#!/usr/bin/env tsx
/**
 * CloudWatch Logs + SSM Run Command — Diagnostic Query Script
 *
 * Fetches the most recent log events from a CloudWatch log group using
 * Logs Insights and retrieves recent SSM Run Command history.
 * Output is printed to the terminal as JSON and saved to the local
 * diagnostics directory.
 *
 * Usage:
 *   Local: npx tsx scripts/local/cw-last-query.ts --log-group /aws/logs/my-app --profile dev-account
 *   CI:    npx tsx scripts/local/cw-last-query.ts --log-group /aws/logs/my-app --env development
 */

import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import type { QueryStatus, ResultField } from '@aws-sdk/client-cloudwatch-logs'
import {
  SSMClient,
  ListCommandsCommand,
  ListCommandInvocationsCommand,
} from '@aws-sdk/client-ssm'
import type { Command, CommandInvocation } from '@aws-sdk/client-ssm'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as log from '../lib/logger.js'
import { startFileLogging, stopFileLogging } from '../lib/logger.js'
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js'
import type { AwsConfig } from '../lib/aws-helpers.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'log-group', description: 'CloudWatch log group name (required)', hasValue: true },
    { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'hours', description: 'Hours to look back', hasValue: true, default: '1' },
    { name: 'limit', description: 'Max log events to return', hasValue: true, default: '50' },
    { name: 'query', description: 'Custom Logs Insights query (overrides default)', hasValue: true },
    { name: 'instance-id', description: 'Filter SSM commands by target instance ID', hasValue: true },
  ],
  'Fetch recent CloudWatch log events and SSM Run Command history — combined diagnostic output',
)

// ========================================
// Constants
// ========================================

/** Maximum seconds to wait for a Logs Insights query to complete */
const QUERY_TIMEOUT_SECONDS = 60

/** Initial polling interval in milliseconds */
const INITIAL_POLL_INTERVAL_MS = 1_000

/** Maximum polling interval in milliseconds */
const MAX_POLL_INTERVAL_MS = 5_000

/** Terminal query statuses that indicate the query has finished */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'Complete',
  'Failed',
  'Cancelled',
  'Timeout',
])

/** Maximum SSM commands to retrieve per page */
const SSM_MAX_RESULTS = 25

// ========================================
// Types
// ========================================

/** A single flattened log event from Logs Insights */
interface LogEvent {
  [key: string]: string
}

/** Summary of a single SSM Run Command with its invocation output */
interface SsmCommandSummary {
  /** Unique command ID */
  commandId: string
  /** SSM document name (e.g. AWS-RunShellScript) */
  documentName: string
  /** Overall command status */
  status: string
  /** When the command was requested */
  requestedAt: string
  /** Target instance IDs */
  targets: string[]
  /** Comment/description if provided */
  comment: string
  /** Invocation details (one per target instance) */
  invocations: SsmInvocationDetail[]
}

/** Detail for a single invocation of an SSM command on one instance */
interface SsmInvocationDetail {
  /** Target instance ID */
  instanceId: string
  /** Invocation status */
  status: string
  /** Standard output (truncated by AWS to ~2500 chars) */
  standardOutput: string
  /** Standard error URL (S3 pre-signed URL, empty if no S3 bucket configured) */
  standardError: string
}

/** Full diagnostic report combining both data sources */
interface DiagnosticReport {
  /** Metadata about the query run */
  metadata: {
    logGroup: string
    region: string
    timeWindow: {
      start: string
      end: string
    }
    generatedAt: string
    instanceIdFilter: string | undefined
  }
  /** Recent log events from CloudWatch Logs Insights */
  logInsights: LogEvent[]
  /** Recent SSM Run Command history */
  ssmCommands: SsmCommandSummary[]
}

// ========================================
// Helpers
// ========================================

/**
 * Resolve the diagnostics output directory path.
 *
 * @returns Absolute path to `scripts/local/diagnostics/`
 */
function getDiagnosticsDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return join(__dirname, 'diagnostics')
}

/**
 * Convert an array of Logs Insights ResultField into a flat key/value object.
 *
 * @param fields - Array of ResultField from GetQueryResults
 * @returns Flattened record
 */
function flattenResultFields(fields: ResultField[]): LogEvent {
  const record: LogEvent = {}
  for (const field of fields) {
    if (field.field && field.value) {
      record[field.field] = field.value
    }
  }
  return record
}

/**
 * Sleep for a given number of milliseconds.
 *
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ========================================
// Phase 1 — CloudWatch Logs Insights
// ========================================

/**
 * Run a CloudWatch Logs Insights query and poll until complete.
 *
 * @param client - CloudWatch Logs SDK client
 * @param logGroupName - Target log group
 * @param queryString - Logs Insights query string
 * @param startTime - Query start (epoch seconds)
 * @param endTime - Query end (epoch seconds)
 * @returns Array of flattened log events
 */
async function runLogsInsightsQuery(
  client: CloudWatchLogsClient,
  logGroupName: string,
  queryString: string,
  startTime: number,
  endTime: number,
): Promise<LogEvent[]> {
  log.step(1, 5, 'Submitting CloudWatch Logs Insights query...')
  log.info(`  Log group: ${logGroupName}`)
  log.info(`  Query: ${queryString}`)

  const startResponse = await client.send(
    new StartQueryCommand({
      logGroupName,
      startTime,
      endTime,
      queryString,
    }),
  )

  const queryId = startResponse.queryId
  if (!queryId) {
    log.fatal('Failed to start Logs Insights query — no queryId returned.')
  }

  log.success(`Query submitted (ID: ${queryId})`)

  // ─── Poll for results ────────────────────────────────────────────────
  log.step(2, 5, 'Polling for query results...')

  let pollInterval = INITIAL_POLL_INTERVAL_MS
  const deadline = Date.now() + QUERY_TIMEOUT_SECONDS * 1_000

  while (Date.now() < deadline) {
    await sleep(pollInterval)

    const resultResponse = await client.send(
      new GetQueryResultsCommand({ queryId }),
    )

    const status: QueryStatus | undefined = resultResponse.status
    const statusStr = status ?? 'Unknown'

    if (TERMINAL_STATUSES.has(statusStr)) {
      if (statusStr === 'Complete') {
        const results = resultResponse.results ?? []
        log.success(`Query complete — ${results.length} event(s) returned`)
        return results.map(flattenResultFields)
      }
      log.fatal(`Logs Insights query finished with status: ${statusStr}`)
    }

    // Exponential back-off capped at MAX_POLL_INTERVAL_MS
    pollInterval = Math.min(pollInterval * 1.5, MAX_POLL_INTERVAL_MS)
  }

  log.fatal(`Logs Insights query timed out after ${QUERY_TIMEOUT_SECONDS}s`)
}

// ========================================
// Phase 2 — SSM Run Command History
// ========================================

/**
 * Fetch recent SSM Run Commands and their invocation output.
 *
 * @param client - SSM SDK client
 * @param startTime - Window start (Date)
 * @param instanceId - Optional instance ID filter
 * @returns Array of SSM command summaries
 */
async function fetchSsmCommandHistory(
  client: SSMClient,
  startTime: Date,
  instanceId?: string,
): Promise<SsmCommandSummary[]> {
  log.step(3, 5, 'Fetching SSM Run Command history...')

  const filters = [
    { key: 'InvokedAfter' as const, value: startTime.toISOString() },
  ]

  const listResponse = await client.send(
    new ListCommandsCommand({
      MaxResults: SSM_MAX_RESULTS,
      Filters: filters,
    }),
  )

  const commands: Command[] = listResponse.Commands ?? []

  if (commands.length === 0) {
    log.info('  No SSM Run Commands found in the time window.')
    return []
  }

  log.success(`Found ${commands.length} SSM command(s)`)

  // Fetch invocation details for each command
  const summaries: SsmCommandSummary[] = []

  for (const cmd of commands) {
    const commandId = cmd.CommandId ?? 'unknown'
    const invocations = await fetchInvocations(client, commandId, instanceId)

    summaries.push({
      commandId,
      documentName: cmd.DocumentName ?? 'Unknown',
      status: cmd.Status ?? 'Unknown',
      requestedAt: cmd.RequestedDateTime?.toISOString() ?? '',
      targets: cmd.Targets?.map((t) => `${t.Key}=${t.Values?.join(',')}`) ?? cmd.InstanceIds ?? [],
      comment: cmd.Comment ?? '',
      invocations,
    })
  }

  return summaries
}

/**
 * Fetch invocation details for a single SSM command.
 *
 * @param client - SSM SDK client
 * @param commandId - The command to look up
 * @param instanceId - Optional instance ID filter
 * @returns Array of invocation details
 */
async function fetchInvocations(
  client: SSMClient,
  commandId: string,
  instanceId?: string,
): Promise<SsmInvocationDetail[]> {
  const params: Record<string, unknown> = {
    CommandId: commandId,
    Details: true,
    MaxResults: 10,
  }

  if (instanceId) {
    params['InstanceId'] = instanceId
  }

  try {
    const response = await client.send(
      new ListCommandInvocationsCommand(params),
    )

    const invocations: CommandInvocation[] = response.CommandInvocations ?? []

    return invocations.map((inv) => {
      const pluginOutput = inv.CommandPlugins?.[0]

      return {
        instanceId: inv.InstanceId ?? 'unknown',
        status: inv.Status ?? 'Unknown',
        standardOutput: pluginOutput?.Output ?? '',
        standardError: pluginOutput?.StandardErrorUrl ?? inv.StandardErrorUrl ?? '',
      }
    })
  } catch {
    log.warn(`  Could not fetch invocations for command ${commandId}`)
    return []
  }
}

// ========================================
// Output
// ========================================

/**
 * Write the diagnostic report JSON to the diagnostics directory.
 *
 * @param report - Combined diagnostic report
 * @returns Absolute path to the saved file
 */
function saveDiagnosticReport(report: DiagnosticReport): string {
  const dir = getDiagnosticsDir()
  mkdirSync(dir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(dir, `cw-last-query-${timestamp}.json`)

  writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8')
  return filePath
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const logGroupName = args['log-group'] as string
  if (!logGroupName) {
    log.fatal(
      '--log-group is required.\n' +
      'Usage: npx tsx scripts/local/cw-last-query.ts --log-group <name> --profile dev-account',
    )
  }

  const logFile = startFileLogging('cw-last-query')
  const config: AwsConfig = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)

  const hours = parseInt(args['hours'] as string, 10)
  const limit = parseInt(args['limit'] as string, 10)
  const instanceId = args['instance-id'] as string | undefined
  const customQuery = args['query'] as string | undefined

  log.header('  CloudWatch Logs + SSM Run Command Diagnostic')
  log.info(`Log Group: ${logGroupName}`)
  log.info(`Auth: ${auth.mode}`)
  log.info(`Region: ${config.region}`)
  log.info(`Look-back: ${hours}h | Limit: ${limit}`)
  if (instanceId) log.info(`Instance filter: ${instanceId}`)
  console.log('')

  // Time window
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - hours * 3_600_000)

  const cwClient = new CloudWatchLogsClient({
    region: config.region,
    credentials: config.credentials,
  })

  const ssmClient = new SSMClient({
    region: config.region,
    credentials: config.credentials,
  })

  // ─── Phase 1: CloudWatch Logs Insights ───────────────────────────────
  const queryString = customQuery ??
    `fields @timestamp, @message, @logStream\n| sort @timestamp desc\n| limit ${limit}`

  const logInsights = await runLogsInsightsQuery(
    cwClient,
    logGroupName,
    queryString,
    Math.floor(startTime.getTime() / 1_000),
    Math.floor(endTime.getTime() / 1_000),
  )

  // ─── Phase 2: SSM Run Command History ────────────────────────────────
  const ssmCommands = await fetchSsmCommandHistory(ssmClient, startTime, instanceId)

  // ─── Phase 3: Combine and output ─────────────────────────────────────
  log.step(4, 5, 'Building diagnostic report...')

  const report: DiagnosticReport = {
    metadata: {
      logGroup: logGroupName,
      region: config.region,
      timeWindow: {
        start: startTime.toISOString(),
        end: endTime.toISOString(),
      },
      generatedAt: new Date().toISOString(),
      instanceIdFilter: instanceId,
    },
    logInsights,
    ssmCommands,
  }

  // Print JSON to terminal
  console.log('')
  console.log(JSON.stringify(report, null, 2))
  console.log('')

  // Save to diagnostics directory
  log.step(5, 5, 'Saving diagnostic report...')
  const outputPath = saveDiagnosticReport(report)

  log.summary('Diagnostic Query Complete', {
    'Log Group': logGroupName,
    'Time Window': `${startTime.toISOString()} → ${endTime.toISOString()}`,
    'Log Events': String(logInsights.length),
    'SSM Commands': String(ssmCommands.length),
    'JSON Report': outputPath,
  })

  stopFileLogging()
  log.info(`\nLog saved to: ${logFile}`)
}

main().catch((error: Error) => {
  log.fatal(`Diagnostic query failed: ${error.message}`)
})
