/**
 * @format
 * admin-api — Cognito JWT authentication middleware.
 *
 * Validates Cognito-issued JWTs using JWKS from the User Pool's well-known
 * endpoint. Any valid, unexpired token from the correct User Pool is accepted —
 * both SaaS end users and staff (role distinction lives in users.role in RDS).
 *
 * Flow:
 *   Authorization: Bearer <cognito-id-token>
 *     → Extract token
 *     → Fetch JWKS from Cognito (cached by jose)
 *     → Verify signature, issuer, audience, expiry
 *     → Attach decoded payload to ctx.set('jwtPayload', payload)
 *     → Continue to handler
 *
 * For staff-only routes, apply requireAdminGroup() as additional middleware.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Context, MiddlewareHandler, Next } from 'hono';

/** JWKS caches per pool ID to avoid redundant HTTP fetches. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(userPoolId: string, region: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache.has(userPoolId)) {
    const url = new URL(
      `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
    );
    jwksCache.set(userPoolId, createRemoteJWKSet(url));
  }
  return jwksCache.get(userPoolId)!;
}

/**
 * Cognito JWT bearer middleware for Hono.
 *
 * Attaches the decoded JWT payload to `ctx.get('jwtPayload')` for use
 * by downstream route handlers and userProvisionMiddleware.
 *
 * @param userPoolId - Cognito User Pool ID (COGNITO_USER_POOL_ID env var).
 * @param clientId   - Cognito app client ID (COGNITO_CLIENT_ID env var).
 * @param issuerUrl  - Cognito issuer URL (COGNITO_ISSUER_URL env var).
 * @param region     - AWS region (AWS_DEFAULT_REGION env var).
 */
export function cognitoJwtAuth(
  userPoolId: string,
  clientId: string,
  issuerUrl: string,
  region: string,
): MiddlewareHandler {
  return async (ctx: Context, next: Next): Promise<void> => {
    const authHeader = ctx.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      ctx.res = new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }

    const token = authHeader.slice(7);
    const jwks  = getJwks(userPoolId, region);

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer:   issuerUrl,
        audience: clientId,
      });
      payload = result.payload as JWTPayload;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token validation failed';
      ctx.res = new Response(
        JSON.stringify({ error: 'Unauthorised', detail: message }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }

    ctx.set('jwtPayload', payload);
    await next();
  };
}

/**
 * Optional middleware for staff-only routes.
 * Apply after cognitoJwtAuth on any route that must be restricted to users
 * in the Cognito 'admin' group (e.g. user management, billing overrides).
 */
export function requireAdminGroup(): MiddlewareHandler {
  return async (ctx: Context, next: Next): Promise<void> => {
    const payload = ctx.get('jwtPayload') as JWTPayload | undefined;
    const groups  = (payload?.['cognito:groups'] as string[] | undefined) ?? [];
    if (!groups.includes('admin')) {
      ctx.res = new Response(
        JSON.stringify({ error: 'Forbidden', detail: "Requires 'admin' group membership" }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
      return;
    }
    await next();
  };
}
