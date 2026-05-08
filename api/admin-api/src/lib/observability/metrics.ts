/**
 * @format
 * admin-api — Prometheus metrics registry.
 *
 * Exposes:
 *   - default Node runtime metrics (process_*, nodejs_eventloop_lag_seconds,
 *     nodejs_heap_size_*, nodejs_gc_duration_seconds)
 *   - HTTP RED: rate, errors, duration with route-level labels
 *
 * Labels are kept low-cardinality — `route` is the matched Hono path
 * pattern (e.g. /api/admin/articles/:id), NEVER the raw URL with IDs,
 * to avoid Prometheus series explosion.
 */

import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({
  service: process.env['OTEL_SERVICE_NAME'] ?? 'admin-api',
  env:     process.env['DEPLOY_ENV']         ?? 'dev',
});

collectDefaultMetrics({
  register: registry,
  eventLoopMonitoringPrecision: 10,
});

export const httpRequestsTotal = new Counter({
  name:       'http_requests_total',
  help:       'Total HTTP requests received by admin-api.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers:  [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name:       'http_request_duration_seconds',
  help:       'HTTP request handler latency in seconds.',
  labelNames: ['method', 'route', 'status_code'] as const,
  // Tuned for an in-cluster BFF: most calls < 250ms, DB-heavy < 1s,
  // outliers < 5s. 10s+ should already be paging.
  buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers:  [registry],
});

// ── Auth-specific counters ────────────────────────────────────────────────────
// Tracks user provisioning outcomes on /api/admin/me calls.
// outcome labels:
//   new_user  — INSERT INTO users succeeded (first-ever sign-in)
//   returning — sub already known to this pod (fast-path cache hit) or
//               upsert returned isNew=false (same sub, pod restart)
//   error     — upsertUser() threw; userId not set on context
export const authProvisionTotal = new Counter({
  name:       'auth_provision_total',
  help:       'User provisioning outcomes on first-ever and returning admin-api sign-ins.',
  labelNames: ['outcome'] as const,
  registers:  [registry],
});
