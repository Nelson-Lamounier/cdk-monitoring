#!/usr/bin/env tsx
/**
 * CloudWatch Log Group Audit
 *
 * Lists all CloudWatch log groups in a region and provides:
 *  - Empty vs active status (based on storedBytes)
 *  - Which CloudFormation stack created each log group (via tags)
 *  - Whether logs are actively being streamed (last ingestion timestamp)
 *  - Retention policy and stored size
 *
 * Usage:
 *   Local: npx tsx scripts/local/cloudwatch-log-audit.ts --env development --profile dev-account
 *   CI:    npx tsx scripts/local/cloudwatch-log-audit.ts --env development
 */

import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import type { LogGroup } from '@aws-sdk/client-cloudwatch-logs'
import * as log from '../lib/logger.js'
import { startFileLogging, stopFileLogging } from '../lib/logger.js'
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js'
import type { AwsConfig } from '../lib/aws-helpers.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'empty-only', description: 'Show only empty log groups', hasValue: false, default: false },
    { name: 'stale-days', description: 'Days since last ingestion to consider stale', hasValue: true, default: '7' },
  ],
  'Audit CloudWatch log groups — identify empty, stale, and unmanaged log groups',
)

// ========================================
// Constants
// ========================================

/** Tag key used by CloudFormation to identify the source stack */
const CFN_STACK_TAG = 'aws:cloudformation:stack-name'

/** Tag key for the logical resource ID within the stack */
const CFN_LOGICAL_ID_TAG = 'aws:cloudformation:logical-id'

/** Milliseconds per day */
const MS_PER_DAY = 86_400_000

// ========================================
// Types
// ========================================

/** Health classification for a log group */
type LogGroupHealth = 'active' | 'stale' | 'empty'

/** Enriched metadata for a single CloudWatch log group */
interface LogGroupInfo {
  /** The log group name */
  name: string
  /** The log group ARN */
  arn: string
  /** Stored bytes (0 = empty) */
  storedBytes: number
  /** Human-readable stored size */
  storedSize: string
  /** Retention in days, or 'Never expire' */
  retention: string
  /** Last ingestion time as ISO string, or 'Never' */
  lastIngestion: string
  /** Milliseconds since last ingestion, or Infinity if never */
  lastIngestionAgeMs: number
  /** Health classification */
  health: LogGroupHealth
  /** CloudFormation stack name, or 'N/A' */
  cfnStack: string
  /** CloudFormation logical ID, or 'N/A' */
  cfnLogicalId: string
  /** All tags on the log group */
  tags: Record<string, string>
}

// ========================================
// Helpers
// ========================================

/**
 * Format bytes into a human-readable size string.
 *
 * @param bytes - Raw byte count
 * @returns Formatted string (e.g. '1.5 MB')
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(1)} ${units[exponent]}`
}

/**
 * Format a Unix timestamp (ms) into a relative age string.
 *
 * @param timestampMs - Unix timestamp in milliseconds
 * @returns Human-readable age (e.g. '3 days ago')
 */
function formatAge(timestampMs: number): string {
  const ageMs = Date.now() - timestampMs
  const days = Math.floor(ageMs / MS_PER_DAY)
  if (days === 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

/**
 * Classify a log group's health based on stored bytes and last ingestion.
 *
 * @param storedBytes - Number of stored bytes
 * @param lastIngestionMs - Milliseconds since epoch of last ingestion, or undefined
 * @param staleDays - Number of days threshold for staleness
 * @returns Health classification
 */
function classifyHealth(
  storedBytes: number,
  lastIngestionMs: number | undefined,
  staleDays: number,
): LogGroupHealth {
  if (storedBytes === 0) return 'empty'
  if (!lastIngestionMs) return 'stale'
  const ageMs = Date.now() - lastIngestionMs
  if (ageMs > staleDays * MS_PER_DAY) return 'stale'
  return 'active'
}

// ========================================
// Core Logic
// ========================================

/**
 * Fetch all log groups in the region, handling pagination.
 *
 * @param client - The CloudWatch Logs SDK client
 * @returns Array of LogGroup objects
 */
async function listAllLogGroups(client: CloudWatchLogsClient): Promise<LogGroup[]> {
  const groups: LogGroup[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(
      new DescribeLogGroupsCommand({ nextToken, limit: 50 }),
    )
    if (response.logGroups) {
      groups.push(...response.logGroups)
    }
    nextToken = response.nextToken
  } while (nextToken)

  return groups
}


/**
 * Sanitise a log group ARN for use with ListTagsForResource.
 *
 * DescribeLogGroups returns ARNs with a trailing `:*` (e.g.
 * `arn:aws:logs:eu-west-1:123456:log-group:/my-group:*`), but
 * ListTagsForResource requires the ARN **without** that suffix.
 *
 * @param arn - Raw ARN from DescribeLogGroups
 * @returns Clean ARN suitable for tag lookups
 */
function sanitiseArn(arn: string): string {
  return arn.endsWith(':*') ? arn.slice(0, -2) : arn
}

async function getLogGroupTags(
  client: CloudWatchLogsClient,
  arn: string,
): Promise<Record<string, string>> {
  try {
    const response = await client.send(
      new ListTagsForResourceCommand({ resourceArn: sanitiseArn(arn) }),
    )
    return response.tags ?? {}
  } catch {
    return {}
  }
}

/**
 * Get the most recent event timestamp across all streams in a log group.
 *
 * Queries the single most-recently-active stream to avoid scanning every stream.
 *
 * @param client - The CloudWatch Logs SDK client
 * @param logGroupName - Name of the log group
 * @returns Unix timestamp in ms of the last event, or undefined if none
 */
async function getLastEventTimestamp(
  client: CloudWatchLogsClient,
  logGroupName: string,
): Promise<number | undefined> {
  try {
    const response = await client.send(
      new DescribeLogStreamsCommand({
        logGroupName,
        orderBy: 'LastEventTime',
        descending: true,
        limit: 1,
      }),
    )
    return response.logStreams?.[0]?.lastEventTimestamp
  } catch {
    return undefined
  }
}

/**
 * Enrich a raw LogGroup with tags, last-event info, and health classification.
 *
 * @param client - The CloudWatch Logs SDK client
 * @param group - Raw LogGroup from the API
 * @param staleDays - Days threshold for stale classification
 * @returns Enriched LogGroupInfo
 */
async function enrichLogGroup(
  client: CloudWatchLogsClient,
  group: LogGroup,
  staleDays: number,
): Promise<LogGroupInfo> {
  const arn = group.arn ?? ''
  const name = group.logGroupName ?? 'Unknown'
  const storedBytes = group.storedBytes ?? 0
  const retentionDays = group.retentionInDays

  const [tags, lastEventMs] = await Promise.all([
    getLogGroupTags(client, arn),
    getLastEventTimestamp(client, name),
  ])

  const health = classifyHealth(storedBytes, lastEventMs, staleDays)

  const lastIngestion = lastEventMs
    ? `${new Date(lastEventMs).toISOString()} (${formatAge(lastEventMs)})`
    : 'Never'

  return {
    name,
    arn,
    storedBytes,
    storedSize: formatBytes(storedBytes),
    retention: retentionDays ? `${retentionDays} days` : 'Never expire',
    lastIngestion,
    lastIngestionAgeMs: lastEventMs ? Date.now() - lastEventMs : Infinity,
    health,
    cfnStack: tags[CFN_STACK_TAG] ?? 'N/A',
    cfnLogicalId: tags[CFN_LOGICAL_ID_TAG] ?? 'N/A',
    tags,
  }
}

/**
 * Print a single log group row in the summary table.
 *
 * @param info - Enriched log group info
 */
function printRow(info: LogGroupInfo): void {
  const healthIcon = info.health === 'active'
    ? log.green('●')
    : info.health === 'stale'
      ? log.yellow('●')
      : log.red('○')

  const nameCol = info.name.padEnd(55)
  const sizeCol = info.storedSize.padStart(10)
  const retCol = info.retention.padStart(14)
  const stackCol = info.cfnStack === 'N/A' ? log.yellow('N/A') : info.cfnStack

  console.log(`  ${healthIcon}  ${nameCol}  ${sizeCol}  ${retCol}  ${stackCol}`)
}

/**
 * Print detailed card for a log group.
 *
 * @param info - Enriched log group info
 */
function printDetail(info: LogGroupInfo): void {
  console.log(`  ┌─ ${info.name}`)
  console.log(`  │  Health: ${info.health.toUpperCase()}`)
  console.log(`  │  Stored: ${info.storedSize}`)
  console.log(`  │  Retention: ${info.retention}`)
  console.log(`  │  Last Event: ${info.lastIngestion}`)
  console.log(`  │  Stack: ${info.cfnStack}`)
  console.log(`  │  Logical ID: ${info.cfnLogicalId}`)

  // Show non-CloudFormation tags
  const customTags = Object.entries(info.tags)
    .filter(([key]) => !key.startsWith('aws:cloudformation:'))
  if (customTags.length > 0) {
    console.log('  │  Tags:')
    for (const [key, value] of customTags) {
      console.log(`  │    ${key} = ${value}`)
    }
  }
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const logFile = startFileLogging('cloudwatch-log-audit')
  const config: AwsConfig = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)
  const emptyOnly = args['empty-only'] as boolean
  const staleDays = parseInt(args['stale-days'] as string, 10)

  log.header(`  CloudWatch Log Group Audit (${config.environment} / ${config.region})`)
  log.info(`Auth: ${auth.mode}`)
  log.info(`Stale threshold: ${staleDays} days`)
  console.log('')

  const client = new CloudWatchLogsClient({
    region: config.region,
    credentials: config.credentials,
  })

  // ─── Step 1: Discover all log groups ────────────────────────────────
  log.step(1, 3, 'Discovering log groups...')
  const groups = await listAllLogGroups(client)

  if (groups.length === 0) {
    log.warn('No CloudWatch log groups found.')
    return
  }
  log.success(`Found ${groups.length} log group(s)`)
  console.log('')

  // ─── Step 2: Enrich with tags and classify ──────────────────────────
  log.step(2, 3, 'Fetching tags and classifying log groups...')

  // Process in batches of 10 to avoid throttling
  const BATCH_SIZE = 10
  const enriched: LogGroupInfo[] = []
  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const batch = groups.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map((g) => enrichLogGroup(client, g, staleDays)),
    )
    enriched.push(...results)
  }

  // Sort: empty first, then stale, then active
  const healthOrder: Record<LogGroupHealth, number> = { empty: 0, stale: 1, active: 2 }
  enriched.sort((a, b) => healthOrder[a.health] - healthOrder[b.health])

  const filtered = emptyOnly ? enriched.filter((g) => g.health === 'empty') : enriched

  // ─── Step 3: Display results ────────────────────────────────────────
  log.step(3, 3, 'Generating report...')
  console.log('')

  // Summary table header
  const headerLine = `  ${'St'.padEnd(3)}  ${'Log Group Name'.padEnd(55)}  ${'Size'.padStart(10)}  ${'Retention'.padStart(14)}  Stack`
  console.log(headerLine)
  console.log(`  ${'─'.repeat(3)}  ${'─'.repeat(55)}  ${'─'.repeat(10)}  ${'─'.repeat(14)}  ${'─'.repeat(30)}`)

  for (const info of filtered) {
    printRow(info)
  }

  // Counts
  const activeCount = enriched.filter((g) => g.health === 'active').length
  const staleCount = enriched.filter((g) => g.health === 'stale').length
  const emptyCount = enriched.filter((g) => g.health === 'empty').length
  const unmanagedCount = enriched.filter((g) => g.cfnStack === 'N/A').length

  console.log('')
  console.log('──────────────────────────────────────────────────────────────')
  console.log(`  Total: ${enriched.length}  │  ${log.green(`● Active: ${activeCount}`)}  │  ${log.yellow(`● Stale: ${staleCount}`)}  │  ${log.red(`○ Empty: ${emptyCount}`)}`)
  console.log(`  Unmanaged (no CFN stack): ${unmanagedCount}`)
  console.log('──────────────────────────────────────────────────────────────')

  // ─── Detailed review of empty log groups ────────────────────────────
  const emptyGroups = enriched.filter((g) => g.health === 'empty')
  if (emptyGroups.length > 0) {
    console.log('')
    log.warn(`Detailed review of ${emptyGroups.length} empty log group(s):`)
    console.log('')
    for (const info of emptyGroups) {
      printDetail(info)
    }
  }

  // ─── Detailed review of unmanaged log groups ────────────────────────
  const unmanagedGroups = enriched.filter((g) => g.cfnStack === 'N/A')
  if (unmanagedGroups.length > 0) {
    console.log('')
    log.warn(`Detailed review of ${unmanagedGroups.length} unmanaged log group(s) (no CloudFormation stack):`)
    console.log('')
    for (const info of unmanagedGroups) {
      printDetail(info)
    }
  }

  log.summary('Log Group Audit Complete', {
    'Total Log Groups': String(enriched.length),
    'Active (receiving logs)': String(activeCount),
    'Stale (no recent logs)': String(staleCount),
    'Empty (0 bytes)': String(emptyCount),
    'Unmanaged (no CFN stack)': String(unmanagedCount),
  })

  stopFileLogging()
  log.info(`\nLog saved to: ${logFile}`)
}

main().catch((error: Error) => {
  log.fatal(`CloudWatch log audit failed: ${error.message}`)
})
