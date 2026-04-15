/**
 * @format
 * admin-api — Article draft upload routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   POST /api/admin/drafts/:slug — Upload a new markdown draft to S3 at
 *                                   drafts/<slug>.md on the assets bucket.
 *
 * Design:
 *   Two-step flow:
 *   1. PutObject to S3 at drafts/<slug>.md — creates the draft source file.
 *   2. Invoke the trigger Lambda directly with a synthetic S3 event — this
 *      works in all environments, including dev where S3 event notifications
 *      may not be configured. The Lambda reads event.Records[].s3 and starts
 *      the Step Functions execution.
 *
 *   This route is intentionally separate from POST /api/admin/content/:slug,
 *   which updates content for articles that already exist in DynamoDB and
 *   have a contentRef. New drafts have neither.
 *
 * @see bedrock-applications/article-pipeline/src/handlers/trigger-handler.ts
 */

import { Hono } from 'hono';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { AdminApiConfig } from '../lib/config.js';

const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1';

/** Singleton S3 client — credentials resolved from IMDS. */
const s3 = new S3Client({ region });

/**
 * Create the drafts admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with draft upload route
 */
export function createDraftsRouter(config: AdminApiConfig): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // POST /api/admin/drafts/:slug
  // Upload a new markdown draft to S3 at drafts/<slug>.md.
  //
  // The S3 bucket has an event notification configured (pipeline-stack.ts)
  // that automatically invokes the article pipeline trigger Lambda on any
  // PUT to drafts/*.md. No direct Lambda invocation needed here — doing both
  // would cause two Step Functions executions per upload.
  //
  // Request body: { content: string }
  //
  // Response: 201 { uploaded: true, slug, key }
  // -------------------------------------------------------------------------
  router.post('/:slug', async (ctx) => {
    const slug = ctx.req.param('slug');
    const body = await ctx.req.json<{ content?: string }>();

    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return ctx.json({ error: '"content" must be a non-empty string' }, 400);
    }

    const key = `drafts/${slug}.md`;

    // Upload draft to S3 — the S3 event notification fires the trigger Lambda
    // automatically. No direct Lambda invocation required.
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.assetsBucketName,
          Key: key,
          Body: body.content,
          ContentType: 'text/markdown; charset=utf-8',
        }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[drafts] S3 PutObject failed — bucket=${config.assetsBucketName} key=${key}`, err);
      return ctx.json({ error: `S3 upload failed: ${message}` }, 500);
    }

    console.log(`[drafts] Draft uploaded — slug=${slug} key=${key} bucket=${config.assetsBucketName}`);
    return ctx.json({ uploaded: true, triggered: true, slug, key }, 201);
  });

  return router;
}
