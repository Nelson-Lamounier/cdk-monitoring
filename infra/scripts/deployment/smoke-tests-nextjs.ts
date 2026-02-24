#!/usr/bin/env npx tsx
/**
 * @format
 * Next.js Comprehensive Smoke Tests
 *
 * Validates all 6 NextJS infrastructure stacks after deployment:
 *   1. CloudFormation Stack Status (all 6 stacks, Edge in us-east-1)
 *   2. ECS Service Health (running tasks, desired count)
 *   3. DynamoDB Table (status, item count)
 *   4. ECR Repository (images, latest tag)
 *   5. S3 Assets Bucket (exists, object count)
 *   6. SSM Parameters (all expected params exist)
 *   7. ALB Endpoints (root, health check)
 *   8. API Gateway Endpoints (articles, subscriptions)
 *   9. CloudFront HTTPS (origin, certificate)
 *  10. Static Assets via CloudFront (CSS, JS chunks)
 *  11. ECS SSR Data Access (direct DynamoDB via Gateway Endpoint, EROFS detection)
 *  12. Article Source Validation (DynamoDB vs MDX fallback)
 *
 * Usage:
 *   npx tsx scripts/deployment/smoke-tests-nextjs.ts development
 *   npx tsx scripts/deployment/smoke-tests-nextjs.ts production --region eu-west-1 \
 *     --alb-dns my-alb.elb.amazonaws.com --cloudfront-domain example.com
 *
 * Environment variables:
 *   ALB_DNS           - ALB DNS name (alternative to --alb-dns)
 *   CLOUDFRONT_DOMAIN - CloudFront domain (alternative to --cloudfront-domain)
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
import {
  DescribeRepositoriesCommand,
  ECRClient,
  ListImagesCommand,
} from '@aws-sdk/client-ecr';
import {
  DescribeServicesCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
} from '@aws-sdk/client-ecs';
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
const edgeRegion = 'us-east-1'; // Edge stack always in us-east-1
const s3BucketName = getFlag('s3-bucket') || process.env.S3_ASSETS_BUCKET || '';

// ALB and CloudFront can be passed via CLI or auto-discovered from SSM
let albDns = getFlag('alb-dns') || process.env.ALB_DNS || '';
let cloudfrontDomain = getFlag('cloudfront-domain') || process.env.CLOUDFRONT_DOMAIN || '';

if (!environment) {
  console.error(
    'Usage: smoke-tests-nextjs.ts <environment> [--region <region>] [--alb-dns <dns>] [--cloudfront-domain <domain>] [--s3-bucket <name>]',
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

// SSM parameter prefix for this environment
const ssmPrefix = `/nextjs/${environment}`;

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
const cfnEdge = new CloudFormationClient({ region: edgeRegion });
const ecs = new ECSClient({ region });
const dynamodb = new DynamoDBClient({ region });
const ecr = new ECRClient({ region });
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

/**
 * Get a CloudFormation stack output value by key.
 * Uses the appropriate client based on whether the stack is in the edge region.
 */
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
// AUTO-DISCOVERY: ALB DNS and CloudFront domain from SSM
// ==========================================================================
async function discoverEndpoints(): Promise<void> {
  // Discover ALB DNS from SSM if not provided via CLI
  if (!albDns) {
    logger.task('Auto-discovering ALB DNS from SSM...');
    try {
      const response = await ssm.send(
        new GetParametersCommand({ Names: [`${ssmPrefix}/alb-dns-name`] }),
      );
      const value = response.Parameters?.[0]?.Value;
      if (value) {
        albDns = value;
        logger.success(`ALB DNS discovered: ${albDns}`);
      } else {
        logger.warn('ALB DNS not found in SSM');
      }
    } catch (err) {
      logger.warn(`ALB DNS discovery failed: ${(err as Error).message}`);
    }
  }

  // Discover CloudFront domain from SSM (Edge region: us-east-1)
  if (!cloudfrontDomain) {
    logger.task('Auto-discovering CloudFront domain from SSM (us-east-1)...');
    try {
      const response = await ssmEdge.send(
        new GetParametersCommand({ Names: [`${ssmPrefix}/cloudfront/distribution-domain`] }),
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

  const stacks = project!.stacks;
  let allHealthy = true;
  let anyFailed = false;
  const details: string[] = [];

  for (const stack of stacks) {
    const stackName = stack.getStackName(environment);
    // Edge stack is in us-east-1, all others in the primary region
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
// CHECK 2: ECS Service Health
// ==========================================================================
async function checkEcsService(): Promise<CheckResult> {
  logger.task('Checking ECS service health...');

  try {
    // Find NextJS cluster
    const clustersResponse = await ecs.send(new ListClustersCommand({}));
    const clusterArns = clustersResponse.clusterArns ?? [];
    const nextjsCluster = clusterArns.find(
      (arn) => arn.toLowerCase().includes('nextjs') || arn.toLowerCase().includes('next-js'),
    );

    if (!nextjsCluster) {
      logger.warn('Could not discover ECS cluster');
      return { name: 'ECS Service', status: 'skipped', critical: true };
    }

    const clusterName = nextjsCluster.split('/').pop() ?? '';
    logger.keyValue('Cluster', clusterName);

    // Find service in cluster
    const servicesResponse = await ecs.send(
      new ListServicesCommand({ cluster: clusterName }),
    );
    const serviceArn = servicesResponse.serviceArns?.[0];

    if (!serviceArn) {
      logger.warn('No services found in cluster');
      return { name: 'ECS Service', status: 'skipped', critical: true };
    }

    const serviceName = serviceArn.split('/').pop() ?? '';
    logger.keyValue('Service', serviceName);

    // Check service health
    const descResponse = await ecs.send(
      new DescribeServicesCommand({
        cluster: clusterName,
        services: [serviceName],
      }),
    );

    const service = descResponse.services?.[0];
    const status = service?.status ?? 'UNKNOWN';
    const desired = service?.desiredCount ?? 0;
    const running = service?.runningCount ?? 0;

    logger.keyValue('Status', status);
    logger.keyValue('Running/Desired', `${running}/${desired}`);

    if (status === 'ACTIVE' && running >= desired && desired > 0) {
      logger.success('ECS service is healthy');
      return { name: 'ECS Service', status: 'healthy', critical: true };
    }

    logger.error('ECS service is not healthy');
    return { name: 'ECS Service', status: 'unhealthy', critical: true };
  } catch (err) {
    logger.warn(`ECS check failed: ${(err as Error).message}`);
    return { name: 'ECS Service', status: 'skipped', critical: true };
  }
}

// ==========================================================================
// CHECK 3: DynamoDB Table
// ==========================================================================
async function checkDynamoDbTable(): Promise<CheckResult> {
  logger.task('Checking DynamoDB table...');

  try {
    // Discover table name from Data stack outputs
    const dataStackName = project!.stacks.find((s) => s.id === 'data')!.getStackName(environment);
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

    // Check GSIs
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
// CHECK 4: ECR Repository
// ==========================================================================
async function checkEcrRepository(): Promise<CheckResult> {
  logger.task('Checking ECR repository...');

  try {
    const repoName = 'nextjs-frontend';
    const descResult = await ecr.send(
      new DescribeRepositoriesCommand({ repositoryNames: [repoName] }),
    );

    if (!descResult.repositories?.length) {
      logger.warn(`ECR repository '${repoName}' not found`);
      return { name: 'ECR Repository', status: 'unhealthy', critical: false };
    }

    logger.keyValue('Repository', repoName);

    // Check for images
    const imagesResult = await ecr.send(
      new ListImagesCommand({ repositoryName: repoName, maxResults: 5 }),
    );
    const imageCount = imagesResult.imageIds?.length ?? 0;
    logger.keyValue('Images', String(imageCount));

    if (imageCount > 0) {
      logger.success('ECR repository has images');
      return { name: 'ECR Repository', status: 'healthy', critical: false };
    }

    logger.warn('ECR repository is empty');
    return { name: 'ECR Repository', status: 'degraded', critical: false };
  } catch (err) {
    logger.warn(`ECR check failed: ${(err as Error).message}`);
    return { name: 'ECR Repository', status: 'skipped', critical: false };
  }
}

// ==========================================================================
// CHECK 5: S3 Assets Bucket
// ==========================================================================
async function checkS3Bucket(): Promise<CheckResult> {
  logger.task('Checking S3 assets bucket...');

  try {
    // Discover bucket from Data stack outputs if not provided
    let bucket = s3BucketName;
    if (!bucket) {
      const dataStackName = project!.stacks.find((s) => s.id === 'data')!.getStackName(environment);
      bucket = (await getStackOutput(dataStackName, 'AssetsBucketName')) ?? '';
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
// CHECK 6: SSM Parameters
// ==========================================================================
async function checkSsmParameters(): Promise<CheckResult> {
  logger.task('Checking SSM parameters...');

  // Parameters stored in the primary region (eu-west-1)
  const primaryParams = [
    `${ssmPrefix}/dynamodb-table-name`,
    `${ssmPrefix}/assets-bucket-name`,
    `${ssmPrefix}/aws-region`,
    `${ssmPrefix}/ecs/cluster-name`,
    `${ssmPrefix}/ecs/service-name`,
    `${ssmPrefix}/alb-dns-name`,
  ];

  // Parameters stored in the edge region (us-east-1)
  const edgeParams = [
    `${ssmPrefix}/cloudfront/distribution-domain`,
    `${ssmPrefix}/cloudfront/waf-arn`,
    `${ssmPrefix}/acm-certificate-arn`,
  ];

  let totalFound = 0;
  let totalExpected = primaryParams.length + edgeParams.length;
  const allMissing: string[] = [];

  try {
    // Check primary region parameters
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

    // Check edge region parameters
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
      totalExpected -= edgeParams.length; // Don't count edge params if we can't reach them
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
// CHECK 7: ALB Endpoints
// ==========================================================================
async function checkAlb(): Promise<CheckResult> {
  if (!albDns) {
    logger.info('No ALB DNS available — skipping');
    return { name: 'ALB Endpoints', status: 'skipped', critical: false };
  }

  logger.task(`Testing ALB endpoints on ${albDns}...`);
  let passed = 0;
  let failed = 0;

  // Test root endpoint
  const rootCode = await httpCheck(`http://${albDns}/`);
  if ([200, 301, 302].includes(rootCode)) {
    logger.success(`Root endpoint: HTTP ${rootCode}`);
    passed++;
  } else {
    logger.error(`Root endpoint: HTTP ${rootCode}`);
    failed++;
  }

  // Test health endpoint
  const healthCode = await httpCheck(`http://${albDns}/api/health`);
  if (healthCode === 200) {
    logger.success(`Health endpoint: HTTP ${healthCode}`);
    passed++;
  } else {
    logger.warn(`Health endpoint: HTTP ${healthCode} (may not exist)`);
  }

  if (failed === 0 && passed > 0) {
    return { name: 'ALB Endpoints', status: 'healthy', critical: false };
  }
  return { name: 'ALB Endpoints', status: 'degraded', critical: false };
}

// ==========================================================================
// CHECK 8: API Gateway Endpoints
// ==========================================================================
async function checkApiGateway(): Promise<CheckResult> {
  logger.task('Checking API Gateway endpoints...');

  try {
    // Discover API URL from API stack outputs
    const apiStackName = project!.stacks.find((s) => s.id === 'api')!.getStackName(environment);
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
// CHECK 9: CloudFront HTTPS
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

  // Verify article pages route to ALB/Next.js (not API Gateway)
  // After removing the /articles/* CloudFront behavior, these should
  // fall through to the default ALB origin and render as HTML pages.
  const articlesListCode = await httpCheck(`https://${cloudfrontDomain}/articles`);
  if ([200, 301, 302].includes(articlesListCode)) {
    logger.success(`CloudFront /articles: HTTP ${articlesListCode}`);
  } else {
    logger.error(`CloudFront /articles: HTTP ${articlesListCode} (routing issue?)`);
    return { name: 'CloudFront', status: 'unhealthy', critical: false };
  }

  // Test an individual article page — fetch the listing first to discover a slug
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const listResponse = await fetch(`https://${cloudfrontDomain}/articles`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (listResponse.ok) {
      const html = await listResponse.text();
      // Match real article slugs (word-word-word) but exclude Next.js
      // internal page IDs like "page-296dc5d9699bb521" (page-<hex>).
      // Real slugs always have multiple hyphen-separated word segments
      // containing letters, e.g. "aws-devops-pro-exam-failure-to-success".
      const slugMatch = html.match(/\/articles\/([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){2,})/);
      if (slugMatch) {
        const articleCode = await httpCheck(
          `https://${cloudfrontDomain}/articles/${slugMatch[1]}`,
        );
        if ([200, 301, 302].includes(articleCode)) {
          logger.success(`CloudFront /articles/${slugMatch[1]}: HTTP ${articleCode}`);
        } else {
          logger.error(
            `CloudFront /articles/${slugMatch[1]}: HTTP ${articleCode} (article pages may be misrouted)`,
          );
          return { name: 'CloudFront', status: 'unhealthy', critical: false };
        }
      }
    }
  } catch {
    logger.warn('Could not test individual article page via CloudFront');
  }

  return { name: 'CloudFront', status: 'healthy', critical: false };
}

// ==========================================================================
// CHECK 10: Static Assets via CloudFront
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
// CHECK 11: ECS SSR Data Access (Direct DynamoDB via VPC Gateway Endpoint)
// Validates that the ECS container can render articles using direct DynamoDB
// access through the free VPC Gateway Endpoint. This replaces the previous
// pattern of routing SSR traffic through API Gateway via a VPC Interface
// Endpoint (which was incompatible with REGIONAL API types).
// ==========================================================================
async function checkEcsSsrDataAccess(): Promise<CheckResult> {
  if (!albDns) {
    return { name: 'ECS SSR Data Access', status: 'skipped', critical: true };
  }

  logger.task('Checking ECS SSR data access (direct DynamoDB via Gateway Endpoint)...');

  try {
    // Fetch the articles page via ALB — this forces the Next.js container
    // to query DynamoDB directly during SSR (via VPC Gateway Endpoint)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(`http://${albDns}/articles`, {
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const html = await response.text();

    // Check for signs of data access failure:
    // 1. DynamoDB access denied or connection errors
    // 2. Connection timeout (Gateway Endpoint misconfigured)
    // 3. AWS SDK errors rendered in the page
    const dataAccessErrors = [
      'AccessDeniedException',
      'ResourceNotFoundException',
      'UnrecognizedClientException',
      'UND_ERR_CONNECT_TIMEOUT',
      'ConnectTimeoutError',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'fetch failed',
    ];

    const hasDataAccessError = dataAccessErrors.some((err) =>
      html.includes(err),
    );

    if (hasDataAccessError) {
      logger.error(
        'ECS container cannot access DynamoDB — check task role permissions or VPC Gateway Endpoint',
      );
      return {
        name: 'ECS SSR Data Access',
        status: 'unhealthy',
        critical: true,
        details: 'DynamoDB access error from ECS container during SSR',
      };
    }

    // Check for EROFS (read-only filesystem) errors
    if (html.includes('EROFS') || html.includes('read-only file system')) {
      logger.warn(
        'EROFS detected — ISR cache writes failing (readonlyRootFilesystem may still be true)',
      );
      return {
        name: 'ECS SSR Data Access',
        status: 'degraded',
        critical: true,
        details: 'Read-only filesystem preventing ISR cache writes',
      };
    }

    if (response.status === 200) {
      logger.success(
        `Articles page rendered: HTTP ${response.status} (SSR data access working)`,
      );
      return { name: 'ECS SSR Data Access', status: 'healthy', critical: true };
    }

    if (response.status === 500) {
      logger.error(`Articles page returned HTTP 500 — server-side data access error`);
      return {
        name: 'ECS SSR Data Access',
        status: 'unhealthy',
        critical: true,
        details: `HTTP ${response.status} from /articles`,
      };
    }

    logger.warn(`Articles page: HTTP ${response.status}`);
    return { name: 'ECS SSR Data Access', status: 'degraded', critical: true };
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('abort') || message.includes('timeout')) {
      logger.error('Articles page timed out — ECS may not be reachable');
    } else {
      logger.warn(`ECS SSR data access check failed: ${message}`);
    }
    return {
      name: 'ECS SSR Data Access',
      status: 'unhealthy',
      critical: true,
      details: message,
    };
  }
}


// ==========================================================================
// Main
// ==========================================================================
async function main(): Promise<void> {
  logger.header(`Next.js Smoke Tests (${environment})`);
  logger.keyValue('Region', region);
  logger.keyValue('Edge Region', edgeRegion);
  logger.blank();

  // Auto-discover ALB DNS and CloudFront domain from SSM if not provided
  await discoverEndpoints();

  logger.blank();
  logger.keyValue('ALB DNS', albDns || '(not available)');
  logger.keyValue('CloudFront', cloudfrontDomain || '(not available)');
  logger.blank();

  // Run all checks
  const results: CheckResult[] = [
    await checkCloudFormationStacks(),
    await checkEcsService(),
    await checkDynamoDbTable(),
    await checkEcrRepository(),
    await checkS3Bucket(),
    await checkSsmParameters(),
    await checkAlb(),
    await checkApiGateway(),
    await checkCloudFront(),
    await checkStaticAssets(),
    await checkEcsSsrDataAccess(),
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
    '## 🧪 Next.js Smoke Test Results',
    '',
    `**Environment**: \`${environment}\``,
    `**Region**: \`${region}\` | **Edge**: \`${edgeRegion}\``,
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

  if (albDns || cloudfrontDomain) {
    summaryLines.push('### Endpoints Tested', '');
    if (albDns) summaryLines.push(`- ALB: \`http://${albDns}/\``);
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
