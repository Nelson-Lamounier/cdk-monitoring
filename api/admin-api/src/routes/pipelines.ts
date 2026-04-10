/**
 * @format
 * admin-api — Pipeline trigger routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   POST /api/admin/pipelines/article     — Trigger the article re-index Lambda
 *   POST /api/admin/pipelines/strategist  — Trigger the Strategist pipeline Lambda
 *
 * Design:
 *   All invocations use `InvocationType: 'Event'` (fire-and-forget async).
 *   The admin UI gets an immediate 202 Accepted response and polls the article
 *   status or dashboard to detect completion.
 *
 *   Note: The publish pipeline (MDX → S3 → DynamoDB) is exposed separately under
 *         POST /api/admin/articles/:slug/publish, which already exists on the
 *         articles router, because it is tightly coupled to a specific article slug.
 *
 * Environment config:
 *   ARTICLE_TRIGGER_ARN    — Lambda ARN for re-index trigger
 *   STRATEGIST_TRIGGER_ARN — Lambda ARN for Strategist pipeline
 */

import { Hono } from 'hono';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { JWTPayload } from 'jose';
import type { AdminApiConfig } from '../lib/config.js';

/** Hono context variable bindings for authenticated routes. */
type AdminApiBindings = {
  Variables: {
    jwtPayload: JWTPayload;
  };
};

/** Singleton Lambda client — credentials from IMDS. */
let _lambdaClient: LambdaClient | undefined;

/**
 * Get or create the singleton Lambda client.
 *
 * @returns Singleton LambdaClient
 */
function getLambdaClient(): LambdaClient {
  if (!_lambdaClient) {
    _lambdaClient = new LambdaClient({});
  }
  return _lambdaClient;
}

/**
 * Invoke a Lambda function asynchronously (fire-and-forget).
 *
 * @param functionArn - The Lambda ARN to invoke
 * @param payload - JSON-serialisable event payload
 */
async function invokeAsync(
  functionArn: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: 'Event', // async — does not wait for result
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

/**
 * Create the pipelines admin router.
 *
 * @param config - Resolved application configuration
 * @returns Hono router with pipeline trigger routes
 */
export function createPipelinesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/article
  // Trigger the article re-index Lambda asynchronously.
  //
  // Optional body: { slug?: string }
  //   slug — if provided, re-indexes only that article; otherwise full re-index.
  //
  // Response: 202 { queued: true, pipeline: 'article', slug? }
  // -------------------------------------------------------------------------
  router.post('/article', async (ctx) => {
    const jwtPayload = ctx.get('jwtPayload') as { sub?: string };
    const body = await ctx.req.json<{ slug?: string }>().catch(() => ({ slug: undefined }));

    await invokeAsync(config.articleTriggerArn, {
      slug: body.slug ?? null,
      triggeredBy: jwtPayload?.sub ?? 'unknown',
      triggeredAt: new Date().toISOString(),
    });

    return ctx.json(
      { queued: true, pipeline: 'article', ...(body.slug ? { slug: body.slug } : {}) },
      202,
    );
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/strategist
  // Trigger the Strategist pipeline Lambda asynchronously.
  //
  // The Strategist pipeline processes application data and generates insights.
  // No request body is required — the Lambda reads its own context from DynamoDB.
  //
  // Response: 202 { queued: true, pipeline: 'strategist' }
  // -------------------------------------------------------------------------
  router.post('/strategist', async (ctx) => {
    const jwtPayload = ctx.get('jwtPayload') as { sub?: string };

    await invokeAsync(config.strategistTriggerArn, {
      triggeredBy: jwtPayload?.sub ?? 'unknown',
      triggeredAt: new Date().toISOString(),
    });

    return ctx.json({ queued: true, pipeline: 'strategist' }, 202);
  });

  return router;
}
