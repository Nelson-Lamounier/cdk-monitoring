#!/usr/bin/env npx tsx
/**
 * Golden AMI Deploy Observer
 *
 * @deprecated Replaced by golden-ami-stack.integration.test.ts (Jest integration test).
 * The Jest test provides the same AMI + package verification with consistent
 * test output across all stack verification jobs. This script is preserved
 * for reference but is no longer invoked by the CI pipeline.
 *
 * Monitors Image Builder builds triggered by CloudFormation during the
 * GoldenAmi stack deployment. Streams S3 and CloudWatch build logs into
 * GitHub Actions output for real-time visibility.
 *
 * Observational only — never blocks the pipeline.
 *
 * Usage:
 *   npx tsx scripts/ci/golden-ami-observer.ts GoldenAmi-development --region eu-west-1
 *
 * Exit codes:
 *   0 = always (observational — does not block)
 */

import { parseArgs } from 'util';

import {
    CloudFormationClient,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeLogStreamsCommand,
    GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    DescribeImagesCommand,
    EC2Client,
} from '@aws-sdk/client-ec2';
import {
    ImagebuilderClient,
    GetImageCommand,
    ListImagesCommand,
    ListImageBuildVersionsCommand,
} from '@aws-sdk/client-imagebuilder';
import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client,
} from '@aws-sdk/client-s3';
import {
    GetParameterCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import { writeSummary } from '@repo/script-utils/github.js';
import logger from '@repo/script-utils/logger.js';


// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
        region: {
            type: 'string',
            default: process.env.AWS_REGION ?? 'eu-west-1',
        },
        'ssm-prefix': {
            type: 'string',
            default: process.env.SSM_PREFIX,
        },
        'max-polls': {
            type: 'string',
            default: '35',
        },
        'poll-interval': {
            type: 'string',
            default: '60',
        },
    },
});

const [stackName] = positionals;
const region = values.region!;
const ssmPrefix = values['ssm-prefix'] ?? `/k8s/${process.env.CDK_ENV ?? 'development'}`;
const maxPolls = parseInt(values['max-polls']!, 10);
const pollInterval = parseInt(values['poll-interval']!, 10);

if (!stackName) {
    console.error('Usage: golden-ami-observer.ts <stack-name> [--region <region>] [--ssm-prefix <prefix>]');
    console.error('  Example: golden-ami-observer.ts GoldenAmi-development --region eu-west-1');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// AWS SDK clients
// ---------------------------------------------------------------------------
const cfnClient = new CloudFormationClient({ region });
const ec2Client = new EC2Client({ region });
const imagebuilderClient = new ImagebuilderClient({ region });
const s3Client = new S3Client({ region });
const ssmClient = new SSMClient({ region });
const logsClient = new CloudWatchLogsClient({ region });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Active Image Builder build states */
const ACTIVE_STATES = new Set(['BUILDING', 'TESTING', 'DISTRIBUTING', 'INTEGRATING']);

/** Terminal Image Builder build states */
const TERMINAL_STATES = new Set(['AVAILABLE', 'FAILED', 'CANCELLED']);

/** Expected packages from the Image Builder validate phase */
const EXPECTED_PACKAGES = [
    { name: 'Docker', pattern: /docker/i },
    { name: 'AWS CLI', pattern: /aws-cli/i },
    { name: 'CloudWatch Agent', pattern: /cloudwatch/i },
    { name: 'containerd', pattern: /containerd/i },
    { name: 'runc', pattern: /runc/i },
    { name: 'crictl', pattern: /crictl/i },
    { name: 'kubeadm', pattern: /kubeadm/i },
    { name: 'kubelet', pattern: /kubelet/i },
    { name: 'kubectl', pattern: /kubectl|gitVersion/i },
    { name: 'Calico manifests', pattern: /calico\.yaml/i },
    { name: 'cfn-signal', pattern: /cfn-signal/i },
    { name: 'Helm', pattern: /helm/i },
    { name: 'boto3', pattern: /boto3/i },
    { name: 'ecr-credential-provider', pattern: /ecr-credential-provider/i },
];

interface PackageResult {
    name: string;
    found: boolean;
}

interface VerificationResult {
    amiId?: string;
    amiState?: string;
    amiTags?: Record<string, string>;
    packages: PackageResult[];
    allVerified: boolean;
}

interface ObserverResult {
    outcome: 'success' | 'failed' | 'skipped' | 'timeout';
    amiId?: string;
    reason?: string;
    pollCount: number;
    verification?: VerificationResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if the CloudFormation stack is actively deploying */
async function isStackDeploying(): Promise<boolean> {
    try {
        const { Stacks } = await cfnClient.send(
            new DescribeStacksCommand({ StackName: stackName }),
        );
        const status = Stacks?.[0]?.StackStatus ?? '';
        const deploying = status.endsWith('_IN_PROGRESS');
        logger.info(`Stack status: ${status}${deploying ? ' (active deployment)' : ''}`);
        return deploying;
    } catch {
        logger.info('Stack not found — skipping observer');
        return false;
    }
}

/** Find an active Image Builder build */
async function findActiveBuild(): Promise<string | undefined> {
    try {
        const { imageVersionList } = await imagebuilderClient.send(
            new ListImagesCommand({ owner: 'Self' }),
        );

        for (const version of imageVersionList ?? []) {
            if (!version.arn) continue;

            const { imageSummaryList } = await imagebuilderClient.send(
                new ListImageBuildVersionsCommand({ imageVersionArn: version.arn }),
            );

            for (const build of imageSummaryList ?? []) {
                if (build.arn && ACTIVE_STATES.has(build.state?.status ?? '')) {
                    return build.arn;
                }
            }
        }
    } catch (err) {
        logger.warn(`Failed to list Image Builder builds: ${(err as Error).message}`);
    }
    return undefined;
}

/** Wait for an active Image Builder build to appear */
async function waitForActiveBuild(maxWaitSec: number): Promise<string | undefined> {
    const waitInterval = 15;
    let waited = 0;

    logger.info('Waiting for Image Builder build to start (CFN creates it)...');

    while (waited < maxWaitSec) {
        const buildArn = await findActiveBuild();
        if (buildArn) return buildArn;

        logger.info(`  Waiting... (${waited}s / ${maxWaitSec}s)`);
        await sleep(waitInterval);
        waited += waitInterval;
    }

    return undefined;
}

/** Get the current status of an Image Builder build */
async function getBuildStatus(buildArn: string): Promise<{ status: string; reason?: string; amiId?: string }> {
    const { image } = await imagebuilderClient.send(
        new GetImageCommand({ imageBuildVersionArn: buildArn }),
    );

    return {
        status: image?.state?.status ?? 'UNKNOWN',
        reason: image?.state?.reason,
        amiId: image?.outputResources?.amis?.[0]?.image,
    };
}

/** Resolve the S3 log bucket from SSM */
async function resolveLogBucket(): Promise<string | undefined> {
    try {
        const { Parameter } = await ssmClient.send(
            new GetParameterCommand({ Name: `${ssmPrefix}/scripts-bucket` }),
        );
        return Parameter?.Value;
    } catch {
        logger.warn('Could not resolve S3 log bucket from SSM');
        return undefined;
    }
}

/** Stream S3 build logs */
async function streamS3Logs(bucket: string, prefix: string, pollNum: number): Promise<void> {
    console.log(`::group::Build Logs (S3 — poll ${pollNum})`);

    try {
        const { Contents } = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
        );

        if (!Contents?.length) {
            console.log('  (no log files yet)');
        } else {
            for (const obj of Contents) {
                if (!obj.Key) continue;
                console.log(`--- s3://${bucket}/${obj.Key} ---`);

                try {
                    const { Body } = await s3Client.send(
                        new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
                    );
                    const text = await Body?.transformToString() ?? '';
                    // Show last 50 lines
                    const lines = text.split('\n');
                    console.log(lines.slice(-50).join('\n'));
                } catch {
                    console.log('  (failed to download)');
                }
                console.log('');
            }
        }
    } catch {
        console.log('  (failed to list S3 logs)');
    }

    console.log('::endgroup::');
}

/** Stream CloudWatch logs from Image Builder log groups */
async function streamCloudWatchLogs(pollNum: number): Promise<void> {
    console.log(`::group::CloudWatch Logs (poll ${pollNum})`);

    try {
        const { logGroups } = await logsClient.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/imagebuilder/' }),
        );

        for (const lg of logGroups ?? []) {
            if (!lg.logGroupName) continue;

            try {
                const { logStreams } = await logsClient.send(
                    new DescribeLogStreamsCommand({
                        logGroupName: lg.logGroupName,
                        orderBy: 'LastEventTime',
                        descending: true,
                        limit: 1,
                    }),
                );

                const streamName = logStreams?.[0]?.logStreamName;
                if (!streamName) continue;

                const { events } = await logsClient.send(
                    new GetLogEventsCommand({
                        logGroupName: lg.logGroupName,
                        logStreamName: streamName,
                        limit: 30,
                    }),
                );

                for (const event of events ?? []) {
                    if (event.message) console.log(event.message.trimEnd());
                }
            } catch {
                // Skip individual log group errors
            }
        }
    } catch {
        console.log('  (failed to read CloudWatch logs)');
    }

    console.log('::endgroup::');
}

/** Fetch all S3 build log content as a single string */
async function fetchAllS3Logs(bucket: string, prefix: string): Promise<string> {
    const parts: string[] = [];

    try {
        const { Contents } = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
        );

        for (const obj of Contents ?? []) {
            if (!obj.Key) continue;
            try {
                const { Body } = await s3Client.send(
                    new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
                );
                const text = await Body?.transformToString() ?? '';
                parts.push(text);
            } catch {
                // Skip unreadable log files
            }
        }
    } catch {
        logger.warn('Failed to fetch S3 logs for package verification');
    }

    return parts.join('\n');
}

/** Fetch all CloudWatch log content as a single string */
async function fetchAllCloudWatchLogs(): Promise<string> {
    const parts: string[] = [];

    try {
        const { logGroups } = await logsClient.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/imagebuilder/' }),
        );

        for (const lg of logGroups ?? []) {
            if (!lg.logGroupName) continue;
            try {
                const { logStreams } = await logsClient.send(
                    new DescribeLogStreamsCommand({
                        logGroupName: lg.logGroupName,
                        orderBy: 'LastEventTime',
                        descending: true,
                        limit: 1,
                    }),
                );

                const streamName = logStreams?.[0]?.logStreamName;
                if (!streamName) continue;

                const { events } = await logsClient.send(
                    new GetLogEventsCommand({
                        logGroupName: lg.logGroupName,
                        logStreamName: streamName,
                        limit: 200,
                    }),
                );

                for (const event of events ?? []) {
                    if (event.message) parts.push(event.message);
                }
            } catch {
                // Skip individual log group errors
            }
        }
    } catch {
        logger.warn('Failed to fetch CloudWatch logs for package verification');
    }

    return parts.join('\n');
}

/** Verify the Golden AMI exists and parse logs for package installations */
async function verifyGoldenAmi(
    amiId: string | undefined,
    logBucket?: string,
    s3LogPrefix?: string,
): Promise<VerificationResult> {
    const packages: PackageResult[] = EXPECTED_PACKAGES.map(p => ({ name: p.name, found: false }));
    let amiState: string | undefined;
    let amiTags: Record<string, string> = {};

    // ── 1. Verify AMI exists via EC2 ──
    // First try the build output AMI ID, then fall back to SSM
    const resolvedAmiId = amiId ?? await resolveAmiFromSsm();

    if (resolvedAmiId) {
        try {
            const { Images } = await ec2Client.send(
                new DescribeImagesCommand({ ImageIds: [resolvedAmiId] }),
            );
            const image = Images?.[0];
            amiState = image?.State;
            for (const tag of image?.Tags ?? []) {
                if (tag.Key && tag.Value) amiTags[tag.Key] = tag.Value;
            }
            logger.info(`AMI ${resolvedAmiId} state: ${amiState}`);
        } catch (err) {
            logger.warn(`Failed to describe AMI ${resolvedAmiId}: ${(err as Error).message}`);
        }
    }

    // ── 2. Collect all build logs ──
    const logParts: string[] = [];

    if (logBucket && s3LogPrefix) {
        logParts.push(await fetchAllS3Logs(logBucket, s3LogPrefix));
    }
    logParts.push(await fetchAllCloudWatchLogs());

    const allLogContent = logParts.join('\n');

    // ── 3. Scan for expected package signatures ──
    for (let i = 0; i < EXPECTED_PACKAGES.length; i++) {
        packages[i].found = EXPECTED_PACKAGES[i].pattern.test(allLogContent);
    }

    const allVerified = packages.every(p => p.found);

    if (allVerified) {
        logger.success('All expected packages verified in build logs');
    } else {
        const missing = packages.filter(p => !p.found).map(p => p.name);
        logger.warn(`Packages not found in logs: ${missing.join(', ')}`);
    }

    return {
        amiId: resolvedAmiId,
        amiState,
        amiTags,
        packages,
        allVerified,
    };
}

/** Resolve the latest AMI ID from SSM */
async function resolveAmiFromSsm(): Promise<string | undefined> {
    try {
        const { Parameter } = await ssmClient.send(
            new GetParameterCommand({ Name: `${ssmPrefix}/golden-ami/latest` }),
        );
        return Parameter?.Value;
    } catch {
        logger.warn('Could not resolve AMI ID from SSM');
        return undefined;
    }
}

/** Build step summary markdown */
function buildSummary(result: ObserverResult): string {
    const lines: string[] = [
        '## 🖼️ Golden AMI Build Observer',
        '',
        `**Stack**: ${stackName}`,
        `**Region**: ${region}`,
        `**Polls**: ${result.pollCount}`,
        '',
    ];

    switch (result.outcome) {
        case 'success':
            lines.push(`✅ **Build succeeded** — AMI ID: \`${result.amiId}\``);
            break;
        case 'failed':
            lines.push(`❌ **Build failed** — ${result.reason ?? 'unknown reason'}`);
            break;
        case 'skipped':
            lines.push(`⏭️ **Skipped** — ${result.reason}`);
            break;
        case 'timeout':
            lines.push(`⏱️ **Timed out** after ${maxPolls} polls`);
            break;
    }

    // ── Verification tables (on success) ──
    if (result.verification) {
        const v = result.verification;

        // AMI Metadata
        if (v.amiId) {
            lines.push('', '### 🖼️ AMI Metadata', '');
            lines.push('| Property | Value |');
            lines.push('|----------|-------|');
            lines.push(`| AMI ID | \`${v.amiId}\` |`);
            lines.push(`| State | ${v.amiState ?? 'unknown'} |`);
            if (v.amiTags?.['KubernetesVersion']) {
                lines.push(`| K8s Version | ${v.amiTags['KubernetesVersion']} |`);
            }
            if (v.amiTags?.['Purpose']) {
                lines.push(`| Purpose | ${v.amiTags['Purpose']} |`);
            }
        }

        // Package Verification
        lines.push('', '### 📦 Package Verification', '');
        lines.push('| Package | Status |');
        lines.push('|---------|--------|');
        for (const pkg of v.packages) {
            lines.push(`| ${pkg.name} | ${pkg.found ? '✅ Verified' : '⚠️ Not found in logs'} |`);
        }

        const verified = v.packages.filter(p => p.found).length;
        lines.push('');
        lines.push(`**${verified}/${v.packages.length}** packages verified in build logs`);
    }

    return lines.join('\n');
}

function sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function timestamp(): string {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    logger.header('Golden AMI Deploy Observer');
    logger.info(`Monitoring Image Builder build for stack: ${stackName}`);
    logger.info(`Region: ${region}`);

    // ── Pre-check: is the stack actively deploying? ──
    if (!(await isStackDeploying())) {
        const result: ObserverResult = {
            outcome: 'skipped',
            reason: 'Stack is not actively deploying',
            pollCount: 0,
        };
        writeSummary(buildSummary(result));
        logger.info('Skipping observer — no active deployment');
        return;
    }

    // ── Quick check: any active Image Builder build? ──
    const quickCheck = await findActiveBuild();
    if (!quickCheck) {
        // Wait for build to start (CFN may still be creating it)
        const buildArn = await waitForActiveBuild(600);

        if (!buildArn) {
            const result: ObserverResult = {
                outcome: 'skipped',
                reason: 'No active Image Builder build detected (AMI may already be current)',
                pollCount: 0,
            };
            writeSummary(buildSummary(result));
            logger.info('No active build detected — CloudFormation may have determined no changes needed');
            return;
        }

        return await pollBuild(buildArn);
    }

    await pollBuild(quickCheck);
}

async function pollBuild(buildArn: string): Promise<void> {
    logger.info(`Tracking build: ${buildArn}`);
    logger.blank();

    // Resolve S3 log bucket
    const logBucket = await resolveLogBucket();
    const s3LogPrefix = logBucket ? 'image-builder-logs/' : undefined;

    for (let i = 1; i <= maxPolls; i++) {
        const { status, reason, amiId } = await getBuildStatus(buildArn);
        console.log(`[${timestamp()}] Poll ${i}/${maxPolls} — Status: ${status}`);

        // Stream logs
        if (logBucket && s3LogPrefix) {
            await streamS3Logs(logBucket, s3LogPrefix, i);
        }
        await streamCloudWatchLogs(i);

        // Check terminal states
        if (status === 'AVAILABLE') {
            logger.blank();
            logger.success(`Golden AMI built successfully: ${amiId}`);

            // ── Post-build verification ──
            logger.info('Running post-build verification...');
            const verification = await verifyGoldenAmi(amiId, logBucket, s3LogPrefix);

            const result: ObserverResult = { outcome: 'success', amiId, pollCount: i, verification };
            writeSummary(buildSummary(result));
            return;
        }

        if (TERMINAL_STATES.has(status) && status !== 'AVAILABLE') {
            logger.blank();
            logger.error(`Build ${status.toLowerCase()}: ${reason ?? 'unknown'}`);

            // Dump full S3 logs on failure
            if (logBucket && s3LogPrefix) {
                console.log('::group::Full Build Logs (S3 — for debugging)');
                await streamS3Logs(logBucket, s3LogPrefix, i);
                console.log('::endgroup::');
            }

            const result: ObserverResult = {
                outcome: 'failed',
                reason: reason ?? status,
                pollCount: i,
            };
            writeSummary(buildSummary(result));
            return;
        }

        if (i < maxPolls) {
            await sleep(pollInterval);
        }
    }

    // Timed out
    logger.warn(`Observer timed out after ${maxPolls} polls`);
    const result: ObserverResult = { outcome: 'timeout', pollCount: maxPolls };
    writeSummary(buildSummary(result));
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Fatal: ${message}`);
    // Always exit 0 — observer should never block deployment
});
