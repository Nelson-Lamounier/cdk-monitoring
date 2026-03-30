/**
 * @format
 * Generic EMF (Embedded Metric Format) Emitter
 *
 * Provides a reusable CloudWatch EMF metric emitter that any Bedrock
 * agent can use. CloudWatch automatically extracts metrics from
 * structured JSON log lines without any SDK calls or API overhead.
 *
 * This is a generalisation of the chatbot's inline `emitEmfMetric()`
 * function, parameterised by namespace so each agent can emit to
 * its own CloudWatch namespace.
 *
 * Existing per-agent namespaces:
 * - `BedrockMultiAgent` — article pipeline (via agent-runner.ts)
 * - `BedrockPublisher`  — article pipeline (via metrics.ts)
 * - `BedrockChatbot`    — chatbot handler
 *
 * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 *
 * @example
 * ```typescript
 * import { emitEmfMetric } from '../../../shared/src/index.js';
 *
 * emitEmfMetric(
 *     'BedrockChatbot',
 *     { Environment: 'production' },
 *     [
 *         { name: 'InvocationCount', value: 1, unit: 'Count' },
 *         { name: 'InvocationLatency', value: 342, unit: 'Milliseconds' },
 *     ],
 *     { sessionId: '550e8400-...' },
 * );
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * A single metric definition for EMF emission.
 */
export interface EmfMetricEntry {
    /** CloudWatch metric name */
    readonly name: string;
    /** Metric value */
    readonly value: number;
    /** CloudWatch unit (e.g. 'Count', 'Milliseconds', 'None') */
    readonly unit: string;
}

// =============================================================================
// EMF EMITTER
// =============================================================================

/**
 * Emit an Embedded Metric Format (EMF) log line to CloudWatch.
 *
 * CloudWatch extracts metrics from structured JSON log lines that
 * conform to the EMF specification. This function builds the EMF
 * envelope with proper `_aws` metadata, dimensions, and metric
 * definitions, then writes it as a single `console.log()` call.
 *
 * @param namespace - CloudWatch metric namespace (e.g. 'BedrockChatbot')
 * @param dimensions - Dimension key-value pairs (become CloudWatch dimensions)
 * @param metrics - Array of metric entries with name, value, and unit
 * @param properties - Optional non-metric properties for log enrichment
 */
export function emitEmfMetric(
    namespace: string,
    dimensions: Record<string, string>,
    metrics: EmfMetricEntry[],
    properties?: Record<string, unknown>,
): void {
    const metricDefinitions = metrics.map(({ name, unit }) => ({
        Name: name,
        Unit: unit,
    }));

    const metricValues: Record<string, number> = {};
    for (const { name, value } of metrics) {
        metricValues[name] = value;
    }

    const emfLog = {
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
                {
                    Namespace: namespace,
                    Dimensions: [Object.keys(dimensions)],
                    Metrics: metricDefinitions,
                },
            ],
        },
        ...dimensions,
        ...metricValues,
        ...properties,
    };

    console.log(JSON.stringify(emfLog));
}
