/**
 * @file articles.ts
 * @description Article routes for the public-api service.
 *
 * Exposes read-only article data from DynamoDB to the Next.js frontend.
 * All routes are unauthenticated and cacheable by CloudFront.
 *
 * ## DynamoDB Access Pattern
 *
 * The content table uses a GSI to serve published articles:
 *   - GSI1 (`gsi1-status-date`): pk `STATUS#published`, sk `DATE#<ISO>`
 *     → sorted article list for the blog index page.
 *
 * Tags are derived from the article items themselves (no separate table).
 *
 * ## Caching Strategy
 *
 * All responses include `Cache-Control: s-maxage=300` to allow CloudFront
 * to serve cached responses at the edge for up to 5 minutes, reducing
 * DynamoDB reads for the high-traffic public listing.
 */

import { Hono } from 'hono';
import { QueryCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../lib/dynamo.js';
import { loadConfig } from '../lib/config.js';

const articles = new Hono();

/** Cache-Control header applied to all article responses. */
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';

/** DynamoDB partition key prefix for published articles on GSI1. */
const PUBLISHED_PK = 'STATUS#published';

/** Type representing a serialisable article record from DynamoDB. */
type ArticleItem = Record<string, unknown>;

/**
 * GET /api/articles
 *
 * Returns all published articles ordered by publish date (newest first).
 * Queries DynamoDB GSI1 (`gsi1-status-date`) using the `STATUS#published`
 * partition key and scans in descending order.
 *
 * @returns JSON array of article objects.
 */
articles.get('/api/articles', async (c) => {
  const cfg = loadConfig();
  const dynamo = getDynamoClient();

  const result = await dynamo.send(
    new QueryCommand({
      TableName: cfg.dynamoTableName,
      IndexName: cfg.dynamoGsi1Name,
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: {
        ':pk': PUBLISHED_PK,
      },
      ScanIndexForward: false, // Newest first (descending date)
      // Limit projection to fields needed by the listing page
      ProjectionExpression:
        'slug, title, excerpt, publishedAt, tags, coverImage, readingTime',
    }),
  );

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({ items: result.Items ?? [], count: result.Count ?? 0 });
});

/**
 * GET /api/articles/:slug
 *
 * Returns a single article by its URL slug.
 * Uses a direct `GetItem` on the primary key (pk = `ARTICLE#<slug>`, sk = `METADATA`).
 *
 * @param slug - The article URL slug (e.g. `my-article-title`).
 * @returns The article object, or 404 if not found.
 */
articles.get('/api/articles/:slug', async (c) => {
  const slug = c.req.param('slug');
  const cfg = loadConfig();
  const dynamo = getDynamoClient();

  const result = await dynamo.send(
    new GetCommand({
      TableName: cfg.dynamoTableName,
      Key: {
        pk: `ARTICLE#${slug}`,
        sk: 'METADATA',
      },
    }),
  );

  if (result.Item === undefined) {
    return c.json({ error: 'Article not found', slug }, 404);
  }

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json(result.Item as ArticleItem);
});

export default articles;
