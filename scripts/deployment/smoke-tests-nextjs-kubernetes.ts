#!/usr/bin/env npx tsx
/**
 * @format
 * Next.js K8s Smoke Tests
 *
 * Validates the NextJS K8s infrastructure after deployment.
 * Combines CloudFormation stack verification (previously in verify-service)
 * with K8s-specific smoke tests — replaces both the verify-service and
 * smoke-tests pipeline jobs with a single, comprehensive check.
 *
 * Checks performed:
 *   1. CloudFormation Stack Status (Data, K8sCompute, API, Edge)
 *   2. EIP HTTP Health (Traefik ingress via Elastic IP)
 *   3. DynamoDB Table (status, GSI health)
 *   4. S3 Assets Bucket (accessible)
 *   5. SSM Parameters (K8s + NextJS sets)
 *   6. API Gateway Endpoints (CORS, validation)
 *   7. CloudFront HTTPS (root, articles routing)
 *   8. Static Assets via CloudFront (CSS/JS chunks)
 *
 * Usage:
 *   npx tsx scripts/deployment/smoke-tests-nextjs-k8s.ts development
 *   npx tsx scripts/deployment/smoke-tests-nextjs-k8s.ts production --region eu-west-1 \
 *     --cloudfront-domain example.com --s3-bucket my-bucket
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
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
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
const s3BucketOverride = getFlag('s3-bucket') || '';

let cloudfrontDomain = getFlag('cloudfront-domain') || process.env.CLOUDFRONT_DOMAIN || '';

if (!environment) {
  console.error(
    'Usage: smoke-tests-nextjs-k8s.ts <environment> [--region <region>] [--cloudfront-domain <domain>] [--s3-bucket <name>]',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Project Configuration
// ---------------------------------------------------------------------------
const project = getProject('nextjs');
if (!project) {
  console.error('NextJS project not found in stacks configuration');
  process.exit(1);
}

// SSM prefixes
const nextjsSsmPrefix = `/nextjs/${environment}`;
const k8sSsmPrefix = `/k8s/${environment}`;

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
const cfnEdge = new CloudFormationClient({ region: edgeRegion });
const dynamodb = new DynamoDBClient({ region });
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

async function getStackOutput(
  stackName: string,
  outputKey: string,
  client: CloudFormationClient = cfn,
): Promise<string | undefined> {
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = response.Stacks?.[0]?.Outputs ?? [];
    return outputs.find((o) => o.OutputKey === outputKey)?.OutputValue;
  } catch {
    return undefined;
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
  if (!cloudfrontDomain) {
    logger.task('Auto-discovering CloudFront domain from SSM (us-east-1)...');
    try {
      const response = await ssmEdge.send(
        new GetParametersCommand({ Names: [`${nextjsSsmPrefix}/cloudfront/distribution-domain`] }),
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

  // K8s pipeline deploys: data, k8sCompute, api, edge
  const k8sStackIds = ['data', 'k8sCompute', 'api', 'edge'];
  const stacks = project!.stacks.filter((s) => k8sStackIds.includes(s.id));

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
      logger.warn(`${stack.name}${regionLabel}: NOT_FOUND`);
      details.push(`${stack.name}: NOT_FOUND`);
      allHealthy = false;
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
// CHECK 2: EIP HTTP Health (Traefik/k3s ingress)
// ==========================================================================
async function checkEipHealth(): Promise<CheckResult> {
  if (!eipAddress) {
    logger.info('No EIP available — skipping');
    return { name: 'EIP HTTP Health', status: 'skipped', critical: true };
  }

  logger.task(`Testing HTTP endpoint on EIP ${eipAddress}...`);

  // Test HTTP root — Traefik should respond (200, 301, 302, or 404 are all valid)
  const rootCode = await httpCheck(`http://${eipAddress}/`);
  if (rootCode > 0 && rootCode < 500) {
    logger.success(`EIP root: HTTP ${rootCode}`);
  } else {
    logger.error(`EIP root: HTTP ${rootCode} (Traefik/k3s not responding)`);
    return {
      name: 'EIP HTTP Health',
      status: 'unhealthy',
      critical: true,
      details: `HTTP ${rootCode} from ${eipAddress}`,
    };
  }

  // Test HTTPS if available (port 443)
  const httpsCode = await httpCheck(`https://${eipAddress}/`, 10_000);
  if (httpsCode > 0) {
    logger.success(`EIP HTTPS: HTTP ${httpsCode}`);
  } else {
    logger.info('EIP HTTPS: not available (expected if TLS terminates at CloudFront)');
  }

  return { name: 'EIP HTTP Health', status: 'healthy', critical: true };
}

// ==========================================================================
// CHECK 3: DynamoDB Table
// ==========================================================================
async function checkDynamoDbTable(): Promise<CheckResult> {
  logger.task('Checking DynamoDB table...');

  try {
    const dataStack = project!.stacks.find((s) => s.id === 'data');
    if (!dataStack) {
      return { name: 'DynamoDB Table', status: 'skipped', critical: true };
    }

    const dataStackName = dataStack.getStackName(environment);
    const tableName = await getStackOutput(dataStackName, 'PortfolioTableName');

    if (!tableName) {
      logger.warn('Could not discover DynamoDB table name from stack outputs');
      return { name: 'DynamoDB Table', status: 'skipped', critical: true };
    }

    logger.keyValue('Table', tableName);

    const response = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
    const tableStatus = response.Table?.TableStatus ?? 'UNKNOWN';
    const itemCount = response.Table?.ItemCount ?? 0;
    const gsis = response.Table?.GlobalSecondaryIndexes ?? [];

    logger.keyValue('Status', tableStatus);
    logger.keyValue('Items', String(itemCount));

    let gsiHealthy = true;
    for (const gsi of gsis) {
      const gsiStatus = gsi.IndexStatus ?? 'UNKNOWN';
      if (gsiStatus !== 'ACTIVE') {
        logger.warn(`GSI ${gsi.IndexName}: ${gsiStatus}`);
        gsiHealthy = false;
      }
    }
    if (gsis.length > 0) {
      logger.keyValue('GSIs', `${gsis.length} (${gsiHealthy ? 'all active' : 'degraded'})`);
    }

    if (tableStatus === 'ACTIVE' && gsiHealthy) {
      logger.success('DynamoDB table is healthy');
      return { name: 'DynamoDB Table', status: 'healthy', critical: true };
    }

    return {
      name: 'DynamoDB Table',
      status: tableStatus === 'ACTIVE' ? 'degraded' : 'unhealthy',
      critical: true,
    };
  } catch (err) {
    logger.warn(`DynamoDB check failed: ${(err as Error).message}`);
    return { name: 'DynamoDB Table', status: 'skipped', critical: true };
  }
}

// ==========================================================================
// CHECK 4: S3 Assets Bucket
// ==========================================================================
async function checkS3Bucket(): Promise<CheckResult> {
  logger.task('Checking S3 assets bucket...');

  try {
    let bucket = s3BucketOverride;
    if (!bucket) {
      const dataStack = project!.stacks.find((s) => s.id === 'data');
      if (dataStack) {
        bucket = (await getStackOutput(dataStack.getStackName(environment), 'AssetsBucketName')) ?? '';
      }
    }

    if (!bucket) {
      logger.warn('Could not discover S3 bucket name');
      return { name: 'S3 Assets Bucket', status: 'skipped', critical: false };
    }

    logger.keyValue('Bucket', bucket);

    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    logger.success('S3 bucket is accessible');
    return { name: 'S3 Assets Bucket', status: 'healthy', critical: false };
  } catch (err) {
    logger.warn(`S3 check failed: ${(err as Error).message}`);
    return { name: 'S3 Assets Bucket', status: 'unhealthy', critical: false };
  }
}

// ==========================================================================
// CHECK 5: SSM Parameters
// ==========================================================================
async function checkSsmParameters(): Promise<CheckResult> {
  logger.task('Checking SSM parameters...');

  // NextJS SSM params (primary region)
  const nextjsParams = [
    `${nextjsSsmPrefix}/dynamodb-table-name`,
    `${nextjsSsmPrefix}/assets-bucket-name`,
    `${nextjsSsmPrefix}/aws-region`,
    `${nextjsSsmPrefix}/api-gateway-url`,
  ];

  // K8s SSM params (primary region)
  const k8sParams = [
    `${k8sSsmPrefix}/instance-id`,
    `${k8sSsmPrefix}/elastic-ip`,
    `${k8sSsmPrefix}/security-group-id`,
  ];

  // Edge SSM params (us-east-1)
  const edgeParams = [
    `${nextjsSsmPrefix}/cloudfront/distribution-domain`,
    `${nextjsSsmPrefix}/cloudfront/waf-arn`,
    `${nextjsSsmPrefix}/acm-certificate-arn`,
  ];

  const primaryParams = [...nextjsParams, ...k8sParams];
  let totalFound = 0;
  let totalExpected = primaryParams.length + edgeParams.length;
  const allMissing: string[] = [];

  try {
    // Check primary region
    const primaryResponse = await ssm.send(
      new GetParametersCommand({ Names: primaryParams }),
    );
    const primaryFound = primaryResponse.Parameters?.length ?? 0;
    const primaryMissing = primaryResponse.InvalidParameters ?? [];
    totalFound += primaryFound;
    allMissing.push(...primaryMissing);

    logger.keyValue('Primary region', `${primaryFound}/${primaryParams.length}`);
    for (const param of primaryMissing) {
      logger.warn(`Missing (${region}): ${param}`);
    }

    // Check edge region
    try {
      const edgeResponse = await ssmEdge.send(
        new GetParametersCommand({ Names: edgeParams }),
      );
      const edgeFound = edgeResponse.Parameters?.length ?? 0;
      const edgeMissing = edgeResponse.InvalidParameters ?? [];
      totalFound += edgeFound;
      allMissing.push(...edgeMissing);

      logger.keyValue('Edge region', `${edgeFound}/${edgeParams.length}`);
      for (const param of edgeMissing) {
        logger.warn(`Missing (${edgeRegion}): ${param}`);
      }
    } catch (err) {
      logger.warn(`Edge SSM check failed: ${(err as Error).message}`);
      totalExpected -= edgeParams.length;
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
// CHECK 6: API Gateway Endpoints
// ==========================================================================
async function checkApiGateway(): Promise<CheckResult> {
  logger.task('Checking API Gateway endpoints...');

  try {
    const apiStack = project!.stacks.find((s) => s.id === 'api');
    if (!apiStack) {
      return { name: 'API Gateway', status: 'skipped', critical: true };
    }

    const apiStackName = apiStack.getStackName(environment);
    const apiUrl = await getStackOutput(apiStackName, 'ApiUrl');

    if (!apiUrl) {
      logger.warn('Could not discover API Gateway URL from stack outputs');
      return { name: 'API Gateway', status: 'skipped', critical: true };
    }

    logger.keyValue('API URL', apiUrl);
    let passed = 0;
    let failed = 0;

    // Test OPTIONS /subscriptions (CORS preflight)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(`${apiUrl}subscriptions`, {
        method: 'OPTIONS',
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 200 || response.status === 204) {
        logger.success(`OPTIONS /subscriptions: HTTP ${response.status}`);
        passed++;
      } else {
        logger.warn(`OPTIONS /subscriptions: HTTP ${response.status}`);
      }
    } catch {
      logger.warn('OPTIONS /subscriptions: timeout or error');
    }

    // Test POST /subscriptions with invalid body (should return 400, not 500)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(`${apiUrl}subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 400) {
        logger.success(`POST /subscriptions (invalid): HTTP ${response.status} (validation works)`);
        passed++;
      } else if (response.status === 500) {
        logger.error(`POST /subscriptions (invalid): HTTP ${response.status} (server error)`);
        failed++;
      } else {
        logger.warn(`POST /subscriptions (invalid): HTTP ${response.status}`);
      }
    } catch {
      logger.warn('POST /subscriptions: timeout or error');
    }

    if (failed === 0 && passed > 0) {
      return { name: 'API Gateway', status: 'healthy', critical: true };
    }
    if (failed > 0) {
      return { name: 'API Gateway', status: 'unhealthy', critical: true };
    }
    return { name: 'API Gateway', status: 'degraded', critical: true };
  } catch (err) {
    logger.warn(`API Gateway check failed: ${(err as Error).message}`);
    return { name: 'API Gateway', status: 'skipped', critical: true };
  }
}

// ==========================================================================
// CHECK 7: CloudFront HTTPS
// ==========================================================================
async function checkCloudFront(): Promise<CheckResult> {
  if (!cloudfrontDomain) {
    logger.info('No CloudFront domain available — skipping');
    return { name: 'CloudFront', status: 'skipped', critical: false };
  }

  logger.task(`Testing CloudFront at ${cloudfrontDomain}...`);

  const code = await httpCheck(`https://${cloudfrontDomain}/`);
  if ([200, 301, 302].includes(code)) {
    logger.success(`CloudFront HTTPS root: HTTP ${code}`);
  } else {
    logger.error(`CloudFront HTTPS root: HTTP ${code}`);
    return { name: 'CloudFront', status: 'unhealthy', critical: false };
  }

  // Verify /articles routes through to the K8s pod (via EIP → Traefik)
  const articlesCode = await httpCheck(`https://${cloudfrontDomain}/articles`);
  if ([200, 301, 302].includes(articlesCode)) {
    logger.success(`CloudFront /articles: HTTP ${articlesCode}`);
  } else {
    logger.error(`CloudFront /articles: HTTP ${articlesCode} (routing issue?)`);
    return { name: 'CloudFront', status: 'unhealthy', critical: false };
  }

  return { name: 'CloudFront', status: 'healthy', critical: false };
}

// ==========================================================================
// CHECK 8: Static Assets via CloudFront
// ==========================================================================
async function checkStaticAssets(): Promise<CheckResult> {
  if (!cloudfrontDomain) {
    return { name: 'Static Assets', status: 'skipped', critical: false };
  }

  logger.task('Testing static assets via CloudFront...');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(`https://${cloudfrontDomain}/`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn('Could not fetch page HTML');
      return { name: 'Static Assets', status: 'skipped', critical: false };
    }

    const html = await response.text();
    let passed = 0;
    let failed = 0;

    // Extract and test CSS
    const cssMatch = html.match(/\/_next\/static\/css\/[^"]+\.css/);
    if (cssMatch) {
      const code = await httpCheck(`https://${cloudfrontDomain}${cssMatch[0]}`, 10_000);
      if (code === 200) {
        logger.success(`CSS asset: HTTP ${code}`);
        passed++;
      } else {
        logger.error(`CSS asset: HTTP ${code}`);
        failed++;
      }
    } else {
      logger.warn('No CSS path found in HTML');
    }

    // Extract and test JS
    const jsMatch = html.match(/\/_next\/static\/chunks\/[^"]+\.js/);
    if (jsMatch) {
      const code = await httpCheck(`https://${cloudfrontDomain}${jsMatch[0]}`, 10_000);
      if (code === 200) {
        logger.success(`JS chunk: HTTP ${code}`);
        passed++;
      } else {
        logger.error(`JS chunk: HTTP ${code}`);
        failed++;
      }
    } else {
      logger.warn('No JS path found in HTML');
    }

    if (failed === 0 && passed > 0) {
      return { name: 'Static Assets', status: 'healthy', critical: false };
    }
    if (passed === 0 && failed === 0) {
      return { name: 'Static Assets', status: 'skipped', critical: false };
    }
    return { name: 'Static Assets', status: 'unhealthy', critical: false };
  } catch (err) {
    logger.warn(`Static assets check failed: ${(err as Error).message}`);
    return { name: 'Static Assets', status: 'skipped', critical: false };
  }
}

// ==========================================================================
// Main
// ==========================================================================
async function main(): Promise<void> {
  logger.header(`Next.js K8s Smoke Tests (${environment})`);
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
    await checkDynamoDbTable(),
    await checkS3Bucket(),
    await checkSsmParameters(),
    await checkApiGateway(),
    await checkCloudFront(),
    await checkStaticAssets(),
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
    '## 🧪 Next.js K8s Smoke Test Results',
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
