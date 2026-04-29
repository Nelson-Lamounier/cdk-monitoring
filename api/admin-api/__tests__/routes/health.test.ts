/**
 * @format
 * Tests for admin-api routes/health.ts
 *
 * The health endpoint is the Kubernetes liveness/readiness probe target.
 * It must always return 200 with `{ status: "ok" }` and must never
 * require authentication — probes cannot send JWTs.
 */

import { Hono } from 'hono';
import { createHealthRouter } from '../../src/routes/health.js';

// ---------------------------------------------------------------------------
// Setup — mirrors the mount point in the real index.ts
// ---------------------------------------------------------------------------

/**
 * Build a minimal test application with the health router at /healthz.
 *
 * @returns Hono app under test.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.route('/healthz', createHealthRouter());
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns HTTP 200', async () => {
    const res = await buildApp().request('/healthz');
    expect(res.status).toBe(200);
  });

  it('returns status: ok', async () => {
    const res = await buildApp().request('/healthz');
    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(body.status).toBe('ok');
  });

  it('identifies the service as admin-api', async () => {
    const res = await buildApp().request('/healthz');
    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(body.service).toBe('admin-api');
  });

  it('includes a timestamp in ISO 8601 format', async () => {
    const res = await buildApp().request('/healthz');
    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('sets Content-Type to application/json', async () => {
    const res = await buildApp().request('/healthz');
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await buildApp().request('/unknown');
    expect(res.status).toBe(404);
  });
});
