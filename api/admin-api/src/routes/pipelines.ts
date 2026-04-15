/**
 * @format
 * admin-api — Pipeline trigger routes.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   POST /api/admin/pipelines/article     — Re-trigger article generation for an existing slug
 *   POST /api/admin/pipelines/strategist  — Trigger the Strategist pipeline Lambda
 *
 * Design:
 *   All invocations use `InvocationType: 'Event'` (fire-and-forget async).
 *   The admin UI gets an immediate 202 Accepted response and polls the article
 *   status or dashboard to detect completion.
 *
 *   The article route builds a synthetic S3 event matching the S3Handler
 *   contract expected by the trigger Lambda (bedrock-*-pipeline-trigger).
 *   This is the same shape that drafts.ts constructs, ensuring consistent
 *   behaviour regardless of which route initiates the pipeline.
 *
 *   Note: The publish pipeline (MDX → S3 → DynamoDB) is exposed separately under
 *         POST /api/admin/articles/:slug/publish, which already exists on the
 *         articles router, because it is tightly coupled to a specific article slug.
 *
 * Environment config:
 *   ARTICLE_TRIGGER_ARN    — Lambda ARN for article pipeline trigger
 *   STRATEGIST_TRIGGER_ARN — Lambda ARN for Strategist pipeline
 *   ASSETS_BUCKET_NAME     — S3 bucket name (used to build the synthetic S3 event)
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
    _lambdaClient = new LambdaClient({
      region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
    });
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
  // Re-trigger article generation for an existing draft slug.
  //
  // Required body: { slug: string }
  //   slug — the article slug whose source file already exists at
  //          s3://<assetsBucket>/drafts/<slug>.md.
  //
  // The trigger Lambda (bedrock-*-pipeline-trigger) is typed as an S3Handler.
  // It iterates event.Records[n].s3.object.key and extracts the slug via the
  // regex /^drafts\/(.+)\.md$/. A flat payload (without a Records array) causes
  // the handler to silently no-op — this was the original bug.
  //
  // This route constructs the same synthetic S3 event shape that drafts.ts uses,
  // ensuring consistent Lambda invocation regardless of trigger origin.
  //
  // InvocationType: 'Event' — async fire-and-forget.
  // The admin dashboard polls GET /api/admin/articles/:slug for status updates.
  //
  // Response: 202 { queued: true, pipeline: 'article', slug, key }
  // -------------------------------------------------------------------------
  router.post('/article', async (ctx) => {
    const body = await ctx.req.json<{ slug?: string }>().catch(() => ({ slug: undefined }));

    // slug is required — without it we cannot construct the S3 object key
    if (!body.slug || typeof body.slug !== 'string' || body.slug.trim().length === 0) {
      return ctx.json({ error: 'slug is required in the request body' }, 400);
    }

    const slug = body.slug.trim();
    const key = `drafts/${slug}.md`;

    // Build a synthetic S3 event matching the S3Handler / S3Event contract.
    // The trigger Lambda reads event.Records[n].s3.bucket.name and
    // event.Records[n].s3.object.key — these two fields are the minimum required.
    const syntheticS3Event = {
      Records: [
        {
          s3: {
            bucket: { name: config.assetsBucketName },
            object: { key },
          },
        },
      ],
    };

    await invokeAsync(config.articleTriggerArn, syntheticS3Event as Record<string, unknown>);

    console.log(`[pipelines] Article re-trigger queued — slug=${slug} key=${key}`);

    return ctx.json({ queued: true, pipeline: 'article', slug, key }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/pipelines/strategist
  // Trigger the Strategist pipeline Lambda asynchronously.
  //
  // The Strategist trigger Lambda's handler is typed as APIGatewayProxyEventV2.
  // It reads `event.body` as a JSON string and parses it through a Zod
  // discriminated union that requires `{ operation, targetCompany, targetRole, ... }`.
  //
  // This route forwards the admin dashboard's request body by wrapping it in the
  // correct APIGatewayProxyEventV2 envelope. A flat payload (without body/requestContext)
  // would fail Zod validation inside the Lambda silently due to async invocation.
  //
  // Required body fields (forwarded verbatim):
  //   operation     — 'analyse' | 'coach'
  //   targetCompany — e.g. 'Acme Corp'
  //   targetRole    — e.g. 'Senior Engineer'
  //   jobDescription — full JD text
  //   resumeId      — DynamoDB RESUME# record ID (for 'analyse')
  //   applicationSlug — existing slug (for 'coach')
  //   interviewStage — 'applied' | 'screening' | 'technical' | ... (for 'coach')
  //
  // InvocationType: 'Event' — async fire-and-forget.
  // Response: 202 { queued: true, pipeline: 'strategist' }
  // -------------------------------------------------------------------------
  router.post('/strategist', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));

    // The Strategist trigger Lambda is an APIGatewayProxyEventV2 handler.
    // We must wrap the request body in the correct envelope shape so that
    // the Lambda's Zod schema can parse it from event.body.
    const lambdaEvent = {
      requestContext: {
        http: { method: 'POST' },
      },
      body: JSON.stringify(body),
    };

    await invokeAsync(config.strategistTriggerArn, lambdaEvent as Record<string, unknown>);

    console.log(`[pipelines] Strategist trigger queued — operation=${String(body['operation'] ?? 'unknown')}`);

    return ctx.json({ queued: true, pipeline: 'strategist' }, 202);
  });

  return router;
}
