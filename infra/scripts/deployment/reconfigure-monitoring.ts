#!/usr/bin/env npx tsx
/**
 * Reconfigure Monitoring Stack via SSM Run Command
 *
 * Triggers the SSM document that configures the monitoring stack on the EC2
 * instance WITHOUT requiring a CDK deploy or EC2 instance replacement.
 *
 * Use cases:
 *   - Rotate Grafana admin password
 *   - Update monitoring stack files after S3 sync
 *   - Re-register SSM endpoints after IP change
 *   - Re-fetch GitHub PAT after token rotation
 *
 * Usage:
 *   yarn cli reconfigure-monitoring                           # interactive defaults
 *   yarn cli reconfigure-monitoring -e development            # specific environment
 *   yarn cli reconfigure-monitoring --profile monitoring-dev  # explicit profile
 */

import {
    EC2Client,
    DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
    SSMClient,
    SendCommandCommand,
    GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

import logger from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconfigureOptions {
    environment: string;
    profile?: string;
    region: string;
    /** Override default SSM document parameters */
    parameters?: Record<string, string[]>;
    /** Timeout in seconds to wait for completion */
    timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function reconfigureMonitoring(options: ReconfigureOptions): Promise<void> {
    const {
        environment,
        region,
        timeoutSeconds = 600,
    } = options;

    logger.header('Reconfigure Monitoring Stack');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', region);
    if (options.profile) {
        logger.keyValue('Profile', options.profile);
    }
    logger.blank();

    // Build environment-specific names
    // CDK naming convention: monitoring-{env}-configure-monitoring-stack
    const envSuffix = environment;
    const ssmDocumentName = `monitoring-${envSuffix}-configure-monitoring-stack`;

    logger.keyValue('SSM Document', ssmDocumentName);
    logger.blank();

    // Initialize AWS clients
    const clientConfig: { region: string; profile?: string } = { region };
    const ec2 = new EC2Client(clientConfig);
    const ssm = new SSMClient(clientConfig);

    // Step 1: Find monitoring instance
    const instanceId = await findMonitoringInstance(ec2);

    // Step 2: Send SSM Run Command
    const commandId = await sendSsmCommand(ssm, {
        documentName: ssmDocumentName,
        instanceId,
        parameters: options.parameters,
        timeoutSeconds,
    });

    // Step 3: Wait for completion
    await waitForCompletion(ssm, { commandId, instanceId, timeoutSeconds, region });

    logger.blank();
    logger.success('Monitoring stack reconfigured successfully!');
    logger.blank();
    logger.info('The monitoring stack has been re-configured without EC2 replacement.');
    logger.info('Services should be back online within a few seconds.');
}

// ---------------------------------------------------------------------------
// Find monitoring EC2 instance
// ---------------------------------------------------------------------------

async function findMonitoringInstance(ec2: EC2Client): Promise<string> {
    logger.task('Discovering monitoring EC2 instance...');

    try {
        const response = await ec2.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:Project', Values: ['Monitoring'] },
                    { Name: 'instance-state-name', Values: ['running'] },
                ],
            })
        );

        const instances =
            response.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];

        if (instances.length === 0) {
            throw new Error(
                'No running monitoring instance found (tag: Project=Monitoring)'
            );
        }

        const instanceId = instances[0].InstanceId!;
        const nameTag =
            instances[0].Tags?.find((t) => t.Key === 'Name')?.Value ?? 'unnamed';
        logger.success(`Found instance: ${instanceId} (${nameTag})`);
        return instanceId;
    } catch (err) {
        logger.error(`Instance discovery failed: ${(err as Error).message}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Send SSM Run Command
// ---------------------------------------------------------------------------

interface SendSsmConfig {
    documentName: string;
    instanceId: string;
    parameters?: Record<string, string[]>;
    timeoutSeconds: number;
}

async function sendSsmCommand(
    ssm: SSMClient,
    config: SendSsmConfig
): Promise<string> {
    logger.task(`Sending SSM command: ${config.documentName}...`);

    try {
        const response = await ssm.send(
            new SendCommandCommand({
                DocumentName: config.documentName,
                InstanceIds: [config.instanceId],
                Parameters: config.parameters,
                TimeoutSeconds: config.timeoutSeconds,
                Comment: `CLI reconfigure-monitoring at ${new Date().toISOString()}`,
            })
        );

        const commandId = response.Command?.CommandId;
        if (!commandId) {
            throw new Error('SSM SendCommand returned no CommandId');
        }

        logger.success(`SSM command sent: ${commandId}`);
        return commandId;
    } catch (err) {
        logger.error(`SSM SendCommand failed: ${(err as Error).message}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Wait for SSM command completion
// ---------------------------------------------------------------------------

interface WaitConfig {
    commandId: string;
    instanceId: string;
    timeoutSeconds: number;
    region: string;
}

async function waitForCompletion(
    ssm: SSMClient,
    config: WaitConfig
): Promise<void> {
    logger.task('Waiting for SSM command to complete...');

    const pollIntervalMs = 5_000;
    const maxWaitMs = config.timeoutSeconds * 1_000;
    let elapsedMs = 0;

    while (elapsedMs < maxWaitMs) {
        await sleep(pollIntervalMs);
        elapsedMs += pollIntervalMs;

        try {
            const response = await ssm.send(
                new GetCommandInvocationCommand({
                    CommandId: config.commandId,
                    InstanceId: config.instanceId,
                })
            );

            const status = response.Status;
            const stepName = response.StandardOutputContent?.match(
                /=== SSM Step: (\S+)/
            )?.[1];

            if (stepName) {
                logger.dim(`  Step: ${stepName} (${status})`);
            }

            switch (status) {
                case 'Success':
                    logger.success('SSM command completed successfully');
                    return;

                case 'Failed':
                case 'Cancelled':
                case 'TimedOut': {
                    const stderr = response.StandardErrorContent ?? '';
                    logger.error(`SSM command ${status}`);
                    if (stderr) {
                        logger.dim('--- stderr ---');
                        logger.dim(stderr.slice(0, 500));
                    }
                    process.exit(1);
                    break;
                }

                case 'InProgress':
                case 'Pending':
                case 'Delayed':
                    // Still running, continue polling
                    break;

                default:
                    logger.dim(`  Status: ${status} (${Math.round(elapsedMs / 1000)}s)`);
            }
        } catch {
            // GetCommandInvocation may fail briefly after SendCommand
            // (race condition) — just keep polling
        }
    }

    logger.error(`SSM command timed out after ${config.timeoutSeconds}s`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
