/**
 * @format
 * SSM Automation Runtime — Post-Deployment Integration Test
 *
 * Validates that SSM Automation documents executed on the correct
 * EC2 instances and that those instances are healthy.
 *
 * Two focused concerns:
 *   1. Instance Targeting — the latest SSM Automation execution for
 *      each role targeted the instance tagged with that role.
 *   2. Instance Health — each K8s instance is running (EC2) and
 *      reachable via SSM Agent (Online status).
 *
 * All assertions pass vacuously when no instances or executions
 * exist (e.g. first deploy, no ASG launches yet).
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/ssm-automation-runtime development --verbose
 */

import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeInstanceStatusCommand,
} from '@aws-sdk/client-ec2';
import type { Instance, InstanceStatus } from '@aws-sdk/client-ec2';
import {
    SSMClient,
    GetAutomationExecutionCommand,
    GetCommandInvocationCommand,
    DescribeInstanceInformationCommand,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';
import type {
    AutomationExecution,
    InstanceInformation,
    StepExecution,
} from '@aws-sdk/client-ssm';

import type { Environment } from '../../../lib/config';
import { k8sSsmPrefix } from '../../../lib/config/ssm-paths';

/**
 * Vacuous-pass sentinel.
 *
 * Integration tests use this to indicate that an assertion cannot be
 * evaluated because the prerequisite resource does not exist yet
 * (e.g. no EC2 instance launched, no SSM execution). The test passes
 * with a console warning instead of silently returning early inside
 * the `it()` body (which violates jest/no-conditional-in-test).
 */
const VACUOUS = 'VACUOUS_PASS' as const;


// =============================================================================
// Configuration — Named Constants (Rule 3)
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PREFIX = k8sSsmPrefix(CDK_ENV);


/** EC2 tag used by compute stacks to identify K8s bootstrap role */
const BOOTSTRAP_ROLE_TAG = 'k8s:bootstrap-role';

/** EC2 instance state expected for healthy nodes */
const EXPECTED_INSTANCE_STATE = 'running';

/** SSM Agent expected ping status */
const EXPECTED_SSM_STATUS = 'Online';

/** EC2 status check expected value */
const EXPECTED_STATUS_CHECK = 'ok';

/**
 * Maximum number of output lines to show inline in CI logs.
 * The full output is always available via the CloudWatch Logs link.
 */
const MAX_INLINE_OUTPUT_LINES = 80;

/** CloudWatch log group path template for bootstrap SSM commands */
const CW_LOG_GROUP_BOOTSTRAP = `/ssm${PREFIX}/bootstrap`;

/** SSM Automation execution status indicating success */
const EXECUTION_STATUS_SUCCESS = 'Success';

/**
 * SSM Automation execution statuses that indicate a failure.
 * The test reports the specific terminal status for post-mortem analysis.
 */
const EXECUTION_FAILURE_STATUSES = new Set([
    'Failed',
    'Cancelled',
    'TimedOut',
    'CompletedWithFailure',
]);

/**
 * All terminal SSM Automation execution statuses.
 *
 * An execution in one of these states has stopped; all other statuses
 * (InProgress, Waiting, Cancelling…) are transient and require polling.
 */
const EXECUTION_TERMINAL_STATUSES = new Set([
    EXECUTION_STATUS_SUCCESS,
    ...EXECUTION_FAILURE_STATUSES,
]);

/**
 * Maximum wall-clock time (ms) to wait for an automation to reach a
 * terminal status before reporting the in-progress status as-is.
 *
 * Set to 24 minutes — comfortably under the verify-bootstrap workflow
 * job cap of 30 minutes, leaving headroom for the beforeAll to finish.
 */
const AUTOMATION_POLL_TIMEOUT_MS = 24 * 60 * 1_000;

/** Poll interval (ms) between GetAutomationExecution API calls */
const AUTOMATION_POLL_INTERVAL_MS = 15_000;

// AWS SDK clients
const ec2 = new EC2Client({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// =============================================================================
// Types
// =============================================================================

/** Bootstrap role definition for test iteration */
interface BootstrapRole {
    /** Human-readable label for test titles */
    label: string;
    /** Value of the k8s:bootstrap-role EC2 tag */
    role: string;
    /** SSM parameter path for the automation document name */
    docNameParam: string;
    /** SSM parameter path where trigger-bootstrap.ts publishes the execution ID */
    execParam: string;
}

/** Cached data per role, populated in beforeAll */
interface RoleData {
    /** EC2 instance matching this role (if any) */
    instance?: Instance;
    /** EC2 status check result (if instance exists) */
    instanceStatus?: InstanceStatus;
    /** SSM Agent info for this instance (if any) */
    ssmInfo?: InstanceInformation;
    /** Instance ID that the latest SSM Automation execution targeted */
    automationTargetInstanceId?: string;
    /** The k8s:bootstrap-role tag value of the automation-targeted instance */
    automationTargetRole?: string;
    /** Full SSM Automation execution detail (for status + step diagnostics) */
    automationExecution?: AutomationExecution;
}

// =============================================================================
// Test Targets — All 4 Bootstrap Roles
// =============================================================================

// =============================================================================
// Test Targets — Bootstrap Roles (legacy + new ASG pools)
//
// Legacy roles (app-worker, mon-worker, argocd-worker) are retained during the
// migration window. Once those stacks are decommissioned, these entries should
// be removed.
//
// New ASG pool roles (general-pool, monitoring-pool) use `general-pool-instance-id`
// and `monitoring-pool-instance-id` SSM parameters published by worker-asg-stack.ts.
// =============================================================================

const BOOTSTRAP_ROLES: BootstrapRole[] = [
    {
        label: 'Control Plane',
        role: 'control-plane',
        docNameParam: `${PREFIX}/bootstrap/control-plane-doc-name`,
        execParam: `${PREFIX}/bootstrap/execution-id`,
    },
    // ── Legacy pet-model nodes (to be removed after decommission) ─────────
    {
        label: 'App Worker (legacy)',
        role: 'app-worker',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
        execParam: `${PREFIX}/bootstrap/worker-execution-id`,
    },
    {
        label: 'Mon Worker (legacy)',
        role: 'mon-worker',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
        execParam: `${PREFIX}/bootstrap/mon-worker-execution-id`,
    },
    {
        label: 'ArgoCD Worker (legacy)',
        role: 'argocd-worker',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
        execParam: `${PREFIX}/bootstrap/argocd-worker-execution-id`,
    },
    // ── New cattle-model ASG pools ─────────────────────────────────────────
    {
        label: 'General Pool',
        role: 'general-pool',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
        execParam: `${PREFIX}/bootstrap/general-pool-execution-id`,
    },
    {
        label: 'Monitoring Pool',
        role: 'monitoring-pool',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
        execParam: `${PREFIX}/bootstrap/monitoring-pool-execution-id`,
    },
];

// =============================================================================
// Helpers (module-level — Rule 10)
// =============================================================================

/**
 * Fetch a single SSM parameter value.
 * Returns undefined if the parameter does not exist.
 */
async function getParam(name: string): Promise<string | undefined> {
    try {
        const result = await ssm.send(new GetParameterCommand({ Name: name }));
        return result.Parameter?.Value;
    } catch {
        return undefined;
    }
}

/**
 * Find the running EC2 instance tagged with a specific bootstrap role.
 * Returns undefined if no instance exists for this role.
 */
async function findInstanceByRole(role: string): Promise<Instance | undefined> {
    const { Reservations } = await ec2.send(
        new DescribeInstancesCommand({
            Filters: [
                { Name: `tag:${BOOTSTRAP_ROLE_TAG}`, Values: [role] },
                { Name: 'instance-state-name', Values: [EXPECTED_INSTANCE_STATE] },
            ],
        }),
    );

    const instances = (Reservations ?? []).flatMap((r) => r.Instances ?? []);
    return instances[0];
}

/**
 * Get EC2 status checks for a specific instance.
 */
async function getInstanceStatus(instanceId: string): Promise<InstanceStatus | undefined> {
    const { InstanceStatuses } = await ec2.send(
        new DescribeInstanceStatusCommand({
            InstanceIds: [instanceId],
        }),
    );

    return InstanceStatuses?.[0];
}

/**
 * Get SSM Agent connection status for a specific instance.
 */
async function getSsmAgentInfo(instanceId: string): Promise<InstanceInformation | undefined> {
    const { InstanceInformationList } = await ssm.send(
        new DescribeInstanceInformationCommand({
            Filters: [
                { Key: 'InstanceIds', Values: [instanceId] },
            ],
        }),
    );

    return InstanceInformationList?.[0];
}

/**
 * Fetch the full SSM Automation execution for a given role.
 *
 * Reads the execution ID from the role-specific SSM parameter
 * (published by trigger-bootstrap.ts), then fetches the full
 * execution detail including status, parameters, and step data.
 *
 * Returns undefined if no execution ID exists for this role.
 */
async function getAutomationExecution(
    execParam: string,
): Promise<AutomationExecution | undefined> {
    const execId = await getParam(execParam);
    if (!execId) return undefined;

    const detail = await ssm.send(
        new GetAutomationExecutionCommand({ AutomationExecutionId: execId }),
    );

    return detail.AutomationExecution ?? undefined;
}

/**
 * Poll an SSM Automation execution until it reaches a terminal status.
 *
 * SSM Automation runs asynchronously — by the time the CI verify job
 * calls GetAutomationExecution the document may still be InProgress.
 * This helper retries at {@link AUTOMATION_POLL_INTERVAL_MS} intervals
 * until the execution is terminal or {@link AUTOMATION_POLL_TIMEOUT_MS}
 * elapses, at which point it returns the most-recent snapshot.
 *
 * @param execution - Initial execution snapshot (may be in any status)
 * @returns Refreshed execution snapshot in a terminal status (or the
 *          most-recent snapshot if the timeout was reached)
 */
async function waitForTerminalStatus(
    execution: AutomationExecution,
): Promise<AutomationExecution> {
    const execId = execution.AutomationExecutionId;
    if (!execId) return execution;

    let current = execution;
    const deadline = Date.now() + AUTOMATION_POLL_TIMEOUT_MS;

    while (!EXECUTION_TERMINAL_STATUSES.has(current.AutomationExecutionStatus ?? '')) {
        if (Date.now() >= deadline) {
            console.warn(
                `[TIMEOUT] Execution ${execId} still '${current.AutomationExecutionStatus}' ` +
                `after ${AUTOMATION_POLL_TIMEOUT_MS / 60_000}m — reporting current status as-is`,
            );
            break;
        }

        console.log(
            `[WAITING] ${execId} status: '${current.AutomationExecutionStatus}' — ` +
            `polling again in ${AUTOMATION_POLL_INTERVAL_MS / 1_000}s`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, AUTOMATION_POLL_INTERVAL_MS));

        const refreshed = await ssm.send(
            new GetAutomationExecutionCommand({ AutomationExecutionId: execId }),
        );
        current = refreshed.AutomationExecution ?? current;
    }

    return current;
}

/**
 * Resolve the k8s:bootstrap-role tag for a given instance ID.
 *
 * Works for both running and recently-terminated instances because
 * EC2 retains tags on terminated instances for a short period.
 * Returns undefined if the instance or tag cannot be found.
 */
async function getInstanceBootstrapRole(instanceId: string): Promise<string | undefined> {
    try {
        const { Reservations } = await ec2.send(
            new DescribeInstancesCommand({
                InstanceIds: [instanceId],
            }),
        );

        const instance = (Reservations ?? []).flatMap((r) => r.Instances ?? [])[0];
        const tag = (instance?.Tags ?? []).find((t) => t.Key === BOOTSTRAP_ROLE_TAG);
        return tag?.Value;
    } catch {
        // Instance may have been fully cleaned up
        return undefined;
    }
}

// =============================================================================
// Execution result cache — populated in beforeAll
// =============================================================================

const roleDataMap = new Map<string, RoleData>();

/**
 * Fetch the full command output via GetCommandInvocation.
 *
 * SSM's `FailureMessage` truncates output to ~2500 characters, making
 * it nearly impossible to diagnose bootstrap failures from CI logs.
 * This function fetches the complete stdout/stderr (up to 24KB each)
 * for the underlying `aws:runCommand` step.
 *
 * @param commandId - The SSM RunCommand ID from the step's Outputs
 * @param instanceId - The target EC2 instance ID
 * @returns Object with stdout, stderr, and the response code
 */
async function getFullCommandOutput(
    commandId: string,
    instanceId: string,
): Promise<{ stdout: string; stderr: string; responseCode: string } | undefined> {
    try {
        const result = await ssm.send(new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
        }));
        return {
            stdout: result.StandardOutputContent ?? '',
            stderr: result.StandardErrorContent ?? '',
            responseCode: String(result.ResponseCode ?? 'unknown'),
        };
    } catch {
        return undefined;
    }
}

/**
 * Build a CloudWatch Logs Insights console URL for a specific command.
 *
 * Generates a direct link to the CloudWatch Logs console filtered to the
 * log stream for the failed SSM RunCommand invocation. This provides
 * access to the completely untruncated output regardless of size.
 *
 * @param commandId - SSM RunCommand ID
 * @param instanceId - EC2 instance ID
 * @returns Direct URL to the CloudWatch Logs console
 */
function buildCloudWatchLink(commandId: string, instanceId: string): string {
    // SSM RunCommand creates log streams with the format: <command-id>/<instance-id>/aws-runShellScript/stdout
    const logStream = `${commandId}/${instanceId}/aws-runShellScript/stdout`;
    const encodedGroup = encodeURIComponent(CW_LOG_GROUP_BOOTSTRAP);
    const encodedStream = encodeURIComponent(logStream);
    return `https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}` +
        `#logsV2:log-groups/log-group/${encodedGroup}/log-events/${encodedStream}`;
}

/**
 * Extract the last N lines from a multi-line string.
 * Helps keep CI output readable while showing the most relevant failure context.
 */
function lastNLines(text: string, n: number): string {
    const lines = text.split('\n');
    if (lines.length <= n) return text;
    return `... (${lines.length - n} lines truncated, see CloudWatch link below) ...\n` +
        lines.slice(-n).join('\n');
}

// =============================================================================
// Tests
// =============================================================================

describe('SSM Automation Runtime — Instance Targeting & Health', () => {
    // ── Global Setup — fetch all data, zero API calls in it() blocks ─────
    beforeAll(async () => {
        for (const target of BOOTSTRAP_ROLES) {
            const data: RoleData = {};

            // 1. Find the EC2 instance for this role
            data.instance = await findInstanceByRole(target.role);

            if (data.instance?.InstanceId) {
                const instanceId = data.instance.InstanceId;

                // 2. EC2 status checks
                data.instanceStatus = await getInstanceStatus(instanceId);

                // 3. SSM Agent status
                data.ssmInfo = await getSsmAgentInfo(instanceId);
            }

            // 4. SSM Automation execution — full detail for status + targeting
            //    Uses the role-specific execution-ID SSM parameter to avoid
            //    shared-doc-name ambiguity between workers.
            data.automationExecution = await getAutomationExecution(
                target.execParam,
            );

            // 5. If the execution is still in progress, poll until it reaches
            //    a terminal status. This prevents the test from failing due to
            //    a race condition between the CI pipeline and SSM Automation.
            if (data.automationExecution) {
                data.automationExecution = await waitForTerminalStatus(
                    data.automationExecution,
                );
            }

            // 6. Extract the target instance ID from the execution
            data.automationTargetInstanceId =
                data.automationExecution?.Parameters?.['InstanceId']?.[0];

            // 7. Resolve the bootstrap-role tag of the targeted instance
            //    (works even if the instance was terminated by ASG)
            if (data.automationTargetInstanceId) {
                data.automationTargetRole = await getInstanceBootstrapRole(
                    data.automationTargetInstanceId,
                );
            }

            roleDataMap.set(target.label, data);
        }
    }, 25 * 60 * 1_000); // 25 minutes: 6 roles × up to 24m polling + API overhead

    // =====================================================================
    // Instance Targeting — SSM Automation ran on the correct instance
    // =====================================================================
    describe.each(BOOTSTRAP_ROLES)(
        'Targeting — $label',
        (target) => {
            let automationTargetRole: string | typeof VACUOUS;
            let expectedRole: string | typeof VACUOUS;

            // Depends on: roleDataMap populated in top-level beforeAll
            beforeAll(() => {
                const data = roleDataMap.get(target.label) ?? {};
                automationTargetRole = data.automationTargetRole ?? VACUOUS;
                // Pre-compute expected value: if no execution data exists
                // (vacuous), expect VACUOUS; otherwise expect the role tag.
                expectedRole = automationTargetRole === VACUOUS ? VACUOUS : target.role;
            });

            it('should have targeted the instance tagged with the correct role', () => {
                // Vacuous pass when no execution or no instance exists.
                // When ASG replaces an instance after the last bootstrap run,
                // the automation's target instance ID will differ from the
                // current running instance — but the tag must still match.
                expect(automationTargetRole).toBe(expectedRole);
            });
        },
    );

    // =====================================================================
    // Execution Status — SSM Automation completed successfully
    //
    // Validates that the latest SSM Automation execution for each role
    // reached a terminal 'Success' status. Reports the specific failure
    // status (TimedOut, Failed, etc.) for post-mortem analysis.
    // =====================================================================
    describe.each(BOOTSTRAP_ROLES)(
        'Execution Status — $label',
        (target) => {
            let executionStatus: string | typeof VACUOUS;
            let executionId: string | typeof VACUOUS;
            let failedStepsDiagnostic: string;

            // Depends on: roleDataMap populated in top-level beforeAll
            beforeAll(async () => {
                const data = roleDataMap.get(target.label) ?? {};
                executionStatus = data.automationExecution?.AutomationExecutionStatus ?? VACUOUS;
                executionId = data.automationExecution?.AutomationExecutionId ?? VACUOUS;

                // Pre-compute failure diagnostics (outside it() per jest/no-conditional-in-test)
                if (executionStatus !== VACUOUS && EXECUTION_FAILURE_STATUSES.has(executionStatus)) {
                    const failedSteps = (data.automationExecution?.StepExecutions ?? [])
                        .filter((s: StepExecution) => s.StepStatus === 'Failed');

                    // Resolve the target instance ID for this execution
                    const targetInstanceId =
                        data.automationExecution?.Parameters?.InstanceId?.[0]
                        ?? data.instance?.InstanceId;

                    // Build diagnostic lines with full command output
                    const diagnosticParts: string[] = [];

                    for (const step of failedSteps) {
                        const stepName = step.StepName ?? 'unknown';
                        diagnosticParts.push(`\n${'═'.repeat(72)}`);
                        diagnosticParts.push(`  FAILED STEP: ${stepName}`);
                        diagnosticParts.push(`${'═'.repeat(72)}`);

                        // Extract CommandId from step outputs (SSM stores it as aws:runCommand output)
                        const commandId = step.Outputs?.['CommandId']?.[0]
                            ?? step.Outputs?.['RunCommandOutput']?.[0];

                        if (commandId && targetInstanceId) {
                            // Fetch full, untruncated output via GetCommandInvocation
                            const fullOutput = await getFullCommandOutput(commandId, targetInstanceId);

                            if (fullOutput) {
                                diagnosticParts.push(`\n  Response code: ${fullOutput.responseCode}`);
                                diagnosticParts.push(`\n  ── stdout (last ${MAX_INLINE_OUTPUT_LINES} lines) ──`);
                                diagnosticParts.push(lastNLines(fullOutput.stdout, MAX_INLINE_OUTPUT_LINES));

                                if (fullOutput.stderr.trim()) {
                                    diagnosticParts.push(`\n  ── stderr (last ${MAX_INLINE_OUTPUT_LINES} lines) ──`);
                                    diagnosticParts.push(lastNLines(fullOutput.stderr, MAX_INLINE_OUTPUT_LINES));
                                }
                            } else {
                                diagnosticParts.push(
                                    `\n  ⚠ Could not fetch full output (CommandId: ${commandId})`,
                                );
                            }

                            // Always provide CloudWatch link for complete, untruncated output
                            diagnosticParts.push(`\n  📋 Full output (CloudWatch Logs):`);
                            diagnosticParts.push(`     ${buildCloudWatchLink(commandId, targetInstanceId)}`);
                        } else {
                            // Fallback to truncated FailureMessage if CommandId unavailable
                            diagnosticParts.push(`\n  FailureMessage (truncated by SSM):`);
                            diagnosticParts.push(`    ${step.FailureMessage ?? 'unknown'}`);
                            diagnosticParts.push(
                                `\n  ⚠ CommandId not found in step outputs — check CloudWatch manually:`,
                            );
                            diagnosticParts.push(
                                `     Log group: ${CW_LOG_GROUP_BOOTSTRAP}`,
                            );
                        }
                    }

                    failedStepsDiagnostic = diagnosticParts.join('\n');

                    console.error(
                        `[FAILED] ${target.label} automation ${executionStatus}${failedStepsDiagnostic}`,
                    );
                } else {
                    failedStepsDiagnostic = '';
                }

                if (executionStatus === VACUOUS) {
                    console.warn(
                        `[VACUOUS] No execution found for ${target.label} — skipping`,
                    );
                }
            });

            it('should have completed with Success status', () => {
                // Log execution context for CI diagnostics
                console.log(
                    `[${target.label}] Execution: ${executionId}, Status: ${executionStatus}`,
                );

                expect([EXECUTION_STATUS_SUCCESS, VACUOUS]).toContain(executionStatus);
            });
        },
    );

    // =====================================================================
    // Instance Health — EC2 running + status checks + SSM Agent online
    // =====================================================================
    describe.each(BOOTSTRAP_ROLES)(
        'Health — $label',
        (target) => {
            let instanceState: string | typeof VACUOUS;
            let instanceStatusCheck: string | typeof VACUOUS;
            let systemStatusCheck: string | typeof VACUOUS;
            let ssmPingStatus: string | typeof VACUOUS;

            // Depends on: roleDataMap populated in top-level beforeAll
            beforeAll(() => {
                const data = roleDataMap.get(target.label) ?? {};
                instanceState = data.instance?.State?.Name ?? VACUOUS;
                instanceStatusCheck = data.instanceStatus?.InstanceStatus?.Status ?? VACUOUS;
                systemStatusCheck = data.instanceStatus?.SystemStatus?.Status ?? VACUOUS;
                ssmPingStatus = data.ssmInfo?.PingStatus ?? VACUOUS;
            });

            it('should have a running EC2 instance', () => {
                expect([EXPECTED_INSTANCE_STATE, VACUOUS]).toContain(instanceState);
            });

            it('should have passing EC2 status checks', () => {
                expect([EXPECTED_STATUS_CHECK, VACUOUS]).toContain(instanceStatusCheck);
                expect([EXPECTED_STATUS_CHECK, VACUOUS]).toContain(systemStatusCheck);
            });

            it('should have SSM Agent online', () => {
                expect([EXPECTED_SSM_STATUS, VACUOUS]).toContain(ssmPingStatus);
            });
        },
    );
});
