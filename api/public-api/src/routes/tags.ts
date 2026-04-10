/**
 * @file tags.ts
 * @description Tags route for the public-api service.
 *
 * Returns all unique tags from published articles by querying DynamoDB
 * GSI2 (`gsi2-tag-date`). Each unique tag is returned once,
 * with an article count for the frontend tag-filter UI.
 *
 * ## Access Pattern
 *
 * A `Scan` with a filter on `status = 'published'` is used to aggregate
 * tags. For a portfolio-scale dataset this is acceptable — the tag list
 * is cached at CloudFront for 10 minutes (`s-maxage=600`).
 *
 * If tag volume grows, this should move to a dedicated GSI or a
 * pre-aggregated tag-count record in DynamoDB.
 */

import { Hono } from 'hono';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../lib/dynamo.js';
import { loadConfig } from '../lib/config.js';

const tags = new Hono();

/** Cache-Control — tags change infrequently, 10-minute edge cache. */
const CACHE_CONTROL = 'public, s-maxage=600, stale-while-revalidate=120';

/** Shape of a tag summary returned to the frontend. */
interface TagSummary {
  tag: string;
  count: number;
}

/**
 * GET /api/tags
 *
 * Returns an array of unique tags with article counts, sorted alphabetically.
 * Only tags from published articles are included.
 *
 * @returns JSON array of `{ tag: string, count: number }` objects.
 */
tags.get('/api/tags', async (c) => {
  const cfg = loadConfig();
  const dynamo = getDynamoClient();

  // Scan articles with status=published, project only the `tags` attribute.
  // ProjectionExpression avoids fetching full article content on each item.
  const result = await dynamo.send(
    new ScanCommand({
      TableName: cfg.dynamoTableName,
      FilterExpression: '#status = :published AND begins_with(pk, :prefix)',
      ExpressionAttributeNames: {
        '#status': 'status', // 'status' is not a reserved word but we alias for clarity
      },
      ExpressionAttributeValues: {
        ':published': 'published',
        ':prefix': 'ARTICLE#',
      },
      ProjectionExpression: 'tags',
    }),
  );

  // Aggregate tag counts across all published articles
  const tagCounts = new Map<string, number>();

  for (const item of result.Items ?? []) {
    const itemTags = item['tags'];
    if (Array.isArray(itemTags)) {
      for (const tag of itemTags as string[]) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  const summary: TagSummary[] = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({ tags: summary });
});

export default tags;
