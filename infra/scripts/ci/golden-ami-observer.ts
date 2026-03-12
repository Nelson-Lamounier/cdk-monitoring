#!/usr/bin/env npx tsx
/**
 * Golden AMI Deploy Observer
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

interface ObserverResult {
    outcome: 'success' | 'failed' | 'skipped' | 'timeout';
    amiId?: string;
    reason?: string;
    pollCount: number;
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
            const result: ObserverResult = { outcome: 'success', amiId, pollCount: i };
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
