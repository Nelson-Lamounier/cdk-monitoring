#!/usr/bin/env tsx
/**
 * Verify DynamoDB Table Structure
 *
 * Checks that the DynamoDB table exists and has the correct key schema
 * for the article migration. Reports on GSIs, billing mode, and item count.
 *
 * Usage: npx tsx scripts/verify-table.ts [--profile dev-account]
 */

import {
  DynamoDBClient,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb'
import * as log from './lib/logger.js'
import { parseArgs, buildAwsConfig } from './lib/aws-helpers.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: dev, staging, prod', hasValue: true, default: 'dev' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'table', description: 'DynamoDB table name override', hasValue: true },
  ],
  'Verify DynamoDB table structure for article migration',
)

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const config = buildAwsConfig(args)
  const tableName =
    (args.table as string) ||
    process.env.DYNAMODB_TABLE_NAME ||
    `webapp-articles-${config.environment}`

  console.log(`Checking DynamoDB table: ${tableName}`)
  console.log(`Region: ${config.region}`)
  console.log('')

  const dynamodb = new DynamoDBClient({
    region: config.region,
    credentials: config.credentials,
  })

  // Describe table
  let tableInfo
  try {
    const result = await dynamodb.send(
      new DescribeTableCommand({ TableName: tableName }),
    )
    tableInfo = result.Table
  } catch {
    log.fatal(`Table '${tableName}' not found or no access`)
  }

  if (!tableInfo) {
    log.fatal(`Table '${tableName}' not found`)
  }

  log.success('Table exists!')
  console.log('')

  // Key schema
  const pk = tableInfo.KeySchema?.find((k) => k.KeyType === 'HASH')?.AttributeName
  const sk = tableInfo.KeySchema?.find((k) => k.KeyType === 'RANGE')?.AttributeName

  console.log('Key Schema:')
  console.log(`  Partition Key: ${pk}`)
  console.log(`  Sort Key: ${sk}`)
  console.log('')

  if (pk !== 'pk' || sk !== 'sk') {
    log.warn(
      `Expected keys 'pk' and 'sk' but found '${pk}' and '${sk}'\n` +
      '\n' +
      'The migration script expects:\n' +
      '  - Partition Key: pk (String)\n' +
      '  - Sort Key: sk (String)\n' +
      '\n' +
      "Your table has different key names. You'll need to either:\n" +
      '  1. Recreate the table with correct keys, OR\n' +
      `  2. Modify the migration script to use '${pk}' and '${sk}'`,
    )
    process.exit(1)
  }

  // GSIs
  const gsis = tableInfo.GlobalSecondaryIndexes || []
  console.log(`Global Secondary Indexes: ${gsis.length}`)
  for (const gsi of gsis) {
    const gsiPk = gsi.KeySchema?.find((k) => k.KeyType === 'HASH')?.AttributeName
    const gsiSk = gsi.KeySchema?.find((k) => k.KeyType === 'RANGE')?.AttributeName
    console.log(`  - ${gsi.IndexName}: ${gsiPk} / ${gsiSk}`)
  }
  console.log('')

  // Billing mode
  const billingMode = tableInfo.BillingModeSummary?.BillingMode || 'PROVISIONED'
  console.log(`Billing Mode: ${billingMode}`)

  if (billingMode === 'PROVISIONED') {
    const read = tableInfo.ProvisionedThroughput?.ReadCapacityUnits
    const write = tableInfo.ProvisionedThroughput?.WriteCapacityUnits
    console.log(`  Read Capacity: ${read}`)
    console.log(`  Write Capacity: ${write}`)
  }
  console.log('')

  // Current state
  const itemCount = tableInfo.ItemCount || 0
  const tableSize = tableInfo.TableSizeBytes || 0

  console.log('Current State:')
  console.log(`  Items: ${itemCount}`)
  console.log(`  Size: ${tableSize} bytes`)
  console.log('')

  if (itemCount > 0) {
    log.info('ℹ️  Table already contains items')
    console.log('   The migration script will skip articles that already exist')
  }

  console.log('')
  log.success('Table structure looks good!')

  log.nextSteps([
    'Run: npx tsx scripts/setup-migration.ts',
    'Run: yarn migrate:articles:dry-run',
    'Run: yarn migrate:articles',
  ])
}

main().catch((error) => {
  log.fatal(`Table verification failed: ${error.message}`)
})
