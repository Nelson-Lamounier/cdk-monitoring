#!/usr/bin/env tsx
/**
 * SSM Automation Troubleshooter
 *
 * Query recent SSM Automation executions and inspect step-level outputs,
 * failure reasons, and CloudWatch logs. Defaults to showing the last
 * execution with Failed or TimedOut status.
 *
 * Usage:
 *   Local: npx tsx scripts/local/ssm-automation.ts --profile dev-account
 *   Filter: npx tsx scripts/local/ssm-automation.ts --status Failed,TimedOut --runbook deploy-monitoring
 *   All:    npx tsx scripts/local/ssm-automation.ts --status Success,Failed,TimedOut --last 5
 */

import {
    SSMClient,
    DescribeAutomationExecutionsCommand,
    GetAutomationExecutionCommand,
    GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';
import type {
    AutomationExecutionMetadata,
    StepExecution,
} from '@aws-sdk/client-ssm';
import {
    CloudWatchLogsClient,
    DescribeLogStreamsCommand,
    GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import * as log from '../lib/logger.js';
import { startFileLogging, stopFileLogging } from '../lib/logger.js';
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js';

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
    [
        { name: 'profile', description: 'AWS CLI profile', hasValue: true },
        { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
        { name: 'runbook', description: 'Filter by Runbook (Document) name prefix', hasValue: true },
        { name: 'status', description: 'Filter by Execution Status (e.g. Failed,TimedOut,Success)', hasValue: true, default: 'Failed,TimedOut,Success' },
        { name: 'last', description: 'Number of executions to inspect', hasValue: true, default: '1' },
        { name: 'since', description: 'How far back to look for executions (e.g. 24h, 48h, 7d)', hasValue: true, default: '24h' },
        { name: 'log-group', description: 'CloudWatch Log Group base path or full override (default: auto-detect from document name)', hasValue: true, default: '/ssm/k8s/development' },
    ],
    'SSM Automation Troubleshooter — query executions, inspect step failures, and fetch CloudWatch logs',
);

// ========================================
// Constants
// ========================================

/** Step statuses that indicate failure */
const FAILURE_STEP_STATUSES: ReadonlySet<string> = new Set(['Failed', 'TimedOut', 'Cancelled']);

/** Step statuses that indicate in-progress work */
const IN_PROGRESS_STEP_STATUSES: ReadonlySet<string> = new Set(['InProgress', 'Pending']);

/** Execution statuses that indicate failure */
const FAILURE_EXECUTION_STATUSES: ReadonlySet<string> = new Set(['Failed', 'TimedOut', 'Cancelled']);

// ========================================
// Types
// ========================================

/** Parsed and validated CLI configuration */
interface ScriptConfig {
    /** Number of executions to query */
    maxResults: number;
    /**
     * CloudWatch log group base path (e.g. `/ssm/k8s/development`).
     * The script appends `/bootstrap` or `/deploy` based on the document name.
     * Override with `--log-group` to force a specific group.
     */
    logGroupBase: string;
    /** If true, --log-group was set explicitly and overrides auto-detection */
    logGroupOverride: boolean;
    /** Status filters to apply */
    statusFilters: string[];
    /** Optional runbook name prefix filter */
    runbookPrefix: string | undefined;
    /** How far back to search (milliseconds from now) */
    sinceMs: number;
}

// ========================================
// Helpers
// ========================================

/**
 * Determine whether an SSM step status represents a failure.
 *
 * @param status - Step execution status string
 * @returns Whether the status indicates failure
 */
function isStepFailure(status: string): boolean {
    return FAILURE_STEP_STATUSES.has(status);
}

/**
 * Determine whether an SSM step status represents in-progress work.
 *
 * @param status - Step execution status string
 * @returns Whether the status indicates in-progress
 */
function isStepInProgress(status: string): boolean {
    return IN_PROGRESS_STEP_STATUSES.has(status);
}

/**
 * Determine whether an execution status represents a failure.
 *
 * @param status - Automation execution status string
 * @returns Whether the status indicates failure
 */
function isExecutionFailure(status: string): boolean {
    return FAILURE_EXECUTION_STATUSES.has(status);
}

/**
 * Colour-code a status string based on its state.
 *
 * @param status - SSM status string (step or execution)
 * @returns ANSI-coloured status string
 */
function colourStatus(status: string): string {
    if (isStepFailure(status) || isExecutionFailure(status)) return log.red(status);
    if (isStepInProgress(status) || status === 'InProgress') return log.yellow(status);
    if (status === 'Success') return log.green(status);
    return status;
}

/**
 * Resolve the display icon for a step based on its status.
 *
 * @param status - Step execution status string
 * @returns ANSI-coloured icon character
 */
function resolveStepIcon(status: string): string {
    if (isStepFailure(status)) return log.red('✗');
    if (isStepInProgress(status)) return log.yellow('●');
    return log.green('✓');
}

/**
 * Format a duration between two dates into a human-readable string.
 *
 * @param start - Start timestamp
 * @param end - End timestamp (defaults to now)
 * @returns Formatted string (e.g. '2m 15s')
 */
function formatDuration(start: Date, end?: Date): string {
    const ms = (end ?? new Date()).getTime() - start.getTime();
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Safely parse a JSON string, returning the parsed value or the original string.
 *
 * @param value - String to attempt JSON parsing on
 * @returns Parsed object or the original string
 */
function safeParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

// ========================================
// Display Functions
// ========================================

/**
 * Print the execution metadata overview for a single automation execution.
 *
 * @param execution - SSM Automation execution metadata
 * @param index - 1-based index of the execution in the results
 * @param total - Total number of executions being inspected
 */
function printExecutionOverview(
    execution: AutomationExecutionMetadata,
    index: number,
    total: number,
): void {
    const status = execution.AutomationExecutionStatus ?? 'UNKNOWN';
    const startTime = execution.ExecutionStartTime?.toISOString() ?? 'N/A';
    const endTime = execution.ExecutionEndTime?.toISOString() ?? 'Still running';
    const duration = execution.ExecutionStartTime
        ? formatDuration(execution.ExecutionStartTime, execution.ExecutionEndTime)
        : 'N/A';

    console.log('');
    console.log(log.cyan(`  ╔══ Execution ${index}/${total} ════════════════════════════════════════`));
    console.log(`  ║  ID: ${execution.AutomationExecutionId}`);
    console.log(`  ║  Document: ${execution.DocumentName ?? 'N/A'}`);
    console.log(`  ║  Status: ${colourStatus(status)}`);
    console.log(`  ║  Started: ${startTime}`);
    console.log(`  ║  Ended: ${endTime}`);
    console.log(`  ║  Duration: ${duration}`);
    if (execution.FailureMessage) {
        const failureText = log.red('Failure: ' + execution.FailureMessage);
        console.log(`  ║  ${failureText}`);
    }
    if (execution.ExecutedBy) {
        console.log(`  ║  Executed By: ${execution.ExecutedBy}`);
    }
    console.log(log.cyan('  ╚════════════════════════════════════════════════════════'));
    console.log('');
}

/**
 * Print detailed step execution information.
 * Highlights failures with red status and failure messages.
 *
 * @param step - SSM step execution object
 * @param stepIndex - 1-based index of the step
 * @param totalSteps - Total number of steps
 */
function printStepDetail(
    step: StepExecution,
    stepIndex: number,
    totalSteps: number,
): void {
    const status = step.StepStatus ?? 'UNKNOWN';
    const statusIcon = resolveStepIcon(status);

    console.log(`  ${statusIcon}  Step ${stepIndex}/${totalSteps}: ${step.StepName} (${step.Action})`);
    console.log(`     Status: ${colourStatus(status)}`);

    if (step.ExecutionStartTime) {
        const duration = formatDuration(step.ExecutionStartTime, step.ExecutionEndTime);
        console.log(`     Duration: ${duration}`);
    }

    if (step.FailureMessage) {
        const failureText = log.red('Failure: ' + step.FailureMessage);
        console.log(`     ${failureText}`);
    }

    if (step.FailureDetails) {
        const failureType = log.red('Failure Type: ' + (step.FailureDetails.FailureType ?? 'Unknown'));
        console.log(`     ${failureType}`);
        if (step.FailureDetails.Details) {
            for (const [key, values] of Object.entries(step.FailureDetails.Details)) {
                const detailLabel = log.yellow(key + ':');
                console.log(`     ${detailLabel} ${values.join(', ')}`);
            }
        }
    }
}

/**
 * Print native SSM step outputs in a structured format.
 * Automatically parses JSON payloads for readability.
 *
 * @param step - SSM step execution object
 */
function printStepOutputs(step: StepExecution): void {
    if (!step.Outputs || Object.keys(step.Outputs).length === 0) return;

    console.log(`     ${log.cyan('Outputs:')}`);

    const parsedOutputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step.Outputs)) {
        if (Array.isArray(value)) {
            const parsedArray = value.map(safeParse);
            parsedOutputs[key] = parsedArray.length === 1 ? parsedArray[0] : parsedArray;
        } else {
            parsedOutputs[key] = value;
        }
    }

    console.dir(parsedOutputs, { depth: null, colors: true });
}

/**
 * Print the SSM native response payload for a step.
 *
 * @param step - SSM step execution object
 */
function printStepResponse(step: StepExecution): void {
    if (!step.Response) return;

    console.log(`     ${log.cyan('Response:')}`);
    const parsed = safeParse(step.Response);
    if (typeof parsed === 'object') {
        console.dir(parsed, { depth: null, colors: true });
    } else {
        console.log(`     ${step.Response}`);
    }
}

// ========================================
// Duration Parsing
// ========================================

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Supported suffixes:
 *   - `m`  — minutes  (e.g. `30m`  → 30 minutes)
 *   - `h`  — hours    (e.g. `24h`  → 24 hours)
 *   - `d`  — days     (e.g. `7d`   → 7 days)
 *
 * @param raw - Duration string (e.g. '24h', '48h', '7d', '30m')
 * @returns Duration in milliseconds
 * @throws {Error} If the format is unrecognised
 */
function parseSinceDuration(raw: string): number {
    const match = /^(\d+)(m|h|d)$/.exec(raw.trim().toLowerCase());
    if (!match) {
        throw new Error(
            `Invalid --since value: "${raw}". Expected format: <number><unit> where unit is m, h, or d (e.g. 24h, 7d, 30m).`,
        );
    }
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = {
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
    };
    return value * multipliers[unit];
}

// ========================================
// Log Group Resolution
// ========================================

/**
 * Resolve the CloudWatch log group for a given SSM document name.
 *
 * The SSM construct writes RunCommand output to two groups:
 *   - `<base>/bootstrap` — k8s-bootstrap-control-plane / k8s-bootstrap-worker
 *   - `<base>/deploy`    — k8s-dev-deploy-secrets (nextjs, monitoring, start-admin)
 *
 * When `--log-group` is given as a full path (contains a trailing segment after
 * the base), it is used as-is (explicit override). Otherwise the suffix is
 * derived from the document name.
 *
 * @param logGroupBase - Base path from config (e.g. `/ssm/k8s/development`)
 * @param logGroupOverride - Whether the user explicitly provided a full path
 * @param documentName - SSM Automation document name (e.g. `k8s-dev-deploy-secrets`)
 * @returns Full CloudWatch log group name
 */
function resolveLogGroup(
    logGroupBase: string,
    logGroupOverride: boolean,
    documentName: string | undefined,
): string {
    if (logGroupOverride) return logGroupBase;
    // Infer suffix from document name
    const nameLC = (documentName ?? '').toLowerCase();
    if (nameLC.includes('deploy')) return `${logGroupBase}/deploy`;
    if (nameLC.includes('bootstrap')) return `${logGroupBase}/bootstrap`;
    // Unknown document type — default to bootstrap for backwards compat
    return `${logGroupBase}/bootstrap`;
}

// ========================================
// Core Logic
// ========================================

/**
 * Discover CloudWatch log stream names for a RunCommand execution.
 *
 * The SSM Agent writes logs using the naming convention:
 *   `{commandId}/{instanceId}/aws-runShellScript/stdout`
 *
 * This function uses a prefix filter to discover all matching streams
 * rather than hard-coding the instance ID.
 *
 * @param cwlClient - CloudWatch Logs SDK client
 * @param commandId - SSM RunCommand command ID
 * @param logGroupName - CloudWatch Log Group name
 * @returns Array of matching stream names (stdout/stderr)
 */
async function discoverLogStreams(
    cwlClient: CloudWatchLogsClient,
    commandId: string,
    logGroupName: string,
): Promise<string[]> {
    const response = await cwlClient.send(
        new DescribeLogStreamsCommand({
            logGroupName,
            logStreamNamePrefix: `${commandId}/`,
            limit: 5,
        }),
    );
    return (response.logStreams ?? []).map((s) => s.logStreamName).filter(
        (name): name is string => typeof name === 'string',
    );
}

/**
 * Fetch CloudWatch logs for a RunCommand step and print them with full pagination.
 *
 * Paginates forward through all log events (500 per page) so long-running scripts
 * never get truncated. Returns the total number of lines printed.
 *
 * @param cwlClient - CloudWatch Logs SDK client
 * @param commandId - SSM RunCommand command ID
 * @param logGroupName - CloudWatch Log Group name
 * @returns Total number of log lines printed (0 = no streams / no events)
 */
async function fetchAndPrintCloudWatchLogs(
    cwlClient: CloudWatchLogsClient,
    commandId: string,
    logGroupName: string,
): Promise<number> {
    const fetchMessage = log.cyan(`Fetching CloudWatch logs (${logGroupName})...`);
    console.log(`     ${fetchMessage}`);
    try {
        // ── 1. Discover streams matching this command ID ─────────────────────
        const streamNames = await discoverLogStreams(cwlClient, commandId, logGroupName);
        if (streamNames.length === 0) {
            log.info('     No CloudWatch log streams found for this command ID.');
            return 0;
        }

        // ── 2. Paginate stdout stream (prefer stdout over stderr) ────────────
        const stdoutStream = streamNames.find((s) => s.endsWith('/stdout'));
        const targetStream = stdoutStream ?? streamNames[0];
        log.info(`     Stream: ${targetStream}`);

        let totalLines = 0;
        let nextToken: string | undefined;

        do {
            const page = await cwlClient.send(
                new GetLogEventsCommand({
                    logGroupName,
                    logStreamName: targetStream,
                    limit: 500,
                    startFromHead: true,
                    nextToken,
                }),
            );

            const events = page.events ?? [];
            for (const event of events) {
                console.log(`     ${log.blue('[CWL]')} ${event.message}`);
            }
            totalLines += events.length;

            // GetLogEvents uses nextForwardToken for pagination;
            // stop when the token doesn't change (API returns same token when exhausted).
            const nextForward = page.nextForwardToken;
            nextToken = nextForward !== nextToken ? nextForward : undefined;
        } while (nextToken);

        if (totalLines === 0) {
            log.info('     No CloudWatch log entries found for this stream.');
        }

        // ── 3. Check stderr stream and warn if it has content ────────────────
        const stderrStream = streamNames.find((s) => s.endsWith('/stderr'));
        if (stderrStream) {
            const stderrEvents = await cwlClient.send(
                new GetLogEventsCommand({
                    logGroupName,
                    logStreamName: stderrStream,
                    limit: 50,
                    startFromHead: false,
                }),
            );
            const stderrEntries = stderrEvents.events ?? [];
            if (stderrEntries.length > 0) {
                log.warn(`     Found ${stderrEntries.length} stderr entries:`);
                for (const event of stderrEntries) {
                    console.log(`     ${log.red('[STDERR]')} ${event.message}`);
                }
            }
        }

        return totalLines;
    } catch (err) {
        log.warn(`     Could not fetch CloudWatch logs: ${(err as Error).message}`);
        return 0;
    }
}

/**
 * Fallback: fetch full command output via GetCommandInvocation API.
 *
 * The SSM Automation step outputs are truncated to 2500 characters.
 * GetCommandInvocation returns the first 24,000 bytes of stdout/stderr directly
 * from the SSM service — no CloudWatch required.
 *
 * Use this when CloudWatch streams are not yet available or the log group
 * is misconfigured.
 *
 * @param ssmClient - SSM SDK client
 * @param commandId - SSM RunCommand command ID
 * @param instanceId - EC2 instance ID that executed the command
 * @returns Whether output was successfully fetched
 */
async function fetchCommandInvocationOutput(
    ssmClient: SSMClient,
    commandId: string,
    instanceId: string,
): Promise<boolean> {
    log.info(`     ${log.cyan('[Fallback]')} Fetching output via GetCommandInvocation...`);
    try {
        const response = await ssmClient.send(
            new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: instanceId,
                // PluginName scopes to the shell script output.
                // AWS-RunShellScript always uses 'aws:runShellScript' as the plugin.
                PluginName: 'aws:runShellScript',
            }),
        );

        const stdout = response.StandardOutputContent?.trim();
        const stderr = response.StandardErrorContent?.trim();
        const status = response.StatusDetails ?? 'Unknown';
        // SSM uploads the full output to S3 when it exceeds 24 KB.
        // A non-empty StandardOutputUrl is the signal that output was truncated.
        const outputUrl = response.StandardOutputUrl;

        console.log(`     ${log.cyan('[GetCommandInvocation]')} Status: ${colourStatus(status)}`);

        if (stdout) {
            for (const line of stdout.split('\n')) {
                console.log(`     ${log.blue('[STDOUT]')} ${line}`);
            }
            if (outputUrl) {
                log.warn(`     Output exceeded 24 KB — full output at: ${outputUrl}`);
                log.warn('     Enable CloudWatch logging (CloudWatchOutputEnabled: true) for unlimited output.');
            }
        } else {
            log.info('     No stdout content returned by GetCommandInvocation.');
        }

        if (stderr) {
            log.warn('     Stderr content:');
            for (const line of stderr.split('\n')) {
                console.log(`     ${log.red('[STDERR]')} ${line}`);
            }
        }

        return true;
    } catch (err) {
        const msg = (err as Error).message;
        // InvocationDoesNotExist means the command hasn't started or already expired (30 days)
        if (msg.includes('InvocationDoesNotExist') || msg.includes('does not exist')) {
            log.warn('     GetCommandInvocation: invocation record no longer exists (expired or pre-invocation).');
        } else {
            log.warn(`     GetCommandInvocation failed: ${msg}`);
        }
        return false;
    }
}

/**
 * Inspect a single SSM Automation execution in detail.
 * Fetches step-level data, outputs, failure reasons, and CloudWatch logs.
 *
 * ## Output strategy (in priority order):
 *   1. CloudWatch logs — full paginated output (500 events/page)
 *   2. GetCommandInvocation fallback — up to 24 KB when CWL has no streams
 *   3. Native SSM step outputs — always shown (may be truncated at 2500 chars)
 *
 * The CloudWatch log group is resolved automatically from the document name:
 *   - Document name containing 'deploy'    → `<base>/deploy`
 *   - Document name containing 'bootstrap' → `<base>/bootstrap`
 *
 * @param ssmClient - SSM SDK client
 * @param cwlClient - CloudWatch Logs SDK client
 * @param executionId - Automation execution ID
 * @param documentName - SSM Automation document name (used to resolve CW log group)
 * @param config - Script configuration
 */
async function inspectExecution(
    ssmClient: SSMClient,
    cwlClient: CloudWatchLogsClient,
    executionId: string,
    documentName: string | undefined,
    config: ScriptConfig,
): Promise<{ totalSteps: number; failedSteps: number }> {
    const resolvedLogGroup = resolveLogGroup(
        config.logGroupBase,
        config.logGroupOverride,
        documentName,
    );

    const executionDetail = await ssmClient.send(
        new GetAutomationExecutionCommand({
            AutomationExecutionId: executionId,
        }),
    );

    const steps = executionDetail.AutomationExecution?.StepExecutions ?? [];
    let failedSteps = 0;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepIndex = i + 1;

        printStepDetail(step, stepIndex, steps.length);

        // Fetch logs for aws:runCommand steps — CWL primary, GetCommandInvocation fallback
        if (step.Action === 'aws:runCommand' && step.Outputs?.['CommandId']) {
            const commandId = step.Outputs['CommandId'][0];

            // InstanceIds is a JSON-encoded array: '["i-0abc123"]'
            const rawInstanceIds = step.Outputs['InstanceIds']?.[0] ?? '';
            let instanceId: string | undefined;
            try {
                const parsed = JSON.parse(rawInstanceIds) as unknown;
                instanceId = Array.isArray(parsed) ? (parsed[0] as string) : rawInstanceIds || undefined;
            } catch {
                instanceId = rawInstanceIds || undefined;
            }

            log.info(`     RunCommand ID: ${commandId}`);
            log.info(`     Instance ID:   ${instanceId ?? '(unknown)'}`);
            log.info(`     CW Log Group:  ${resolvedLogGroup}`);

            // Primary: CloudWatch logs (full paginated output)
            const cwlLines = await fetchAndPrintCloudWatchLogs(cwlClient, commandId, resolvedLogGroup);

            // Fallback: GetCommandInvocation when CWL has no streams yet
            // (e.g. CloudWatchOutputEnabled was just added, or streams haven't flushed)
            if (cwlLines === 0 && instanceId) {
                await fetchCommandInvocationOutput(ssmClient, commandId, instanceId);
            } else if (cwlLines === 0) {
                log.warn('     No CWL output and no instance ID — cannot use GetCommandInvocation fallback.');
            }
        }

        // Print native SSM outputs and responses (always shown, may be truncated)
        printStepOutputs(step);
        printStepResponse(step);

        if (isStepFailure(step.StepStatus ?? '')) {
            failedSteps++;
        }

        console.log('');
    }

    return { totalSteps: steps.length, failedSteps };
}

// ========================================
// Main
// ========================================

/**
 * Entry point: queries SSM Automation executions, inspects each in detail,
 * and produces a structured summary with colour-coded output.
 */
async function main(): Promise<void> {
    const logFile = startFileLogging('ssm-automation');
    const awsConfig = buildAwsConfig(args);
    const auth = resolveAuth(awsConfig.profile);

    const sinceRaw = (args['since'] as string) ?? '24h';
    const sinceMs = parseSinceDuration(sinceRaw);

    const rawLogGroup = args['log-group'] as string;
    const defaultLogGroupBase = '/ssm/k8s/development';
    // Detect explicit override: user passed a value different from the default
    const logGroupOverride = rawLogGroup !== defaultLogGroupBase;

    const config: ScriptConfig = {
        maxResults: Math.min(Number.parseInt(args['last'] as string, 10), 50),
        logGroupBase: rawLogGroup,
        logGroupOverride,
        statusFilters: (args.status as string).split(',').map((s) => s.trim()),
        runbookPrefix: args.runbook ? (args.runbook as string) : undefined,
        sinceMs,
    };

    log.header('  SSM Automation Troubleshooter');
    log.config('Configuration', {
        'Auth': auth.mode,
        'Region': awsConfig.region,
        'Status Filter': config.statusFilters.join(', '),
        'Runbook Filter': config.runbookPrefix ?? '(all)',
        'Max Executions': String(config.maxResults),
        'Since': `${sinceRaw} (from ${new Date(Date.now() - config.sinceMs).toISOString()})`,
        'CW Log Group': logGroupOverride
            ? rawLogGroup
            : `${rawLogGroup}/bootstrap|deploy (auto-detected per execution)`,
    });

    const ssmClient = new SSMClient({
        region: awsConfig.region,
        credentials: awsConfig.credentials,
    });
    const cwlClient = new CloudWatchLogsClient({
        region: awsConfig.region,
        credentials: awsConfig.credentials,
    });

    // ─── Step 1: Build API filters ────────────────────────────────────────
    log.step(1, 3, 'Querying SSM Automation executions...');

    // The SSM API supports StartTimeAfter / StartTimeBefore as Filter keys — confirmed in
    // the SDK type definitions (DescribeAutomationExecutionsCommand.d.ts).
    type AutomationFilter = { Key: string; Values: string[] };
    const filters: AutomationFilter[] = [];

    if (config.runbookPrefix) {
        filters.push({
            Key: 'DocumentNamePrefix',
            Values: [config.runbookPrefix],
        });
    }

    if (config.statusFilters.length > 0) {
        filters.push({
            Key: 'ExecutionStatus',
            Values: config.statusFilters,
        });
    }

    // Scope results to the --since window.
    const startTimeFilter = new Date(Date.now() - config.sinceMs);
    filters.push({
        Key: 'StartTimeAfter',
        Values: [startTimeFilter.toISOString()],
    });

    const describeResponse = await ssmClient.send(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new DescribeAutomationExecutionsCommand({
            MaxResults: config.maxResults,
            Filters: filters as any,
        }),
    );

    const executions = describeResponse.AutomationExecutionMetadataList ?? [];

    if (executions.length === 0) {
        log.warn(
            `No executions found matching status [${config.statusFilters.join(', ')}] in the last ${sinceRaw}.`,
        );
        log.nextSteps([
            `Broaden the time window:  --since 48h  or  --since 7d`,
            `Broaden the status filter: --status Success,Failed,TimedOut`,
            'Remove the runbook filter to search across all documents',
            'Check the AWS Console → Systems Manager → Automation for recent executions',
        ]);
        stopFileLogging();
        return;
    }

    log.success(`Found ${executions.length} execution(s)`);
    console.log('');

    // ─── Step 2: Inspect each execution ───────────────────────────────────
    log.step(2, 3, `Inspecting ${executions.length} execution(s)...`);

    let totalFailedSteps = 0;
    let totalStepsInspected = 0;

    for (let i = 0; i < executions.length; i++) {
        const execution = executions[i];
        printExecutionOverview(execution, i + 1, executions.length);

        const executionId = execution.AutomationExecutionId;
        if (!executionId) {
            log.warn('  Execution has no ID — skipping.');
            continue;
        }

        const result = await inspectExecution(
            ssmClient,
            cwlClient,
            executionId,
            execution.DocumentName,
            config,
        );
        totalStepsInspected += result.totalSteps;
        totalFailedSteps += result.failedSteps;
    }

    // ─── Step 3: Summary ──────────────────────────────────────────────────
    log.step(3, 3, 'Generating summary...');

    const failedExecutions = executions.filter((e) =>
        isExecutionFailure(e.AutomationExecutionStatus ?? ''),
    );

    log.summary('SSM Automation Troubleshoot Complete', {
        'Executions Inspected': String(executions.length),
        'Failed Executions': String(failedExecutions.length),
        'Total Steps Inspected': String(totalStepsInspected),
        'Failed Steps': String(totalFailedSteps),
        'Status Filter': config.statusFilters.join(', '),
        'Runbook Filter': config.runbookPrefix ?? '(all)',
    });

    if (failedExecutions.length > 0) {
        console.log(log.red('  Failed Execution IDs:'));
        for (const exec of failedExecutions) {
            const failureMsg = exec.FailureMessage ? ` — ${exec.FailureMessage}` : '';
            console.log(log.red(`    • ${exec.AutomationExecutionId}${failureMsg}`));
        }
        console.log('');
    }

    stopFileLogging();
    log.info(`\nLog saved to: ${logFile}`);
}

main().catch((error: Error) => {
    log.fatal(`SSM Automation troubleshoot failed: ${error.message}`);
});
