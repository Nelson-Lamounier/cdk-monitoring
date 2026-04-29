/**
 * @format
 * admin-api — Health check route.
 *
 * GET /healthz
 *
 * Used by Kubernetes as the liveness and readiness probe target.
 * Does NOT require authentication — Kubernetes probes cannot send JWTs.
 *
 * Returns a minimal JSON body to confirm the process is alive.
 * Does NOT check DynamoDB or Lambda connectivity — a dependency
 * failure should surface as a 5xx error on a real request, not
 * silently crash the health check and trigger pod restarts.
 */

import { Hono } from 'hono';

/**
 * Create the health check router.
 *
 * @returns Hono router with GET /healthz.
 */
export function createHealthRouter(): Hono {
  const router = new Hono();

  router.get('/', (ctx) => {
    return ctx.json({
      status: 'ok',
      service: 'admin-api',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
