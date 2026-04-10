/**
 * @file cors.ts
 * @description CORS middleware for the public-api Hono application.
 *
 * Public-api is a read-only service consumed by the Next.js frontend
 * (same origin in production) and by browser clients during local
 * development. The middleware allows the portfolio domain and localhost
 * origins while blocking untrusted cross-origin write requests.
 */

import { cors } from 'hono/cors';

/** Portfolio production domain. */
const PORTFOLIO_ORIGIN = 'https://nelsonlamounier.com';

/** Next.js local dev server (default port). */
const LOCAL_ORIGIN = 'http://localhost:3000';

/**
 * CORS middleware configured for the public-api service.
 *
 * - `GET` and `HEAD` are allowed from any origin (public read API).
 * - Credentials are not exposed (`credentials: false`) — no cookies.
 * - Cache-Control headers are forwarded to CloudFront for edge caching.
 *
 * @returns Hono CORS middleware handler.
 */
export const corsMiddleware = cors({
  origin: [PORTFOLIO_ORIGIN, LOCAL_ORIGIN],
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Accept'],
  exposeHeaders: ['X-Request-Id', 'Cache-Control'],
  credentials: false,
  maxAge: 86_400, // Pre-flight cache: 24 hours
});
