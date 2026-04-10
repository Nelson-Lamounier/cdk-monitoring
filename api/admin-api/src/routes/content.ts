/**
 * @format
 * admin-api — Article MDX content routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   GET  /api/admin/content/:slug — Fetch the MDX body for an article from S3.
 *                                   Resolves the `contentRef` pointer from DynamoDB first,
 *                                   then streams the S3 object body.
 *
 *   POST /api/admin/content/:slug — Write updated MDX to S3 and stamp `updatedAt`
 *                                   on the DynamoDB METADATA record.
 *
 * Design:
 *   The `contentRef` stored on the METADATA record (e.g. `s3://bucket/drafts/slug.mdx`)
 *   is the canonical pointer to the article body. This route decouples the editor's
 *   save flow from direct S3 access in the frontend pod.
 *
 * Error handling:
 *   - 404 if the METADATA record doesn't exist.
 *   - 422 if the METADATA record exists but has no `contentRef` (misconfiguration).
 *   - 500 for unexpected S3 or DynamoDB failures.
 */

import { Hono } from 'hono';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { AdminApiConfig } from '../lib/config.js';
import { docClient } from '../lib/dynamo.js';

/** Singleton S3 client — credentials resolved from IMDS. */
const s3 = new S3Client({});

/**
 * Parse an S3 URI of the form `s3://bucket/key` into its components.
 *
 * @param uri - Full S3 URI
 * @returns Bucket and key, or null if the URI is malformed
 */
function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Create the content admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with MDX content routes
 */
export function createContentRouter(config: AdminApiConfig): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /api/admin/content/:slug
  // Fetch the MDX body for a single article.
  //
  // Flow:
  //   1. GetItem on DynamoDB (ARTICLE#<slug>, METADATA) to resolve contentRef
  //   2. Parse the S3 URI from contentRef
  //   3. GetObject from S3 and return the body as text/plain
  //
  // Response: { slug, contentRef, content }
  // -------------------------------------------------------------------------
  router.get('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');

    // Step 1: Resolve contentRef from METADATA record
    const metaResult = await docClient.send(
      new GetCommand({
        TableName: config.dynamoTableName,
        Key: { pk: `ARTICLE#${slug}`, sk: 'METADATA' },
      }),
    );

    if (!metaResult.Item) {
      return ctx.json({ error: `Article not found: ${slug}` }, 404);
    }

    const contentRef = metaResult.Item['contentRef'] as string | undefined;

    if (!contentRef) {
      return ctx.json(
        {
          error: `Article "${slug}" has no contentRef — it may not have content yet`,
          slug,
          content: '',
          contentRef: '',
        },
        200, // Return 200 with empty content so the editor opens in blank state
      );
    }

    // Step 2: Parse S3 URI
    const s3Uri = parseS3Uri(contentRef);
    if (!s3Uri) {
      return ctx.json(
        { error: `Invalid contentRef format: "${contentRef}"` },
        422,
      );
    }

    // Step 3: Fetch body from S3
    const s3Result = await s3.send(
      new GetObjectCommand({
        Bucket: s3Uri.bucket,
        Key: s3Uri.key,
      }),
    );

    const body = s3Result.Body;
    const content = body ? await body.transformToString('utf-8') : '';

    return ctx.json({ slug, contentRef, content });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/content/:slug
  // Save updated MDX content to S3 and stamp updatedAt on METADATA.
  //
  // Request body: { content: string }
  //
  // Flow:
  //   1. GetItem on DynamoDB (ARTICLE#<slug>, METADATA) to resolve contentRef
  //   2. PutObject to S3 with the new MDX text
  //   3. UpdateItem to stamp updatedAt on METADATA record
  //
  // Response: { saved: true, slug, contentRef }
  // -------------------------------------------------------------------------
  router.post('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');
    const body = await ctx.req.json<{ content?: string }>();

    if (typeof body.content !== 'string') {
      return ctx.json({ error: '"content" must be a string' }, 400);
    }

    // Step 1: Resolve contentRef
    const metaResult = await docClient.send(
      new GetCommand({
        TableName: config.dynamoTableName,
        Key: { pk: `ARTICLE#${slug}`, sk: 'METADATA' },
      }),
    );

    if (!metaResult.Item) {
      return ctx.json({ error: `Article not found: ${slug}` }, 404);
    }

    const contentRef = metaResult.Item['contentRef'] as string | undefined;
    if (!contentRef) {
      return ctx.json(
        { error: `Article "${slug}" has no contentRef — cannot save content` },
        422,
      );
    }

    // Step 2: Parse and validate S3 URI
    const s3Uri = parseS3Uri(contentRef);
    if (!s3Uri) {
      return ctx.json(
        { error: `Invalid contentRef format: "${contentRef}"` },
        422,
      );
    }

    // Step 3: Write to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Uri.bucket,
        Key: s3Uri.key,
        Body: body.content,
        ContentType: 'text/markdown; charset=utf-8',
      }),
    );

    // Step 4: Stamp updatedAt on METADATA
    await docClient.send(
      new UpdateCommand({
        TableName: config.dynamoTableName,
        Key: { pk: `ARTICLE#${slug}`, sk: 'METADATA' },
        UpdateExpression: 'SET updatedAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }),
    );

    return ctx.json({ saved: true, slug, contentRef });
  });

  return router;
}
