#!/usr/bin/env npx tsx
/**
 * Verify ArgoCD Sync
 *
 * Polls the ArgoCD API to verify all expected Applications have reached
 * Synced + Healthy state after a Git push. Consolidates three workflow
 * steps into a single script:
 *
 *   1. Resolve ArgoCD endpoint via SSM (EIP behind Traefik)
 *   2. Retrieve CI bot token from Secrets Manager
 *   3. Poll ArgoCD API until all apps are Synced + Healthy
 *
 * Graceful skip: if EIP or token is unavailable (Day-0), the script
 * exits 0 with a warning annotation instead of failing the pipeline.
 *
 * Usage:
 *   npx tsx infra/scripts/cd/verify-argocd-sync.ts \
 *     --environment development \
 *     --region eu-west-1
 *
 * Called by: .github/workflows/gitops-k8s.yml (verify-argocd job)
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
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
  'Verify ArgoCD sync status for all expected Applications.',
);

const environment = args.environment as string;
const awsConfig = buildAwsConfig(args);
const pollInterval = parseInt(args['poll-interval'] as string, 10) || 30;
const maxPolls = parseInt(args['max-polls'] as string, 10) || 12;
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
 * Resolve the ArgoCD URL from the EIP stored in SSM Parameter Store.
 * ArgoCD is behind Traefik on the control plane node.
 *
 * @returns ArgoCD base URL or undefined if EIP is not available
 */
async function resolveArgoCDEndpoint(): Promise<string | undefined> {
  logger.step(1, 3, 'Resolve ArgoCD Endpoint');

  const eip = await getParam(`${ssmPrefix}/elastic-ip`);
  if (!eip) {
    emitAnnotation(
      'warning',
      'Could not resolve EIP — ArgoCD verification skipped',
      'ArgoCD Endpoint',
    );
    logger.warn('Could not resolve EIP from SSM — skipping verification');
    return undefined;
  }

  const url = `http://${eip}/argocd`;
  logger.info(`ArgoCD URL: ${url}`);
  return url;
}

/**
 * Retrieve the ArgoCD CI bot token from Secrets Manager.
 * The token is created by bootstrap_argocd.py during cluster setup.
 *
 * @returns Bearer token or undefined if not available
 */
async function retrieveCIToken(): Promise<string | undefined> {
  logger.step(2, 3, 'Retrieve CI Bot Token');

  const secretId = `k8s/${environment}/argocd-ci-token`;
  const token = await getSecret(secretId);

  if (!token) {
    emitAnnotation(
      'warning',
      'ArgoCD CI token not found — skipping verification',
      'ArgoCD Token',
    );
    logger.warn('ArgoCD CI token not found in Secrets Manager — skipping');
    return undefined;
  }

  maskSecret(token);
  logger.success('CI bot token retrieved and masked');
  return token;
}

/**
 * Probe a single ArgoCD application to surface auth/network errors early.
 */
async function diagnosticProbe(
  baseUrl: string,
  token: string,
): Promise<void> {
  const probeApp = EXPECTED_APPS[0];
  const probeUrl = `${baseUrl}/api/v1/applications/${probeApp}`;

  logger.info(`Diagnostic probe: GET ${probeUrl}`);

  try {
    const response = await fetch(probeUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    logger.info(`  HTTP Status: ${response.status}`);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const preview = body.slice(0, 500);
      logger.warn(`  Response body (first 500 chars): ${preview}`);

      if (response.status === 401 || response.status === 403) {
        emitAnnotation(
          'error',
          'Authentication failed. The CI bot token may be expired or revoked. Regenerate it: just argocd-ci-token',
          'ArgoCD Auth',
        );
      } else if (response.status >= 500) {
        logger.warn('  ArgoCD server returned a server error');
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation(
      'error',
      `ArgoCD API is unreachable: ${message}`,
      'ArgoCD Connectivity',
    );
    logger.error(`  ArgoCD API unreachable: ${message}`);
  }

  console.log('');
}

/**
 * Check the sync and health status of a single ArgoCD application.
 */
async function checkApp(
  baseUrl: string,
  token: string,
  app: string,
): Promise<AppStatus> {
  try {
    const response = await fetch(
      `${baseUrl}/api/v1/applications/${app}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      return {
        app,
        syncStatus: 'Unknown',
        healthStatus: 'Unknown',
        error: `HTTP ${response.status}`,
        reachable: true,
      };
    }

    const data = (await response.json()) as {
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
      reachable: false,
    };
  }
}

/**
 * Poll all expected ArgoCD Applications until all are Synced + Healthy.
 *
 * @returns true if all apps passed, false if timed out
 */
async function waitForSync(
  baseUrl: string,
  token: string,
): Promise<boolean> {
  logger.step(3, 3, 'Wait for ArgoCD Sync');

  console.log('## ArgoCD Sync Verification');
  console.log('');
  console.log(`Endpoint: ${baseUrl}`);
  console.log(`Expected Applications: ${EXPECTED_APPS.join(', ')}`);
  console.log(`Poll interval: ${pollInterval}s, max polls: ${maxPolls}`);
  console.log('');

  // Run diagnostic probe on first app
  await diagnosticProbe(baseUrl, token);

  for (let poll = 1; poll <= maxPolls; poll++) {
    const timestamp = new Date().toISOString().slice(11, 19);
    let allSynced = true;

    console.log(`--- Poll ${poll}/${maxPolls} (${timestamp}) ---`);

    for (const app of EXPECTED_APPS) {
      const status = await checkApp(baseUrl, token, app);

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
  console.log('This is informational — ArgoCD will continue retrying.');
  console.log(`Check: ${baseUrl} for details.`);

  writeSummary('## ArgoCD Sync Verification');
  writeSummary('');
  writeSummary(
    `⚠️ Some Applications did not reach Synced+Healthy within ${totalWait}s`,
  );

  return false;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  logger.header('Verify ArgoCD Sync');
  logger.info(`Environment: ${environment}`);
  logger.info(`Region:      ${awsConfig.region}`);
  console.log('');

  // Step 1: Resolve endpoint
  const argoCDUrl = await resolveArgoCDEndpoint();
  if (!argoCDUrl) {
    logger.warn('Exiting gracefully — no ArgoCD endpoint available');
    process.exit(0);
  }

  // Step 2: Retrieve token
  const token = await retrieveCIToken();
  if (!token) {
    logger.warn('Exiting gracefully — no CI bot token available');
    process.exit(0);
  }

  // Step 3: Poll for sync
  const success = await waitForSync(argoCDUrl, token);

  if (!success) {
    emitAnnotation(
      'warning',
      'Some ArgoCD Applications did not reach Synced+Healthy — ArgoCD will continue retrying',
      'ArgoCD Sync Timeout',
    );
    process.exit(1);
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
