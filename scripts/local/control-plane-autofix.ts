#!/usr/bin/env tsx
/**
 * Control Plane Auto-Fix
 *
 * Pipeline-friendly post-automation repair script. Watches an SSM Automation
 * execution and automatically repairs known failure modes when the Kubernetes
 * control plane bootstrap fails.
 *
 * Handles:
 *   - Missing podSubnet in kubeadm-config  → Calico operator cannot deploy
 *   - CCM taint not removed (timeout)      → removes stale markers, reruns step
 *   - Stale .calico-installed / .ccm-installed markers after partial run
 *
 * Designed to run as a pipeline step immediately after the SSM Automation
 * that executes control_plane.py. Sources the S3_BUCKET and other bootstrap
 * env vars from the instance's /etc/kubernetes/bootstrap-env file (written
 * on first boot) or from CLI arguments.
 *
 * Usage:
 *   yarn tsx scripts/local/control-plane-autofix.ts --bucket k8s-dev-scripts-xxx
 *   yarn tsx scripts/local/control-plane-autofix.ts --automation-id <id>
 *   yarn tsx scripts/local/control-plane-autofix.ts --dry-run
 *
 * Exit codes:
 *   0  Bootstrap healthy or repair applied and verified successfully
 *   1  Unrecoverable failure, or post-repair verification failed
 *
 * @module control-plane-autofix
 */

import {
    SSMClient,
    GetParameterCommand,
    SendCommandCommand,
    GetCommandInvocationCommand,
    DescribeAutomationExecutionsCommand,
    GetAutomationExecutionCommand,
} from '@aws-sdk/client-ssm';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import * as log from '../lib/logger.js';
import { startFileLogging, stopFileLogging } from '../lib/logger.js';
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js';

// ============================================================================
// CLI Arguments
// ============================================================================

const args = parseArgs(
    [
        { name: 'profile',       description: 'AWS CLI profile',                                    hasValue: true },
        { name: 'region',        description: 'AWS region',                                         hasValue: true,  default: 'eu-west-1' },
        { name: 'env',           description: 'Environment: development | staging | production',    hasValue: true,  default: 'development' },
        { name: 'automation-id', description: 'SSM Automation execution ID to watch (optional)',    hasValue: true },
        { name: 'bucket',        description: 'S3_BUCKET for bootstrap re-run (auto-detected if omitted)', hasValue: true },
        { name: 'timeout',       description: 'Max seconds to wait for automation to finish',       hasValue: true,  default: '900' },
        { name: 'dry-run',       description: 'Print what would be done without executing',         hasValue: false, default: false },
        { name: 'no-rerun',      description: 'Apply fix only — skip bootstrap re-run',             hasValue: false, default: false },
        { name: 'skip-verify',   description: 'Skip post-repair node readiness verification',       hasValue: false, default: false },
    ],
    'Control Plane Auto-Fix — watches SSM Automation and repairs known failure modes',
);

// ============================================================================
// Constants
// ============================================================================

const SSM_POLL_INTERVAL_MS     = 5_000;
const SSM_CMD_TIMEOUT_SECONDS  = 120;
const BOOTSTRAP_TIMEOUT_S      = 1_800;   // 30 min — ArgoCD bootstrap needs ~800 s
const POD_CIDR                 = '192.168.0.0/16';
const BOOTSTRAP_SCRIPT         = '/data/k8s-bootstrap/boot/steps/control_plane.py';
const BOOTSTRAP_ENV_FILE       = '/etc/kubernetes/bootstrap-env';

/** Step markers that must be removed before a re-run can retry those steps */
const RETRYABLE_MARKERS: Record<string, string> = {
    'install-calico': '/etc/kubernetes/.calico-installed',
    'install-ccm':    '/etc/kubernetes/.ccm-installed',
};

/** Known failure patterns and their repair strategy */
const FAILURE_PATTERNS = [
    {
        id: 'missing-pod-subnet',
        match: (output: string) =>
            output.includes('podSubnet') && output.includes('missing') ||
            output.includes('missing required podSubnet'),
        description: 'podSubnet missing from kubeadm-config',
    },
    {
        id: 'ccm-taint-timeout',
        match: (output: string) =>
            output.includes('CCM installed but taint not removed') ||
            output.includes('uninitialized') && output.includes('still present'),
        description: 'CCM installed but uninitialized taint not removed within timeout',
    },
    {
        id: 'calico-not-deployed',
        match: (output: string) =>
            output.includes('Calico pods not found') ||
            output.includes('calico-node never deploys'),
        description: 'Calico CNI pods not running',
    },
] as const;

type FailureId = typeof FAILURE_PATTERNS[number]['id'];

// ============================================================================
// Types
// ============================================================================

interface RepairPlan {
    failures: FailureId[];
    markersToRemove: string[];
    patchPodSubnet: boolean;
    rerunBootstrap: boolean;
}

interface BootstrapEnv {
    S3_BUCKET:      string;
    SSM_PREFIX:     string;
    AWS_REGION:     string;
    K8S_VERSION:    string;
    POD_CIDR:       string;
    SERVICE_CIDR:   string;
    MOUNT_POINT:    string;
    CALICO_VERSION: string;
    ENVIRONMENT:    string;
}

// ============================================================================
// AWS Client
// ============================================================================

function createSSMClient(
    region: string,
    credentials?: AwsCredentialIdentityProvider,
): SSMClient {
    return new SSMClient({ region, credentials });
}

// ============================================================================
// SSM Remote Execution
// ============================================================================

async function runOnInstance(
    ssm: SSMClient,
    instanceId: string,
    commands: string[],
    timeoutSeconds = SSM_CMD_TIMEOUT_SECONDS,
): Promise<{ status: string; stdout: string; stderr: string }> {
    const sendResult = await ssm.send(
        new SendCommandCommand({
            InstanceIds:    [instanceId],
            DocumentName:   'AWS-RunShellScript',
            TimeoutSeconds: timeoutSeconds,
            Parameters:     { commands },
        }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) throw new Error('SSM SendCommand returned no CommandId');

    const maxAttempts = Math.ceil((timeoutSeconds * 1_000) / SSM_POLL_INTERVAL_MS);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(SSM_POLL_INTERVAL_MS);
        try {
            const inv = await ssm.send(
                new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
            );
            const status = inv.Status ?? 'Unknown';
            if (status !== 'InProgress' && status !== 'Pending') {
                return {
                    status,
                    stdout: inv.StandardOutputContent ?? '',
                    stderr: inv.StandardErrorContent ?? '',
                };
            }
        } catch {
            // InvocationDoesNotExist — command hasn't registered yet
        }
    }

    return { status: 'TimedOut', stdout: '', stderr: `Timed out after ${timeoutSeconds}s` };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Step 1 — Resolve instance ID from SSM
// ============================================================================

async function resolveInstanceId(ssm: SSMClient, env: string): Promise<string> {
    const param = `/k8s/${env}/instance-id`;
    try {
        const result = await ssm.send(new GetParameterCommand({ Name: param }));
        const value = result.Parameter?.Value;
        if (value && value !== 'None') return value;
        log.fatal(`SSM parameter ${param} is empty — cannot identify control plane instance`);
    } catch {
        log.fatal(`SSM parameter ${param} not found — has the bootstrap run at least once?`);
    }
    // unreachable — log.fatal throws/exits
    return '';
}

// ============================================================================
// Step 2 — Watch SSM Automation execution
// ============================================================================

/**
 * If an automation ID is provided, poll until it completes and return the
 * final status.  If no ID is given, fetch the most recent bootstrap execution.
 */
async function watchAutomation(
    ssm: SSMClient,
    automationId: string | undefined,
    timeoutSeconds: number,
): Promise<{ status: string; output: string }> {

    const executionId = automationId ?? await resolveLatestAutomationId(ssm);

    if (!executionId) {
        log.warn('No SSM Automation execution found — proceeding directly to diagnostics');
        return { status: 'Unknown', output: '' };
    }

    log.info(`Watching automation execution: ${executionId}`);

    const deadline = Date.now() + timeoutSeconds * 1_000;

    while (Date.now() < deadline) {
        const detail = await ssm.send(
            new GetAutomationExecutionCommand({ AutomationExecutionId: executionId }),
        );

        const exec = detail.AutomationExecution;
        const status = exec?.AutomationExecutionStatus ?? 'Unknown';

        // Terminal states
        if (['Success', 'Failed', 'TimedOut', 'Cancelled'].includes(status)) {
            const stepOutputs = (exec?.StepExecutions ?? [])
                .map((s) => `${s.StepName}: ${s.StepStatus} — ${s.FailureMessage ?? ''}`)
                .join('\n');
            log.info(`Automation ${status}: ${executionId}`);
            return { status, output: stepOutputs };
        }

        log.info(`  Automation still ${status} — polling again in ${SSM_POLL_INTERVAL_MS / 1000}s...`);
        await sleep(SSM_POLL_INTERVAL_MS);
    }

    log.warn(`Automation did not finish within ${timeoutSeconds}s — proceeding with diagnostics`);
    return { status: 'TimedOut', output: '' };
}

async function resolveLatestAutomationId(ssm: SSMClient): Promise<string | undefined> {
    try {
        const result = await ssm.send(
            new DescribeAutomationExecutionsCommand({ MaxResults: 10 }),
        );
        const executions = result.AutomationExecutionMetadataList ?? [];
        const bootstrap = executions.find(
            (e) => e.DocumentName?.includes('bootstrap') || e.DocumentName?.includes('k8s'),
        );
        return bootstrap?.AutomationExecutionId;
    } catch {
        return undefined;
    }
}

// ============================================================================
// Step 3 — Diagnose failure mode on the instance
// ============================================================================

/**
 * Run a lightweight diagnostic on the instance to determine:
 *   - Whether podSubnet is missing from kubeadm-config
 *   - Which step markers are present / absent
 *   - Whether the bootstrap env file exists and has S3_BUCKET
 */
async function diagnoseInstance(
    ssm: SSMClient,
    instanceId: string,
): Promise<{ raw: string; envVars: Partial<BootstrapEnv> }> {
    const script = [
        'set +e',
        'export KUBECONFIG=/etc/kubernetes/super-admin.conf',
        '',
        '# Bootstrap env file (written on first boot)',
        `echo "=== BOOTSTRAP_ENV ==="`,
        `cat ${BOOTSTRAP_ENV_FILE} 2>/dev/null || echo "ENV_FILE_MISSING"`,
        '',
        '# kubeadm-config podSubnet',
        'echo "=== KUBEADM_CONFIG ==="',
        'kubectl get cm kubeadm-config -n kube-system -o jsonpath="{.data.ClusterConfiguration}" 2>&1',
        '',
        '# Step markers',
        'echo "=== MARKERS ==="',
        'echo "CALICO_MARKER=$(test -f /etc/kubernetes/.calico-installed && echo present || echo absent)"',
        'echo "CCM_MARKER=$(test -f /etc/kubernetes/.ccm-installed && echo present || echo absent)"',
        '',
        '# Bootstrap run summary',
        'echo "=== SUMMARY ==="',
        'cat /opt/k8s-bootstrap/run_summary.json 2>/dev/null || echo "NO_SUMMARY"',
        '',
        '# Node status',
        'echo "=== NODE_STATUS ==="',
        'kubectl get nodes --no-headers 2>&1',
        '',
        '# Calico pods',
        'echo "=== CALICO_PODS ==="',
        'kubectl get pods -n calico-system --no-headers 2>&1',
    ].join('\n');

    const result = await runOnInstance(ssm, instanceId, [script]);

    if (result.status !== 'Success') {
        log.warn(`Instance diagnostic failed (${result.status}) — ${result.stderr.substring(0, 200)}`);
        return { raw: '', envVars: {} };
    }

    // Parse bootstrap-env file into key=value pairs
    const envSection = extractSection(result.stdout, 'BOOTSTRAP_ENV', 'KUBEADM_CONFIG');
    const envVars: Partial<BootstrapEnv> = {};

    for (const line of envSection.split('\n')) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=').trim();
        if (key && value && !line.startsWith('#')) {
            (envVars as Record<string, string>)[key.trim()] = value;
        }
    }

    return { raw: result.stdout, envVars };
}

// ============================================================================
// Step 4 — Build repair plan
// ============================================================================

function buildRepairPlan(
    automationOutput: string,
    instanceOutput: string,
): RepairPlan {
    const combined = automationOutput + '\n' + instanceOutput;

    const detectedFailures = FAILURE_PATTERNS
        .filter((p) => p.match(combined))
        .map((p) => p.id);

    // Check kubeadm-config section for missing podSubnet
    const kubeadmConfig = extractSection(instanceOutput, 'KUBEADM_CONFIG', 'MARKERS');
    const podSubnetMissing = !kubeadmConfig.includes('podSubnet');
    if (podSubnetMissing && !detectedFailures.includes('missing-pod-subnet')) {
        detectedFailures.push('missing-pod-subnet');
    }

    // Determine which markers to remove for retry
    const markerSection = extractSection(instanceOutput, 'MARKERS', 'SUMMARY');
    const markersToRemove: string[] = [];

    if (markerSection.includes('CALICO_MARKER=present')) {
        markersToRemove.push(RETRYABLE_MARKERS['install-calico']);
    }
    if (markerSection.includes('CCM_MARKER=present')) {
        markersToRemove.push(RETRYABLE_MARKERS['install-ccm']);
    }

    return {
        failures:        detectedFailures,
        markersToRemove,
        patchPodSubnet:  podSubnetMissing,
        rerunBootstrap:  detectedFailures.length > 0,
    };
}

// ============================================================================
// Step 5 — Apply repair on the instance
// ============================================================================

/**
 * Patch podSubnet into kubeadm-config using Python (not sed).
 * Raises on any failure because Calico cannot deploy without it.
 */
async function applyRepair(
    ssm: SSMClient,
    instanceId: string,
    plan: RepairPlan,
    dryRun: boolean,
): Promise<boolean> {

    if (plan.failures.length === 0) {
        log.success('No actionable failures detected — cluster appears healthy');
        return true;
    }

    log.info(`Detected failure modes: ${plan.failures.join(', ')}`);

    const markerRemovals = plan.markersToRemove.map((m) => `rm -f ${m}`);

    // The podSubnet patch uses inline Python — no sed, no temp files, no subprocess spawning
    const podSubnetPatch = plan.patchPodSubnet
        ? [
            'echo "=== FIX_PODSUBNET ==="',
            'python3 - <<\'PYEOF\'',
            'import yaml, json, subprocess, sys',
            'env = {"KUBECONFIG": "/etc/kubernetes/super-admin.conf", "PATH": "/usr/local/bin:/usr/bin:/bin"}',
            'r = subprocess.run(["kubectl","get","cm","kubeadm-config","-n","kube-system","-o","jsonpath={.data.ClusterConfiguration}"], capture_output=True, text=True, env=env)',
            'if r.returncode != 0:',
            '    print("PODSUBNET_ERROR: " + r.stderr.strip()); sys.exit(1)',
            'cfg = yaml.safe_load(r.stdout)',
            `if cfg.get("networking", {}).get("podSubnet") == "${POD_CIDR}":`,
            '    print("PODSUBNET_ALREADY_SET"); sys.exit(0)',
            `cfg.setdefault("networking", {})["podSubnet"] = "${POD_CIDR}"`,
            'patch = json.dumps({"data": {"ClusterConfiguration": yaml.dump(cfg, default_flow_style=False)}})',
            'p = subprocess.run(["kubectl","patch","cm","kubeadm-config","-n","kube-system","--type","merge","-p",patch], capture_output=True, text=True, env=env)',
            'if p.returncode != 0:',
            '    print("PODSUBNET_ERROR: " + p.stderr.strip()); sys.exit(1)',
            'print("PODSUBNET_PATCHED")',
            'PYEOF',
        ]
        : ['echo "=== FIX_PODSUBNET ==="; echo "PODSUBNET_SKIP"'];

    const fixScript = [
        'set -e',
        'export KUBECONFIG=/etc/kubernetes/super-admin.conf',
        '',
        '# Remove stale step markers',
        'echo "=== FIX_MARKERS ==="',
        ...markerRemovals,
        'echo "MARKERS_REMOVED"',
        '',
        ...podSubnetPatch,
    ].join('\n');

    if (dryRun) {
        log.info('[DRY RUN] Would run the following repair script on the instance:');
        console.log(fixScript);
        return true;
    }

    log.info('Applying repair on instance...');
    const result = await runOnInstance(ssm, instanceId, [fixScript]);

    if (result.status !== 'Success') {
        log.warn(`Repair script failed (${result.status}): ${result.stderr.substring(0, 300)}`);
        return false;
    }

    const output = result.stdout;

    // Verify podSubnet patch
    if (plan.patchPodSubnet) {
        if (output.includes('PODSUBNET_PATCHED')) {
            log.success(`podSubnet=${POD_CIDR} patched into kubeadm-config`);
        } else if (output.includes('PODSUBNET_ALREADY_SET')) {
            log.info('podSubnet already correct — no patch needed');
        } else if (output.includes('PODSUBNET_ERROR')) {
            const errLine = output.split('\n').find((l) => l.includes('PODSUBNET_ERROR')) ?? '';
            log.warn(`podSubnet patch failed: ${errLine}`);
            return false;
        }
    }

    if (output.includes('MARKERS_REMOVED')) {
        log.success(`Removed step markers: ${plan.markersToRemove.join(', ') || 'none'}`);
    }

    return true;
}

// ============================================================================
// Step 6 — Re-run bootstrap
// ============================================================================

/**
 * Re-run control_plane.py on the instance with the full environment.
 * Env vars are sourced from the instance's bootstrap-env file, supplemented
 * by any values explicitly passed via CLI.
 */
async function rerunBootstrap(
    ssm: SSMClient,
    instanceId: string,
    instanceEnv: Partial<BootstrapEnv>,
    overrides: Partial<BootstrapEnv>,
    dryRun: boolean,
): Promise<boolean> {

    const merged: BootstrapEnv = {
        S3_BUCKET:      overrides.S3_BUCKET      ?? instanceEnv.S3_BUCKET      ?? '',
        SSM_PREFIX:     overrides.SSM_PREFIX      ?? instanceEnv.SSM_PREFIX      ?? '/k8s/development',
        AWS_REGION:     overrides.AWS_REGION      ?? instanceEnv.AWS_REGION      ?? 'eu-west-1',
        K8S_VERSION:    overrides.K8S_VERSION     ?? instanceEnv.K8S_VERSION     ?? '1.35.1',
        POD_CIDR:       overrides.POD_CIDR        ?? instanceEnv.POD_CIDR        ?? '192.168.0.0/16',
        SERVICE_CIDR:   overrides.SERVICE_CIDR    ?? instanceEnv.SERVICE_CIDR    ?? '10.96.0.0/12',
        MOUNT_POINT:    overrides.MOUNT_POINT     ?? instanceEnv.MOUNT_POINT     ?? '/data',
        CALICO_VERSION: overrides.CALICO_VERSION  ?? instanceEnv.CALICO_VERSION  ?? 'v3.29.3',
        ENVIRONMENT:    overrides.ENVIRONMENT     ?? instanceEnv.ENVIRONMENT     ?? 'development',
    };

    if (!merged.S3_BUCKET) {
        log.warn(
            'S3_BUCKET is not set. Provide it via --bucket or ensure the instance has ' +
            `${BOOTSTRAP_ENV_FILE} with S3_BUCKET=<value>.`,
        );
        return false;
    }

    const envPrefix = Object.entries(merged)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');

    const rerunCmd = `${envPrefix} python3 ${BOOTSTRAP_SCRIPT}`;

    if (dryRun) {
        log.info('[DRY RUN] Would re-run bootstrap with:');
        log.info(`  ${rerunCmd}`);
        return true;
    }

    log.info('Re-running control plane bootstrap...');
    log.info(`  S3_BUCKET=${merged.S3_BUCKET}, K8S_VERSION=${merged.K8S_VERSION}, ENV=${merged.ENVIRONMENT}`);

    const result = await runOnInstance(
        ssm,
        instanceId,
        [rerunCmd],
        BOOTSTRAP_TIMEOUT_S,
    );

    if (result.status !== 'Success') {
        log.warn(`Bootstrap re-run failed (${result.status})`);
        if (result.stderr) log.warn(result.stderr.substring(0, 500));
        return false;
    }

    // Check for failure markers in the bootstrap output
    const failureLines = result.stdout
        .split('\n')
        .filter((l) => l.includes('"level": "ERROR"') || l.includes('"level": "FATAL"'));

    if (failureLines.length > 0) {
        log.warn('Bootstrap completed with errors:');
        for (const line of failureLines.slice(0, 5)) {
            log.warn(`  ${line}`);
        }
        return false;
    }

    log.success('Bootstrap re-run completed');
    return true;
}

// ============================================================================
// Step 7 — Verify recovery
// ============================================================================

/**
 * Check that the node reached Ready and Calico pods are running.
 * Polls for up to 120 s to allow Calico time to initialise.
 */
async function verifyRecovery(
    ssm: SSMClient,
    instanceId: string,
): Promise<boolean> {
    log.info('Verifying cluster health after repair...');

    const verifyScript = [
        'set +e',
        'export KUBECONFIG=/etc/kubernetes/super-admin.conf',
        'echo "=== NODE ==="',
        'kubectl get nodes --no-headers 2>&1',
        'echo "=== CALICO ==="',
        'kubectl get pods -n calico-system --no-headers 2>&1',
        'echo "=== KUBEADM_CONFIG ==="',
        'kubectl get cm kubeadm-config -n kube-system -o jsonpath="{.data.ClusterConfiguration}" 2>&1 | grep podSubnet || echo "podSubnet MISSING"',
    ].join('\n');

    // Poll up to 2 minutes for node to become Ready
    for (let attempt = 1; attempt <= 24; attempt++) {
        const result = await runOnInstance(ssm, instanceId, [verifyScript]);

        if (result.status !== 'Success') {
            log.warn(`Verification command failed (attempt ${attempt}/24)`);
            await sleep(5_000);
            continue;
        }

        const nodeSection   = extractSection(result.stdout, 'NODE',   'CALICO');
        const calicoSection = extractSection(result.stdout, 'CALICO', 'KUBEADM_CONFIG');
        const configSection = extractSection(result.stdout, 'KUBEADM_CONFIG', '');

        const nodeReady    = nodeSection.includes('Ready') && !nodeSection.includes('NotReady');
        const calicoOk     = calicoSection.includes('Running');
        const subnetOk     = configSection.includes('podSubnet');

        log.info(
            `  [${attempt}/24] Node: ${nodeReady ? '✓ Ready' : '⏳ NotReady'} | ` +
            `Calico: ${calicoOk ? '✓ Running' : '⏳ not yet'} | ` +
            `podSubnet: ${subnetOk ? '✓' : '✗'}`,
        );

        if (nodeReady && calicoOk && subnetOk) {
            log.success('Cluster is healthy — node Ready, Calico running, podSubnet set');
            return true;
        }

        await sleep(5_000);
    }

    log.warn('Node did not reach Ready state within 2 minutes — Calico may need more time');
    log.info('Run the troubleshooter for a full status report:');
    log.info('  yarn tsx scripts/local/control-plane-troubleshoot.ts');
    return false;
}

// ============================================================================
// Utility
// ============================================================================

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

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const logFile    = startFileLogging('control-plane-autofix');
    const awsConfig  = buildAwsConfig(args);
    const auth       = resolveAuth(awsConfig.profile);
    const env        = (args.env as string)  || 'development';
    const dryRun     = args['dry-run'] === true;
    const noRerun    = args['no-rerun'] === true;
    const skipVerify = args['skip-verify'] === true;
    const timeoutS   = Number.parseInt(args.timeout as string, 10);
    const autoId     = args['automation-id'] as string | undefined;
    const bucketArg  = args.bucket as string | undefined;

    log.header('  🔧 Control Plane Auto-Fix');
    log.config('Configuration', {
        'Auth':           auth.mode,
        'Region':         awsConfig.region,
        'Environment':    env,
        'Dry run':        dryRun ? 'YES' : 'no',
        'Automation ID':  autoId ?? '(latest)',
        'Timeout':        `${timeoutS}s`,
        'Re-run':         noRerun ? 'disabled' : 'enabled',
    });

    const ssm = createSSMClient(awsConfig.region, awsConfig.credentials);

    // ── 1. Resolve instance ─────────────────────────────────────────────
    log.step(1, 4, 'Resolving control plane instance...');
    const instanceId = await resolveInstanceId(ssm, env);
    log.info(`  Instance: ${instanceId}`);

    // ── 2. Watch automation ─────────────────────────────────────────────
    log.step(2, 4, 'Checking SSM Automation status...');
    const { status: autoStatus, output: autoOutput } = await watchAutomation(
        ssm,
        autoId,
        timeoutS,
    );

    if (autoStatus === 'Success') {
        log.success('Automation completed successfully — running quick health check');
        if (!skipVerify) {
            const healthy = await verifyRecovery(ssm, instanceId);
            stopFileLogging();
            log.info(`\nLog saved to: ${logFile}`);
            process.exit(healthy ? 0 : 1);
        }
        process.exit(0);
    }

    if (autoStatus !== 'Failed' && autoStatus !== 'Unknown' && autoStatus !== 'TimedOut') {
        log.warn(`Unexpected automation status: ${autoStatus} — proceeding with diagnostics`);
    }

    // ── 3. Diagnose and plan ─────────────────────────────────────────────
    log.step(3, 4, 'Diagnosing failure mode...');
    const { raw: instanceOutput, envVars: instanceEnv } = await diagnoseInstance(ssm, instanceId);

    const plan = buildRepairPlan(autoOutput, instanceOutput);

    if (plan.failures.length === 0) {
        log.success('No known failure modes detected — cluster may be healthy already');
        log.info('Run the troubleshooter for a full status report:');
        log.info('  yarn tsx scripts/local/control-plane-troubleshoot.ts');
        stopFileLogging();
        log.info(`\nLog saved to: ${logFile}`);
        process.exit(0);
    }

    log.info('Repair plan:');
    for (const f of plan.failures) {
        const desc = FAILURE_PATTERNS.find((p) => p.id === f)?.description ?? f;
        log.warn(`  • ${desc}`);
    }
    if (plan.markersToRemove.length > 0) {
        log.info(`  • Remove markers: ${plan.markersToRemove.join(', ')}`);
    }

    // ── 4. Apply repair ──────────────────────────────────────────────────
    log.step(4, 4, 'Applying repair...');

    const repairOk = await applyRepair(ssm, instanceId, plan, dryRun);
    if (!repairOk) {
        log.fail('Repair failed — manual intervention required');
        log.info('Run the troubleshooter for details:');
        log.info('  yarn tsx scripts/local/control-plane-troubleshoot.ts --fix');
        stopFileLogging();
        log.info(`\nLog saved to: ${logFile}`);
        process.exit(1);
    }

    // ── 5. Re-run bootstrap ──────────────────────────────────────────────
    if (!noRerun && !dryRun) {
        const overrides: Partial<BootstrapEnv> = {};
        if (bucketArg) overrides.S3_BUCKET = bucketArg;
        if (env)       overrides.ENVIRONMENT = env;
        overrides.AWS_REGION = awsConfig.region;
        overrides.SSM_PREFIX = `/k8s/${env}`;

        const rerunOk = await rerunBootstrap(ssm, instanceId, instanceEnv, overrides, dryRun);
        if (!rerunOk) {
            log.fail('Bootstrap re-run failed');
            stopFileLogging();
            log.info(`\nLog saved to: ${logFile}`);
            process.exit(1);
        }
    } else if (noRerun) {
        log.info('Skipping bootstrap re-run (--no-rerun)');
    }

    // ── 6. Verify ────────────────────────────────────────────────────────
    if (!skipVerify && !dryRun) {
        const healthy = await verifyRecovery(ssm, instanceId);
        stopFileLogging();
        log.info(`\nLog saved to: ${logFile}`);
        process.exit(healthy ? 0 : 1);
    }

    log.success('Auto-fix complete');
    stopFileLogging();
    log.info(`\nLog saved to: ${logFile}`);
    process.exit(0);
}

main().catch((error: Error) => {
    log.fatal(`Control plane auto-fix failed: ${error.message}`);
});
