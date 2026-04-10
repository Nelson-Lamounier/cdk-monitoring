/**
 * @file health.ts
 * @description Health check route for the public-api service.
 *
 * Used by the three-probe model in the Kubernetes Deployment:
 *   - startupProbe:   GET /healthz (up to 150s startup window)
 *   - readinessProbe: GET /healthz (gates traffic routing)
 *   - livenessProbe:  GET /healthz (restarts on failure)
 *
 * Returns a 200 with a minimal JSON body. No database checks —
 * health is kept lightweight and cannot block pod startup.
 */

import { Hono } from 'hono';

const health = new Hono();

/**
 * GET /healthz
 *
 * @returns `{ status: 'ok', service: 'public-api' }` with HTTP 200.
 */
health.get('/healthz', (c) => {
  return c.json({ status: 'ok', service: 'public-api' });
});

export default health;
