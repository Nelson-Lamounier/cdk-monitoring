/**
 * @format
 * admin-api — OpenTelemetry SDK bootstrap.
 *
 * MUST be loaded before any instrumented module (http, pg, aws-sdk, hono).
 * Loaded via `node --import ./dist/lib/observability/telemetry.js` in the
 * Dockerfile CMD, NOT via a regular `import` from index.ts (ESM hoisting
 * would evaluate http/pg imports before this file's side effects ran).
 *
 * Pipeline:
 *   admin-api → OTLP/HTTP → Alloy DaemonSet → Tempo (traces)
 *                                          ↘ Mimir (span metrics, optional)
 *
 * Auto-instrumented:
 *   - http        incoming + outgoing HTTP (covers Hono, fetch via undici)
 *   - pg          pg query spans w/ sanitised SQL
 *   - aws-sdk     S3, CloudWatch, Cognito, etc. — span per API call
 *   - dns         optional, low value, disabled
 *
 * Env vars (Helm-templated):
 *   OTEL_SERVICE_NAME            (default 'admin-api')
 *   OTEL_SERVICE_VERSION         (chart appVersion)
 *   OTEL_EXPORTER_OTLP_ENDPOINT  (e.g. http://alloy.observability:4318)
 *   OTEL_RESOURCE_ATTRIBUTES     (deployment.environment=dev,k8s.cluster.name=…)
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

if (process.env['OTEL_DIAG'] === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]:    process.env['OTEL_SERVICE_NAME']    ?? 'admin-api',
    [ATTR_SERVICE_VERSION]: process.env['OTEL_SERVICE_VERSION'] ?? '0.1.0',
  }),
  traceExporter: new OTLPTraceExporter({
    // Defaults to OTEL_EXPORTER_OTLP_ENDPOINT env var.
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // dns spans are noise — every getaddrinfo creates one.
      '@opentelemetry/instrumentation-dns': { enabled: false },
      // fs spans explode cardinality on file-mounted secret reads.
      '@opentelemetry/instrumentation-fs':  { enabled: false },
      '@opentelemetry/instrumentation-http': {
        // Healthcheck noise dominates traces; drop them.
        ignoreIncomingRequestHook: (req) => req.url === '/healthz' || req.url === '/livez' || req.url === '/readyz' || req.url === '/metrics',
      },
      '@opentelemetry/instrumentation-pg': {
        enhancedDatabaseReporting: false,  // sanitised SQL only — never bind values
      },
    }),
  ],
});

sdk.start();

// ── Pyroscope continuous profiling ───────────────────────────────────────────
// Pushes CPU + heap pprof samples to the Pyroscope server every 10s. ~1-2%
// overhead. Disabled when PYROSCOPE_SERVER_ADDRESS is unset (local dev).
if (process.env['PYROSCOPE_SERVER_ADDRESS']) {
  // Dynamic import to avoid pulling node-gyp bindings into environments that
  // don't profile (tests, build-time module resolution).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Pyroscope = require('@pyroscope/nodejs');
  Pyroscope.init({
    serverAddress: process.env['PYROSCOPE_SERVER_ADDRESS'],
    appName:       process.env['OTEL_SERVICE_NAME'] ?? 'admin-api',
    tags: {
      env:       process.env['DEPLOY_ENV']         ?? 'dev',
      version:   process.env['OTEL_SERVICE_VERSION'] ?? '0.0.0',
      namespace: process.env['POD_NAMESPACE']      ?? 'admin-api',
    },
  });
  Pyroscope.start();
}

// Flush spans on graceful shutdown so SIGTERM doesn't drop the last few.
const shutdown = async (): Promise<void> => {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('[admin-api] OTel shutdown error', err);
  }
};
process.once('SIGTERM', shutdown);
process.once('SIGINT',  shutdown);
