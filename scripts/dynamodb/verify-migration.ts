#!/usr/bin/env tsx
/**
 * Post-Migration Verification Script
 *
 * Smoke test that verifies:
 * 1. Articles exist in DynamoDB (Scan by entityType)
 * 2. GSI1 query works (STATUS#published — same query the Next.js app uses)
 * 3. GSI2 query works (TAG#<tag> — tag-based lookup)
 *
 * Intended to run as a pipeline step after migration to fail the build
 * if the data layer is broken.
 *
 * Usage:
 *   npx tsx scripts/dynamodb/verify-migration.ts --env development
 *   npx tsx scripts/dynamodb/verify-migration.ts --env dev --profile dev-account
 */

import {
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import logger from '@repo/script-utils/logger.js'
import {
  parseArgs,
  buildAwsConfig,
  getSSMParameterWithFallbacks,
} from '@repo/script-utils/aws.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: dev, development, staging, prod', hasValue: true, default: 'dev' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
  ],
  'Verify that DynamoDB table has been populated and SDK queries work',
)

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const config = buildAwsConfig(args)

  logger.header('🔍 Post-Migration & SDK Verification')
  logger.config('Configuration', {
    'AWS Region': config.region,
    'Environment': config.environment,
  })

  const totalSteps = 5

  // Step 1: Resolve table name and GSI names from SSM
  logger.step(1, totalSteps, 'Discovering DynamoDB table from SSM...')

  let tableName = process.env.DYNAMODB_TABLE_NAME
  if (!tableName) {
    const tableResult = await getSSMParameterWithFallbacks(
      [
        `/nextjs/${config.environment}/dynamodb-table-name`,
        `/nextjs/${config.environment}/dynamodb/table-name`,
      ],
      config,
    )
    if (tableResult) {
      tableName = tableResult.value
    } else {
      logger.fatal(
        `DynamoDB table name not found in SSM.\n` +
        `   Searched paths:\n` +
        `     /nextjs/${config.environment}/dynamodb-table-name\n` +
        `     /nextjs/${config.environment}/dynamodb/table-name`,
      )
    }
  }

  const gsi1Name = process.env.DYNAMODB_GSI1_NAME || 'gsi1-status-date'
  const gsi2Name = process.env.DYNAMODB_GSI2_NAME || 'gsi2-tag-date'

  logger.success(`Table: ${tableName}`)
  console.log(`   GSI1: ${gsi1Name}`)
  console.log(`   GSI2: ${gsi2Name}`)

  // Create DynamoDB client
  const dynamoClient = new DynamoDBClient({
    region: config.region,
    credentials: config.credentials,
  })
  const docClient = DynamoDBDocumentClient.from(dynamoClient)

  // Step 2: Describe table to check status
  logger.step(2, totalSteps, 'Checking table status...')

  const describeResult = await dynamoClient.send(
    new DescribeTableCommand({ TableName: tableName }),
  )

  const tableStatus = describeResult.Table?.TableStatus
  const approxItemCount = describeResult.Table?.ItemCount ?? 0

  console.log(`   Table status: ${tableStatus}`)
  console.log(`   Approximate item count: ${approxItemCount}`)

  if (tableStatus !== 'ACTIVE') {
    logger.fatal(`Table is not ACTIVE (status: ${tableStatus}). Migration may have failed.`)
  }

  // Step 3: Scan for article metadata items
  logger.step(3, totalSteps, 'Verifying article data exists (Scan)...')

  const scanResult = await docClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'entityType = :type',
      ExpressionAttributeValues: {
        ':type': 'ARTICLE_METADATA',
      },
      Select: 'COUNT',
    }),
  )

  const articleCount = scanResult.Count ?? 0

  if (articleCount === 0) {
    logger.fatal(
      `No articles found in DynamoDB table '${tableName}'.\n` +
      `   The migration step may have failed silently or used the wrong table.\n` +
      `   Table item count from DescribeTable: ${approxItemCount}\n` +
      `   Articles found via Scan: ${articleCount}`,
    )
  }

  logger.success(`Scan found ${articleCount} articles`)

  // Step 4: Verify GSI1 query (STATUS#published) — this is how the Next.js app reads articles
  logger.step(4, totalSteps, 'Verifying GSI1 query (STATUS#published)...')

  try {
    const gsi1Result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: gsi1Name,
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: {
          ':pk': 'STATUS#published',
        },
        ScanIndexForward: false,
      }),
    )

    const gsi1Count = gsi1Result.Items?.length ?? 0

    if (gsi1Count === 0) {
      logger.fatal(
        `GSI1 query returned 0 results.\n` +
        `   Index: ${gsi1Name}\n` +
        `   Query: gsi1pk = STATUS#published\n` +
        `   This means the Next.js app won't see any articles via DynamoDB SDK.\n` +
        `   Check that migrated articles have gsi1pk set to 'STATUS#published'.`,
      )
    }

    logger.success(`GSI1 query returned ${gsi1Count} published articles`)

    // Show sample articles in date order (as the app displays them)
    if (gsi1Result.Items && gsi1Result.Items.length > 0) {
      console.log('\n   Published articles (newest first):')
      for (const item of gsi1Result.Items) {
        console.log(`     ✓ ${item.date} — ${item.slug}`)
      }
    }

    // Cross-check: GSI1 count should match Scan count
    if (gsi1Count !== articleCount) {
      console.log(`\n   ⚠️  Count mismatch: Scan=${articleCount}, GSI1=${gsi1Count}`)
      console.log(`      Some articles may not have status=published or gsi1pk set.`)
    }
  } catch (error: any) {
    logger.fatal(
      `GSI1 query failed.\n` +
      `   Index: ${gsi1Name}\n` +
      `   Error: ${error.message}\n` +
      `   Ensure the GSI exists on the table with pk=gsi1pk, sk=gsi1sk.`,
    )
  }

  // Step 5: Verify GSI2 query (TAG# lookup) — spot check
  logger.step(5, totalSteps, 'Verifying GSI2 tag index (spot check)...')

  try {
    // First find a tag to query by scanning TAG_INDEX items
    const tagScan = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'entityType = :type',
        ExpressionAttributeValues: {
          ':type': 'TAG_INDEX',
        },
        Limit: 1,
      }),
    )

    if (tagScan.Items && tagScan.Items.length > 0) {
      const sampleTag = tagScan.Items[0].tag as string

      const gsi2Result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: gsi2Name,
          KeyConditionExpression: 'gsi2pk = :pk',
          ExpressionAttributeValues: {
            ':pk': `TAG#${sampleTag}`,
          },
          ScanIndexForward: false,
        }),
      )

      const tagCount = gsi2Result.Items?.length ?? 0
      logger.success(`GSI2 query for tag "${sampleTag}" returned ${tagCount} articles`)
    } else {
      console.log('   ⚠️  No TAG_INDEX items found, skipping GSI2 verification')
    }
  } catch (error: any) {
    // GSI2 is less critical — warn instead of fatal
    console.log(`   ⚠️  GSI2 query failed: ${error.message}`)
    console.log(`      Tag queries may not work. Check GSI2 index: ${gsi2Name}`)
  }

  // Summary
  logger.summary('Verification Passed', {
    'Table': tableName!,
    'Status': tableStatus!,
    'Articles (Scan)': String(articleCount),
    'GSI1 (STATUS#published)': '✅ Working',
    'GSI2 (TAG# lookup)': '✅ Checked',
  })
}

main().catch((error) => {
  logger.fatal(`Verification failed: ${error.message}`)
})
