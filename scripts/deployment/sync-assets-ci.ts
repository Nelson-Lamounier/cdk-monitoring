#!/usr/bin/env npx tsx
/**
 * Sync Static Assets to S3 + CloudFront Cache Invalidation
 *
 * Fetches the S3 bucket name from SSM, syncs .next/static/ to S3,
 * and optionally invalidates CloudFront cache.
 *
 * Usage:
 *   npx tsx scripts/deployment/sync-assets-ci.ts development
 *   npx tsx scripts/deployment/sync-assets-ci.ts production --region eu-west-1 --domain example.com
 *
 * Environment variables:
 *   STATIC_DIR - Path to .next/static directory (default: .next/static)
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   bucket           - S3 bucket name
 *   files_synced     - Number of files synced
 *   invalidation_id  - CloudFront invalidation ID (if applicable)
 *
 * Exit codes:
 *   0 = sync completed successfully
 *   1 = fatal error
 */

import { appendFileSync, existsSync } from 'fs';

import {
  CloudFrontClient,
  ListDistributionsCommand,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import {
  SSMClient,
  GetParameterCommand,
} from '@aws-sdk/client-ssm';

import { runCommand } from './exec.js';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const environment = args[0];
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');
const domainFlag = args.indexOf('--domain');
const domainName = domainFlag !== -1 ? args[domainFlag + 1] : undefined;

if (!environment) {
  console.error('Usage: sync-assets-ci.ts <environment> [--region <region>] [--domain <domain>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const ssm = new SSMClient({ region });
const cloudfront = new CloudFrontClient({ region: 'us-east-1' }); // CloudFront is global

// ---------------------------------------------------------------------------
// Helper: write to $GITHUB_OUTPUT
// ---------------------------------------------------------------------------
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  logger.keyValue(key, value);
}

// ---------------------------------------------------------------------------
// Get S3 bucket name from SSM
// ---------------------------------------------------------------------------
async function getBucketFromSSM(): Promise<string> {
  const paramName = `/nextjs/${environment}/assets-bucket-name`;
  logger.task(`Fetching bucket name from SSM: ${paramName}`);

  try {
    const response = await ssm.send(
      new GetParameterCommand({ Name: paramName })
    );
    const bucket = response.Parameter?.Value;
    if (!bucket) {
      throw new Error(`SSM parameter ${paramName} has no value`);
    }
    return bucket;
  } catch (err) {
    logger.error(`Could not find S3 bucket name in SSM: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync static assets to S3
// ---------------------------------------------------------------------------
async function syncToS3(bucket: string): Promise<number> {
  const staticDir = process.env.STATIC_DIR ?? '.next/static';

  if (!existsSync(staticDir)) {
    logger.warn(`No ${staticDir} directory found — skipping sync`);
    logger.info('Static assets should be built and synced as part of application deployment');
    return 0;
  }

  const s3Path = `s3://${bucket}/_next/static/`;
  logger.task(`Syncing ${staticDir}/ to ${s3Path}`);

  const result = await runCommand(
    'aws',
    ['s3', 'sync', staticDir, s3Path, '--delete', '--size-only'],
    { captureOutput: true }
  );

  if (result.exitCode !== 0) {
    logger.error(`S3 sync failed: ${result.stderr}`);
    process.exit(1);
  }

  // Count files from output lines
  const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
  const fileCount = lines.length;

  logger.success(`Synced ${fileCount} files to S3`);
  return fileCount;
}

// ---------------------------------------------------------------------------
// Invalidate CloudFront cache
// ---------------------------------------------------------------------------
async function invalidateCloudFront(domain: string): Promise<string | undefined> {
  logger.task(`Looking up CloudFront distribution for ${domain}...`);

  try {
    // Find distribution by alias
    const listResponse = await cloudfront.send(
      new ListDistributionsCommand({})
    );

    const distributions = listResponse.DistributionList?.Items ?? [];
    const dist = distributions.find((d: { Aliases?: { Items?: string[] }; Id?: string }) =>
      d.Aliases?.Items?.includes(domain)
    );

    if (!dist?.Id) {
      logger.warn(`Could not find CloudFront distribution for ${domain}`);
      return undefined;
    }

    logger.info(`Found distribution: ${dist.Id}`);
    logger.task('Creating cache invalidation for /_next/*...');

    const invalidation = await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: dist.Id,
        InvalidationBatch: {
          CallerReference: `sync-${Date.now()}`,
          Paths: {
            Quantity: 1,
            Items: ['/_next/*'],
          },
        },
      })
    );

    const invalidationId = invalidation.Invalidation?.Id ?? 'unknown';
    logger.success(`Cache invalidation started: ${invalidationId}`);
    return invalidationId;
  } catch (err) {
    logger.warn(`CloudFront invalidation failed: ${(err as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`Sync Static Assets (${environment})`);

  // 1. Get S3 bucket from SSM
  const bucket = await getBucketFromSSM();
  setOutput('bucket', bucket);
  logger.success(`S3 bucket: ${bucket}`);

  // 2. Sync static assets
  const filesSynced = await syncToS3(bucket);
  setOutput('files_synced', String(filesSynced));

  // 3. Invalidate CloudFront cache (if domain provided)
  let invalidationId = '';
  if (domainName) {
    const id = await invalidateCloudFront(domainName);
    invalidationId = id ?? '';
  } else {
    logger.info('No domain provided — skipping CloudFront invalidation');
  }
  setOutput('invalidation_id', invalidationId);

  // Summary
  logger.blank();
  logger.table(
    ['Action', 'Result'],
    [
      ['S3 Bucket', bucket],
      ['Files Synced', String(filesSynced)],
      ['CloudFront Invalidation', invalidationId || 'Skipped'],
    ]
  );

  logger.success('Static asset sync complete');
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
