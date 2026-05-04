/**
 * @format
 * admin-api — Structured logger.
 *
 * pino emits JSON lines to stdout, picked up by Alloy → Loki.
 * Each log line carries the active OTel span's trace_id and span_id when
 * present, so Grafana's "Logs to Trace" pivot works without manual ID
 * propagation in user code.
 *
 * Levels: trace | debug | info | warn | error | fatal
 *   default 'info' in prod, 'debug' in dev.
 */

import { context, trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

const level = process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug');

export const logger: Logger = pino({
  level,
  base: {
    service: process.env['OTEL_SERVICE_NAME'] ?? 'admin-api',
    env:     process.env['DEPLOY_ENV']         ?? 'dev',
  },
  // Inject active span context into every log record.
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const { traceId, spanId, traceFlags } = span.spanContext();
    return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Loki parses ts as nanoseconds; pino default ms is fine — Alloy converts.
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.pgPassword',
      '*.githubPrivateKey',
      '*.githubWebhookSecret',
    ],
    censor: '[REDACTED]',
  },
});
