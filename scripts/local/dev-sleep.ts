/**
 * dev-sleep — Scale dev ASGs to zero and restore them.
 *
 * Saves current min/desired to SSM before sleeping so wake restores exact state.
 * Uses tag-based discovery (environment + project) so new pools are picked up automatically.
 *
 * Usage:
 *   npx tsx scripts/local/dev-sleep.ts --action sleep  [--profile dev-account] [--region eu-west-1]
 *   npx tsx scripts/local/dev-sleep.ts --action wake   [--profile dev-account] [--region eu-west-1]
 *
 * EventBridge impact:
 *   - EIP failover Lambda: fires on instance termination, finds no replacement, exits gracefully.
 *   - SSM State Manager (rate 30min): targets 0 instances → no-op.
 *   - AMI refresh rule: SSM-parameter triggered, not time-based → silent.
 */

import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    UpdateAutoScalingGroupCommand,
    type AutoScalingGroup,
} from '@aws-sdk/client-auto-scaling';
import {
    SSMClient,
    PutParameterCommand,
    GetParameterCommand,
    ParameterType,
} from '@aws-sdk/client-ssm';

import { parseArgs, buildAwsConfig } from '../lib/aws-helpers.js';
import * as log from '../lib/logger.js';

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = parseArgs(
    [
        { name: 'action', description: 'sleep | wake', hasValue: true },
        { name: 'env', description: 'Environment tag value', hasValue: true, default: 'development' },
        { name: 'project', description: 'Project tag value', hasValue: true, default: 'k8s-platform' },
        { name: 'profile', description: 'AWS CLI profile', hasValue: true },
        { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    ],
    'Scale dev ASGs to zero (sleep) or restore them (wake)',
);

const action = args['action'] as string;
if (action !== 'sleep' && action !== 'wake') {
    console.error('Error: --action must be "sleep" or "wake"');
    process.exit(1);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface AsgSnapshot {
    name: string;
    min: number;
    max: number;
    desired: number;
}

// ─── SSM state helpers ───────────────────────────────────────────────────────

const SSM_STATE_PREFIX = '/dev-sleep/asg-state';

function ssmPath(asgName: string): string {
    return `${SSM_STATE_PREFIX}/${asgName}`;
}

async function saveState(ssm: SSMClient, snap: AsgSnapshot): Promise<void> {
    await ssm.send(new PutParameterCommand({
        Name: ssmPath(snap.name),
        Value: JSON.stringify({ min: snap.min, max: snap.max, desired: snap.desired }),
        Type: ParameterType.STRING,
        Overwrite: true,
        Description: 'dev-sleep: pre-sleep ASG capacity snapshot',
    }));
}

async function loadState(ssm: SSMClient, asgName: string): Promise<AsgSnapshot | undefined> {
    try {
        const res = await ssm.send(new GetParameterCommand({ Name: ssmPath(asgName) }));
        const val = res.Parameter?.Value;
        if (!val) return undefined;
        const parsed = JSON.parse(val) as { min: number; max: number; desired: number };
        return { name: asgName, ...parsed };
    } catch {
        return undefined;
    }
}

// ─── ASG helpers ─────────────────────────────────────────────────────────────

async function discoverAsgs(
    asg: AutoScalingClient,
    envTag: string,
    projectTag: string,
): Promise<AutoScalingGroup[]> {
    const groups: AutoScalingGroup[] = [];
    let nextToken: string | undefined;

    do {
        const res = await asg.send(new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }));
        nextToken = res.NextToken;

        for (const group of res.AutoScalingGroups ?? []) {
            const tags = (group.Tags ?? []).reduce<Record<string, string>>((acc, t) => {
                if (t.Key && t.Value) acc[t.Key] = t.Value;
                return acc;
            }, {});

            if (tags['environment'] === envTag && tags['project'] === projectTag) {
                groups.push(group);
            }
        }
    } while (nextToken);

    return groups;
}

async function setCapacity(
    asg: AutoScalingClient,
    name: string,
    min: number,
    desired: number,
): Promise<void> {
    await asg.send(new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: name,
        MinSize: min,
        DesiredCapacity: desired,
    }));
}

// ─── Main ────────────────────────────────────────────────────────────────────

const printBanner = (title: string) => {
    console.log('\n================================================');
    const pad = Math.max(0, Math.floor((48 - title.length) / 2));
    console.log(' '.repeat(pad) + title);
    console.log('================================================\n');
};

const main = async () => {
    const config = buildAwsConfig(args);
    const envTag = args['env'] as string;
    const projectTag = args['project'] as string;

    const asgClient = new AutoScalingClient({ region: config.region, credentials: config.credentials });
    const ssmClient = new SSMClient({ region: config.region, credentials: config.credentials });

    printBanner(`dev-sleep: ${action.toUpperCase()}`);
    console.log(`  Environment : ${envTag}`);
    console.log(`  Project     : ${projectTag}`);
    console.log(`  Region      : ${config.region}\n`);

    const groups = await discoverAsgs(asgClient, envTag, projectTag);

    if (groups.length === 0) {
        log.warn(`No ASGs found tagged environment=${envTag}, project=${projectTag}`);
        return;
    }

    console.log(`Found ${groups.length} ASG(s):\n`);
    for (const g of groups) {
        console.log(`  • ${g.AutoScalingGroupName}  min=${g.MinSize} max=${g.MaxSize} desired=${g.DesiredCapacity} instances=${g.Instances?.length ?? 0}`);
    }
    console.log('');

    if (action === 'sleep') {
        for (const g of groups) {
            const name = g.AutoScalingGroupName!;
            const snap: AsgSnapshot = {
                name,
                min: g.MinSize ?? 1,
                max: g.MaxSize ?? 4,
                desired: g.DesiredCapacity ?? 1,
            };

            process.stdout.write(`  Saving state for ${name} ... `);
            await saveState(ssmClient, snap);
            console.log('saved');

            process.stdout.write(`  Scaling to 0    for ${name} ... `);
            await setCapacity(asgClient, name, 0, 0);
            console.log('done');
        }

        console.log('');
        log.success('All ASGs scaled to zero. Instances will terminate shortly.');
        console.log('  Note: EIP failover Lambda may log a warning — expected, not an error.');
        console.log(`  Wake up: npx tsx scripts/local/dev-sleep.ts --action wake --profile ${args['profile'] ?? 'dev-account'}\n`);

    } else {
        // wake
        for (const g of groups) {
            const name = g.AutoScalingGroupName!;

            process.stdout.write(`  Loading state for ${name} ... `);
            const snap = await loadState(ssmClient, name);

            if (!snap) {
                log.warn(`No saved state found for ${name} — using min=1, desired=1`);
                await setCapacity(asgClient, name, 1, 1);
            } else {
                console.log(`found (min=${snap.min} max=${snap.max} desired=${snap.desired})`);
                process.stdout.write(`  Restoring       ${name} ... `);
                await setCapacity(asgClient, name, snap.min, snap.desired);
                console.log('done');
            }
        }

        console.log('');
        log.success('ASGs restored. New instances will bootstrap and join the cluster.');
        console.log('  Cluster Autoscaler will resume managing scale after nodes are Ready.\n');
    }
};

main().catch(err => {
    console.error('Script failed:', err);
    process.exit(1);
});
