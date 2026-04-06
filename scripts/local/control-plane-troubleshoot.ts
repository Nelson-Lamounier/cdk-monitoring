#!/usr/bin/env tsx
/**
 * Control Plane Troubleshooter
 *
 * Comprehensive diagnostic and recovery script for Kubernetes control plane
 * failures after ASG instance replacement. Runs locally via SSM and provides
 * a detailed overview of:
 *
 *  1. **Infrastructure** — SSM parameters, instance metadata, EBS volume state
 *  2. **Automation** — SSM Automation execution history and failure analysis
 *  3. **DR Restore** — Backup artefacts, certificate SANs vs current IPs
 *  4. **Kubernetes** — API server health, node status, pod state, Calico/CNI,
 *     kubelet logs, and kubeadm-config validation
 *
 * Each phase issues a pass/fail verdict and the script produces a consolidated
 * summary with root cause analysis and recommended next steps.
 *
 * Usage:
 *   npx tsx scripts/local/control-plane-troubleshoot.ts
 *   npx tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account --fix
 *   npx tsx scripts/local/control-plane-troubleshoot.ts --help
 *
 * @module control-plane-troubleshoot
 */

import {
    SSMClient,
    GetParameterCommand,
    SendCommandCommand,
    GetCommandInvocationCommand,
    DescribeAutomationExecutionsCommand,
    GetAutomationExecutionCommand,
} from '@aws-sdk/client-ssm';
import type {
    AutomationExecutionMetadata,
    StepExecution,
} from '@aws-sdk/client-ssm';
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeVolumesCommand,
} from '@aws-sdk/client-ec2';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import * as log from '../lib/logger.js';
import { startFileLogging, stopFileLogging } from '../lib/logger.js';
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js';

// ============================================================================
// CLI Arguments
// ============================================================================

const args = parseArgs(
    [
        { name: 'profile', description: 'AWS CLI profile', hasValue: true },
        { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
        { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
        { name: 'fix', description: 'Attempt automatic certificate and config repair', hasValue: false, default: false },
        { name: 'last', description: 'Number of SSM Automation executions to inspect', hasValue: true, default: '3' },
        { name: 'skip-k8s', description: 'Skip Kubernetes cluster diagnostics (useful if instance is unreachable)', hasValue: false, default: false },
    ],
    'Control Plane Troubleshooter — diagnose and optionally repair K8s control plane after ASG replacement',
);

// ============================================================================
// Constants
// ============================================================================

/** Pod network CIDR expected in kubeadm-config */
const EXPECTED_POD_CIDR = '192.168.0.0/16';

/** Maximum seconds to wait for an SSM command to complete */
const SSM_COMMAND_TIMEOUT_SECONDS = 120;

/** Poll interval when waiting for SSM commands */
const SSM_POLL_INTERVAL_MS = 3_000;

/** Statuses that indicate SSM Automation failure */
const FAILURE_STATUSES: ReadonlySet<string> = new Set(['Failed', 'TimedOut', 'Cancelled']);

// ============================================================================
// Types
// ============================================================================

/** Structured result from a single diagnostic check */
interface CheckResult {
    /** Human-readable check name */
    name: string;
    /** Whether the check passed */
    passed: boolean;
    /** Details about the check result */
    detail: string;
    /** Raw output for debugging */
    raw?: string;
    /** Severity level for failures */
    severity?: 'critical' | 'warning' | 'info';
}

/** SSM parameters map for the control plane */
interface ControlPlaneParams {
    instanceId: string;
    controlPlaneEndpoint?: string;
    privateIp?: string;
    publicIp?: string;
    amiId?: string;
    k8sVersion?: string;
}

/** Instance metadata retrieved via IMDS */
interface InstanceMetadata {
    privateIp: string;
    publicIp: string;
    instanceId: string;
    availabilityZone: string;
    instanceType: string;
}

/** Consolidated diagnostic report */
interface DiagnosticReport {
    timestamp: string;
    environment: string;
    instanceId: string;
    checks: CheckResult[];
    metadata?: InstanceMetadata;
    automationFailures: string[];
    recommendations: string[];
}

// ============================================================================
// AWS Client Factory
// ============================================================================

/**
 * Create pre-configured AWS SDK clients for the target region and credentials.
 *
 * @param region - AWS region
 * @param credentials - Optional credential provider
 * @returns Object containing all required SDK clients
 */
function createClients(
    region: string,
    credentials?: AwsCredentialIdentityProvider,
): {
    ssm: SSMClient;
    ec2: EC2Client;
    asg: AutoScalingClient;
} {
    const config = { region, credentials };
    return {
        ssm: new SSMClient(config),
        ec2: new EC2Client(config),
        asg: new AutoScalingClient(config),
    };
}

// ============================================================================
// SSM Remote Execution Helpers
// ============================================================================

/**
 * Execute a shell command on a remote EC2 instance via SSM RunCommand.
 * Waits for completion and returns the stdout/stderr output.
 *
 * @param ssm - SSM SDK client
 * @param instanceId - Target EC2 instance ID
 * @param commands - Shell commands to execute
 * @param timeoutSeconds - Maximum wait time before returning
 * @returns Object with status, stdout, and stderr
 */
async function runOnInstance(
    ssm: SSMClient,
    instanceId: string,
    commands: string[],
    timeoutSeconds = SSM_COMMAND_TIMEOUT_SECONDS,
): Promise<{ status: string; stdout: string; stderr: string }> {
    const sendResult = await ssm.send(
        new SendCommandCommand({
            InstanceIds: [instanceId],
            DocumentName: 'AWS-RunShellScript',
            TimeoutSeconds: timeoutSeconds,
            Parameters: { commands },
        }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) {
        throw new Error('SSM SendCommand returned no CommandId');
    }

    // Poll until the command completes
    const maxAttempts = Math.ceil((timeoutSeconds * 1000) / SSM_POLL_INTERVAL_MS);
    let status = 'InProgress';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(SSM_POLL_INTERVAL_MS);

        try {
            const invocation = await ssm.send(
                new GetCommandInvocationCommand({
                    CommandId: commandId,
                    InstanceId: instanceId,
                }),
            );
            status = invocation.Status ?? 'Unknown';

            if (status !== 'InProgress' && status !== 'Pending') {
                return {
                    status,
                    stdout: invocation.StandardOutputContent ?? '',
                    stderr: invocation.StandardErrorContent ?? '',
                };
            }
        } catch {
            // InvocationDoesNotExist — command hasn't registered yet
        }
    }

    return { status: 'TimedOut', stdout: '', stderr: `Command ${commandId} timed out after ${timeoutSeconds}s` };
}

/**
 * Sleep for the specified number of milliseconds.
 *
 * @param ms - Duration to sleep
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Phase 1: Infrastructure Diagnostics
// ============================================================================

/**
 * Fetch control plane SSM parameters and validate they exist.
 *
 * @param ssm - SSM SDK client
 * @param env - Environment name (development, staging, production)
 * @returns SSM parameters and check results
 */
async function diagnoseSSMParameters(
    ssm: SSMClient,
    env: string,
): Promise<{ params: ControlPlaneParams; checks: CheckResult[] }> {
    const prefix = `/k8s/${env}`;
    const checks: CheckResult[] = [];

    const paramPaths: Record<keyof ControlPlaneParams, string> = {
        instanceId: `${prefix}/instance-id`,
        controlPlaneEndpoint: `${prefix}/control-plane-endpoint`,
        privateIp: `${prefix}/private-ip`,
        publicIp: `${prefix}/public-ip`,
        amiId: `${prefix}/ami-id`,
        k8sVersion: `${prefix}/kubernetes-version`,
    };

    const params: Partial<ControlPlaneParams> = {};

    for (const [key, path] of Object.entries(paramPaths)) {
        try {
            const result = await ssm.send(new GetParameterCommand({ Name: path }));
            const value = result.Parameter?.Value;
            if (value && value !== 'None') {
                params[key as keyof ControlPlaneParams] = value;
                checks.push({
                    name: `SSM: ${path}`,
                    passed: true,
                    detail: value,
                });
            } else {
                checks.push({
                    name: `SSM: ${path}`,
                    passed: false,
                    detail: 'Parameter exists but value is empty/None',
                    severity: key === 'instanceId' ? 'critical' : 'warning',
                });
            }
        } catch {
            checks.push({
                name: `SSM: ${path}`,
                passed: false,
                detail: 'Parameter not found',
                severity: key === 'instanceId' ? 'critical' : 'warning',
            });
        }
    }

    if (!params.instanceId) {
        log.fatal(`Critical SSM parameter missing: ${paramPaths.instanceId}. Cannot proceed.`);
    }

    return { params: params as ControlPlaneParams, checks };
}

/**
 * Validate the EC2 instance is running and reachable via SSM.
 *
 * @param ec2 - EC2 SDK client
 * @param instanceId - Instance ID to check
 * @returns Check results for instance state
 */
async function diagnoseEC2Instance(
    ec2: EC2Client,
    instanceId: string,
): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    try {
        const result = await ec2.send(
            new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
        );

        const instance = result.Reservations?.[0]?.Instances?.[0];
        if (!instance) {
            checks.push({
                name: 'EC2: Instance existence',
                passed: false,
                detail: `Instance ${instanceId} not found — possibly terminated`,
                severity: 'critical',
            });
            return checks;
        }

        const state = instance.State?.Name ?? 'unknown';
        checks.push({
            name: 'EC2: Instance state',
            passed: state === 'running',
            detail: `State: ${state}, Type: ${instance.InstanceType}, AZ: ${instance.Placement?.AvailabilityZone}`,
            severity: state !== 'running' ? 'critical' : undefined,
        });

        checks.push({
            name: 'EC2: Private IP',
            passed: !!instance.PrivateIpAddress,
            detail: `Private: ${instance.PrivateIpAddress ?? 'NONE'}, Public: ${instance.PublicIpAddress ?? 'NONE'}`,
        });

        // Check EBS volumes
        const volumeIds = (instance.BlockDeviceMappings ?? [])
            .map((bdm) => bdm.Ebs?.VolumeId)
            .filter((id): id is string => !!id);

        if (volumeIds.length > 0) {
            const volumes = await ec2.send(
                new DescribeVolumesCommand({ VolumeIds: volumeIds }),
            );
            for (const vol of volumes.Volumes ?? []) {
                const tags = (vol.Tags ?? []).reduce<Record<string, string>>((acc, t) => {
                    if (t.Key && t.Value) acc[t.Key] = t.Value;
                    return acc;
                }, {});

                const isDataVol = tags['Name']?.includes('etcd') || tags['component']?.includes('etcd');
                const deleteOnTerm = vol.Attachments?.[0]?.DeleteOnTermination;

                checks.push({
                    name: `EBS: ${vol.VolumeId} (${vol.Size}GB)`,
                    passed: vol.State === 'in-use',
                    detail: `State: ${vol.State}, DeleteOnTermination: ${deleteOnTerm}, Data Volume: ${isDataVol ? 'YES' : 'no'}`,
                    severity: isDataVol && deleteOnTerm ? 'warning' : undefined,
                });
            }
        }
    } catch (error) {
        checks.push({
            name: 'EC2: Instance lookup',
            passed: false,
            detail: `Failed: ${(error as Error).message}`,
            severity: 'critical',
        });
    }

    return checks;
}

/**
 * Check the ASG configuration and recent activity.
 *
 * @param asg - AutoScaling SDK client
 * @param env - Environment name for tag filtering
 * @returns Check results for ASG state
 */
async function diagnoseASG(
    asg: AutoScalingClient,
    env: string,
): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    try {
        const result = await asg.send(new DescribeAutoScalingGroupsCommand({}));
        const groups = result.AutoScalingGroups ?? [];

        const cpASG = groups.find((g) => {
            const tags = g.Tags ?? [];
            return tags.some((t) => t.Key === 'component' && t.Value?.includes('control-plane'));
        });

        if (!cpASG) {
            checks.push({
                name: 'ASG: Control plane group',
                passed: false,
                detail: 'No ASG found with component=control-plane tag',
                severity: 'warning',
            });
            return checks;
        }

        checks.push({
            name: 'ASG: Configuration',
            passed: true,
            detail: `Name: ${cpASG.AutoScalingGroupName}, Desired: ${cpASG.DesiredCapacity}, Min: ${cpASG.MinSize}, Max: ${cpASG.MaxSize}`,
        });

        const healthyInstances = (cpASG.Instances ?? []).filter(
            (i) => i.HealthStatus === 'Healthy' && i.LifecycleState === 'InService',
        );

        checks.push({
            name: 'ASG: Instance health',
            passed: healthyInstances.length > 0,
            detail: `Healthy: ${healthyInstances.length}/${cpASG.Instances?.length ?? 0}, Recent Activities: check AWS Console`,
            severity: healthyInstances.length === 0 ? 'critical' : undefined,
        });
    } catch (error) {
        checks.push({
            name: 'ASG: Lookup',
            passed: false,
            detail: `Failed: ${(error as Error).message}`,
            severity: 'warning',
        });
    }

    return checks;
}

// ============================================================================
// Phase 2: SSM Automation History
// ============================================================================

/**
 * Inspect recent SSM Automation executions for bootstrap failures.
 *
 * @param ssm - SSM SDK client
 * @param maxResults - Maximum number of executions to inspect
 * @returns Check results and list of failure descriptions
 */
async function diagnoseAutomation(
    ssm: SSMClient,
    maxResults: number,
): Promise<{ checks: CheckResult[]; failures: string[] }> {
    const checks: CheckResult[] = [];
    const failures: string[] = [];

    try {
        const executions = await ssm.send(
            new DescribeAutomationExecutionsCommand({
                MaxResults: Math.min(maxResults, 50),
                Filters: [
                    { Key: 'ExecutionStatus', Values: ['Failed', 'TimedOut', 'Success'] },
                ],
            }),
        );

        const metaList = executions.AutomationExecutionMetadataList ?? [];

        if (metaList.length === 0) {
            checks.push({
                name: 'Automation: Recent executions',
                passed: true,
                detail: 'No recent executions found',
                severity: 'info',
            });
            return { checks, failures };
        }

        // Summarise each execution
        for (const meta of metaList) {
            const status = meta.AutomationExecutionStatus ?? 'Unknown';
            const isFailed = FAILURE_STATUSES.has(status);
            const startTime = meta.ExecutionStartTime?.toISOString() ?? 'N/A';
            const duration = meta.ExecutionStartTime
                ? formatDuration(meta.ExecutionStartTime, meta.ExecutionEndTime)
                : 'N/A';

            checks.push({
                name: `Automation: ${meta.DocumentName ?? 'unknown'} (${startTime})`,
                passed: !isFailed,
                detail: `Status: ${status}, Duration: ${duration}${meta.FailureMessage ? `, Failure: ${meta.FailureMessage}` : ''}`,
                severity: isFailed ? 'critical' : undefined,
            });

            // Fetch step-level detail for failed executions
            if (isFailed && meta.AutomationExecutionId) {
                const stepFailures = await inspectFailedSteps(ssm, meta.AutomationExecutionId);
                failures.push(...stepFailures);
            }
        }
    } catch (error) {
        checks.push({
            name: 'Automation: Query',
            passed: false,
            detail: `Failed to query automation history: ${(error as Error).message}`,
            severity: 'warning',
        });
    }

    return { checks, failures };
}

/**
 * Inspect the individual steps of a failed automation execution.
 *
 * @param ssm - SSM SDK client
 * @param executionId - Automation execution ID
 * @returns Array of human-readable failure descriptions
 */
async function inspectFailedSteps(
    ssm: SSMClient,
    executionId: string,
): Promise<string[]> {
    const failures: string[] = [];

    try {
        const detail = await ssm.send(
            new GetAutomationExecutionCommand({ AutomationExecutionId: executionId }),
        );

        const steps = detail.AutomationExecution?.StepExecutions ?? [];

        for (const step of steps) {
            const stepStatus = step.StepStatus ?? 'Unknown';
            if (!FAILURE_STATUSES.has(stepStatus)) continue;

            const failureMsg = step.FailureMessage ?? 'No failure message';
            const stepName = step.StepName ?? 'unknown';
            const action = step.Action ?? 'unknown';

            const description = `Step "${stepName}" (${action}) → ${stepStatus}: ${failureMsg}`;
            failures.push(description);

            // Print step detail inline
            printStepDetail(step);
        }
    } catch (error) {
        failures.push(`Could not inspect execution ${executionId}: ${(error as Error).message}`);
    }

    return failures;
}

/**
 * Print detailed information about a single SSM step execution.
 *
 * @param step - SSM step execution object
 */
function printStepDetail(step: StepExecution): void {
    const status = step.StepStatus ?? 'UNKNOWN';
    const icon = FAILURE_STATUSES.has(status) ? log.red('✗') : log.green('✓');
    const duration = step.ExecutionStartTime
        ? formatDuration(step.ExecutionStartTime, step.ExecutionEndTime)
        : 'N/A';

    console.log(`     ${icon}  ${step.StepName} (${step.Action})`);
    console.log(`        Status: ${colourStatus(status)}, Duration: ${duration}`);

    if (step.FailureMessage) {
        console.log(`        ${log.red('Failure: ' + step.FailureMessage)}`);
    }

    if (step.Outputs) {
        const keys = Object.keys(step.Outputs);
        if (keys.length > 0) {
            console.log(`        ${log.cyan('Outputs:')} ${keys.join(', ')}`);
        }
    }
}

// ============================================================================
// Phase 3: DR Certificate & Backup Diagnostics
// ============================================================================

/**
 * Check the API server certificate SANs, backup state, and kubeadm-config.
 * This is the core diagnostic for the recurring SAN mismatch bug.
 *
 * @param ssm - SSM SDK client
 * @param instanceId - Target instance ID
 * @returns Check results for DR and certificate state
 */
async function diagnoseDRAndCerts(
    ssm: SSMClient,
    instanceId: string,
): Promise<{ checks: CheckResult[]; metadata: InstanceMetadata | undefined }> {
    const checks: CheckResult[] = [];
    let metadata: InstanceMetadata | undefined;

    const drScript = [
        'set +e',
        // Get IMDS token
        'TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds:21600)',
        'PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
        'PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)',
        'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
        'AZ=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)',
        'INSTANCE_TYPE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-type)',
        '',
        'echo "META_PRIVATE_IP=$PRIVATE_IP"',
        'echo "META_PUBLIC_IP=$PUBLIC_IP"',
        'echo "META_INSTANCE_ID=$INSTANCE_ID"',
        'echo "META_AZ=$AZ"',
        'echo "META_INSTANCE_TYPE=$INSTANCE_TYPE"',
        '',
        '# Certificate SANs',
        'echo "=== CERT_SANS ==="',
        'if [ -f /etc/kubernetes/pki/apiserver.crt ]; then',
        '  openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text 2>&1 | grep -A1 "Subject Alternative Name" | tail -1',
        '  echo "CERT_EXISTS=true"',
        '  echo "CERT_EXPIRY=$(openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate 2>&1 | cut -d= -f2)"',
        'else',
        '  echo "CERT_EXISTS=false"',
        'fi',
        '',
        '# DR backup marker and bootstrap summary',
        'echo "=== DR_STATE ==="',
        'echo "ADMIN_CONF_EXISTS=$(test -f /etc/kubernetes/admin.conf && echo true || echo false)"',
        'echo "SUPER_ADMIN_CONF_EXISTS=$(test -f /etc/kubernetes/super-admin.conf && echo true || echo false)"',
        'echo "PKI_DIR_EXISTS=$(test -d /etc/kubernetes/pki && echo true || echo false)"',
        'echo "PKI_FILE_COUNT=$(ls /etc/kubernetes/pki/ 2>/dev/null | wc -l | tr -d \" \")"',
        'echo "MANIFESTS_DIR_EXISTS=$(test -d /etc/kubernetes/manifests && echo true || echo false)"',
        'echo "MANIFESTS_COUNT=$(ls /etc/kubernetes/manifests/*.yaml 2>/dev/null | wc -l | tr -d \" \")"',
        'echo "CALICO_MARKER=$(test -f /etc/kubernetes/.calico-installed && echo true || echo false)"',
        '',
        'echo "=== BOOTSTRAP_SUMMARY ==="',
        'if [ -f /opt/k8s-bootstrap/run_summary.json ]; then',
        '  cat /opt/k8s-bootstrap/run_summary.json',
        'else',
        '  echo "NO_SUMMARY_FILE"',
        'fi',
        '',
        '# kubeadm-config podSubnet check',
        'echo "=== KUBEADM_CONFIG ==="',
        'export KUBECONFIG=/etc/kubernetes/super-admin.conf',
        'kubectl get cm kubeadm-config -n kube-system -o jsonpath="{.data.ClusterConfiguration}" 2>&1 || echo "KUBEADM_CONFIG_MISSING"',
    ].join('\n');

    log.step(3, 5, 'Running DR & certificate diagnostics on instance...');
    const result = await runOnInstance(ssm, instanceId, [drScript]);

    if (result.status !== 'Success') {
        checks.push({
            name: 'DR: Remote diagnostics',
            passed: false,
            detail: `SSM command failed: ${result.status}`,
            raw: result.stderr,
            severity: 'critical',
        });
        return { checks, metadata };
    }

    const output = result.stdout;

    // Parse instance metadata
    metadata = {
        privateIp: extractValue(output, 'META_PRIVATE_IP'),
        publicIp: extractValue(output, 'META_PUBLIC_IP'),
        instanceId: extractValue(output, 'META_INSTANCE_ID'),
        availabilityZone: extractValue(output, 'META_AZ'),
        instanceType: extractValue(output, 'META_INSTANCE_TYPE'),
    };

    // Check certificate SANs vs current IP
    const certExists = extractValue(output, 'CERT_EXISTS') === 'true';

    if (!certExists) {
        checks.push({
            name: 'DR: API server certificate',
            passed: false,
            detail: 'apiserver.crt does NOT exist — certificate was not restored or not yet generated',
            severity: 'critical',
        });
    } else {
        const sanLine = output.split('=== CERT_SANS ===')[1]?.split('\n').find(
            (line) => line.includes('IP Address:'),
        ) ?? '';
        const certIps = [...sanLine.matchAll(/IP Address:(\d+\.\d+\.\d+\.\d+)/g)].map(
            (m) => m[1],
        );
        const hasCurrentIp = certIps.includes(metadata.privateIp);

        checks.push({
            name: 'DR: Certificate SANs',
            passed: hasCurrentIp,
            detail: hasCurrentIp
                ? `Certificate includes current IP ${metadata.privateIp}. SANs: ${certIps.join(', ')}`
                : `⚠ MISMATCH: Cert SANs [${certIps.join(', ')}] do NOT include current IP ${metadata.privateIp}`,
            severity: hasCurrentIp ? undefined : 'critical',
        });

        const certExpiry = extractValue(output, 'CERT_EXPIRY');
        checks.push({
            name: 'DR: Certificate expiry',
            passed: true,
            detail: `Expires: ${certExpiry}`,
        });
    }

    // DR file state
    const adminConf = extractValue(output, 'ADMIN_CONF_EXISTS') === 'true';
    const pkiDir = extractValue(output, 'PKI_DIR_EXISTS') === 'true';
    const pkiCount = extractValue(output, 'PKI_FILE_COUNT');
    const manifestsCount = extractValue(output, 'MANIFESTS_COUNT');

    checks.push({
        name: 'DR: Restored files',
        passed: adminConf && pkiDir,
        detail: `admin.conf: ${adminConf ? '✓' : '✗'}, PKI dir: ${pkiDir ? `✓ (${pkiCount} files)` : '✗'}, Manifests: ${manifestsCount}`,
        severity: !adminConf || !pkiDir ? 'critical' : undefined,
    });

    // Bootstrap summary
    const summarySection = output.split('=== BOOTSTRAP_SUMMARY ===')[1]?.split('=== KUBEADM_CONFIG ===')[0]?.trim();
    if (summarySection && summarySection !== 'NO_SUMMARY_FILE') {
        try {
            const summary = JSON.parse(summarySection);
            const overallStatus = summary.overall_status ?? 'unknown';
            checks.push({
                name: 'DR: Bootstrap summary',
                passed: overallStatus === 'success',
                detail: `Status: ${overallStatus}, Failure code: ${summary.failure_code ?? 'none'}`,
                raw: summarySection,
                severity: overallStatus !== 'success' ? 'critical' : undefined,
            });

            // Parse individual step statuses
            if (summary.steps) {
                for (const [stepName, stepData] of Object.entries(summary.steps)) {
                    const data = stepData as Record<string, unknown>;
                    const stepStatus = data.status as string;
                    if (stepStatus === 'failed') {
                        checks.push({
                            name: `DR: Bootstrap step — ${stepName}`,
                            passed: false,
                            detail: `Failed: ${data.error ?? 'no error message'}`,
                            severity: 'critical',
                        });
                    }
                }
            }
        } catch {
            checks.push({
                name: 'DR: Bootstrap summary',
                passed: false,
                detail: 'Could not parse run_summary.json',
                raw: summarySection,
                severity: 'warning',
            });
        }
    } else {
        checks.push({
            name: 'DR: Bootstrap summary',
            passed: false,
            detail: 'run_summary.json not found — bootstrap may not have been executed',
            severity: 'warning',
        });
    }

    // kubeadm-config podSubnet check
    const kubeadmConfig = output.split('=== KUBEADM_CONFIG ===')[1]?.trim() ?? '';
    if (kubeadmConfig.includes('KUBEADM_CONFIG_MISSING')) {
        checks.push({
            name: 'DR: kubeadm-config podSubnet',
            passed: false,
            detail: 'kubeadm-config ConfigMap not found — kubeadm init may not have run',
            severity: 'critical',
        });
    } else {
        const hasPodSubnet = kubeadmConfig.includes('podSubnet');
        checks.push({
            name: 'DR: kubeadm-config podSubnet',
            passed: hasPodSubnet,
            detail: hasPodSubnet
                ? `podSubnet is present in kubeadm-config`
                : `⚠ podSubnet MISSING from kubeadm-config — Calico operator will fail with "missing required podSubnet field"`,
            severity: hasPodSubnet ? undefined : 'critical',
        });
    }

    return { checks, metadata };
}

// ============================================================================
// Phase 4: Kubernetes Cluster Diagnostics
// ============================================================================

/**
 * Run comprehensive Kubernetes diagnostics on the control plane instance.
 * Checks API server health, node status, pods, Calico, kubelet logs, etc.
 *
 * @param ssm - SSM SDK client
 * @param instanceId - Target instance ID
 * @returns Check results for the Kubernetes cluster state
 */
async function diagnoseKubernetes(
    ssm: SSMClient,
    instanceId: string,
): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    const k8sScript = [
        'set +e',
        'export KUBECONFIG=/etc/kubernetes/super-admin.conf',
        '',
        'echo "=== API_HEALTH ==="',
        'kubectl get --raw /healthz 2>&1',
        '',
        'echo "=== NODES ==="',
        'kubectl get nodes -o wide 2>&1',
        '',
        'echo "=== NODE_CONDITIONS ==="',
        'NODE_NAME=$(hostname -f)',
        'kubectl get node $NODE_NAME -o jsonpath="{.status.conditions}" 2>&1 | python3 -m json.tool 2>&1 || echo "CANNOT_GET_CONDITIONS"',
        '',
        'echo "=== ALL_PODS ==="',
        'kubectl get pods -A -o wide 2>&1',
        '',
        'echo "=== CALICO_STATUS ==="',
        'kubectl get tigerastatus 2>&1',
        '',
        'echo "=== CALICO_PODS ==="',
        'kubectl get pods -n calico-system 2>&1',
        '',
        'echo "=== KUBE_PROXY ==="',
        'kubectl get ds kube-proxy -n kube-system -o wide 2>&1',
        '',
        'echo "=== COREDNS ==="',
        'kubectl get deploy coredns -n kube-system -o wide 2>&1',
        '',
        'echo "=== NODE_TAINTS ==="',
        'kubectl get node $NODE_NAME -o jsonpath="{.spec.taints}" 2>&1 | python3 -m json.tool 2>&1 || echo "NO_TAINTS"',
        '',
        'echo "=== KUBELET_STATUS ==="',
        'systemctl is-active kubelet 2>&1',
        '',
        'echo "=== KUBELET_ERRORS ==="',
        'journalctl -u kubelet --no-pager -n 20 --priority=err 2>&1',
        '',
        'echo "=== STATIC_PODS ==="',
        'crictl ps --no-trunc 2>&1 | head -15',
        '',
        'echo "=== HELM_RELEASES ==="',
        'helm list -A 2>&1',
    ].join('\n');

    log.step(4, 5, 'Running Kubernetes cluster diagnostics...');
    const result = await runOnInstance(ssm, instanceId, [k8sScript], 180);

    if (result.status !== 'Success') {
        checks.push({
            name: 'K8s: Remote diagnostics',
            passed: false,
            detail: `SSM command failed: ${result.status}`,
            raw: result.stderr,
            severity: 'critical',
        });
        return checks;
    }

    const output = result.stdout;

    // API server health
    const apiHealth = extractSection(output, 'API_HEALTH', 'NODES').trim();
    checks.push({
        name: 'K8s: API server health (/healthz)',
        passed: apiHealth.includes('ok'),
        detail: apiHealth.includes('ok') ? 'API server is healthy' : `API server unhealthy: ${apiHealth.substring(0, 200)}`,
        severity: !apiHealth.includes('ok') ? 'critical' : undefined,
    });

    // Node status
    const nodesSection = extractSection(output, 'NODES', 'NODE_CONDITIONS');
    const nodeReady = nodesSection.includes(' Ready ') && !nodesSection.includes('NotReady');
    const noResources = nodesSection.includes('No resources found');

    checks.push({
        name: 'K8s: Node registration',
        passed: !noResources,
        detail: noResources
            ? '⚠ No nodes registered — kubelet cannot reach API server'
            : nodesSection.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | '),
        severity: noResources ? 'critical' : undefined,
    });

    if (!noResources) {
        checks.push({
            name: 'K8s: Node Ready status',
            passed: nodeReady,
            detail: nodeReady ? 'Node is Ready' : '⚠ Node is NotReady — check CNI/Calico',
            severity: nodeReady ? undefined : 'critical',
        });
    }

    // Node conditions detail (for NotReady diagnosis)
    const conditionsSection = extractSection(output, 'NODE_CONDITIONS', 'ALL_PODS');
    if (conditionsSection.includes('NetworkPluginNotReady')) {
        checks.push({
            name: 'K8s: CNI plugin',
            passed: false,
            detail: '⚠ CNI plugin NOT initialised — Calico pods may be missing or degraded',
            severity: 'critical',
        });
    }

    // Node taints
    const taintsSection = extractSection(output, 'NODE_TAINTS', 'KUBELET_STATUS');
    if (taintsSection.includes('uninitialized')) {
        checks.push({
            name: 'K8s: Uninitialised taint',
            passed: false,
            detail: '⚠ node.cloudprovider.kubernetes.io/uninitialized taint present — CCM has not processed this node',
            severity: 'warning',
        });
    }

    // Calico / Tigera status
    const calicoStatus = extractSection(output, 'CALICO_STATUS', 'CALICO_PODS');
    const calicoDegraded = calicoStatus.includes('True') && calicoStatus.includes('Degraded');
    const calicoPods = extractSection(output, 'CALICO_PODS', 'KUBE_PROXY');
    const calicoPodsRunning = calicoPods.includes('Running');

    checks.push({
        name: 'K8s: Calico/Tigera status',
        passed: !calicoDegraded && calicoPodsRunning,
        detail: calicoDegraded
            ? '⚠ Calico is DEGRADED — check tigera-operator logs'
            : calicoPodsRunning
              ? 'Calico pods are running'
              : 'Calico pods not found — CNI not deployed',
        severity: calicoDegraded || !calicoPodsRunning ? 'critical' : undefined,
        raw: calicoStatus + '\n' + calicoPods,
    });

    // Kubelet status
    const kubeletStatus = extractSection(output, 'KUBELET_STATUS', 'KUBELET_ERRORS').trim();
    checks.push({
        name: 'K8s: Kubelet service',
        passed: kubeletStatus.includes('active'),
        detail: `systemctl: ${kubeletStatus}`,
        severity: !kubeletStatus.includes('active') ? 'critical' : undefined,
    });

    // Kubelet errors
    const kubeletErrors = extractSection(output, 'KUBELET_ERRORS', 'STATIC_PODS');
    const hasTlsError = kubeletErrors.includes('x509') || kubeletErrors.includes('tls:');
    const hasConnRefused = kubeletErrors.includes('connection refused');

    if (hasTlsError) {
        checks.push({
            name: 'K8s: Kubelet TLS errors',
            passed: false,
            detail: '⚠ TLS/x509 errors detected in kubelet logs — certificate SAN mismatch likely',
            raw: kubeletErrors.substring(0, 500),
            severity: 'critical',
        });
    }

    if (hasConnRefused) {
        checks.push({
            name: 'K8s: Kubelet connection',
            passed: false,
            detail: '⚠ "connection refused" in kubelet logs — API server may not be running',
            severity: 'critical',
        });
    }

    // Helm releases
    const helmSection = extractSection(output, 'HELM_RELEASES', '');
    if (helmSection.includes('failed')) {
        checks.push({
            name: 'K8s: Helm releases',
            passed: false,
            detail: '⚠ Failed Helm releases detected — may need cleanup',
            raw: helmSection,
            severity: 'warning',
        });
    }

    // Static pods (via crictl)
    const staticPods = extractSection(output, 'STATIC_PODS', 'HELM_RELEASES');
    const staticPodNames = ['kube-apiserver', 'kube-controller-manager', 'kube-scheduler', 'etcd'];
    for (const pod of staticPodNames) {
        const podRunning = staticPods.includes(pod);
        checks.push({
            name: `K8s: Static pod — ${pod}`,
            passed: podRunning,
            detail: podRunning ? 'Running' : `⚠ ${pod} is NOT running`,
            severity: podRunning ? undefined : 'critical',
        });
    }

    return checks;
}

// ============================================================================
// Phase 5: Automatic Repair (--fix)
// ============================================================================

/**
 * Attempt automatic repair of the control plane.
 * Regenerates the API server certificate, patches kubeadm-config, restarts
 * the operator, and removes stale taints.
 *
 * @param ssm - SSM SDK client
 * @param instanceId - Target instance ID
 * @param metadata - Instance metadata with current IPs
 * @returns Check results from the repair attempt
 */
async function attemptRepair(
    ssm: SSMClient,
    instanceId: string,
    metadata: InstanceMetadata,
): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    log.header('  ⚡ Automatic Repair');
    log.warn('Attempting certificate regeneration and config repair...');

    const fixScript = [
        'set -e',
        'export KUBECONFIG=/etc/kubernetes/super-admin.conf',
        `PRIVATE_IP="${metadata.privateIp}"`,
        `PUBLIC_IP="${metadata.publicIp}"`,
        '',
        '# Step 1: Regenerate API server certificate',
        'echo "=== FIX_CERT ==="',
        'rm -f /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key',
        `kubeadm init phase certs apiserver --apiserver-advertise-address=$PRIVATE_IP --apiserver-cert-extra-sans=127.0.0.1,$PRIVATE_IP,k8s-api.k8s.internal,$PUBLIC_IP 2>&1`,
        'echo "CERT_REGEN=done"',
        '',
        '# Step 2: Verify new cert SANs',
        'echo "=== FIX_VERIFY ==="',
        'openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text 2>&1 | grep -A1 "Subject Alternative Name" | tail -1',
        '',
        '# Step 3: Patch kubeadm-config with podSubnet if missing',
        'echo "=== FIX_PODSUBNET ==="',
        'CURRENT=$(kubectl get cm kubeadm-config -n kube-system -o jsonpath="{.data.ClusterConfiguration}" 2>&1)',
        `echo "$CURRENT" | grep -q podSubnet && echo "PODSUBNET_ALREADY_SET" || {`,
        `  echo "$CURRENT" | sed "s/networking:/networking:\\n  podSubnet: ${EXPECTED_POD_CIDR}/" > /tmp/cc.yaml`,
        '  kubectl create cm kubeadm-config -n kube-system --from-file=ClusterConfiguration=/tmp/cc.yaml --dry-run=client -o yaml | kubectl apply -f - 2>&1',
        '  echo "PODSUBNET_PATCHED"',
        '}',
        '',
        '# Step 4: Restart kube-apiserver and kubelet',
        'echo "=== FIX_RESTART ==="',
        'crictl rm $(crictl ps --name kube-apiserver -q) 2>/dev/null || true',
        'sleep 5',
        'systemctl restart kubelet',
        'sleep 15',
        '',
        '# Step 5: Restart tigera-operator',
        'kubectl rollout restart deploy/tigera-operator -n tigera-operator 2>&1 || true',
        'sleep 10',
        '',
        '# Step 6: Label node and remove taints',
        'NODE_NAME=$(hostname -f)',
        'kubectl label node $NODE_NAME node-role.kubernetes.io/control-plane= --overwrite 2>&1 || true',
        'kubectl taint nodes $NODE_NAME node.cloudprovider.kubernetes.io/uninitialized:NoSchedule- 2>&1 || true',
        '',
        '# Step 7: Final status',
        'echo "=== FIX_RESULT ==="',
        'kubectl get nodes -o wide 2>&1',
        'echo "---"',
        'kubectl get pods -A -o wide 2>&1',
        'echo "---"',
        'kubectl get tigerastatus 2>&1',
    ].join('\n');

    const result = await runOnInstance(ssm, instanceId, [fixScript], 180);

    if (result.status !== 'Success') {
        checks.push({
            name: 'Repair: Execution',
            passed: false,
            detail: `Repair command failed: ${result.status}`,
            raw: result.stderr,
            severity: 'critical',
        });
        return checks;
    }

    const output = result.stdout;

    // Check cert regen
    const certRegen = output.includes('CERT_REGEN=done');
    checks.push({
        name: 'Repair: Certificate regeneration',
        passed: certRegen,
        detail: certRegen ? `Certificate regenerated with SANs for ${metadata.privateIp}` : 'Certificate regeneration failed',
        severity: certRegen ? undefined : 'critical',
    });

    // Check podSubnet patch
    const podSubnetPatched = output.includes('PODSUBNET_PATCHED') || output.includes('PODSUBNET_ALREADY_SET');
    checks.push({
        name: 'Repair: kubeadm-config podSubnet',
        passed: podSubnetPatched,
        detail: output.includes('PODSUBNET_ALREADY_SET') ? 'Already set' : 'Patched successfully',
    });

    // Check final node status
    const finalSection = output.split('=== FIX_RESULT ===')[1] ?? '';
    const nodeReady = finalSection.includes(' Ready ') && !finalSection.includes('NotReady');
    checks.push({
        name: 'Repair: Node status after fix',
        passed: nodeReady,
        detail: nodeReady ? 'Node is Ready!' : 'Node is NotReady — Calico may need more time to initialise',
        severity: nodeReady ? undefined : 'warning',
    });

    // Print the raw final state for the user
    console.log('');
    log.info('Final cluster state:');
    console.log(finalSection);

    return checks;
}

// ============================================================================
// Report Generation
// ============================================================================

/**
 * Analyse check results and generate recommendations.
 *
 * @param report - Diagnostic report to analyse
 * @returns Array of recommended actions
 */
function generateRecommendations(report: DiagnosticReport): string[] {
    const recommendations: string[] = [];
    const failedNames = report.checks.filter((c) => !c.passed).map((c) => c.name);

    // Certificate SAN mismatch
    if (failedNames.some((n) => n.includes('Certificate SANs'))) {
        recommendations.push(
            'CRITICAL: API server certificate has stale IPs. Run with --fix to regenerate, ' +
            'or manually: rm /etc/kubernetes/pki/apiserver.{crt,key} && kubeadm init phase certs apiserver ...',
        );
    }

    // Missing podSubnet
    if (failedNames.some((n) => n.includes('podSubnet'))) {
        recommendations.push(
            'CRITICAL: kubeadm-config ConfigMap is missing podSubnet. Calico will not deploy. ' +
            'Run with --fix to patch, or manually patch the ConfigMap.',
        );
    }

    // Node not registered
    if (failedNames.some((n) => n.includes('Node registration'))) {
        recommendations.push(
            'Node is not registered with the API server. Check kubelet logs for TLS errors ' +
            'or connection refused. The cert SAN mismatch is the most common cause.',
        );
    }

    // Calico degraded
    if (failedNames.some((n) => n.includes('Calico'))) {
        recommendations.push(
            'Calico is degraded. Check tigera-operator logs: ' +
            'kubectl logs -n tigera-operator deploy/tigera-operator --tail=50',
        );
    }

    // Failed Helm releases
    if (failedNames.some((n) => n.includes('Helm'))) {
        recommendations.push(
            'Failed Helm releases detected. Clean up with: helm uninstall <release-name> -n <namespace>',
        );
    }

    // Bootstrap step failures
    if (failedNames.some((n) => n.includes('Bootstrap step'))) {
        recommendations.push(
            'Bootstrap automation failed. Check /opt/k8s-bootstrap/run_summary.json for details, ' +
            'and use: npx tsx scripts/local/ssm-automation.ts for step-level logs.',
        );
    }

    // Static pods missing
    const missingPods = failedNames.filter((n) => n.includes('Static pod'));
    if (missingPods.length > 0) {
        recommendations.push(
            `Static pod(s) not running: ${missingPods.map((n) => n.split('— ')[1]).join(', ')}. ` +
            'Check /etc/kubernetes/manifests/ and kubelet logs.',
        );
    }

    if (recommendations.length === 0) {
        recommendations.push('All checks passed — control plane appears healthy.');
    }

    return recommendations;
}

/**
 * Print the final diagnostic report with colour-coded results.
 *
 * @param report - Completed diagnostic report
 */
function printReport(report: DiagnosticReport): void {
    console.log('');
    log.header('  📋 Diagnostic Report');

    log.config('Environment', {
        'Timestamp': report.timestamp,
        'Environment': report.environment,
        'Instance ID': report.instanceId,
        'Private IP': report.metadata?.privateIp ?? 'unknown',
        'Public IP': report.metadata?.publicIp ?? 'unknown',
    });

    // Group checks by phase
    const phases = new Map<string, CheckResult[]>();
    for (const check of report.checks) {
        const phase = check.name.split(':')[0];
        const existing = phases.get(phase) ?? [];
        existing.push(check);
        phases.set(phase, existing);
    }

    for (const [phase, phaseChecks] of phases) {
        const passed = phaseChecks.filter((c) => c.passed).length;
        const total = phaseChecks.length;
        const allPassed = passed === total;

        console.log('');
        const phaseIcon = allPassed ? log.green('✓') : log.red('✗');
        console.log(`${phaseIcon}  ${log.cyan(phase)} — ${passed}/${total} checks passed`);

        for (const check of phaseChecks) {
            const icon = check.passed ? log.green('  ✓') : log.red('  ✗');
            const name = check.name.split(': ').slice(1).join(': ');
            console.log(`${icon}  ${name}`);
            console.log(`     ${check.detail}`);
        }
    }

    // Automation failures
    if (report.automationFailures.length > 0) {
        console.log('');
        log.header('  🔍 Automation Failure Details');
        for (const failure of report.automationFailures) {
            console.log(`  ${log.red('•')} ${failure}`);
        }
    }

    // Recommendations
    console.log('');
    log.header('  💡 Recommendations');
    const criticalChecks = report.checks.filter((c) => !c.passed && c.severity === 'critical');
    const warningChecks = report.checks.filter((c) => !c.passed && c.severity === 'warning');

    console.log(`  ${log.red(`${criticalChecks.length} critical`)} | ${log.yellow(`${warningChecks.length} warnings`)} | ${log.green(`${report.checks.filter((c) => c.passed).length} passed`)}`);
    console.log('');

    for (const [i, rec] of report.recommendations.entries()) {
        console.log(`  ${i + 1}. ${rec}`);
    }

    console.log('');
}

// ============================================================================
// Utility Helpers
// ============================================================================

/**
 * Extract a key=value from SSM command output.
 *
 * @param output - Full command output
 * @param key - Key to search for
 * @returns The extracted value or empty string
 */
function extractValue(output: string, key: string): string {
    const match = output.match(new RegExp(`${key}=(.+)`));
    return match?.[1]?.trim() ?? '';
}

/**
 * Extract a section of output between two markers.
 *
 * @param output - Full command output
 * @param startMarker - Start section marker (without === prefix)
 * @param endMarker - End section marker (without === prefix), empty for end of string
 * @returns Extracted section content
 */
function extractSection(output: string, startMarker: string, endMarker: string): string {
    const startIdx = output.indexOf(`=== ${startMarker} ===`);
    if (startIdx === -1) return '';

    const contentStart = output.indexOf('\n', startIdx) + 1;
    if (endMarker) {
        const endIdx = output.indexOf(`=== ${endMarker} ===`, contentStart);
        return endIdx === -1 ? output.substring(contentStart) : output.substring(contentStart, endIdx);
    }
    return output.substring(contentStart);
}

/**
 * Format a duration between two dates.
 *
 * @param start - Start time
 * @param end - End time (defaults to now)
 * @returns Human-readable duration string
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
 * Colour-code a status string.
 *
 * @param status - Status string
 * @returns ANSI-coloured status
 */
function colourStatus(status: string): string {
    if (FAILURE_STATUSES.has(status)) return log.red(status);
    if (status === 'Success') return log.green(status);
    if (status === 'InProgress') return log.yellow(status);
    return status;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Entry point: runs all diagnostic phases sequentially, builds a consolidated
 * report, and optionally attempts automatic repair.
 */
async function main(): Promise<void> {
    const logFile = startFileLogging('control-plane-troubleshoot');
    const awsConfig = buildAwsConfig(args);
    const auth = resolveAuth(awsConfig.profile);
    const env = (args.env as string) || 'development';
    const shouldFix = args.fix === true;
    const maxAutomationResults = Math.min(Number.parseInt(args.last as string, 10), 50);
    const skipK8s = args['skip-k8s'] === true;

    log.header('  🔧 Control Plane Troubleshooter');
    log.config('Configuration', {
        'Auth': auth.mode,
        'Region': awsConfig.region,
        'Environment': env,
        'Auto-fix': shouldFix ? 'ENABLED' : 'disabled',
        'Automation history': `last ${maxAutomationResults}`,
        'Skip K8s': skipK8s ? 'YES' : 'no',
    });

    const clients = createClients(awsConfig.region, awsConfig.credentials);

    const report: DiagnosticReport = {
        timestamp: new Date().toISOString(),
        environment: env,
        instanceId: '',
        checks: [],
        automationFailures: [],
        recommendations: [],
    };

    // ── Phase 1: Infrastructure ──────────────────────────────────────────
    log.step(1, 5, 'Checking SSM parameters and infrastructure...');

    const { params, checks: ssmChecks } = await diagnoseSSMParameters(clients.ssm, env);
    report.instanceId = params.instanceId;
    report.checks.push(...ssmChecks);

    const ec2Checks = await diagnoseEC2Instance(clients.ec2, params.instanceId);
    report.checks.push(...ec2Checks);

    const asgChecks = await diagnoseASG(clients.asg, env);
    report.checks.push(...asgChecks);

    // ── Phase 2: SSM Automation History ──────────────────────────────────
    log.step(2, 5, 'Inspecting SSM Automation execution history...');

    const { checks: autoChecks, failures } = await diagnoseAutomation(clients.ssm, maxAutomationResults);
    report.checks.push(...autoChecks);
    report.automationFailures = failures;

    // ── Phase 3: DR & Certificate Diagnostics ────────────────────────────
    const { checks: drChecks, metadata } = await diagnoseDRAndCerts(
        clients.ssm,
        params.instanceId,
    );
    report.checks.push(...drChecks);
    report.metadata = metadata;

    // ── Phase 4: Kubernetes Diagnostics ──────────────────────────────────
    if (!skipK8s) {
        const k8sChecks = await diagnoseKubernetes(clients.ssm, params.instanceId);
        report.checks.push(...k8sChecks);
    } else {
        log.warn('Skipping Kubernetes diagnostics (--skip-k8s)');
    }

    // ── Phase 5: Automatic Repair ────────────────────────────────────────
    if (shouldFix && metadata) {
        const criticalFailures = report.checks.filter(
            (c) => !c.passed && c.severity === 'critical',
        );
        if (criticalFailures.length > 0) {
            const repairChecks = await attemptRepair(clients.ssm, params.instanceId, metadata);
            report.checks.push(...repairChecks);
        } else {
            log.success('No critical failures detected — skipping repair');
        }
    }

    // ── Generate recommendations and print report ────────────────────────
    report.recommendations = generateRecommendations(report);
    printReport(report);

    // Summary line
    const critCount = report.checks.filter((c) => !c.passed && c.severity === 'critical').length;
    const totalChecks = report.checks.length;
    const passedChecks = report.checks.filter((c) => c.passed).length;

    if (critCount > 0) {
        log.fail(`${critCount} critical issue(s) found across ${totalChecks} checks`);
        if (!shouldFix) {
            log.info('Run with --fix to attempt automatic repair');
        }
    } else {
        log.success(`All ${passedChecks}/${totalChecks} checks passed`);
    }

    stopFileLogging();
    log.info(`\nLog saved to: ${logFile}`);
}

main().catch((error: Error) => {
    log.fatal(`Control plane troubleshoot failed: ${error.message}`);
});
