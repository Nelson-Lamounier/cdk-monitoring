/**
 * @format
 * Tests for public-api routes/health.ts
 *
 * The health route serves K8s startup, readiness, and liveness probes.
 * It must always return 200 and requires no authentication.
 */

import health from '../../src/routes/health.js';

describe('GET /healthz', () => {
  it('returns 200 OK', async () => {
    const res = await health.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('returns status: ok', async () => {
    const res = await health.request('/healthz');
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
  });

  it('identifies the service as public-api', async () => {
    const res = await health.request('/healthz');
    const body = (await res.json()) as { status: string; service: string };
    expect(body.service).toBe('public-api');
  });

  it('returns Content-Type: application/json', async () => {
    const res = await health.request('/healthz');
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
  });
});
