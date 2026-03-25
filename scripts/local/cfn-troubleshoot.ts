#!/usr/bin/env tsx
/**
 * CloudFormation Stack Troubleshooter
 *
 * Deep-dive diagnostics for CloudFormation stack deployments.
 * Pass a stack name to see:
 *  - Current stack status and metadata
 *  - Recent stack events (failures highlighted)
 *  - Slow resources (sorted by duration)
 *  - Resources in failed or in-progress states
 *
 * Usage:
 *   Local: npx tsx scripts/local/cfn-troubleshoot.ts --stack ComputeStack-development --env development --profile dev-account
 *   CI:    npx tsx scripts/local/cfn-troubleshoot.ts --stack ComputeStack-development --env development
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
} from '@aws-sdk/client-cloudformation'
import type {
  StackEvent,
  StackResource,
} from '@aws-sdk/client-cloudformation'
import * as log from '../lib/logger.js'
import { startFileLogging, stopFileLogging } from '../lib/logger.js'
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js'
import type { AwsConfig } from '../lib/aws-helpers.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'stack', description: 'CloudFormation stack name (required)', hasValue: true },
    { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'events', description: 'Max events to show', hasValue: true, default: '50' },
    { name: 'slow-threshold', description: 'Seconds threshold for flagging slow resources', hasValue: true, default: '60' },
  ],
  'Troubleshoot CloudFormation stack deployments — diagnose slow, stuck, or failed operations',
)

// ========================================
// Constants
// ========================================

/** Status keywords that indicate a failure */
const FAILURE_STATUSES = [
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
  'ROLLBACK_IN_PROGRESS',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
] as const

/** Status keywords that indicate an in-progress operation */
const IN_PROGRESS_STATUSES = [
  'CREATE_IN_PROGRESS',
  'UPDATE_IN_PROGRESS',
  'DELETE_IN_PROGRESS',
  'UPDATE_ROLLBACK_IN_PROGRESS',
  'ROLLBACK_IN_PROGRESS',
] as const

// ========================================
// Types
// ========================================

/** Computed resource timing from stack events */
interface ResourceTiming {
  /** Logical resource ID */
  logicalId: string
  /** Resource type (e.g. AWS::AutoScaling::AutoScalingGroup) */
  resourceType: string
  /** When the resource operation started */
  startTime: Date
  /** When the resource operation ended (if complete) */
  endTime?: Date
  /** Duration in seconds */
  durationSeconds: number
  /** Final status of the resource */
  status: string
  /** Status reason if present */
  statusReason?: string
}

// ========================================
// Helpers
// ========================================

/**
 * Format a duration in seconds into a human-readable string.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string (e.g. '2m 15s')
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

/**
 * Determine if a status string represents a failure.
 *
 * @param status - CloudFormation resource/stack status
 * @returns Whether the status indicates failure
 */
function isFailureStatus(status: string): boolean {
  return FAILURE_STATUSES.some((s) => status.includes(s))
}

/**
 * Determine if a status string represents an in-progress operation.
 *
 * @param status - CloudFormation resource/stack status
 * @returns Whether the status indicates in-progress
 */
function isInProgressStatus(status: string): boolean {
  return IN_PROGRESS_STATUSES.some((s) => status.includes(s))
}

/**
 * Colour a status string based on its state.
 *
 * @param status - CloudFormation status
 * @returns ANSI-coloured status string
 */
function colourStatus(status: string): string {
  if (isFailureStatus(status)) return log.red(status)
  if (isInProgressStatus(status)) return log.yellow(status)
  if (status.includes('COMPLETE')) return log.green(status)
  return status
}

// ========================================
// Core Logic
// ========================================

/**
 * Fetch all stack events, handling pagination.
 *
 * @param client - CloudFormation SDK client
 * @param stackName - Stack name or ID
 * @param maxEvents - Maximum number of events to return
 * @returns Array of StackEvent objects (newest first)
 */
async function listStackEvents(
  client: CloudFormationClient,
  stackName: string,
  maxEvents: number,
): Promise<StackEvent[]> {
  const events: StackEvent[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(
      new DescribeStackEventsCommand({ StackName: stackName, NextToken: nextToken }),
    )
    if (response.StackEvents) {
      events.push(...response.StackEvents)
    }
    nextToken = response.NextToken
  } while (nextToken && events.length < maxEvents)

  return events.slice(0, maxEvents)
}

/**
 * Compute per-resource timings from stack events.
 *
 * Pairs IN_PROGRESS events with their corresponding COMPLETE/FAILED events
 * to calculate how long each resource took.
 *
 * @param events - Stack events (newest first)
 * @returns Array of ResourceTiming objects sorted by duration descending
 */
function computeResourceTimings(events: StackEvent[]): ResourceTiming[] {
  // Group events by logical resource ID
  const byResource = new Map<string, StackEvent[]>()
  for (const event of events) {
    const id = event.LogicalResourceId ?? 'Unknown'
    const existing = byResource.get(id) ?? []
    existing.push(event)
    byResource.set(id, existing)
  }

  const timings: ResourceTiming[] = []

  for (const [logicalId, resourceEvents] of byResource) {
    // Sort oldest first
    const sorted = [...resourceEvents].sort(
      (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0),
    )

    // Find the most recent IN_PROGRESS → COMPLETE/FAILED pair
    let startEvent: StackEvent | undefined
    let endEvent: StackEvent | undefined

    for (const event of sorted) {
      const status = event.ResourceStatus ?? ''
      if (isInProgressStatus(status)) {
        startEvent = event
        endEvent = undefined // Reset end when new start found
      } else if (startEvent && (status.includes('COMPLETE') || status.includes('FAILED'))) {
        endEvent = event
      }
    }

    if (startEvent?.Timestamp) {
      const startTime = startEvent.Timestamp
      const endTime = endEvent?.Timestamp
      const durationMs = endTime
        ? endTime.getTime() - startTime.getTime()
        : Date.now() - startTime.getTime()

      timings.push({
        logicalId,
        resourceType: startEvent.ResourceType ?? 'Unknown',
        startTime,
        endTime,
        durationSeconds: Math.round(durationMs / 1000),
        status: endEvent?.ResourceStatus ?? startEvent.ResourceStatus ?? 'UNKNOWN',
        statusReason: endEvent?.ResourceStatusReason ?? startEvent.ResourceStatusReason,
      })
    }
  }

  // Sort by duration descending (slowest first)
  return timings.sort((a, b) => b.durationSeconds - a.durationSeconds)
}

// ========================================
// Display Functions
// ========================================

/**
 * Print stack overview section.
 *
 * @param stackName - Stack name
 * @param status - Current stack status
 * @param description - Stack description
 * @param lastUpdated - Last update timestamp
 * @param stackId - Full stack ARN
 */
function printStackOverview(
  stackName: string,
  status: string,
  description: string,
  lastUpdated: Date | undefined,
  stackId: string,
): void {
  console.log('')
  console.log(log.cyan('  ╔══ Stack Overview ══════════════════════════════════════'))
  console.log(`  ║  Name: ${stackName}`)
  console.log(`  ║  Status: ${colourStatus(status)}`)
  if (description) console.log(`  ║  Description: ${description}`)
  if (lastUpdated) console.log(`  ║  Last Updated: ${lastUpdated.toISOString()}`)
  console.log(`  ║  ARN: ${stackId}`)
  console.log(log.cyan('  ╚════════════════════════════════════════════════════════'))
  console.log('')
}

/**
 * Print failed events section.
 *
 * @param events - Stack events to filter for failures
 */
function printFailedEvents(events: StackEvent[]): void {
  const failures = events.filter((e) =>
    isFailureStatus(e.ResourceStatus ?? ''),
  )

  if (failures.length === 0) {
    log.success('No failed events found')
    console.log('')
    return
  }

  console.log(log.red(`  ⚠️  ${failures.length} FAILED event(s):`))
  console.log('')

  for (const event of failures) {
    const time = event.Timestamp?.toISOString().split('T')[1]?.replace('Z', '') ?? ''
    const logicalId = event.LogicalResourceId ?? ''
    const status = event.ResourceStatus ?? ''
    const reason = event.ResourceStatusReason ?? ''

    console.log(`  ${log.red('✗')}  ${time}  ${logicalId}`)
    console.log(`     Status: ${colourStatus(status)}`)
    if (reason) {
      console.log(`     Reason: ${log.yellow(reason)}`)
    }
    console.log('')
  }
}

/**
 * Print slow resources section.
 *
 * @param timings - Computed resource timings
 * @param thresholdSeconds - Minimum duration to flag as slow
 */
function printSlowResources(timings: ResourceTiming[], thresholdSeconds: number): void {
  const slow = timings.filter((t) => t.durationSeconds >= thresholdSeconds)

  if (slow.length === 0) {
    log.success(`No resources exceeded ${thresholdSeconds}s threshold`)
    console.log('')
    return
  }

  console.log(log.yellow(`  🐢  ${slow.length} resource(s) exceeded ${thresholdSeconds}s threshold:`))
  console.log('')

  const headerLine = `  ${'Duration'.padStart(10)}  ${'Logical ID'.padEnd(50)}  ${'Type'.padEnd(40)}  Status`
  console.log(headerLine)
  console.log(`  ${'─'.repeat(10)}  ${'─'.repeat(50)}  ${'─'.repeat(40)}  ${'─'.repeat(25)}`)

  for (const timing of slow) {
    const dur = formatDuration(timing.durationSeconds).padStart(10)
    const id = timing.logicalId.padEnd(50)
    const type = timing.resourceType.padEnd(40)
    const status = colourStatus(timing.status)
    console.log(`  ${dur}  ${id}  ${type}  ${status}`)

    if (timing.statusReason) {
      console.log(`${''.padStart(14)}${log.yellow(`↳ ${timing.statusReason}`)}`)
    }
  }
  console.log('')
}

/**
 * Print resources currently in-progress.
 *
 * @param resources - Stack resources from DescribeStackResources
 */
function printInProgressResources(resources: StackResource[]): void {
  const inProgress = resources.filter((r) =>
    isInProgressStatus(r.ResourceStatus ?? ''),
  )

  if (inProgress.length === 0) {
    log.success('No resources currently in-progress')
    console.log('')
    return
  }

  console.log(log.yellow(`  ⏳  ${inProgress.length} resource(s) currently in-progress:`))
  console.log('')

  for (const resource of inProgress) {
    const elapsed = resource.Timestamp
      ? Math.round((Date.now() - resource.Timestamp.getTime()) / 1000)
      : 0

    console.log(`  ${log.yellow('●')}  ${resource.LogicalResourceId}`)
    console.log(`     Type: ${resource.ResourceType}`)
    console.log(`     Status: ${colourStatus(resource.ResourceStatus ?? '')}`)
    console.log(`     Elapsed: ${formatDuration(elapsed)}`)
    if (resource.ResourceStatusReason) {
      console.log(`     Reason: ${resource.ResourceStatusReason}`)
    }
    console.log('')
  }
}

/**
 * Print recent event timeline.
 *
 * @param events - Stack events (newest first)
 * @param limit - Max events to show
 */
function printEventTimeline(events: StackEvent[], limit: number): void {
  const shown = events.slice(0, limit)
  console.log(`  📋  Recent events (last ${shown.length}):\n`)

  const headerLine = `  ${'Time'.padEnd(15)}  ${'Status'.padEnd(30)}  ${'Logical ID'.padEnd(50)}  Reason`
  console.log(headerLine)
  console.log(`  ${'─'.repeat(15)}  ${'─'.repeat(30)}  ${'─'.repeat(50)}  ${'─'.repeat(40)}`)

  for (const event of shown) {
    const time = (event.Timestamp?.toISOString().split('T')[1]?.replace('Z', '') ?? '').padEnd(15)
    const status = event.ResourceStatus ?? ''
    const paddedStatus = status.padEnd(30)
    const logicalId = (event.LogicalResourceId ?? '').padEnd(50)
    const reason = event.ResourceStatusReason ?? ''

    // Colour the entire line based on status
    if (isFailureStatus(status)) {
      console.log(log.red(`  ${time}  ${paddedStatus}  ${logicalId}  ${reason}`))
    } else if (isInProgressStatus(status)) {
      console.log(`  ${time}  ${log.yellow(paddedStatus)}  ${logicalId}  ${reason}`)
    } else {
      console.log(`  ${time}  ${log.green(paddedStatus)}  ${logicalId}  ${reason}`)
    }
  }
  console.log('')
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const stackName = args['stack'] as string
  if (!stackName) {
    log.fatal('--stack is required. Usage: npx tsx scripts/local/cfn-troubleshoot.ts --stack <stack-name> --env development')
  }

  const logFile = startFileLogging('cfn-troubleshoot')
  const config: AwsConfig = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)
  const maxEvents = parseInt(args['events'] as string, 10)
  const slowThreshold = parseInt(args['slow-threshold'] as string, 10)

  log.header(`  CloudFormation Troubleshooter`)
  log.info(`Stack: ${stackName}`)
  log.info(`Auth: ${auth.mode}`)
  log.info(`Region: ${config.region}`)
  log.info(`Slow threshold: ${slowThreshold}s`)
  console.log('')

  const client = new CloudFormationClient({
    region: config.region,
    credentials: config.credentials,
  })

  // ─── Step 1: Stack overview ─────────────────────────────────────────
  log.step(1, 5, 'Fetching stack details...')

  const stackResponse = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
  )
  const stack = stackResponse.Stacks?.[0]

  if (!stack) {
    log.fatal(`Stack "${stackName}" not found.`)
  }

  printStackOverview(
    stack.StackName ?? stackName,
    stack.StackStatus ?? 'UNKNOWN',
    stack.Description ?? '',
    stack.LastUpdatedTimestamp ?? stack.CreationTime,
    stack.StackId ?? '',
  )

  // ─── Step 2: Fetch all events ───────────────────────────────────────
  log.step(2, 5, `Fetching last ${maxEvents} stack events...`)
  const events = await listStackEvents(client, stackName, maxEvents)
  log.success(`Retrieved ${events.length} event(s)`)
  console.log('')

  // ─── Step 3: Show failures ──────────────────────────────────────────
  log.step(3, 5, 'Analysing failures...')
  printFailedEvents(events)

  // ─── Step 4: Compute resource timings ───────────────────────────────
  log.step(4, 5, 'Computing resource timings...')
  const timings = computeResourceTimings(events)
  printSlowResources(timings, slowThreshold)

  // ─── Step 5: Current state & timeline ───────────────────────────────
  log.step(5, 5, 'Checking current resource states...')

  const resourcesResponse = await client.send(
    new DescribeStackResourcesCommand({ StackName: stackName }),
  )
  const resources = resourcesResponse.StackResources ?? []

  printInProgressResources(resources)
  printEventTimeline(events, 30)

  // ─── Summary ────────────────────────────────────────────────────────
  const failedCount = events.filter((e) => isFailureStatus(e.ResourceStatus ?? '')).length
  const slowCount = timings.filter((t) => t.durationSeconds >= slowThreshold).length
  const inProgressCount = resources.filter((r) => isInProgressStatus(r.ResourceStatus ?? '')).length
  const slowest = timings[0]

  log.summary('Stack Troubleshoot Complete', {
    'Stack': stackName,
    'Status': stack.StackStatus ?? 'UNKNOWN',
    'Total Events': String(events.length),
    'Failed Events': String(failedCount),
    'Slow Resources (>threshold)': String(slowCount),
    'Currently In-Progress': String(inProgressCount),
    'Slowest Resource': slowest
      ? `${slowest.logicalId} (${formatDuration(slowest.durationSeconds)})`
      : 'N/A',
  })

  stopFileLogging()
  log.info(`\nLog saved to: ${logFile}`)
}

main().catch((error: Error) => {
  log.fatal(`Stack troubleshoot failed: ${error.message}`)
})
