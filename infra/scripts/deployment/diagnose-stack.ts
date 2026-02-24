#!/usr/bin/env npx tsx
/**
 * Diagnose CloudFormation Stack Failure
 *
 * Queries CloudFormation for failed events and current stack status after a
 * deployment failure. Writes diagnostics to console (via logger), GitHub
 * Actions error annotations, and $GITHUB_STEP_SUMMARY.
 *
 * This script is diagnostic-only — it always exits 0 so it never masks the
 * real deployment failure. The composite action runs it with continue-on-error.
 *
 * Usage:
 *   npx tsx scripts/deployment/diagnose-stack.ts <stack-name> [--region <region>]
 *
 * Examples:
 *   npx tsx scripts/deployment/diagnose-stack.ts Monitoring-Compute-development
 *   npx tsx scripts/deployment/diagnose-stack.ts K8s-Edge-development --region eu-west-1
 *
 * Environment variables:
 *   AWS_REGION — fallback region if --region is not provided (default: eu-west-1)
 */

import { appendFileSync } from 'fs';

import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const stackName = args[0];
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');

if (!stackName) {
  console.error('Usage: diagnose-stack.ts <stack-name> [--region <region>]');
  process.exit(0); // Diagnostic script — never fail
}

// ---------------------------------------------------------------------------
// AWS Client
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FailedEvent {
  logicalId: string;
  resourceType: string;
  status: string;
  reason: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Failure status filter
// ---------------------------------------------------------------------------
const FAILURE_STATUSES = new Set([
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
]);

// ---------------------------------------------------------------------------
// Fetch failed stack events
// ---------------------------------------------------------------------------
async function getFailedEvents(): Promise<FailedEvent[]> {
  try {
    const response = await cfn.send(
      new DescribeStackEventsCommand({ StackName: stackName })
    );

    return (response.StackEvents ?? [])
      .filter((e) => FAILURE_STATUSES.has(e.ResourceStatus ?? ''))
      .map((e) => ({
        logicalId: e.LogicalResourceId ?? 'Unknown',
        resourceType: e.ResourceType ?? 'Unknown',
        status: e.ResourceStatus ?? 'Unknown',
        reason: e.ResourceStatusReason ?? 'No reason provided',
        timestamp: e.Timestamp?.toISOString() ?? 'Unknown',
      }));
  } catch (err) {
    logger.warn(`Could not fetch stack events: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch current stack status
// ---------------------------------------------------------------------------
async function getStackStatus(): Promise<{ status: string; reason: string }> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    const stack = response.Stacks?.[0];
    return {
      status: stack?.StackStatus ?? 'NOT_FOUND',
      reason: stack?.StackStatusReason ?? '',
    };
  } catch {
    return { status: 'NOT_FOUND', reason: 'Stack not found or deleted' };
  }
}

// ---------------------------------------------------------------------------
// Write GitHub Actions error annotations
// ---------------------------------------------------------------------------
function emitAnnotations(events: FailedEvent[]): void {
  if (!process.env.GITHUB_ACTIONS) return;

  for (const event of events) {
    console.log(
      `::error title=CFN ${event.status}::${event.resourceType} ${event.logicalId}: ${event.reason}`
    );
  }
}

// ---------------------------------------------------------------------------
// Write $GITHUB_STEP_SUMMARY
// ---------------------------------------------------------------------------
function writeSummary(
  events: FailedEvent[],
  stackStatus: { status: string; reason: string }
): void {
  const lines: string[] = [];

  lines.push('### ❌ CloudFormation Failed Resources');
  lines.push('');

  if (events.length > 0) {
    lines.push('| Resource | Type | Status | Reason |');
    lines.push('|----------|------|--------|--------|');
    for (const e of events) {
      lines.push(`| \`${e.logicalId}\` | ${e.resourceType} | ${e.status} | ${e.reason} |`);
    }
  } else {
    lines.push('No failed CloudFormation events found (stack may have rolled back).');
  }

  lines.push('');
  lines.push(`**Current stack status**: \`${stackStatus.status}\``);
  if (stackStatus.reason) {
    lines.push(`**Reason**: ${stackStatus.reason}`);
  }
  lines.push('');

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`Diagnose CloudFormation Failure — ${stackName}`);
  logger.keyValue('Stack', stackName);
  logger.keyValue('Region', region);
  logger.blank();

  // 1. Fetch failed events
  logger.task('Querying CloudFormation events...');
  const failedEvents = await getFailedEvents();

  if (failedEvents.length > 0) {
    logger.error(`Found ${failedEvents.length} failed resource(s)`);
    logger.blank();

    logger.table(
      ['Resource', 'Type', 'Status', 'Reason'],
      failedEvents.map((e) => [e.logicalId, e.resourceType, e.status, e.reason])
    );

    // Emit GitHub Actions annotations
    emitAnnotations(failedEvents);
  } else {
    logger.info('No failed CloudFormation events found (stack may have rolled back)');
  }

  // 2. Current stack status
  logger.blank();
  logger.task('Checking current stack status...');
  const stackStatus = await getStackStatus();
  logger.keyValue('Status', stackStatus.status);
  if (stackStatus.reason) {
    logger.keyValue('Reason', stackStatus.reason);
  }

  // 3. Write summary
  writeSummary(failedEvents, stackStatus);

  logger.blank();
  logger.info('Diagnostics complete');
}

main().catch((err) => {
  // Diagnostic script — log but never fail the pipeline
  logger.warn(`Diagnostics error: ${(err as Error).message}`);
  process.exit(0);
});
