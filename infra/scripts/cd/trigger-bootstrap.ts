#!/usr/bin/env npx tsx
/**
 * Trigger SSM Bootstrap
 *
 * Triggers SSM Automation on Kubernetes nodes in a defined order:
 *   1. Start control-plane bootstrap
 *   2. Wait for control-plane to complete (workers need join credentials)
 *   3. Start app-worker + mon-worker bootstrap (if instances exist)
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
// AWS Client
// =============================================================================
const ssm = new SSMClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

// =============================================================================
// Node Trigger Target Definitions
// =============================================================================
interface TriggerTarget {
    /** Node role label (e.g. control-plane, app-worker) */
    role: string;
    /** SSM parameter path for the instance ID */
    instanceParam: string;
    /** SSM parameter path for the automation document name */
    docParam: string;
    /** SSM parameter path to publish the execution ID */
    execParam: string;
    /** GitHub Actions output key */
    outputKey: string;
}

function buildTargets(prefix: string): TriggerTarget[] {
    return [
        {
            role: 'control-plane',
            instanceParam: `${prefix}/bootstrap/control-plane-instance-id`,
            docParam: `${prefix}/bootstrap/control-plane-doc-name`,
            execParam: `${prefix}/bootstrap/execution-id`,
            outputKey: 'cp_execution_id',
        },
        {
            role: 'app-worker',
            instanceParam: `${prefix}/bootstrap/app-worker-instance-id`,
            docParam: `${prefix}/bootstrap/worker-doc-name`,
            execParam: `${prefix}/bootstrap/worker-execution-id`,
            outputKey: 'worker_execution_id',
        },
        {
            role: 'mon-worker',
            instanceParam: `${prefix}/bootstrap/mon-worker-instance-id`,
            docParam: `${prefix}/bootstrap/worker-doc-name`,
            execParam: `${prefix}/bootstrap/mon-worker-execution-id`,
            outputKey: 'mon_worker_execution_id',
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

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Core Functions
// =============================================================================

interface TriggerResult {
    role: string;
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

    // 1. Resolve instance ID
    const instanceId = await getParam(target.instanceParam);
    if (!instanceId) {
        logger.info(`[SKIP] No instance ID at ${target.instanceParam} — node not deployed`);
        return { role: target.role, status: 'skipped', reason: 'no instance ID' };
    }
    logger.keyValue('Instance', instanceId);

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

    // 4. Start SSM Automation execution
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
    // Workers need join credentials (token, CA hash, endpoint) that the
    // control-plane publishes to SSM during initKubeadm.
    if (cpResult.status === 'triggered' && cpResult.executionId) {
        const cpSuccess = await waitForAutomation('control-plane', cpResult.executionId, maxWait);
        if (!cpSuccess) {
            emitAnnotation(
                'warning',
                'Control-plane bootstrap did not succeed — triggering workers anyway',
                'Bootstrap Warning',
            );
        }
    } else if (cpResult.status === 'skipped') {
        emitAnnotation(
            'warning',
            'Control-plane not triggered — triggering workers immediately',
            'Bootstrap Warning',
        );
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
