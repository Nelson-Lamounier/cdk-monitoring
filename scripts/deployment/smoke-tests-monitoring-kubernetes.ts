#!/usr/bin/env npx tsx
/**
 * @format
 * Monitoring K8s Smoke Tests
 *
 * Validates the Monitoring K8s infrastructure after deployment.
 * Combines CloudFormation stack verification with monitoring-specific
 * health checks — replaces the verify job in the monitoring-k8s pipeline.
 *
 * Checks performed:
 *   1. CloudFormation Stack Status (Compute + Edge)
 *   2. EIP HTTP Health (Traefik ingress — Grafana, Prometheus)
 *   3. SSM Parameters (/k8s/{env}/*)
 *   4. S3 Scripts Bucket (manifests bucket accessible)
 *   5. CloudFront HTTPS (monitoring dashboard access)
 *
 * Usage:
 *   npx tsx scripts/deployment/smoke-tests-monitoring-k8s.ts development
 *   npx tsx scripts/deployment/smoke-tests-monitoring-k8s.ts production --region eu-west-1 \
 *     --cloudfront-domain monitor.example.com
 *
 * Exit codes:
 *   0 = all critical checks passed
 *   1 = critical check failed
 */

import { appendFileSync } from 'fs';

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

import logger from './logger.js';
import { getProject, type Environment } from './stacks.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type CheckStatus = 'healthy' | 'unhealthy' | 'degraded' | 'skipped';

interface CheckResult {
  name: string;
  status: CheckStatus;
  critical: boolean;
  details?: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const environment = args[0] as Environment;

function getFlag(name: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : '';
}

const region = getFlag('region') || process.env.AWS_REGION || 'eu-west-1';
const edgeRegion = 'us-east-1';

let cloudfrontDomain = getFlag('cloudfront-domain') || process.env.CLOUDFRONT_DOMAIN || '';

if (!environment) {
  console.error(
    'Usage: smoke-tests-monitoring-k8s.ts <environment> [--region <region>] [--cloudfront-domain <domain>]',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Project Configuration
// ---------------------------------------------------------------------------
const project = getProject('kubernetes');
if (!project) {
  console.error('K8s project not found in stacks configuration');
  process.exit(1);
}

// SSM prefix
const k8sSsmPrefix = `/k8s/${environment}`;

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
const cfnEdge = new CloudFormationClient({ region: edgeRegion });
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });
const ssmEdge = new SSMClient({ region: edgeRegion });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

function appendSummary(content: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, content + '\n');
  }
}

async function httpCheck(url: string, timeoutMs = 30_000): Promise<number> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    return response.status;
  } catch {
    return 0;
  }
}

// ==========================================================================
// AUTO-DISCOVERY: EIP + CloudFront from SSM
// ==========================================================================
let eipAddress = '';

async function discoverEndpoints(): Promise<void> {
  // Discover EIP from SSM (/k8s/{env}/elastic-ip)
  logger.task('Auto-discovering EIP from SSM...');
  try {
    const response = await ssm.send(
      new GetParametersCommand({ Names: [`${k8sSsmPrefix}/elastic-ip`] }),
    );
    const value = response.Parameters?.[0]?.Value;
    if (value) {
      eipAddress = value;
      logger.success(`EIP discovered: ${eipAddress}`);
    } else {
      logger.warn('EIP not found in SSM');
    }
  } catch (err) {
    logger.warn(`EIP discovery failed: ${(err as Error).message}`);
  }

  // Discover CloudFront domain from SSM (Edge region: us-east-1)
  // Monitoring uses /k8s/{env}/cloudfront/distribution-domain
  if (!cloudfrontDomain) {
    logger.task('Auto-discovering CloudFront domain from SSM (us-east-1)...');
    try {
      const response = await ssmEdge.send(
        new GetParametersCommand({
          Names: [`${k8sSsmPrefix}/cloudfront/distribution-domain`],
        }),
      );
      const value = response.Parameters?.[0]?.Value;
      if (value) {
        cloudfrontDomain = value;
        logger.success(`CloudFront domain discovered: ${cloudfrontDomain}`);
      } else {
        logger.warn('CloudFront domain not found in SSM (Edge stack may not be deployed)');
      }
    } catch (err) {
      logger.warn(`CloudFront domain discovery failed: ${(err as Error).message}`);
    }
  }
}

// ==========================================================================
// CHECK 1: CloudFormation Stack Status
// ==========================================================================
async function checkCloudFormationStacks(): Promise<CheckResult> {
  logger.task('Checking CloudFormation stack statuses...');

  // Monitoring K8s has 2 stacks: compute + edge
  const stacks = project!.stacks;

  let allHealthy = true;
  let anyFailed = false;
  const details: string[] = [];

  for (const stack of stacks) {
    const stackName = stack.getStackName(environment);
    const isEdge = stack.id === 'edge';
    const client = isEdge ? cfnEdge : cfn;
    const regionLabel = isEdge ? ` (${edgeRegion})` : '';

    try {
      const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
      const status = response.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
      const healthy = status.includes('COMPLETE') && !status.includes('ROLLBACK');

      if (healthy) {
        logger.success(`${stack.name}${regionLabel}: ${status}`);
      } else {
        logger.error(`${stack.name}${regionLabel}: ${status}`);
        allHealthy = false;
        if (status.includes('FAILED') || status.includes('ROLLBACK')) {
          anyFailed = true;
        }
      }
      details.push(`${stack.name}: ${status}`);
    } catch {
      // NOT_FOUND — Edge stack may not be deployed (development)
      if (isEdge) {
        logger.warn(`${stack.name}${regionLabel}: NOT_FOUND (Edge stack not deployed — OK for dev)`);
        details.push(`${stack.name}: NOT_FOUND (optional)`);
      } else {
        logger.error(`${stack.name}${regionLabel}: NOT_FOUND`);
        details.push(`${stack.name}: NOT_FOUND`);
        allHealthy = false;
        anyFailed = true;
      }
    }
  }

  return {
    name: 'CloudFormation Stacks',
    status: allHealthy ? 'healthy' : anyFailed ? 'unhealthy' : 'degraded',
    critical: true,
    details: details.join('; '),
  };
}

// ==========================================================================
// CHECK 2: EIP HTTP Health (Traefik / k3s ingress — Grafana)
// ==========================================================================
async function checkEipHealth(): Promise<CheckResult> {
  if (!eipAddress) {
    logger.info('No EIP available — skipping');
    return { name: 'EIP HTTP Health', status: 'skipped', critical: true };
  }

  logger.task(`Testing HTTP endpoint on EIP ${eipAddress}...`);
  let passed = 0;
  let failed = 0;

  // Test HTTP root — Traefik should respond (200, 301, 302, or 404 are all valid)
  const rootCode = await httpCheck(`http://${eipAddress}/`);
  if (rootCode > 0 && rootCode < 500) {
    logger.success(`EIP root: HTTP ${rootCode}`);
    passed++;
  } else {
    logger.error(`EIP root: HTTP ${rootCode} (Traefik/k3s not responding)`);
    failed++;
  }

  // Test Grafana endpoint (port 80 via Traefik IngressRoute)
  // Traefik routes grafana.* or /grafana to the Grafana service
  const grafanaCode = await httpCheck(`http://${eipAddress}/grafana/`, 15_000);
  if (grafanaCode > 0 && grafanaCode < 500) {
    logger.success(`Grafana via Traefik: HTTP ${grafanaCode}`);
    passed++;
  } else if (grafanaCode === 0) {
    logger.warn('Grafana via Traefik: timeout (IngressRoute may not be configured)');
  } else {
    logger.warn(`Grafana via Traefik: HTTP ${grafanaCode}`);
  }

  if (failed > 0) {
    return {
      name: 'EIP HTTP Health',
      status: 'unhealthy',
      critical: true,
      details: `${failed} endpoint(s) unreachable`,
    };
  }

  return {
    name: 'EIP HTTP Health',
    status: passed > 0 ? 'healthy' : 'degraded',
    critical: true,
  };
}

// ==========================================================================
// CHECK 3: SSM Parameters
// ==========================================================================
async function checkSsmParameters(): Promise<CheckResult> {
  logger.task('Checking SSM parameters...');

  // K8s SSM params (primary region)
  const k8sParams = [
    `${k8sSsmPrefix}/instance-id`,
    `${k8sSsmPrefix}/elastic-ip`,
    `${k8sSsmPrefix}/security-group-id`,
  ];

  let totalFound = 0;
  let totalExpected = k8sParams.length;
  const allMissing: string[] = [];

  try {
    // Check primary region
    const primaryResponse = await ssm.send(
      new GetParametersCommand({ Names: k8sParams }),
    );
    const primaryFound = primaryResponse.Parameters?.length ?? 0;
    const primaryMissing = primaryResponse.InvalidParameters ?? [];
    totalFound += primaryFound;
    allMissing.push(...primaryMissing);

    logger.keyValue('Primary region', `${primaryFound}/${k8sParams.length}`);
    for (const param of primaryMissing) {
      logger.warn(`Missing (${region}): ${param}`);
    }

    // Check edge region (if CloudFront domain was discoverable)
    const edgeParams = [
      `${k8sSsmPrefix}/cloudfront/distribution-domain`,
    ];

    try {
      const edgeResponse = await ssmEdge.send(
        new GetParametersCommand({ Names: edgeParams }),
      );
      const edgeFound = edgeResponse.Parameters?.length ?? 0;
      const edgeMissing = edgeResponse.InvalidParameters ?? [];
      totalFound += edgeFound;
      totalExpected += edgeParams.length;
      allMissing.push(...edgeMissing);

      logger.keyValue('Edge region', `${edgeFound}/${edgeParams.length}`);
      for (const param of edgeMissing) {
        logger.warn(`Missing (${edgeRegion}): ${param}`);
      }
    } catch (err) {
      logger.warn(`Edge SSM check failed: ${(err as Error).message}`);
    }

    logger.keyValue('Total', `${totalFound}/${totalExpected}`);

    if (totalFound === totalExpected) {
      logger.success('All SSM parameters exist');
      return { name: 'SSM Parameters', status: 'healthy', critical: false };
    }

    if (totalFound > 0) {
      return {
        name: 'SSM Parameters',
        status: 'degraded',
        critical: false,
        details: `${allMissing.length} missing`,
      };
    }

    return { name: 'SSM Parameters', status: 'unhealthy', critical: false };
  } catch (err) {
    logger.warn(`SSM check failed: ${(err as Error).message}`);
    return { name: 'SSM Parameters', status: 'skipped', critical: false };
  }
}

// ==========================================================================
// CHECK 4: S3 Scripts Bucket
// ==========================================================================
async function checkS3Bucket(): Promise<CheckResult> {
  logger.task('Checking S3 scripts bucket...');

  // Discover the bucket name from the Compute stack output
  try {
    const computeStack = project!.stacks.find((s) => s.id === 'compute');
    if (!computeStack) {
      return { name: 'S3 Scripts Bucket', status: 'skipped', critical: false };
    }

    const computeStackName = computeStack.getStackName(environment);

    // Try stack output first
    let bucket = '';
    try {
      const response = await cfn.send(
        new DescribeStacksCommand({ StackName: computeStackName }),
      );
      const outputs = response.Stacks?.[0]?.Outputs ?? [];
      bucket =
        outputs.find((o) => o.OutputKey === 'ScriptsBucketName')?.OutputValue ?? '';
    } catch {
      // Stack output not available — use deterministic name
    }

    if (!bucket) {
      // Fallback: deterministic bucket name pattern
      const accountId = process.env.AWS_ACCOUNT_ID || '';
      if (accountId) {
        bucket = `k8s-${environment}-k8s-scripts-${accountId}`;
      } else {
        logger.warn('Cannot determine bucket name (no stack output or AWS_ACCOUNT_ID)');
        return { name: 'S3 Scripts Bucket', status: 'skipped', critical: false };
      }
    }

    logger.keyValue('Bucket', bucket);

    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    logger.success('S3 scripts bucket is accessible');
    return { name: 'S3 Scripts Bucket', status: 'healthy', critical: false };
  } catch (err) {
    logger.warn(`S3 check failed: ${(err as Error).message}`);
    return { name: 'S3 Scripts Bucket', status: 'unhealthy', critical: false };
  }
}

// ==========================================================================
// CHECK 5: CloudFront HTTPS (Monitoring Dashboard)
// ==========================================================================
async function checkCloudFront(): Promise<CheckResult> {
  if (!cloudfrontDomain) {
    logger.info('No CloudFront domain available — skipping');
    return { name: 'CloudFront', status: 'skipped', critical: false };
  }

  logger.task(`Testing CloudFront at ${cloudfrontDomain}...`);

  // Test root — should redirect to Grafana or return a response
  const rootCode = await httpCheck(`https://${cloudfrontDomain}/`);
  if (rootCode > 0 && rootCode < 500) {
    logger.success(`CloudFront HTTPS root: HTTP ${rootCode}`);
  } else {
    logger.error(`CloudFront HTTPS root: HTTP ${rootCode}`);
    return { name: 'CloudFront', status: 'unhealthy', critical: false };
  }

  // Test Grafana path if configured
  const grafanaCode = await httpCheck(`https://${cloudfrontDomain}/grafana/`, 15_000);
  if (grafanaCode > 0 && grafanaCode < 500) {
    logger.success(`CloudFront /grafana: HTTP ${grafanaCode}`);
  } else if (grafanaCode === 0) {
    logger.warn('CloudFront /grafana: timeout');
  } else {
    logger.warn(`CloudFront /grafana: HTTP ${grafanaCode}`);
  }

  return { name: 'CloudFront', status: 'healthy', critical: false };
}

// ==========================================================================
// Main
// ==========================================================================
async function main(): Promise<void> {
  logger.header(`Monitoring K8s Smoke Tests (${environment})`);
  logger.keyValue('Region', region);
  logger.keyValue('Edge Region', edgeRegion);
  logger.blank();

  // Auto-discover EIP and CloudFront from SSM
  await discoverEndpoints();

  logger.blank();
  logger.keyValue('EIP', eipAddress || '(not available)');
  logger.keyValue('CloudFront', cloudfrontDomain || '(not available)');
  logger.blank();

  // Run all checks
  const results: CheckResult[] = [
    await checkCloudFormationStacks(),
    await checkEipHealth(),
    await checkSsmParameters(),
    await checkS3Bucket(),
    await checkCloudFront(),
  ];

  // Determine overall status
  const criticalFailures = results.filter((r) => r.critical && r.status === 'unhealthy');
  const anyDegraded = results.some((r) => r.status === 'degraded');
  const overall = criticalFailures.length > 0 ? 'failure' : anyDegraded ? 'degraded' : 'success';

  // Set GitHub outputs
  setOutput('status', overall);
  for (const result of results) {
    const key = result.name.toLowerCase().replace(/\s+/g, '_') + '_status';
    setOutput(key, result.status);
  }

  // Generate GitHub Step Summary
  const summaryLines = [
    '## 🧪 Monitoring K8s Smoke Test Results',
    '',
    `**Environment**: \`${environment}\``,
    `**Region**: \`${region}\` | **Edge**: \`${edgeRegion}\``,
    `**EIP**: \`${eipAddress || 'N/A'}\``,
    `**Overall**: ${overall === 'success' ? '✅' : overall === 'degraded' ? '⚠️' : '❌'} ${overall}`,
    '',
    '### Service Health',
    '',
    '| Component | Status | Critical |',
    '|-----------|--------|----------|',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.status === 'healthy' ? '✅' : r.status === 'skipped' ? '⏭️' : r.status === 'degraded' ? '⚠️' : '❌'} ${r.status} | ${r.critical ? 'Yes' : 'No'} |`,
    ),
    '',
  ];

  if (eipAddress || cloudfrontDomain) {
    summaryLines.push('### Endpoints Tested', '');
    if (eipAddress) summaryLines.push(`- EIP: \`http://${eipAddress}/\``);
    if (cloudfrontDomain) summaryLines.push(`- CloudFront: \`https://${cloudfrontDomain}/\``);
    summaryLines.push('');
  }

  appendSummary(summaryLines.join('\n'));

  // Console summary table
  logger.blank();
  logger.table(
    ['Component', 'Status', 'Critical'],
    results.map((r) => [r.name, r.status, r.critical ? 'Yes' : '-']),
  );

  // Final verdict
  if (criticalFailures.length > 0) {
    logger.error(
      `Smoke tests FAILED — ${criticalFailures.length} critical failure(s): ${criticalFailures.map((r) => r.name).join(', ')}`,
    );
    process.exit(1);
  }

  if (anyDegraded) {
    logger.warn('Smoke tests passed with warnings (some checks degraded)');
  } else {
    logger.success('All smoke tests passed');
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
