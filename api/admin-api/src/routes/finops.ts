/**
 * @format
 * admin-api — FinOps and observability metrics routes.
 *
 * Provides read-only access to CloudWatch custom metrics and AWS Cost Explorer
 * billing data for the admin dashboard. All routes are protected by the
 * Cognito JWT middleware mounted at the parent level.
 *
 * Routes:
 *   GET /realtime      — BedrockMultiAgent CloudWatch metrics (token usage, latency)
 *   GET /costs         — AWS Cost Explorer billed cost breakdown (daily, by profile)
 *   GET /chatbot       — BedrockChatbot CloudWatch metrics (invocations, safety)
 *   GET /self-healing  — self-healing-development/SelfHealing token metrics
 *
 * All routes accept a `?days=N` query param (default: 7, max: 365).
 *
 * AWS credentials: EC2 Instance Profile (IMDS) — no secrets in pod env.
 * Cost Explorer is always in us-east-1 (AWS global requirement).
 */

import { Hono } from 'hono';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricDataResult } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import type { ResultByTime } from '@aws-sdk/client-cost-explorer';
import type { AdminApiConfig } from '../lib/config.js';

// ── CloudWatch / Cost Explorer clients (lazy singletons) ─────────────────────

let _cwClient: CloudWatchClient | null = null;
let _ceClient: CostExplorerClient | null = null;

function getCwClient(region: string): CloudWatchClient {
  if (!_cwClient) {
    _cwClient = new CloudWatchClient({ region });
  }
  return _cwClient;
}

function getCeClient(): CostExplorerClient {
  if (!_ceClient) {
    // Cost Explorer is a global service — always us-east-1
    _ceClient = new CostExplorerClient({ region: 'us-east-1' });
  }
  return _ceClient;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse and clamp the `?days=` query parameter.
 *
 * @param raw - Raw query string value
 * @returns Clamped integer (1–365, default 7)
 */
function parseDays(raw: string | undefined): number {
  const n = parseInt(raw ?? '7', 10);
  if (isNaN(n)) return 7;
  return Math.max(1, Math.min(365, n));
}

/**
 * Derive a `[startTime, endTime]` date window from a day count.
 *
 * @param days - Number of days to look back from now
 * @returns Tuple of [startDate, endDate]
 */
function dateWindow(days: number): [Date, Date] {
  const endTime = new Date();
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - days);
  return [startTime, endTime];
}

/**
 * Collapse MetricDataResults into a simple key→number record.
 * Each metric query returns a time-series; we take the first value if present.
 *
 * @param results - AWS MetricDataResult array
 * @param defaults - Default value map
 * @returns Flat stats record
 */
function collapseMetrics(
  results: MetricDataResult[],
  defaults: Record<string, number>,
): Record<string, number> {
  const stats = { ...defaults };
  for (const res of results) {
    if (res.Id !== undefined && res.Values && res.Values.length > 0) {
      const value = res.Values[0];
      if (value !== undefined) {
        stats[res.Id] = value;
      }
    }
  }
  return stats;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the Hono router for FinOps metrics routes.
 *
 * @param config - Validated admin-api configuration
 * @returns Hono router instance
 */
export function createFinopsRouter(config: AdminApiConfig): Hono {
  const app = new Hono();

  // ── GET /realtime — BedrockMultiAgent metrics ─────────────────────────────
  /**
   * Returns token usage and latency metrics from the BedrockMultiAgent
   * CloudWatch namespace, aggregated over the requested day window.
   *
   * @query days - Lookback window in days (default 7, max 365)
   * @returns Flat stats record: inputTokens, outputTokens, thinkingTokens, etc.
   */
  app.get('/realtime', async (ctx) => {
    const days = parseDays(ctx.req.query('days'));
    const [startTime, endTime] = dateWindow(days);
    const periodInSeconds = days * 24 * 60 * 60;

    const command = new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'inputTokens',
          MetricStat: {
            Metric: { Namespace: 'BedrockMultiAgent', MetricName: 'InputTokens' },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'outputTokens',
          MetricStat: {
            Metric: { Namespace: 'BedrockMultiAgent', MetricName: 'OutputTokens' },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'thinkingTokens',
          MetricStat: {
            Metric: { Namespace: 'BedrockMultiAgent', MetricName: 'ThinkingTokens' },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'processingDuration',
          MetricStat: {
            Metric: { Namespace: 'BedrockMultiAgent', MetricName: 'ProcessingDurationMs' },
            Period: periodInSeconds,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'bedrockConverseDuration',
          MetricStat: {
            Metric: { Namespace: 'BedrockMultiAgent', MetricName: 'BedrockConverseMs' },
            Period: periodInSeconds,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'invocations',
          MetricStat: {
            Metric: { Namespace: 'BedrockMultiAgent', MetricName: 'InvocationCount' },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
      ],
    });

    const result = await getCwClient(config.awsRegion).send(command);

    const stats = collapseMetrics((result.MetricDataResults ?? []) as MetricDataResult[], {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      processingDuration: 0,
      bedrockConverseDuration: 0,
      invocations: 0,
    });

    return ctx.json(stats);
  });

  // ── GET /costs — Cost Explorer ────────────────────────────────────────────
  /**
   * Returns penny-accurate billed costs from AWS Cost Explorer,
   * filtered by the 'bedrock' Project tag and grouped by inference profile.
   *
   * @query days - Lookback window in days (default 7, max 365)
   * @returns Array of daily ResultsByTime from Cost Explorer (or empty on error)
   */
  app.get('/costs', async (ctx) => {
    const days = parseDays(ctx.req.query('days'));
    const [startDate, endDate] = dateWindow(days);

    const startStr = startDate.toISOString().split('T')[0]!;
    const endStr = endDate.toISOString().split('T')[0]!;

    try {
      const result = await getCeClient().send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: startStr, End: endStr },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
          Filter: {
            Tags: { Key: 'Project', Values: ['bedrock'] },
          },
          GroupBy: [{ Type: 'TAG', Key: 'aws:bedrock:inference-profile' }],
        }),
      );
      return ctx.json({ costs: (result.ResultsByTime ?? []) as ResultByTime[] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[finops] Cost Explorer query failed:', message);
      return ctx.json({ costs: [] });
    }
  });

  // ── GET /chatbot — BedrockChatbot metrics ─────────────────────────────────
  /**
   * Returns chatbot usage and safety metrics from the BedrockChatbot
   * CloudWatch namespace for the development environment.
   *
   * @query days - Lookback window in days (default 7, max 365)
   * @returns Flat stats record: invocationCount, blockedInputs, etc.
   */
  app.get('/chatbot', async (ctx) => {
    const days = parseDays(ctx.req.query('days'));
    const [startTime, endTime] = dateWindow(days);
    const periodInSeconds = days * 24 * 60 * 60;
    const dims = [{ Name: 'Environment', Value: 'development' }];

    const command = new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'invocationCount',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'InvocationCount', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'invocationLatency',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'InvocationLatency', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'invocationErrors',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'InvocationErrors', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'promptLength',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'PromptLength', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'responseLength',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'ResponseLength', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'blockedInputs',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'BlockedInputs', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'redactedOutputs',
          MetricStat: {
            Metric: { Namespace: 'BedrockChatbot', MetricName: 'RedactedOutputs', Dimensions: dims },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
      ],
    });

    const result = await getCwClient(config.awsRegion).send(command);

    const stats = collapseMetrics((result.MetricDataResults ?? []) as MetricDataResult[], {
      invocationCount: 0,
      invocationLatency: 0,
      invocationErrors: 0,
      promptLength: 0,
      responseLength: 0,
      blockedInputs: 0,
      redactedOutputs: 0,
    });

    return ctx.json(stats);
  });

  // ── GET /self-healing — SelfHealing token metrics ─────────────────────────
  /**
   * Returns token usage metrics from the self-healing pipeline CloudWatch
   * namespace (`self-healing-development/SelfHealing`).
   *
   * @query days - Lookback window in days (default 7, max 365)
   * @returns Flat stats record: inputTokens, outputTokens
   */
  app.get('/self-healing', async (ctx) => {
    const days = parseDays(ctx.req.query('days'));
    const [startTime, endTime] = dateWindow(days);
    const periodInSeconds = days * 24 * 60 * 60;

    const command = new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'inputTokens',
          MetricStat: {
            Metric: {
              Namespace: 'self-healing-development/SelfHealing',
              MetricName: 'InputTokens',
            },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
        {
          Id: 'outputTokens',
          MetricStat: {
            Metric: {
              Namespace: 'self-healing-development/SelfHealing',
              MetricName: 'OutputTokens',
            },
            Period: periodInSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
      ],
    });

    const result = await getCwClient(config.awsRegion).send(command);

    const stats = collapseMetrics((result.MetricDataResults ?? []) as MetricDataResult[], {
      inputTokens: 0,
      outputTokens: 0,
    });

    return ctx.json(stats);
  });

  return app;
}
