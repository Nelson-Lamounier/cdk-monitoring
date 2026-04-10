#!/usr/bin/env npx tsx
/**
 * Trigger SSM Bootstrap
 *
 * Triggers SSM Automation on Kubernetes nodes in a defined order:
 *   1. Start control-plane bootstrap
 *   2. Wait for control-plane to complete (workers need join credentials)
 *   3. Start all worker nodes (legacy + new ASG pools) in parallel
 *
 * MIGRATION NOTE: During the K8s-native worker migration, both legacy worker
 * targets (app-worker, mon-worker, argocd-worker) and the new ASG pool targets
 * (general-pool, monitoring-pool) are active. Remove legacy targets once the
 * old stacks are decommissioned.
 *
 * For each node role, the script:
 *   - Resolves the instance ID from SSM Parameter Store
 *   - Resolves the SSM Automation document name from SSM
 *   - Starts SSM Automation execution
 *   - Publishes the execution ID back to SSM for the observer job
 *   - Sets GitHub Actions outputs for downstream jobs
 *
 * Usage:
 *   npx tsx trigger-bootstrap.ts \
 *     --environment development \
 *     [--region eu-west-1] \
 *     [--max-wait 600]
 *
 * Environment variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 *
 * Exit codes:
 *   0 — success (all triggered nodes started; CP may have failed but workers still triggered)
 *   1 — fatal error (missing environment)
 */

import {
    DescribeInstancesCommand,
    EC2Client,
    RebootInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
    DescribeInstanceInformationCommand,
    GetAutomationExecutionCommand,
    GetParameterCommand,
    PutParameterCommand,
    SSMClient,
    StartAutomationExecutionCommand,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '@repo/script-utils/aws.js';
import { setOutput, writeSummary, emitAnnotation } from '@repo/script-utils/github.js';
import logger from '@repo/script-utils/logger.js';

// =============================================================================
// CLI argument parsing
// =============================================================================
const args = parseArgs(
    [
        {
            name: 'environment',
            description: 'Deployment environment (e.g. development, staging)',
            hasValue: true,
            default: process.env.DEPLOY_ENVIRONMENT ?? '',
        },
        {
            name: 'region',
            description: 'AWS region',
            hasValue: true,
            default: process.env.AWS_REGION ?? 'eu-west-1',
        },
        {
            name: 'max-wait',
            description: 'Max seconds to wait for control-plane automation (default: 600)',
            hasValue: true,
            default: '600',
        },
    ],
    'Trigger SSM Automation bootstrap on K8s nodes',
);

if (!args.environment) {
    logger.fatal(
        'Missing --environment flag or DEPLOY_ENVIRONMENT env var.\n' +
        'Run with --help for usage.',
    );
}

const environment = args.environment as string;
const awsConfig = buildAwsConfig(args);
const maxWait = parseInt(args['max-wait'] as string, 10) || 600;
const ssmPrefix = `/k8s/${environment}`;

// =============================================================================
// AWS Clients
// =============================================================================
const ssm = new SSMClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

const ec2 = new EC2Client({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

// =============================================================================
// Node Trigger Target Definitions
// =============================================================================
interface TriggerTarget {
    /** Node role label (e.g. control-plane, app-worker) */
    role: string;
    /** SSM parameter path for the automation document name */
    docParam: string;
    /** SSM parameter path to publish the execution ID */
    execParam: string;
    /** GitHub Actions output key */
    outputKey: string;
    /** Value of the k8s:bootstrap-role tag used for EC2 discovery and SSM targeting */
    targetTagValue: string;
}

function buildTargets(prefix: string): TriggerTarget[] {
    return [
        {
            role: 'control-plane',
            docParam: `${prefix}/bootstrap/control-plane-doc-name`,
            execParam: `${prefix}/bootstrap/execution-id`,
            outputKey: 'cp_execution_id',
            targetTagValue: 'control-plane',
        },

        // // ─── Legacy worker targets ───────────────────────────────────────────
        // // These targets remain active during the zero-downtime migration.
        // // Remove once the AppWorker, MonitoringWorker, and ArgocdWorker stacks
        // // have been fully drained and destroyed.
        // {
        //     role: 'app-worker',
        //     docParam: `${prefix}/bootstrap/worker-doc-name`,
        //     execParam: `${prefix}/bootstrap/worker-execution-id`,
        //     outputKey: 'worker_execution_id',
        //     targetTagValue: 'app-worker',
        // },
        // {
        //     role: 'mon-worker',
        //     docParam: `${prefix}/bootstrap/worker-doc-name`,
        //     execParam: `${prefix}/bootstrap/mon-worker-execution-id`,
        //     outputKey: 'mon_worker_execution_id',
        //     targetTagValue: 'mon-worker',
        // },
        // {
        //     role: 'argocd-worker',
        //     docParam: `${prefix}/bootstrap/worker-doc-name`,
        //     execParam: `${prefix}/bootstrap/argocd-worker-execution-id`,
        //     outputKey: 'argocd_worker_execution_id',
        //     targetTagValue: 'argocd-worker',
        // },

        // ─── New ASG pool targets (K8s-native worker migration) ───────────────
        // general-pool:    t3.small Spot, hosts Next.js / start-admin / ArgoCD.
        //                  No taint — node-pool=general label applied by bootstrap.
        // monitoring-pool: t3.medium Spot, hosts observability stack.
        //                  Tainted dedicated=monitoring:NoSchedule by bootstrap.
        {
            role: 'general-pool',
            docParam: `${prefix}/bootstrap/worker-doc-name`,
            execParam: `${prefix}/bootstrap/general-pool-execution-id`,
            outputKey: 'general_pool_execution_id',
            targetTagValue: 'general-pool',
        },
        {
            role: 'monitoring-pool',
            docParam: `${prefix}/bootstrap/worker-doc-name`,
            execParam: `${prefix}/bootstrap/monitoring-pool-execution-id`,
            outputKey: 'monitoring_pool_execution_id',
            targetTagValue: 'monitoring-pool',
        },
    ];
}

// =============================================================================
// Helpers
// =============================================================================

/** Fetch a single SSM parameter value, returning undefined if missing. */
async function getParam(name: string): Promise<string | undefined> {
    try {
        const result = await ssm.send(new GetParameterCommand({ Name: name }));
        const value = result.Parameter?.Value;
        if (value && value !== 'None') return value;
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolve a running instance ID by its k8s:bootstrap-role tag.
 *
 * Uses EC2 DescribeInstances filtered by tag + running state.
 * This replaces the previous SSM parameter-based lookup, which
 * was prone to stale IDs when instances were replaced by the ASG.
 */
async function resolveInstanceByTag(tagValue: string): Promise<string | undefined> {
    try {
        const result = await ec2.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:k8s:bootstrap-role', Values: [tagValue] },
                    { Name: 'instance-state-name', Values: ['running'] },
                ],
            }),
        );

        const instances = result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
        if (instances.length === 0) return undefined;

        // Return the first running instance (there should be exactly one per role)
        return instances[0].InstanceId;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`EC2 describe-instances failed for tag k8s:bootstrap-role=${tagValue}: ${message}`);
        return undefined;
    }
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the SSM agent on an instance is online before firing automation.
 *
 * If the agent is `ConnectionLost` or `Inactive`, triggers an EC2 reboot and
 * re-polls for up to `maxRecoverySeconds` seconds.
 *
 * **Throws** a descriptive `Error` on every irrecoverable failure path —
 * callers must NOT continue firing SSM Automation after this function rejects,
 * as doing so would cause the execution to hang for 15 min on an unresponsive
 * instance, leaving the site down the entire time.
 *
 * @param instanceId            - EC2 instance to check.
 * @param maxRecoverySeconds    - Max seconds to wait after reboot (default 180).
 * @throws {Error} If the SSM agent cannot be confirmed online.
 */
async function checkSsmAgentHealth(
    instanceId: string,
    maxRecoverySeconds = 180,
): Promise<void> {
    /** Fetch the current SSM PingStatus for the instance. */
    async function getPingStatus(): Promise<string> {
        try {
            const result = await ssm.send(
                new DescribeInstanceInformationCommand({
                    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
                }),
            );
            return result.InstanceInformationList?.[0]?.PingStatus ?? 'Unknown';
        } catch {
            return 'Unknown';
        }
    }

    const initialStatus = await getPingStatus();
    logger.keyValue('SSM PingStatus', initialStatus);

    if (initialStatus === 'Online') return; // agent is ready \u2014 proceed


    // ── Recovery: reboot the instance to restart the SSM agent ──────────────
    if (initialStatus === 'ConnectionLost' || initialStatus === 'Inactive') {
        logger.warn(
            `SSM agent is ${initialStatus} on ${instanceId} — triggering reboot to recover`,
        );
        try {
            await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
            logger.info('Reboot triggered — waiting for SSM agent to come online...');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // HARD FAILURE: cannot even attempt recovery — abort the deployment.
            throw new Error(
                `FATAL: Could not reboot instance ${instanceId} to recover SSM agent (${msg}). ` +
                'Aborting deployment — a broken node must be investigated before bootstrap proceeds.',
            );
        }

        // Poll every 15 s for up to maxRecoverySeconds
        const pollMs = 15_000;
        let waited = 0;
        while (waited < maxRecoverySeconds * 1000) {
            await sleep(pollMs);
            waited += pollMs;
            const status = await getPingStatus();
            logger.info(
                `SSM agent recovery: ${status} (${waited / 1000}s / ${maxRecoverySeconds}s)`,
            );
            if (status === 'Online') {
                logger.success(`SSM agent recovered on ${instanceId} after ${waited / 1000}s`);
                return; // recovered \u2014 proceed with automation
            }

        }

        // HARD FAILURE: agent still offline after full recovery window.
        // Continuing would fire automation on an unresponsive instance and
        // hang for 15 min before timing out — leaving the site down the whole time.
        throw new Error(
            `FATAL: SSM agent on ${instanceId} (${initialStatus}) did not come online within ` +
            `${maxRecoverySeconds}s after reboot. Aborting deployment — ` +
            'check CloudWatch agent logs and EC2 system status checks before retrying.',
        );
    }

    // NotYetRegistered / Unknown — cannot recover automatically.
    // Throw rather than silently skip — an unknown agent state is a configuration error.
    throw new Error(
        `FATAL: Unexpected SSM agent PingStatus '${initialStatus}' on ${instanceId}. ` +
        'This instance has never registered with SSM or its registration has been lost. ' +
        'Verify the IAM role, SSM agent installation, and VPC endpoints before retrying.',
    );
}

// =============================================================================
// Core Functions
// =============================================================================

interface TriggerResult {
    role: string;
    /** `triggered` = SSM Automation started. `skipped` = no instance found (not an error). */
    status: 'triggered' | 'skipped';
    executionId?: string;
    instanceId?: string;
    reason?: string;
}

/**
 * Trigger SSM Automation for a single node role.
 *
 * Resolves instance ID → doc name → S3 bucket, starts automation,
 * publishes execution ID, and sets GitHub Actions output.
 */
async function triggerNode(target: TriggerTarget): Promise<TriggerResult> {
    logger.task(`${target.role}`);

    // 1. Resolve instance ID from EC2 tags (live, never stale)
    const instanceId = await resolveInstanceByTag(target.targetTagValue);
    if (!instanceId) {
        logger.info(`[SKIP] No running instance with tag k8s:bootstrap-role=${target.targetTagValue}`);
        return { role: target.role, status: 'skipped', reason: 'no running instance' };
    }
    logger.keyValue('Instance', instanceId);

    // 1b. Verify SSM agent is online — auto-reboot and retry if ConnectionLost.
    //     checkSsmAgentHealth() THROWS on any irrecoverable failure, aborting
    //     the deployment rather than silently continuing to fire automation
    //     on an unresponsive instance.
    await checkSsmAgentHealth(instanceId);

    // 2. Resolve automation document name
    const docName = await getParam(target.docParam);
    if (!docName) {
        emitAnnotation('warning', `SSM doc name not found at ${target.docParam} — skipping ${target.role}`);
        logger.warn(`SSM doc name not found at ${target.docParam} — skipping`);
        return { role: target.role, status: 'skipped', reason: 'no doc name' };
    }
    logger.keyValue('Document', docName);

    // 3. Resolve S3 bucket for bootstrap scripts
    const s3Bucket = await getParam(`${ssmPrefix}/scripts-bucket`) ?? '';

    // 4. Start SSM Automation execution (direct instance targeting)
    //    We pass the instance ID directly instead of using Targets, because
    //    SSM Targets tag resolution finds ALL instances with the tag —
    //    including terminated ones that retain their tags. Since we already
    //    resolved the single running instance via resolveInstanceByTag(),
    //    we pass it directly to avoid spawning child executions on dead instances.
    const startResult = await ssm.send(
        new StartAutomationExecutionCommand({
            DocumentName: docName,
            Parameters: {
                InstanceId: [instanceId],
                SsmPrefix: [ssmPrefix],
                S3Bucket: [s3Bucket],
                Region: [awsConfig.region],
            },
        }),
    );

    const executionId = startResult.AutomationExecutionId;
    if (!executionId) {
        logger.warn(`Failed to start automation for ${target.role} — no execution ID returned`);
        return { role: target.role, status: 'skipped', reason: 'start failed' };
    }

    logger.keyValue('Execution', executionId);

    // 5. Publish execution ID to SSM for the observer job
    try {
        await ssm.send(
            new PutParameterCommand({
                Name: target.execParam,
                Value: executionId,
                Type: 'String',
                Overwrite: true,
            }),
        );
    } catch {
        // Non-fatal — observer can still use GitHub outputs
        logger.warn(`Could not publish execution ID to ${target.execParam}`);
    }

    // 6. Set GitHub Actions output
    setOutput(target.outputKey, executionId);

    logger.success(`${target.role} SSM Automation triggered`);
    return { role: target.role, status: 'triggered', executionId, instanceId };
}

/** Terminal SSM Automation statuses. */
const TERMINAL_SUCCESS = new Set(['Success']);
const TERMINAL_FAILURE = new Set(['Failed', 'Cancelled', 'TimedOut', 'CompletedWithFailure']);

/**
 * Poll SSM Automation execution until completion or timeout.
 *
 * @returns true if automation succeeded, false otherwise.
 */
async function waitForAutomation(
    role: string,
    executionId: string,
    maxWaitSeconds: number,
): Promise<boolean> {
    const pollInterval = 15_000; // 15 seconds
    let waited = 0;

    logger.blank();
    logger.task(`Waiting for ${role} automation (${executionId})`);

    while (waited < maxWaitSeconds * 1000) {
        let status = 'Unknown';

        try {
            const result = await ssm.send(
                new GetAutomationExecutionCommand({
                    AutomationExecutionId: executionId,
                }),
            );
            status = result.AutomationExecution?.AutomationExecutionStatus ?? 'Unknown';
        } catch {
            // Transient error — keep polling
        }

        if (TERMINAL_SUCCESS.has(status)) {
            logger.success(`${role} automation completed successfully (${waited / 1000}s)`);
            return true;
        }

        if (TERMINAL_FAILURE.has(status)) {
            logger.warn(`${role} automation finished with status: ${status} (${waited / 1000}s)`);
            return false;
        }

        logger.info(`${role} status: ${status} (${waited / 1000}s / ${maxWaitSeconds}s)`);
        await sleep(pollInterval);
        waited += pollInterval;
    }

    logger.warn(`${role} automation did not complete within ${maxWaitSeconds}s`);
    return false;
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('Trigger SSM Bootstrap');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', awsConfig.region);
    logger.keyValue('SSM Prefix', ssmPrefix);
    logger.keyValue('Max Wait (CP)', `${maxWait}s`);
    logger.blank();

    const targets = buildTargets(ssmPrefix);
    const results: TriggerResult[] = [];

    // ── Step 1: Trigger control-plane ────────────────────────────────────────
    const cpTarget = targets[0];
    const cpResult = await triggerNode(cpTarget);
    results.push(cpResult);
    logger.blank();

    // ── Step 2: Wait for control-plane to complete ───────────────────────────
    // Workers MUST NOT start until the control-plane exports join credentials
    // (join token, CA hash, API server endpoint) to SSM. Triggering workers
    // against a failed control-plane means they will never join — leaving the
    // cluster nodeless and the site down.
    if (cpResult.status === 'triggered' && cpResult.executionId) {
        const cpSuccess = await waitForAutomation('control-plane', cpResult.executionId, maxWait);
        if (!cpSuccess) {
            // HARD FAILURE — abort before workers are triggered.
            // A partial cluster (CP bootstrapped but workers not joined) is
            // worse than a clean failure: pods become Pending, Traefik loses
            // backends, and the site shows "no available server".
            emitAnnotation(
                'error',
                'Control-plane bootstrap FAILED — aborting worker triggers to prevent a broken cluster state. ' +
                'Check the SSM Automation logs and CloudWatch boot logs before retrying.',
                'Bootstrap Aborted',
            );
            logger.fatal(
                'Control-plane automation did not succeed. ' +
                'Worker nodes will NOT be triggered to avoid a partially bootstrapped cluster. ' +
                'Fix the control-plane failure, then re-run the workflow.',
            );
            process.exit(1);
        }
    } else if (cpResult.status === 'skipped') {
        // CP skipped = no running instance found. Workers rely on CP join
        // credentials, so this is also a hard stop.
        emitAnnotation(
            'error',
            'Control-plane instance not found — cannot trigger workers without join credentials. Aborting.',
            'Bootstrap Aborted',
        );
        logger.fatal(
            'No running control-plane instance was found. ' +
            'Verify the EC2 instance is running and has the correct k8s:bootstrap-role tag.',
        );
        process.exit(1);
    }

    logger.blank();

    // ── Step 3: Trigger worker nodes ─────────────────────────────────────────
    for (const workerTarget of targets.slice(1)) {
        const result = await triggerNode(workerTarget);
        results.push(result);
        logger.blank();
    }

    // ── Step 4: Write GitHub step summary ────────────────────────────────────
    const summaryLines: string[] = [
        '## SSM Bootstrap Triggers',
        '',
        '| Role | Status | Execution ID |',
        '|------|--------|--------------|',
    ];

    for (const r of results) {
        const icon = r.status === 'triggered' ? '✅' : '⏭️';
        const execId = r.executionId ? `\`${r.executionId}\`` : r.reason ?? '—';
        summaryLines.push(`| ${r.role} | ${icon} ${r.status} | ${execId} |`);
    }

    summaryLines.push('');
    summaryLines.push(`**Environment:** ${environment}`);
    summaryLines.push(`**SSM Prefix:** \`${ssmPrefix}\``);

    writeSummary(summaryLines.join('\n'));

    // ── Done ─────────────────────────────────────────────────────────────────
    const triggeredCount = results.filter((r) => r.status === 'triggered').length;
    logger.header('Trigger Complete');
    logger.success(`${triggeredCount}/${results.length} nodes triggered`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `SSM trigger failed: ${message}`, 'Bootstrap Trigger Error');
    logger.fatal(`SSM trigger failed: ${message}`);
});
