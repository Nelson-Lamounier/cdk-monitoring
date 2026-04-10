/**
 * @format
 * admin-api — Comment moderation routes.
 *
 * Provides read/moderate/delete operations for user comments stored
 * in the DYNAMODB_TABLE_NAME DynamoDB table (content table).
 * All routes are protected by the Cognito JWT middleware.
 *
 * Comments use:
 *   pk  = ARTICLE#<slug>
 *   sk  = COMMENT#<timestamp>#<uuid>
 *   gsi1pk = COMMENT#pending  (pending queue key)
 *
 * Routes:
 *   GET  /pending                  — all comments pending moderation
 *   POST /:id/moderate             — approve or reject a comment
 *   DELETE /:id                    — permanently delete a comment
 *
 * The `:id` parameter is a composite `slug__sk` string (double underscore).
 */

import { Hono } from 'hono';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AdminApiConfig } from '../lib/config.js';

// ── DynamoDB client (lazy singleton per config) ───────────────────────────────

let _docClient: DynamoDBDocumentClient | null = null;

function getDocClient(region: string): DynamoDBDocumentClient {
  if (!_docClient) {
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _docClient;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Splits a composite comment ID (`slug__sk`) into its constituent parts.
 *
 * @param compositeId - Combined `slug__sk` identifier
 * @returns Tuple of `[slug, sortKey]`
 */
function parseCompositeId(compositeId: string): [string, string] {
  const parts = compositeId.split('__');
  const slug = parts[0] ?? '';
  const sk = parts.slice(1).join('__');
  return [slug, sk];
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * Creates the Hono router for comment moderation routes.
 *
 * @param config - Validated admin-api configuration
 * @returns Hono router instance
 */
export function createCommentsRouter(config: AdminApiConfig): Hono {
  const app = new Hono();
  const TABLE = config.dynamoTableName;
  const GSI1 = config.dynamoGsi1Name;

  // ── GET /pending — pending moderation queue ───────────────────────────────
  /**
   * Retrieves all comments with status=pending across all articles.
   * Uses GSI1 with gsi1pk=COMMENT#pending for efficient querying.
   *
   * @returns Array of pending admin comment records (newest first)
   */
  app.get('/pending', async (ctx) => {
    const client = getDocClient(config.awsRegion);

    try {
      const result = await client.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: GSI1,
          KeyConditionExpression: 'gsi1pk = :pk',
          ExpressionAttributeValues: { ':pk': 'COMMENT#pending' },
          ScanIndexForward: false,
        }),
      );

      const comments = (result.Items ?? []).map((item) => ({
        commentId: String(item['commentId'] ?? ''),
        articleSlug: String(item['articleSlug'] ?? ''),
        name: String(item['name'] ?? ''),
        email: String(item['email'] ?? ''),
        body: String(item['body'] ?? ''),
        status: String(item['status'] ?? 'pending'),
        createdAt: String(item['createdAt'] ?? ''),
      }));

      return ctx.json({ comments, count: comments.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[comments] GSI1 unavailable for pending comments:', message);
      return ctx.json({ comments: [], count: 0 });
    }
  });

  // ── POST /:id/moderate — approve or reject ────────────────────────────────
  /**
   * Approves or rejects a pending comment.
   *
   * On approval, increments the article's commentCount counter.
   * Updates gsi1pk to COMMENT#approved or COMMENT#rejected so it no longer
   * appears in the pending queue.
   *
   * @param id - Composite comment ID in `slug__sk` format (URL-encoded)
   * @body status - 'approve' or 'reject'
   * @returns Updated comment record
   */
  app.post('/:id/moderate', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const compositeId = decodeURIComponent(ctx.req.param('id'));
    const [slug, commentSk] = parseCompositeId(compositeId);

    const body = await ctx.req.json<{ status?: string }>();
    const action = body.status;

    if (action !== 'approve' && action !== 'reject') {
      return ctx.json({ error: 'status must be "approve" or "reject"' }, 400);
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const result = await client.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `ARTICLE#${slug}`, sk: commentSk },
        UpdateExpression: 'SET #status = :status, gsi1pk = :gsi1pk',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': newStatus,
          ':gsi1pk': `COMMENT#${newStatus}`,
        },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      return ctx.json({ error: 'Comment not found' }, 404);
    }

    // Increment comment counter on approval
    if (action === 'approve') {
      await client.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: `ARTICLE#${slug}`, sk: 'COUNTERS' },
          UpdateExpression: 'ADD commentCount :inc',
          ExpressionAttributeValues: { ':inc': 1 },
        }),
      );
    }

    const item = result.Attributes;
    return ctx.json({
      comment: {
        commentId: String(item['commentId'] ?? ''),
        articleSlug: String(item['articleSlug'] ?? ''),
        name: String(item['name'] ?? ''),
        email: String(item['email'] ?? ''),
        body: String(item['body'] ?? ''),
        status: newStatus,
        createdAt: String(item['createdAt'] ?? ''),
      },
    });
  });

  // ── DELETE /:id — permanently delete ─────────────────────────────────────
  /**
   * Permanently deletes a comment. If it was approved, decrements the
   * article's commentCount counter.
   *
   * @param id - Composite comment ID in `slug__sk` format (URL-encoded)
   * @returns Success indicator
   */
  app.delete('/:id', async (ctx) => {
    const client = getDocClient(config.awsRegion);
    const compositeId = decodeURIComponent(ctx.req.param('id'));
    const [slug, commentSk] = parseCompositeId(compositeId);

    // Check current status before deletion (needed for counter adjustment)
    const existing = await client.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `ARTICLE#${slug}`, sk: commentSk },
        ProjectionExpression: '#status',
        ExpressionAttributeNames: { '#status': 'status' },
      }),
    );

    if (!existing.Item) {
      return ctx.json({ error: 'Comment not found' }, 404);
    }

    await client.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { pk: `ARTICLE#${slug}`, sk: commentSk },
      }),
    );

    // Decrement counter only if the comment was approved
    if (existing.Item['status'] === 'approved') {
      await client.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: `ARTICLE#${slug}`, sk: 'COUNTERS' },
          UpdateExpression: 'ADD commentCount :dec',
          ExpressionAttributeValues: { ':dec': -1 },
        }),
      );
    }

    return ctx.json({ deleted: true });
  });

  return app;
}
