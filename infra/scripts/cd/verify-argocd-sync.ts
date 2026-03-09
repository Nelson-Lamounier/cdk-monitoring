#!/usr/bin/env npx tsx
/**
 * Verify ArgoCD Sync (via SSM send-command)
 *
 * Polls the ArgoCD API to verify all expected Applications have reached
 * Synced + Healthy state after a Git push. Instead of calling ArgoCD
 * directly (blocked by ingress SG), runs curl on the control plane
 * node via SSM send-command.
 *
 * Modes:
 *   --mode sync   (default)  Full sync polling until all apps are Synced + Healthy
 *   --mode health            Quick reachability check — poll until HTTP 200
 *
 * Steps:
 *   1. Resolve control plane instance ID via SSM
 *   2. Retrieve CI bot token (env ARGOCD_TOKEN or Secrets Manager)
 *   3. Poll ArgoCD API (via SSM) per mode
 *
 * Graceful skip: if instance ID or token is unavailable (Day-0), the
 * script exits 0 with a warning annotation instead of failing.
 *
 * Usage:
 *   npx tsx infra/scripts/cd/verify-argocd-sync.ts \
 *     --environment development --region eu-west-1 --mode sync
 *
 * Called by:
 *   - .github/workflows/gitops-k8s.yml (mode=sync)
 *   - .github/workflows/_deploy-ssm-automation.yml (mode=health)
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SSMClient,
  GetParameterCommand,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '@repo/script-utils/aws.js';
import {
  emitAnnotation,
  maskSecret,
  writeSummary,
} from '@repo/script-utils/github.js';
import logger from '@repo/script-utils/logger.js';

// =============================================================================
// CLI argument parsing
// =============================================================================

const args = parseArgs(
  [
    {
      name: 'environment',
      description: 'Deployment environment',
      hasValue: true,
      default: 'development',
    },
    {
      name: 'region',
      description: 'AWS region',
      hasValue: true,
      default: 'eu-west-1',
    },
    {
      name: 'profile',
      description: 'AWS profile (local only)',
      hasValue: true,
    },
    {
      name: 'mode',
      description: 'Verification mode: sync (full polling) or health (reachability only)',
      hasValue: true,
      default: 'sync',
    },
    {
      name: 'poll-interval',
      description: 'Seconds between polls',
      hasValue: true,
      default: '30',
    },
    {
      name: 'max-polls',
      description: 'Maximum number of poll attempts',
      hasValue: true,
      default: '12',
    },
  ],
  'Verify ArgoCD sync/health status via SSM send-command.',
);

const environment = args.environment as string;
const mode = (args.mode as string) || 'sync';
const awsConfig = buildAwsConfig(args);
const pollInterval = parseInt(args['poll-interval'] as string, 10) || 30;
const maxPolls = parseInt(args['max-polls'] as string, 10) || 12;

// ArgoCD server ClusterIP address inside K8s (HTTPS with self-signed cert).
// Bypasses Traefik (whose IngressRoute requires websecure + Host header).
const ARGOCD_BASE = 'https://argocd-server.argocd.svc.cluster.local/argocd';

const ssmPrefix = `/k8s/${environment}`;

// =============================================================================
// Expected ArgoCD Applications
// =============================================================================

const EXPECTED_APPS = [
  'nextjs',
  'traefik',
  'metrics-server',
  'local-path-provisioner',
  'monitoring',
];

// =============================================================================
// AWS Clients
// =============================================================================

const ssm = new SSMClient({
  region: awsConfig.region,
  credentials: awsConfig.credentials,
});

const secretsManager = new SecretsManagerClient({
  region: awsConfig.region,
  credentials: awsConfig.credentials,
});

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

/** Fetch a secret from Secrets Manager, returning undefined if missing. */
async function getSecret(secretId: string): Promise<string | undefined> {
  try {
    const result = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    return result.SecretString || undefined;
  } catch {
    return undefined;
  }
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a curl command on the control plane node via SSM send-command.
 * Returns the stdout output (curl response body or HTTP code).
 */
async function ssmCurl(
  instanceId: string,
  curlCommand: string,
): Promise<string | undefined> {
  try {
    const sendResult = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands: [curlCommand] },
        TimeoutSeconds: 30,
      }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) return undefined;

    // Wait for command to finish (poll up to 15s)
    for (let wait = 0; wait < 5; wait++) {
      await sleep(3000);
      try {
        const invocation = await ssm.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
          }),
        );

        if (
          invocation.Status === 'Success' ||
          invocation.Status === 'Failed'
        ) {
          return invocation.StandardOutputContent?.trim() || undefined;
        }
      } catch {
        // InvocationDoesNotExist — command still pending
      }
    }

    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`SSM send-command error: ${message}`);
    return undefined;
  }
}

// =============================================================================
// ArgoCD API Types
// =============================================================================

interface AppStatus {
  app: string;
  syncStatus: string;
  healthStatus: string;
  error?: string;
  reachable: boolean;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Resolve the control plane instance ID from SSM Parameter Store.
 * Used to route ArgoCD API calls via SSM send-command (localhost).
 */
async function resolveControlPlaneInstance(): Promise<string | undefined> {
  logger.step(1, 3, 'Resolve Control Plane Instance');

  const instanceId = await getParam(
    `${ssmPrefix}/bootstrap/control-plane-instance-id`,
  );
  if (!instanceId) {
    emitAnnotation(
      'warning',
      'Could not resolve control-plane instance ID -- ArgoCD verification skipped',
      'ArgoCD Endpoint',
    );
    logger.warn(
      'Could not resolve control-plane instance ID from SSM -- skipping verification',
    );
    return undefined;
  }

  logger.info(`Control plane instance: ${instanceId}`);
  return instanceId;
}

/**
 * Retrieve the ArgoCD CI bot token.
 *
 * Priority:
 *   1. ARGOCD_TOKEN env var (set by SSM pipeline from previous step output)
 *   2. Secrets Manager (used by GitOps pipeline)
 *
 * @returns Bearer token or undefined if not available
 */
async function retrieveCIToken(): Promise<string | undefined> {
  const totalSteps = mode === 'health' ? 2 : 3;
  logger.step(2, totalSteps, 'Retrieve CI Bot Token');

  // Check env var first (SSM pipeline passes token from previous step)
  const envToken = process.env.ARGOCD_TOKEN;
  if (envToken) {
    maskSecret(envToken);
    logger.success('CI bot token loaded from ARGOCD_TOKEN env var');
    return envToken;
  }

  // Fall back to Secrets Manager
  const secretId = `k8s/${environment}/argocd-ci-token`;
  const token = await getSecret(secretId);

  if (!token) {
    emitAnnotation(
      'warning',
      'ArgoCD CI token not found -- skipping verification',
      'ArgoCD Token',
    );
    logger.warn('ArgoCD CI token not found in Secrets Manager -- skipping');
    return undefined;
  }

  maskSecret(token);
  logger.success('CI bot token retrieved from Secrets Manager');
  return token;
}

/**
 * Probe a single ArgoCD application to surface auth/network errors early.
 * Runs via SSM send-command on the control plane node.
 */
async function diagnosticProbe(
  instanceId: string,
  token: string,
): Promise<void> {
  const probeApp = EXPECTED_APPS[0];
  const curlCmd = `curl -sk -w '\\n%{http_code}' --max-time 10 -H 'Authorization: Bearer ${token}' '${ARGOCD_BASE}/api/v1/applications/${probeApp}' 2>/dev/null`;

  logger.info(
    `Diagnostic probe: ArgoCD API /applications/${probeApp} (via SSM)`,
  );

  const output = await ssmCurl(instanceId, curlCmd);

  if (!output || output.includes('UNREACHABLE')) {
    emitAnnotation(
      'error',
      'ArgoCD API is unreachable via SSM send-command',
      'ArgoCD Connectivity',
    );
    logger.error('  ArgoCD API unreachable via SSM');
    return;
  }

  // Output format: body\nHTTP_CODE
  const lines = output.split('\n');
  const httpCode = lines[lines.length - 1]?.trim();
  logger.info(`  HTTP Status: ${httpCode}`);

  if (httpCode === '401' || httpCode === '403') {
    emitAnnotation(
      'error',
      'Authentication failed. The CI bot token may be expired or revoked. Regenerate it: just argocd-ci-token',
      'ArgoCD Auth',
    );
  } else if (httpCode && parseInt(httpCode, 10) >= 500) {
    logger.warn('  ArgoCD server returned a server error');
  }

  console.log('');
}

/**
 * Check the sync and health status of a single ArgoCD application.
 * Runs via SSM send-command on the control plane node.
 */
async function checkApp(
  instanceId: string,
  token: string,
  app: string,
): Promise<AppStatus> {
  // Curl that returns JSON body only (for parsing sync/health status)
  const curlCmd = `curl -sk --max-time 10 -H 'Authorization: Bearer ${token}' '${ARGOCD_BASE}/api/v1/applications/${app}' 2>/dev/null`;

  const output = await ssmCurl(instanceId, curlCmd);

  if (!output) {
    return {
      app,
      syncStatus: 'Unknown',
      healthStatus: 'Unknown',
      reachable: false,
    };
  }

  try {
    const data = JSON.parse(output) as {
      error?: string;
      status?: {
        sync?: { status?: string };
        health?: { status?: string };
      };
    };

    if (data.error) {
      return {
        app,
        syncStatus: 'Unknown',
        healthStatus: 'Unknown',
        error: data.error,
        reachable: true,
      };
    }

    return {
      app,
      syncStatus: data.status?.sync?.status || 'Unknown',
      healthStatus: data.status?.health?.status || 'Unknown',
      reachable: true,
    };
  } catch {
    return {
      app,
      syncStatus: 'Unknown',
      healthStatus: 'Unknown',
      error: 'Invalid JSON response',
      reachable: true,
    };
  }
}

/**
 * Poll all expected ArgoCD Applications until all are Synced + Healthy.
 *
 * @returns true if all apps passed, false if timed out
 */
async function waitForSync(
  instanceId: string,
  token: string,
): Promise<boolean> {
  logger.step(3, 3, 'Wait for ArgoCD Sync');

  console.log('## ArgoCD Sync Verification (via SSM)');
  console.log('');
  console.log(`Instance: ${instanceId}`);
  console.log(`Expected Applications: ${EXPECTED_APPS.join(', ')}`);
  console.log(`Poll interval: ${pollInterval}s, max polls: ${maxPolls}`);
  console.log('');

  // Run diagnostic probe on first app
  await diagnosticProbe(instanceId, token);

  for (let poll = 1; poll <= maxPolls; poll++) {
    const timestamp = new Date().toISOString().slice(11, 19);
    let allSynced = true;

    console.log(`--- Poll ${poll}/${maxPolls} (${timestamp}) ---`);

    for (const app of EXPECTED_APPS) {
      const status = await checkApp(instanceId, token, app);

      if (!status.reachable) {
        console.log(`  ${app}: [WARN] API unreachable`);
        allSynced = false;
      } else if (status.error) {
        console.log(`  ${app}: [ERROR] ${status.error}`);
        allSynced = false;
      } else if (
        status.syncStatus === 'Synced' &&
        status.healthStatus === 'Healthy'
      ) {
        console.log(`  ${app}: [PASS] Synced + Healthy`);
      } else {
        console.log(
          `  ${app}: [WAIT] Sync=${status.syncStatus} Health=${status.healthStatus}`,
        );
        allSynced = false;
      }
    }

    if (allSynced) {
      console.log('');
      console.log(
        `## [PASS] All ${EXPECTED_APPS.length} Applications are Synced and Healthy`,
      );

      writeSummary('## ArgoCD Sync Verification');
      writeSummary('');
      writeSummary(
        `✅ All ${EXPECTED_APPS.length} Applications are **Synced + Healthy**`,
      );
      writeSummary('');
      writeSummary('| Application | Sync | Health |');
      writeSummary('|:---|:---|:---|');
      for (const app of EXPECTED_APPS) {
        writeSummary(`| ${app} | Synced | Healthy |`);
      }

      return true;
    }

    if (poll < maxPolls) {
      await sleep(pollInterval * 1000);
    }
  }

  // Timed out
  const totalWait = maxPolls * pollInterval;
  console.log('');
  console.log(
    `## [WARN] Some Applications did not reach Synced+Healthy within ${totalWait}s`,
  );
  console.log(
    'This is informational -- ArgoCD will continue retrying.',
  );

  writeSummary('## ArgoCD Sync Verification');
  writeSummary('');
  writeSummary(
    `⚠️ Some Applications did not reach Synced+Healthy within ${totalWait}s`,
  );

  return false;
}

// =============================================================================
// Health Check Mode
// =============================================================================

/**
 * Quick reachability check: poll ArgoCD API until HTTP 200.
 * Used by the SSM pipeline after bootstrap completes.
 */
async function healthCheck(
  instanceId: string,
  token: string,
): Promise<boolean> {
  const totalWait = maxPolls * pollInterval;
  logger.info(
    `Health check: polling until HTTP 200 (timeout: ${totalWait}s)...`,
  );

  const curlCmd = `curl -sk -o /dev/null -w '%{http_code}' --max-time 10 -H 'Authorization: Bearer ${token}' '${ARGOCD_BASE}/api/v1/applications' 2>/dev/null`;

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    const output = await ssmCurl(instanceId, curlCmd);
    const httpCode = output?.trim() || '000';

    if (httpCode === '200') {
      logger.success(`ArgoCD is reachable via SSM (HTTP ${httpCode})`);
      writeSummary('## ArgoCD Health Check');
      writeSummary('');
      writeSummary('✅ ArgoCD server is reachable (HTTP 200)');
      return true;
    }

    logger.info(
      `  Attempt ${attempt}/${maxPolls} -- HTTP ${httpCode}, retrying in ${pollInterval}s...`,
    );
    await sleep(pollInterval * 1000);
  }

  emitAnnotation(
    'error',
    `ArgoCD unreachable after ${totalWait}s -- bootstrapArgoCD may have failed`,
    'ArgoCD Health',
  );
  return false;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const modeLabel = mode === 'health' ? 'Health Check' : 'Sync Verification';
  logger.header(`Verify ArgoCD (${modeLabel})`);
  logger.info(`Environment: ${environment}`);
  logger.info(`Region:      ${awsConfig.region}`);
  logger.info(`Mode:        ${mode}`);
  console.log('');

  // Step 1: Resolve control plane instance
  const instanceId = await resolveControlPlaneInstance();
  if (!instanceId) {
    logger.warn('Exiting gracefully -- no control plane instance available');
    process.exit(0);
  }

  // Step 2: Retrieve token
  const token = await retrieveCIToken();
  if (!token) {
    logger.warn('Exiting gracefully -- no CI bot token available');
    process.exit(0);
  }

  // Step 3: Execute mode
  if (mode === 'health') {
    const reachable = await healthCheck(instanceId, token);
    if (!reachable) {
      process.exit(1);
    }
  } else {
    const success = await waitForSync(instanceId, token);
    if (!success) {
      emitAnnotation(
        'warning',
        'Some ArgoCD Applications did not reach Synced+Healthy -- ArgoCD will continue retrying',
        'ArgoCD Sync Timeout',
      );
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  emitAnnotation(
    'error',
    `ArgoCD sync verification failed: ${message}`,
    'ArgoCD Sync Error',
  );
  logger.fatal(`ArgoCD sync verification failed: ${message}`);
});
