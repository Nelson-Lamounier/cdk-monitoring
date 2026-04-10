/**
 * @file resumes.ts
 * @description Public resume route for the public-api service.
 *
 * Exposes the active resume publicly so portfolio visitors and the site's
 * SSR pages can fetch it without hitting DynamoDB directly.
 *
 * Routes (all unauthenticated — public read-only):
 *
 *   GET /api/resumes/active — Returns the currently active resume.
 *                             Returns 204 if no resume is active.
 *
 * ## Caching strategy
 *
 * Resumes change rarely (admin action required), so we apply a generous
 * Cache-Control header (`s-maxage=300, stale-while-revalidate=600`).
 * CloudFront will serve this from edge for up to 5 minutes between deploys.
 *
 * The `revalidate` endpoint on the site can purge the CDN cache immediately
 * after an admin activates a new resume (future enhancement).
 *
 * ## DynamoDB access pattern
 *
 * Resumes live in the Strategist table (STRATEGIST_TABLE_NAME).
 * The active resume is found via a Scan with:
 *   entityType = RESUME AND isActive = true AND sk = METADATA
 *
 * Table is small (< 20 items) — Scan is acceptable here.
 */

import { Hono } from 'hono';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../lib/dynamo.js';
import { loadConfig } from '../lib/config.js';

const resumes = new Hono();

/** Cache-Control header for resume responses. */
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';

/**
 * GET /api/resumes/active
 *
 * Returns the currently active resume data.
 *
 * Response:
 *   200 — Active resume JSON (full data included)
 *   204 — No active resume configured (frontend falls back to hardcoded data)
 *
 * @returns JSON resume object or empty 204 response
 */
resumes.get('/api/resumes/active', async (c) => {
  const cfg = loadConfig();

  // Graceful degradation: if STRATEGIST_TABLE_NAME is not configured in this
  // environment, return 204 so the site falls back to hardcoded resume data.
  if (!cfg.resumesTableName) {
    return new Response(null, { status: 204 });
  }

  const dynamo = getDynamoClient();

  const result = await dynamo.send(
    new ScanCommand({
      TableName: cfg.resumesTableName,
      FilterExpression: 'entityType = :type AND isActive = :active AND sk = :sk',
      ExpressionAttributeValues: {
        ':type': 'RESUME',
        ':active': true,
        ':sk': 'METADATA',
      },
    }),
  );

  if (!result.Items || result.Items.length === 0) {
    // 204 No Content — frontend uses hardcoded fallback
    return new Response(null, { status: 204 });
  }

  const entity = result.Items[0] as Record<string, unknown>;

  // Strip DynamoDB-internal keys before returning to the public caller.
  const internalKeys = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk', 'entityType']);
  const publicPayload = Object.fromEntries(
    Object.entries(entity).filter(([key]) => !internalKeys.has(key)),
  );

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json(publicPayload);
});

export default resumes;
