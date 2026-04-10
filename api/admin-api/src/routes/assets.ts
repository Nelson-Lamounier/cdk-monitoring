/**
 * @format
 * admin-api — Asset upload routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   POST /api/admin/assets/presign — Generate a pre-signed S3 PUT URL
 *               for direct browser-to-S3 upload (avoids proxy overhead).
 *   DELETE /api/admin/assets/:key  — Delete an asset from S3 by key.
 *
 * Pre-signed URL design:
 *   The TanStack start-admin frontend requests a signed URL, then puts
 *   the file directly to S3 from the browser. This avoids routing
 *   binary content through the Kubernetes pod, drastically reducing
 *   memory pressure and upload latency.
 *
 *   URL expiry: 5 minutes — sufficient for a direct upload.
 */

import { Hono } from 'hono';
import { S3Client, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AdminApiConfig } from '../lib/config.js';

/** S3 client singleton — credentials from IMDS, no explicit config. */
const s3 = new S3Client({});

/** Allowed MIME types for article asset uploads. */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
]);

/** Maximum upload size via pre-signed URL (50 MB). */
const MAX_CONTENT_LENGTH = 50 * 1024 * 1024;

/**
 * Create the assets admin router.
 *
 * @param config - Resolved application configuration.
 * @returns Hono router with asset upload/delete routes.
 */
export function createAssetsRouter(config: AdminApiConfig): Hono {
  const router = new Hono();

  // -----------------------------------------------------------------------
  // POST /api/admin/assets/presign
  // Generate a pre-signed S3 PUT URL for browser-to-S3 direct upload.
  //
  // Request body:
  //   { key: string, contentType: string, contentLength: number }
  //
  // Response:
  //   { url: string, key: string, expiresIn: number }
  // -----------------------------------------------------------------------
  router.post('/presign', async (ctx) => {
    const body = await ctx.req.json<{
      key: string;
      contentType: string;
      contentLength: number;
    }>();

    const { key, contentType, contentLength } = body;

    if (!key || !contentType || !contentLength) {
      return ctx.json({ error: 'key, contentType, and contentLength are required' }, 400);
    }

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return ctx.json(
        { error: `Unsupported content type: ${contentType}` },
        415,
      );
    }

    if (contentLength > MAX_CONTENT_LENGTH) {
      return ctx.json(
        { error: `File exceeds maximum allowed size of ${MAX_CONTENT_LENGTH / 1024 / 1024} MB` },
        413,
      );
    }

    // Scope uploads to articles/ prefix to prevent path traversal attacks
    const safeKey = `articles/${key.replace(/^\/+/, '').replace(/\.\./g, '')}`;

    const command = new PutObjectCommand({
      Bucket: config.assetsBucketName,
      Key: safeKey,
      ContentType: contentType,
      ContentLength: contentLength,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes

    return ctx.json({ url, key: safeKey, expiresIn: 300 });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/admin/assets/:key
  // Delete a specific asset by S3 key.
  // Key is URL-encoded in the path.
  // -----------------------------------------------------------------------
  router.delete('/:key{.+}', async (ctx) => {
    const rawKey = ctx.req.param('key');
    const key = decodeURIComponent(rawKey);

    // Scope safety: only allow deletion within articles/ prefix
    if (!key.startsWith('articles/')) {
      return ctx.json({ error: 'Asset key must be within articles/ prefix' }, 403);
    }

    await s3.send(
      new DeleteObjectCommand({
        Bucket: config.assetsBucketName,
        Key: key,
      }),
    );

    return ctx.json({ deleted: true, key });
  });

  return router;
}
