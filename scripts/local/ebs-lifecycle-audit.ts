#!/usr/bin/env tsx
/**
 * EBS Volume Lifecycle Auditor
 *
 * Diagnoses EBS volume detach/attach timing during ASG rolling updates.
 * Queries CloudTrail for volume events, EC2 for current state, and
 * Auto Scaling for activity history to build a complete timeline.
 *
 * Usage:
 *   just ebs-lifecycle vol-09129364aa3bd586e development
 *   npx tsx scripts/local/ebs-lifecycle-audit.ts --volume vol-xxx --env development --profile dev-account
 */

import {
  EC2Client,
  DescribeVolumesCommand,
  DescribeVolumeStatusCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2'
import type { Volume, VolumeStatusItem } from '@aws-sdk/client-ec2'
import {
  CloudTrailClient,
  LookupEventsCommand,
} from '@aws-sdk/client-cloudtrail'
import type { Event as CloudTrailEvent } from '@aws-sdk/client-cloudtrail'
import {
  AutoScalingClient,
  DescribeScalingActivitiesCommand,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling'
import type { Activity, AutoScalingGroup } from '@aws-sdk/client-auto-scaling'
import {
  CloudFormationClient,
  DescribeStackResourceCommand,
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
    { name: 'volume', description: 'EBS volume ID (required)', hasValue: true },
    { name: 'stack', description: 'CloudFormation stack name (optional, for ASG lookup)', hasValue: true },
    { name: 'asg-logical-id', description: 'ASG logical resource ID (optional)', hasValue: true },
    { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'hours', description: 'Hours to look back for CloudTrail events', hasValue: true, default: '24' },
  ],
  'Diagnose EBS volume lifecycle during ASG rolling updates — detach/attach timing analysis',
)

// ========================================
// Constants
// ========================================

/** CloudTrail event names related to EBS volume lifecycle */
const VOLUME_EVENT_NAMES = [
  'AttachVolume',
  'DetachVolume',
  'CreateVolume',
  'DeleteVolume',
  'ModifyVolume',
] as const

/** Healthy timing thresholds in seconds */
const THRESHOLDS = {
  /** Max acceptable time for a detach operation */
  detachWarn: 120,
  detachCritical: 600,
  /** Max acceptable time for volume to go from detaching → available */
  availableWarn: 120,
  availableCritical: 600,
  /** Max acceptable time for an attach operation */
  attachWarn: 60,
  attachCritical: 300,
} as const

// ========================================
// Types
// ========================================

/** Parsed CloudTrail volume event */
interface VolumeEvent {
  /** Event timestamp */
  timestamp: Date
  /** Event name (AttachVolume, DetachVolume, etc.) */
  eventName: string
  /** Instance involved */
  instanceId: string
  /** Whether the API call succeeded */
  success: boolean
  /** Error message if failed */
  errorMessage?: string
  /** IAM principal who initiated */
  principal: string
  /** Source IP */
  sourceIp: string
}

/** Timeline gap between two events */
interface TimelineGap {
  /** Description of the gap */
  label: string
  /** Start event */
  from: VolumeEvent
  /** End event */
  to: VolumeEvent
  /** Duration in seconds */
  durationSeconds: number
  /** Health assessment */
  severity: 'ok' | 'warn' | 'critical'
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
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
}

/**
 * Colour a severity label.
 *
 * @param severity - ok, warn, or critical
 * @param text - Text to colour
 * @returns ANSI-coloured string
 */
function colourSeverity(severity: 'ok' | 'warn' | 'critical', text: string): string {
  switch (severity) {
    case 'ok': return log.green(text)
    case 'warn': return log.yellow(text)
    case 'critical': return log.red(text)
  }
}

/**
 * Assess severity based on a duration and threshold pair.
 *
 * @param durationSeconds - Actual duration
 * @param warnThreshold - Seconds above which is a warning
 * @param critThreshold - Seconds above which is critical
 * @returns Severity level
 */
function assessSeverity(
  durationSeconds: number,
  warnThreshold: number,
  critThreshold: number,
): 'ok' | 'warn' | 'critical' {
  if (durationSeconds >= critThreshold) return 'critical'
  if (durationSeconds >= warnThreshold) return 'warn'
  return 'ok'
}

// ========================================
// Data Fetching
// ========================================

/**
 * Fetch CloudTrail events for a specific EBS volume.
 *
 * @param client - CloudTrail SDK client
 * @param volumeId - EBS volume ID
 * @param hoursBack - Number of hours to look back
 * @returns Parsed volume events sorted oldest-first
 */
async function fetchVolumeEvents(
  client: CloudTrailClient,
  volumeId: string,
  hoursBack: number,
): Promise<VolumeEvent[]> {
  const startTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000)
  const endTime = new Date()

  const response = await client.send(
    new LookupEventsCommand({
      LookupAttributes: [
        { AttributeKey: 'ResourceName', AttributeValue: volumeId },
      ],
      StartTime: startTime,
      EndTime: endTime,
      MaxResults: 50,
    }),
  )

  const events: VolumeEvent[] = []

  for (const event of response.Events ?? []) {
    const eventName = event.EventName ?? ''
    if (!VOLUME_EVENT_NAMES.some((name) => eventName.includes(name))) continue

    let instanceId = 'unknown'
    let errorMessage: string | undefined
    let success = true

    // Parse CloudEvent JSON for instance ID and error info
    if (event.CloudTrailEvent) {
      try {
        const detail = JSON.parse(event.CloudTrailEvent)
        instanceId = detail.requestParameters?.instanceId
          ?? detail.responseElements?.instanceId
          ?? extractInstanceFromResources(event)
        if (detail.errorCode) {
          success = false
          errorMessage = `${detail.errorCode}: ${detail.errorMessage ?? ''}`
        }
      } catch {
        instanceId = extractInstanceFromResources(event)
      }
    }

    events.push({
      timestamp: event.EventTime ?? new Date(),
      eventName,
      instanceId,
      success,
      errorMessage,
      principal: event.Username ?? 'unknown',
      sourceIp: extractSourceIp(event),
    })
  }

  // Sort oldest first for timeline analysis
  return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

/**
 * Extract instance ID from CloudTrail event resources.
 *
 * @param event - CloudTrail event
 * @returns Instance ID or 'unknown'
 */
function extractInstanceFromResources(event: CloudTrailEvent): string {
  for (const resource of event.Resources ?? []) {
    if (resource.ResourceType === 'AWS::EC2::Instance') {
      return resource.ResourceName ?? 'unknown'
    }
  }
  return 'unknown'
}

/**
 * Extract source IP from a CloudTrail event.
 *
 * @param event - CloudTrail event
 * @returns Source IP address
 */
function extractSourceIp(event: CloudTrailEvent): string {
  if (event.CloudTrailEvent) {
    try {
      const detail = JSON.parse(event.CloudTrailEvent)
      return detail.sourceIPAddress ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return 'unknown'
}

/**
 * Fetch current EBS volume details.
 *
 * @param client - EC2 SDK client
 * @param volumeId - EBS volume ID
 * @returns Volume details
 */
async function fetchVolumeDetails(
  client: EC2Client,
  volumeId: string,
): Promise<{ volume: Volume; status: VolumeStatusItem | undefined }> {
  const [volumeResponse, statusResponse] = await Promise.all([
    client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] })),
    client.send(new DescribeVolumeStatusCommand({ VolumeIds: [volumeId] })),
  ])

  const volume = volumeResponse.Volumes?.[0]
  if (!volume) {
    log.fatal(`Volume ${volumeId} not found`)
  }

  return {
    volume,
    status: statusResponse.VolumeStatuses?.[0],
  }
}

/**
 * Resolve the ASG physical name from a CloudFormation stack.
 *
 * @param client - CloudFormation SDK client
 * @param stackName - Stack name
 * @param logicalId - Logical resource ID of the ASG
 * @returns Physical ASG name
 */
async function resolveAsgName(
  client: CloudFormationClient,
  stackName: string,
  logicalId: string,
): Promise<string | undefined> {
  try {
    const response = await client.send(
      new DescribeStackResourceCommand({
        StackName: stackName,
        LogicalResourceId: logicalId,
      }),
    )
    return response.StackResourceDetail?.PhysicalResourceId
  } catch {
    return undefined
  }
}

/**
 * Fetch recent ASG scaling activities.
 *
 * @param client - Auto Scaling SDK client
 * @param asgName - Auto Scaling group name
 * @param maxItems - Maximum activities to return
 * @returns Recent scaling activities
 */
async function fetchAsgActivities(
  client: AutoScalingClient,
  asgName: string,
  maxItems: number,
): Promise<{ activities: Activity[]; asg: AutoScalingGroup | undefined }> {
  const [activitiesResponse, asgResponse] = await Promise.all([
    client.send(
      new DescribeScalingActivitiesCommand({
        AutoScalingGroupName: asgName,
        MaxRecords: maxItems,
      }),
    ),
    client.send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [asgName],
      }),
    ),
  ])

  return {
    activities: activitiesResponse.Activities ?? [],
    asg: asgResponse.AutoScalingGroups?.[0],
  }
}

/**
 * Look up the instance name tag.
 *
 * @param client - EC2 SDK client
 * @param instanceId - Instance ID
 * @returns Instance name or 'unknown'
 */
async function getInstanceName(client: EC2Client, instanceId: string): Promise<string> {
  if (!instanceId || instanceId === 'unknown') return 'unknown'
  try {
    const response = await client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    )
    const tags = response.Reservations?.[0]?.Instances?.[0]?.Tags ?? []
    const nameTag = tags.find((t) => t.Key === 'Name')
    return nameTag?.Value ?? instanceId
  } catch {
    return instanceId
  }
}

// ========================================
// Analysis
// ========================================

/**
 * Compute timeline gaps between sequential volume events.
 *
 * @param events - Volume events sorted oldest-first
 * @returns Array of timeline gaps
 */
function computeTimelineGaps(events: VolumeEvent[]): TimelineGap[] {
  const gaps: TimelineGap[] = []

  for (let i = 0; i < events.length - 1; i++) {
    const from = events[i]
    const to = events[i + 1]
    const durationSeconds = Math.round(
      (to.timestamp.getTime() - from.timestamp.getTime()) / 1000,
    )

    let severity: 'ok' | 'warn' | 'critical' = 'ok'
    let label = `${from.eventName} → ${to.eventName}`

    // Assess based on transition type
    if (from.eventName === 'DetachVolume' && to.eventName === 'AttachVolume') {
      label = 'Detach → Attach (volume idle time)'
      severity = assessSeverity(durationSeconds, THRESHOLDS.availableWarn, THRESHOLDS.availableCritical)
    } else if (from.eventName === 'DetachVolume' && to.eventName === 'DetachVolume') {
      label = 'Detach retry'
      severity = assessSeverity(durationSeconds, THRESHOLDS.detachWarn, THRESHOLDS.detachCritical)
    } else if (from.eventName === 'AttachVolume' && to.eventName === 'DetachVolume') {
      label = 'Attached duration (time volume was in use)'
      severity = 'ok'
    }

    gaps.push({ label, from, to, durationSeconds, severity })
  }

  return gaps
}

// ========================================
// Display Functions
// ========================================

/**
 * Print volume overview section.
 *
 * @param volume - EBS volume details
 * @param status - Volume status check
 */
function printVolumeOverview(volume: Volume, status: VolumeStatusItem | undefined): void {
  console.log('')
  console.log(log.cyan('  ╔══ Volume Overview ═════════════════════════════════════'))
  console.log(`  ║  Volume ID: ${volume.VolumeId}`)
  console.log(`  ║  State: ${volume.State === 'in-use' ? log.green(volume.State) : log.yellow(volume.State ?? 'unknown')}`)
  console.log(`  ║  Size: ${volume.Size} GiB`)
  console.log(`  ║  Type: ${volume.VolumeType}`)
  console.log(`  ║  AZ: ${volume.AvailabilityZone}`)
  console.log(`  ║  Encrypted: ${volume.Encrypted ? log.green('Yes') : log.yellow('No')}`)

  if (volume.Attachments && volume.Attachments.length > 0) {
    const att = volume.Attachments[0]
    console.log(`  ║  Attached to: ${att.InstanceId} (${att.Device})`)
    console.log(`  ║  Attach time: ${att.AttachTime?.toISOString() ?? 'N/A'}`)
    console.log(`  ║  Attach state: ${att.State}`)
  } else {
    console.log(`  ║  Attached to: ${log.yellow('Not attached')}`)
  }

  if (status) {
    const volStatus = status.VolumeStatus?.Status ?? 'unknown'
    const colour = volStatus === 'ok' ? log.green(volStatus) : log.red(volStatus)
    console.log(`  ║  Volume Status Check: ${colour}`)
  }

  // Tags
  const tags = volume.Tags ?? []
  if (tags.length > 0) {
    console.log(`  ║  Tags:`)
    for (const tag of tags) {
      console.log(`  ║    ${tag.Key}: ${tag.Value}`)
    }
  }

  console.log(log.cyan('  ╚════════════════════════════════════════════════════════'))
  console.log('')
}

/**
 * Print CloudTrail event timeline.
 *
 * @param events - Volume events
 * @param ec2Client - EC2 client for instance name lookup
 */
async function printEventTimeline(events: VolumeEvent[], ec2Client: EC2Client): Promise<void> {
  if (events.length === 0) {
    log.warn('No CloudTrail events found for this volume in the given time range')
    console.log('')
    return
  }

  console.log(`  📋  CloudTrail Volume Events (${events.length} event(s)):\n`)

  const header = `  ${'Time'.padEnd(24)}  ${'Event'.padEnd(16)}  ${'Instance'.padEnd(22)}  ${'Status'.padEnd(8)}  Principal`
  console.log(header)
  console.log(`  ${'─'.repeat(24)}  ${'─'.repeat(16)}  ${'─'.repeat(22)}  ${'─'.repeat(8)}  ${'─'.repeat(30)}`)

  // Collect unique instance IDs for name lookup
  const instanceIds = [...new Set(events.map((e) => e.instanceId).filter((id) => id !== 'unknown'))]
  const nameMap = new Map<string, string>()
  for (const id of instanceIds) {
    nameMap.set(id, await getInstanceName(ec2Client, id))
  }

  for (const event of events) {
    const time = event.timestamp.toISOString().replace('T', ' ').replace('Z', '').padEnd(24)
    const name = event.eventName.padEnd(16)
    const instance = (event.instanceId === 'unknown' ? '—' : event.instanceId).padEnd(22)
    const status = event.success ? log.green('OK'.padEnd(8)) : log.red('FAIL'.padEnd(8))
    const principal = event.principal

    console.log(`  ${time}  ${name}  ${instance}  ${status}  ${principal}`)

    if (!event.success && event.errorMessage) {
      console.log(`${''.padStart(28)}${log.red(`↳ ${event.errorMessage}`)}`)
    }
  }
  console.log('')
}

/**
 * Print timeline gap analysis.
 *
 * @param gaps - Computed timeline gaps
 */
function printTimelineAnalysis(gaps: TimelineGap[]): void {
  if (gaps.length === 0) {
    log.info('Insufficient events for timeline gap analysis')
    console.log('')
    return
  }

  console.log(`  ⏱️   Timeline Gap Analysis:\n`)

  const header = `  ${'Duration'.padStart(12)}  ${'Severity'.padEnd(10)}  Transition`
  console.log(header)
  console.log(`  ${'─'.repeat(12)}  ${'─'.repeat(10)}  ${'─'.repeat(50)}`)

  for (const gap of gaps) {
    const dur = formatDuration(gap.durationSeconds).padStart(12)
    const sev = colourSeverity(gap.severity, gap.severity.toUpperCase().padEnd(10))
    console.log(`  ${dur}  ${sev}  ${gap.label}`)
    console.log(`${''.padStart(28)}${gap.from.timestamp.toISOString()} → ${gap.to.timestamp.toISOString()}`)
  }
  console.log('')

  // Identify the bottleneck
  const worst = gaps.reduce((prev, curr) =>
    curr.durationSeconds > prev.durationSeconds ? curr : prev,
  )

  if (worst.severity !== 'ok') {
    console.log(colourSeverity(worst.severity,
      `  🔍  Bottleneck: "${worst.label}" took ${formatDuration(worst.durationSeconds)}`))
    console.log('')
  }
}

/**
 * Print ASG scaling activities.
 *
 * @param activities - Recent scaling activities
 * @param asg - ASG details
 */
function printAsgActivities(activities: Activity[], asg: AutoScalingGroup | undefined): void {
  if (asg) {
    console.log(log.cyan('  ╔══ Auto Scaling Group ═══════════════════════════════'))
    console.log(`  ║  Name: ${asg.AutoScalingGroupName}`)
    console.log(`  ║  Desired: ${asg.DesiredCapacity}  Min: ${asg.MinSize}  Max: ${asg.MaxSize}`)
    console.log(`  ║  Health Check Type: ${asg.HealthCheckType}`)
    console.log(`  ║  Health Check Grace: ${asg.HealthCheckGracePeriod}s`)
    console.log(`  ║  Instances: ${asg.Instances?.length ?? 0}`)

    for (const inst of asg.Instances ?? []) {
      const health = inst.HealthStatus === 'Healthy' ? log.green('Healthy') : log.red(inst.HealthStatus ?? 'Unknown')
      console.log(`  ║    ${inst.InstanceId}  ${health}  (${inst.LifecycleState})`)
    }
    console.log(log.cyan('  ╚════════════════════════════════════════════════════════'))
    console.log('')
  }

  if (activities.length === 0) {
    log.info('No recent ASG scaling activities')
    return
  }

  console.log(`  📋  Recent ASG Activities (${activities.length}):\n`)

  for (const activity of activities.slice(0, 10)) {
    const start = activity.StartTime?.toISOString() ?? 'N/A'
    const end = activity.EndTime?.toISOString() ?? 'ongoing'
    const status = activity.StatusCode ?? 'Unknown'
    const statusColour = status === 'Successful' ? log.green(status)
      : status === 'Failed' ? log.red(status)
        : log.yellow(status)

    let duration = 'ongoing'
    if (activity.StartTime && activity.EndTime) {
      const secs = Math.round(
        (activity.EndTime.getTime() - activity.StartTime.getTime()) / 1000,
      )
      duration = formatDuration(secs)
    }

    console.log(`  ${statusColour}  ${start} → ${end}  (${duration})`)

    // Truncate cause to keep output clean
    const cause = activity.Cause ?? ''
    if (cause.length > 120) {
      console.log(`    Cause: ${cause.substring(0, 120)}...`)
    } else if (cause) {
      console.log(`    Cause: ${cause}`)
    }

    if (activity.Description) {
      console.log(`    Description: ${activity.Description}`)
    }
    console.log('')
  }
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const volumeId = args['volume'] as string
  if (!volumeId) {
    log.fatal('--volume is required. Usage: npx tsx scripts/local/ebs-lifecycle-audit.ts --volume vol-xxx --env development')
  }

  const logFile = startFileLogging('ebs-lifecycle')
  const config: AwsConfig = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)
  const hoursBack = parseInt(args['hours'] as string, 10)
  const stackName = args['stack'] as string | undefined
  const asgLogicalId = args['asg-logical-id'] as string | undefined

  log.header('  EBS Volume Lifecycle Auditor')
  log.info(`Volume: ${volumeId}`)
  log.info(`Auth: ${auth.mode}`)
  log.info(`Region: ${config.region}`)
  log.info(`Lookback: ${hoursBack}h`)
  console.log('')

  const ec2Client = new EC2Client({ region: config.region, credentials: config.credentials })
  const ctClient = new CloudTrailClient({ region: config.region, credentials: config.credentials })
  const cfnClient = new CloudFormationClient({ region: config.region, credentials: config.credentials })
  const asgClient = new AutoScalingClient({ region: config.region, credentials: config.credentials })

  // ─── Step 1: Volume details ─────────────────────────────────────────
  log.step(1, 4, 'Fetching volume details...')
  const { volume, status } = await fetchVolumeDetails(ec2Client, volumeId)
  printVolumeOverview(volume, status)

  // ─── Step 2: CloudTrail events ──────────────────────────────────────
  log.step(2, 4, `Querying CloudTrail (last ${hoursBack}h)...`)
  const events = await fetchVolumeEvents(ctClient, volumeId, hoursBack)
  log.success(`Found ${events.length} volume event(s)`)
  console.log('')
  await printEventTimeline(events, ec2Client)

  // ─── Step 3: Timeline analysis ──────────────────────────────────────
  log.step(3, 4, 'Analysing timeline gaps...')
  const gaps = computeTimelineGaps(events)
  printTimelineAnalysis(gaps)

  // ─── Step 4: ASG context (optional) ─────────────────────────────────
  log.step(4, 4, 'Checking ASG context...')

  let asgName: string | undefined

  if (stackName && asgLogicalId) {
    asgName = await resolveAsgName(cfnClient, stackName, asgLogicalId)
    if (asgName) {
      log.success(`Resolved ASG: ${asgName}`)
    }
  }

  if (asgName) {
    const { activities, asg } = await fetchAsgActivities(asgClient, asgName, 10)
    printAsgActivities(activities, asg)
  } else {
    log.info('No --stack / --asg-logical-id provided, skipping ASG analysis')
    log.info('Tip: pass --stack ControlPlane-development --asg-logical-id ComputeAutoScalingGroupASG7021CF69')
  }

  // ─── Summary ────────────────────────────────────────────────────────
  const failedEvents = events.filter((e) => !e.success).length
  const worstGap = gaps.length > 0
    ? gaps.reduce((p, c) => c.durationSeconds > p.durationSeconds ? c : p)
    : undefined

  log.summary('EBS Lifecycle Audit Complete', {
    'Volume': volumeId,
    'State': volume.State ?? 'unknown',
    'Total Events': String(events.length),
    'Failed Events': String(failedEvents),
    'Timeline Gaps': String(gaps.length),
    'Worst Gap': worstGap
      ? `${worstGap.label} (${formatDuration(worstGap.durationSeconds)}) [${worstGap.severity.toUpperCase()}]`
      : 'N/A',
    'Attached To': volume.Attachments?.[0]?.InstanceId ?? 'Not attached',
  })

  stopFileLogging()
  log.info(`\nLog saved to: ${logFile}`)
}

main().catch((error: Error) => {
  log.fatal(`EBS lifecycle audit failed: ${error.message}`)
})
