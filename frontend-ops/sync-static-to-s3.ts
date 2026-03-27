#!/usr/bin/env tsx
/**
 * Static Assets S3 Sync Script
 *
 * Syncs Next.js static assets (.next/static) to S3 for CloudFront serving
 * and optionally invalidates the CloudFront cache.
 *
 * Auth modes:
 *   - CI/Pipeline: Uses OIDC (credentials from env vars, no --profile needed)
 *   - Local/Manual: Uses AWS CLI profile (--profile flag)
 *
 * Usage:
 *   Local:    npx tsx scripts/sync-static-to-s3.ts --env dev --profile dev-account
 *   Pipeline: npx tsx scripts/sync-static-to-s3.ts --env development --region eu-west-1
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront'
import { lookup } from 'mime-types'
import logger from '@repo/script-utils/logger.js'
import type { AwsConfig } from '@repo/script-utils/aws.js'
import {
  parseArgs,
  buildAwsConfig,
  getSSMParameterWithFallbacks,
  getSSMParameter,
  getAccountId,
  resolveAuth,
} from '@repo/script-utils/aws.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: dev, staging, prod', hasValue: true, default: 'dev' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'skip-invalidation', description: 'Skip CloudFront cache invalidation', hasValue: false, default: false },
  ],
  'Sync Next.js static assets to S3 bucket and invalidate CloudFront cache',
)

// ========================================
// Helpers
// ========================================

/** Recursively get all files in a directory */
function getAllFiles(dir: string): string[] {
  const files: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath))
    } else {
      files.push(fullPath)
    }
  }

  return files
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const config = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)
  const skipInvalidation = args['skip-invalidation'] as boolean

  // Determine project root
  const projectRoot = join(__dirname, '..')
  const staticDir = join(projectRoot, '.next', 'static')

  logger.header('📦 Static Assets S3 Sync Script')
  logger.config('Configuration', {
    'Auth Mode': auth.mode,
    'AWS Region': config.region,
    'Environment': config.environment,
  })

  const totalSteps = 5

  // Step 1: Verify static directory exists
  logger.step(1, totalSteps, 'Verifying static assets directory...')

  if (!existsSync(staticDir)) {
    logger.fatal(
      `Static assets not found at: ${staticDir}\n` +
      "   Run 'yarn build' first to generate static assets.",
    )
  }

  const allFiles = getAllFiles(staticDir)
  logger.success(`Found ${allFiles.length} static assets`)

  // Step 2: Get S3 bucket name from SSM
  logger.step(2, totalSteps, 'Discovering S3 bucket from SSM...')

  const ssmPaths = [
    `/nextjs/${config.environment}/assets-bucket-name`,
    `/nextjs/${config.environment}/s3/static-assets-bucket`,
  ]

  const bucketResult = await getSSMParameterWithFallbacks(ssmPaths, config)
  let bucketName: string

  if (bucketResult) {
    bucketName = bucketResult.value
  } else {
    logger.warn('SSM parameter not found. Trying alternative discovery...')
    const accountId = await getAccountId(config)
    bucketName = `nextjs-static-assets-${config.environment}-${accountId}`
    logger.warn(`Using fallback bucket name: ${bucketName}`)
  }

  // Strip s3:// prefix and trailing slash if present
  bucketName = bucketName.replace(/^s3:\/\//, '').replace(/\/$/, '')
  logger.success(`Bucket: ${bucketName}`)

  // Step 3: Sync static assets to S3
  logger.step(3, totalSteps, 'Syncing static assets to S3...')
  console.log(`   Source:      ${staticDir}`)
  console.log(`   Destination: s3://${bucketName}/_next/static/`)

  const s3 = new S3Client({
    region: config.region,
    credentials: config.credentials,
  })

  // Upload all local files
  let uploaded = 0
  for (const filePath of allFiles) {
    const relativePath = relative(staticDir, filePath)
    const s3Key = `_next/static/${relativePath}`
    const contentType = lookup(filePath) || 'application/octet-stream'
    const fileContent = readFileSync(filePath)

    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
    uploaded++
  }

  logger.success(`Uploaded ${uploaded} files to S3`)

  // -----------------------------------------------------------------------
  // BlueGreen-safe cleanup: preserve the previous build's assets
  //
  // During an Argo Rollout BlueGreen promotion, the old pod continues
  // serving traffic for ~2-5 minutes (Image Updater poll + analysis +
  // auto-promote). The old pod's HTML references /_next/static/<oldBuildId>/
  // paths. If we delete those, CSS/JS 404 → site breaks.
  //
  // Strategy:
  //   - Keep: current build ID + most recent previous build ID
  //   - Delete: build IDs older than the previous one
  //   - Shared dirs (chunks/, css/, media/) have content-hashed filenames
  //     so old files there can be safely removed.
  // -----------------------------------------------------------------------

  // Discover the current build ID from local files
  const localBuildIds = readdirSync(staticDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !['chunks', 'css', 'media'].includes(name))

  const currentBuildId = localBuildIds.length > 0 ? localBuildIds[0] : undefined

  const localKeys = new Set(
    allFiles.map((f) => `_next/static/${relative(staticDir, f)}`),
  )

  let continuationToken: string | undefined

  // Collect all S3 keys and identify build ID directories
  const s3BuildIds = new Set<string>()
  const allS3Keys: string[] = []

  do {
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: '_next/static/',
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of listResult.Contents || []) {
      if (obj.Key) {
        allS3Keys.push(obj.Key)
        // Extract build ID from keys like _next/static/<buildId>/file.js
        const segments = obj.Key.replace('_next/static/', '').split('/')
        if (segments.length > 0 && !['chunks', 'css', 'media'].includes(segments[0])) {
          s3BuildIds.add(segments[0])
        }
      }
    }

    continuationToken = listResult.NextContinuationToken
  } while (continuationToken)

  // Determine which build IDs to keep (current + most recent previous)
  const buildIdsToKeep = new Set<string>()
  if (currentBuildId) {
    buildIdsToKeep.add(currentBuildId)
  }

  // Keep one previous build ID for BlueGreen transition safety
  for (const buildId of s3BuildIds) {
    if (buildId !== currentBuildId) {
      buildIdsToKeep.add(buildId)
      break // keep only the most recent previous one
    }
  }

  logger.info(`Build IDs in S3: ${[...s3BuildIds].join(', ') || 'none'}`)
  logger.info(`Keeping build IDs: ${[...buildIdsToKeep].join(', ') || 'none'}`)

  // Delete stale files:
  // - Shared dirs (chunks/css/media): delete files NOT in current build
  // - Build ID dirs: delete entire directories for old build IDs (not current or previous)
  const staleKeys: string[] = []

  for (const key of allS3Keys) {
    const relativePart = key.replace('_next/static/', '')
    const topDir = relativePart.split('/')[0]

    if (['chunks', 'css', 'media'].includes(topDir)) {
      // Shared content-hashed dir — safe to remove old files
      if (!localKeys.has(key)) {
        staleKeys.push(key)
      }
    } else if (!buildIdsToKeep.has(topDir)) {
      // Old build ID directory — safe to remove entirely
      staleKeys.push(key)
    }
  }

  if (staleKeys.length > 0) {
    // Delete in batches of 1000 (S3 limit)
    for (let i = 0; i < staleKeys.length; i += 1000) {
      const batch = staleKeys.slice(i, i + 1000)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      )
    }
    logger.success(`Deleted ${staleKeys.length} stale files from S3 (preserved ${buildIdsToKeep.size} build ID(s))`)
  } else {
    logger.success('No stale files to delete')
  }

  // Step 4: Verify sync
  logger.step(4, totalSteps, 'Verifying upload...')

  let totalInS3 = 0
  continuationToken = undefined
  do {
    const listResult: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: '_next/static/',
        ContinuationToken: continuationToken,
      }),
    )
    totalInS3 += listResult.KeyCount || 0
    continuationToken = listResult.NextContinuationToken
  } while (continuationToken)

  logger.success(`${totalInS3} files in S3`)

  // Step 5: CloudFront Cache Invalidation
  logger.step(5, totalSteps, 'CloudFront cache invalidation...')

  if (skipInvalidation) {
    logger.warn('Skipping CloudFront invalidation (--skip-invalidation)')
  } else {
    const cfParam = `/nextjs/${config.environment}/cloudfront/distribution-id`
    // CloudFront edge stack stores SSM parameters in us-east-1 (global service)
    const cfConfig: AwsConfig = { ...config, region: 'us-east-1' }
    console.log(`   Looking up: ${cfParam} (us-east-1)`)
    const distributionId = await getSSMParameter(cfParam, cfConfig)

    if (!distributionId) {
      logger.warn(
        `CloudFront distribution ID not found in SSM. Skipping invalidation.\n` +
        `   Create SSM parameter: ${cfParam}`,
      )
    } else {
      console.log(`   Distribution: ${distributionId}`)

      const cf = new CloudFrontClient({
        region: config.region,
        credentials: config.credentials,
      })

      const result = await cf.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: `sync-${Date.now()}`,
            Paths: {
              Quantity: 2,
              Items: ['/_next/static/*', '/_next/data/*'],
            },
          },
        }),
      )

      logger.success(
        `CloudFront invalidation created: ${result.Invalidation?.Id}`,
      )
    }
  }

  logger.summary('Static Assets Sync Complete!', {
    'S3 Bucket': bucketName,
    'S3 Prefix': '/_next/static/',
    'Files Synced': String(uploaded),
  })
}

main().catch((error) => {
  logger.fatal(`S3 sync failed: ${error.message}`)
})
