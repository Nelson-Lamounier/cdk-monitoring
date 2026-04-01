#!/usr/bin/env tsx
/**
 * CloudWatch Log Stream Explorer
 *
 * Interactive troubleshooting tool that:
 *  1. Lists all CloudWatch log groups in the region
 *  2. Prompts the user to select a log group (or pass via --log-group)
 *  3. Fetches the last N log streams (newest first)
 *  4. Displays log events from each stream
 *  5. Saves the full output to a local diagnostics log file
 *
 * Usage:
 *   Interactive: npx tsx scripts/local/cloudwatch-logs.ts --profile dev-account
 *   Direct:      npx tsx scripts/local/cloudwatch-logs.ts --profile dev-account --log-group /ssm/k8s/development/bootstrap
 *   Customised:  npx tsx scripts/local/cloudwatch-logs.ts --profile dev-account --streams 10 --events 100
 */

import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeLogStreamsCommand,
    GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type {
    LogGroup,
    LogStream,
    OutputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { createInterface } from 'readline/promises';
import * as log from '../lib/logger.js';
import { startFileLogging, stopFileLogging } from '../lib/logger.js';
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js';

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
    [
        { name: 'profile', description: 'AWS CLI profile', hasValue: true },
        { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
        { name: 'log-group', description: 'Skip selection and query this log group directly', hasValue: true },
        { name: 'streams', description: 'Number of recent log streams to fetch', hasValue: true, default: '5' },
        { name: 'events', description: 'Max log events per stream', hasValue: true, default: '50' },
    ],
    'CloudWatch Log Stream Explorer — interactively browse log groups, streams, and events',
);

// ========================================
// Constants
// ========================================

/** Maximum log groups to list per API page */
const LOG_GROUP_PAGE_SIZE = 50;

/** Maximum log streams to fetch per API page */
const LOG_STREAM_PAGE_SIZE = 50;

// ========================================
// Types
// ========================================

/** Parsed and validated script configuration */
interface ScriptConfig {
    /** Number of recent log streams to fetch */
    maxStreams: number;
    /** Max log events to display per stream */
    maxEvents: number;
    /** Pre-selected log group name (skips interactive prompt) */
    preselectedLogGroup: string | undefined;
}

/** Summary of a log stream with its events */
interface StreamSummary {
    /** The log stream name */
    name: string;
    /** Last event timestamp in ms, or undefined */
    lastEventTimestamp: number | undefined;
    /** First event timestamp in ms, or undefined */
    firstEventTimestamp: number | undefined;
    /** Number of events fetched */
    eventCount: number;
    /** The log events */
    events: OutputLogEvent[];
}

// ========================================
// Helpers
// ========================================

/**
 * Format a Unix timestamp (ms) into a human-readable ISO string with a relative suffix.
 *
 * @param timestampMs - Unix timestamp in milliseconds
 * @returns Formatted string (e.g. '2026-04-01T11:18:30Z (2h ago)')
 */
function formatTimestamp(timestampMs: number | undefined): string {
    if (!timestampMs) return 'N/A';

    const date = new Date(timestampMs);
    const ageMs = Date.now() - timestampMs;
    const ageMinutes = Math.floor(ageMs / 60_000);
    const ageHours = Math.floor(ageMs / 3_600_000);
    const ageDays = Math.floor(ageMs / 86_400_000);

    let relative: string;
    if (ageMinutes < 1) {
        relative = 'just now';
    } else if (ageMinutes < 60) {
        relative = `${ageMinutes}m ago`;
    } else if (ageHours < 24) {
        relative = `${ageHours}h ago`;
    } else {
        relative = `${ageDays}d ago`;
    }

    return `${date.toISOString()} (${relative})`;
}

/**
 * Prompt the user to enter a number within a valid range.
 *
 * @param prompt - Message to display
 * @param min - Minimum valid value (inclusive)
 * @param max - Maximum valid value (inclusive)
 * @returns The selected number
 */
async function promptNumber(prompt: string, min: number, max: number): Promise<number> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const answer = await rl.question(prompt);
            const num = Number.parseInt(answer.trim(), 10);

            if (!Number.isNaN(num) && num >= min && num <= max) {
                return num;
            }

            log.warn(`Please enter a number between ${min} and ${max}.`);
        }
    } finally {
        rl.close();
    }
}

// ========================================
// Core Logic
// ========================================

/**
 * Fetch all CloudWatch log groups in the region, handling pagination.
 *
 * @param client - CloudWatch Logs SDK client
 * @returns Array of LogGroup objects sorted by name
 */
async function listAllLogGroups(client: CloudWatchLogsClient): Promise<LogGroup[]> {
    const groups: LogGroup[] = [];
    let nextToken: string | undefined;

    do {
        const response = await client.send(
            new DescribeLogGroupsCommand({ nextToken, limit: LOG_GROUP_PAGE_SIZE }),
        );
        if (response.logGroups) {
            groups.push(...response.logGroups);
        }
        nextToken = response.nextToken;
    } while (nextToken);

    return groups;
}

/**
 * Fetch the most recent log streams for a given log group.
 *
 * @param client - CloudWatch Logs SDK client
 * @param logGroupName - Name of the log group
 * @param maxStreams - Maximum number of streams to return
 * @returns Array of LogStream objects (newest first)
 */
async function listRecentStreams(
    client: CloudWatchLogsClient,
    logGroupName: string,
    maxStreams: number,
): Promise<LogStream[]> {
    const streams: LogStream[] = [];
    let nextToken: string | undefined;

    do {
        const response = await client.send(
            new DescribeLogStreamsCommand({
                logGroupName,
                orderBy: 'LastEventTime',
                descending: true,
                limit: Math.min(maxStreams - streams.length, LOG_STREAM_PAGE_SIZE),
                nextToken,
            }),
        );
        if (response.logStreams) {
            streams.push(...response.logStreams);
        }
        nextToken = response.nextToken;
    } while (nextToken && streams.length < maxStreams);

    return streams.slice(0, maxStreams);
}

/**
 * Fetch log events from a specific log stream.
 *
 * @param client - CloudWatch Logs SDK client
 * @param logGroupName - Name of the log group
 * @param logStreamName - Name of the log stream
 * @param maxEvents - Maximum number of events to fetch
 * @returns Array of OutputLogEvent objects (newest first)
 */
async function fetchStreamEvents(
    client: CloudWatchLogsClient,
    logGroupName: string,
    logStreamName: string,
    maxEvents: number,
): Promise<OutputLogEvent[]> {
    const response = await client.send(
        new GetLogEventsCommand({
            logGroupName,
            logStreamName,
            limit: maxEvents,
            startFromHead: false,
        }),
    );

    return response.events ?? [];
}

// ========================================
// Display Functions
// ========================================

/**
 * Print the numbered list of available log groups for selection.
 *
 * @param groups - Array of log groups
 */
function printLogGroupList(groups: LogGroup[]): void {
    console.log('');
    console.log(log.cyan('  Available Log Groups:'));
    console.log(log.cyan('  ─────────────────────────────────────────────────'));

    const indexWidth = String(groups.length).length;

    for (let i = 0; i < groups.length; i++) {
        const index = String(i + 1).padStart(indexWidth);
        const name = groups[i].logGroupName ?? 'Unknown';
        console.log(`  ${log.yellow(index)}  ${name}`);
    }

    console.log('');
}

/**
 * Print a log stream summary header.
 *
 * @param stream - The log stream metadata
 * @param index - 1-based index
 * @param total - Total number of streams
 */
function printStreamHeader(stream: LogStream, index: number, total: number): void {
    console.log('');
    console.log(log.cyan(`  ╔══ Stream ${index}/${total} ═══════════════════════════════════════`));
    console.log(`  ║  Name: ${stream.logStreamName ?? 'Unknown'}`);
    console.log(`  ║  Last Event: ${formatTimestamp(stream.lastEventTimestamp)}`);
    console.log(`  ║  First Event: ${formatTimestamp(stream.firstEventTimestamp)}`);
    console.log(`  ║  Created: ${formatTimestamp(stream.creationTime)}`);
    console.log(log.cyan('  ╚════════════════════════════════════════════════════════'));
}

/**
 * Print log events for a single stream.
 *
 * @param events - Array of log events
 * @param streamName - Name of the stream (for labelling)
 */
function printStreamEvents(events: OutputLogEvent[], streamName: string): void {
    if (events.length === 0) {
        log.warn(`  No events found in stream: ${streamName}`);
        return;
    }

    console.log(`  ${log.green(`${events.length} event(s):`)}`);
    console.log('');

    for (const event of events) {
        const timestamp = event.timestamp
            ? new Date(event.timestamp).toISOString()
            : 'N/A';
        const message = (event.message ?? '').trimEnd();
        console.log(`  ${log.blue(timestamp)}  ${message}`);
    }
}

/**
 * Print the final summary of all streams inspected.
 *
 * @param logGroupName - The selected log group
 * @param summaries - Array of stream summaries
 * @param config - Script configuration
 */
function printFinalSummary(
    logGroupName: string,
    summaries: StreamSummary[],
    config: ScriptConfig,
): void {
    const totalEvents = summaries.reduce((sum, s) => sum + s.eventCount, 0);
    const emptyStreams = summaries.filter((s) => s.eventCount === 0).length;

    log.summary('CloudWatch Log Exploration Complete', {
        'Log Group': logGroupName,
        'Streams Inspected': String(summaries.length),
        'Total Events Retrieved': String(totalEvents),
        'Empty Streams': String(emptyStreams),
        'Max Events/Stream': String(config.maxEvents),
    });
}

// ========================================
// Main
// ========================================

/**
 * Entry point: lists log groups, prompts for selection, fetches recent
 * streams and their events, and saves everything to a diagnostics log.
 */
async function main(): Promise<void> {
    const logFile = startFileLogging('cloudwatch-logs');
    const awsConfig = buildAwsConfig(args);
    const auth = resolveAuth(awsConfig.profile);

    const config: ScriptConfig = {
        maxStreams: Number.parseInt(args['streams'] as string, 10),
        maxEvents: Number.parseInt(args['events'] as string, 10),
        preselectedLogGroup: args['log-group'] ? (args['log-group'] as string) : undefined,
    };

    log.header('  CloudWatch Log Stream Explorer');
    log.config('Configuration', {
        'Auth': auth.mode,
        'Region': awsConfig.region,
        'Log Group': config.preselectedLogGroup ?? '(interactive selection)',
        'Max Streams': String(config.maxStreams),
        'Max Events/Stream': String(config.maxEvents),
    });

    const client = new CloudWatchLogsClient({
        region: awsConfig.region,
        credentials: awsConfig.credentials,
    });

    // ─── Step 1: Select a log group ───────────────────────────────────────
    let selectedLogGroup: string;

    if (config.preselectedLogGroup) {
        selectedLogGroup = config.preselectedLogGroup;
        log.step(1, 4, `Using pre-selected log group: ${selectedLogGroup}`);
    } else {
        log.step(1, 4, 'Discovering log groups in the region...');

        const groups = await listAllLogGroups(client);

        if (groups.length === 0) {
            log.warn('No CloudWatch log groups found in this region.');
            stopFileLogging();
            return;
        }

        log.success(`Found ${groups.length} log group(s)`);
        printLogGroupList(groups);

        const selection = await promptNumber(
            log.cyan(`  Select a log group [1-${groups.length}]: `),
            1,
            groups.length,
        );

        selectedLogGroup = groups[selection - 1].logGroupName ?? '';
        if (!selectedLogGroup) {
            log.fatal('Selected log group has no name.');
        }
    }

    console.log('');
    log.success(`Selected: ${selectedLogGroup}`);
    console.log('');

    // ─── Step 2: Fetch recent log streams ─────────────────────────────────
    log.step(2, 4, `Fetching last ${config.maxStreams} log stream(s)...`);

    let streams: LogStream[];
    try {
        streams = await listRecentStreams(client, selectedLogGroup, config.maxStreams);
    } catch (err) {
        log.fatal(`Failed to fetch log streams: ${(err as Error).message}`);
    }

    if (streams.length === 0) {
        log.warn(`No log streams found in: ${selectedLogGroup}`);
        log.nextSteps([
            'Verify the log group name is correct',
            'Check if the application is actively writing to this log group',
            'Try a different log group',
        ]);
        stopFileLogging();
        return;
    }

    log.success(`Found ${streams.length} stream(s)`);

    // ─── Step 3: Fetch events from each stream ───────────────────────────
    log.step(3, 4, 'Fetching log events from each stream...');

    const summaries: StreamSummary[] = [];

    for (let i = 0; i < streams.length; i++) {
        const stream = streams[i];
        const streamName = stream.logStreamName ?? 'Unknown';

        printStreamHeader(stream, i + 1, streams.length);

        try {
            const events = await fetchStreamEvents(
                client,
                selectedLogGroup,
                streamName,
                config.maxEvents,
            );

            printStreamEvents(events, streamName);

            summaries.push({
                name: streamName,
                lastEventTimestamp: stream.lastEventTimestamp,
                firstEventTimestamp: stream.firstEventTimestamp,
                eventCount: events.length,
                events,
            });
        } catch (err) {
            const errorMessage = (err as Error).message;
            log.warn(`  Failed to fetch events for stream "${streamName}": ${errorMessage}`);

            summaries.push({
                name: streamName,
                lastEventTimestamp: stream.lastEventTimestamp,
                firstEventTimestamp: stream.firstEventTimestamp,
                eventCount: 0,
                events: [],
            });
        }

        console.log('');
    }

    // ─── Step 4: Summary ──────────────────────────────────────────────────
    log.step(4, 4, 'Generating summary...');
    printFinalSummary(selectedLogGroup, summaries, config);

    stopFileLogging();
    log.info(`\nLog saved to: ${logFile}`);
}

main().catch((error: Error) => {
    log.fatal(`CloudWatch log exploration failed: ${error.message}`);
});
