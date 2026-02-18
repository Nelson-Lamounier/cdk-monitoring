/**
 * @format
 * Articles List Lambda Handler
 *
 * Lists published articles from DynamoDB using GSI1.
 *
 * Environment Variables:
 * - TABLE_NAME: DynamoDB table name
 * - GSI1_NAME: GSI1 index name (default: 'gsi1-status-date')
 *
 * Query Parameters:
 * - limit: Number of articles to return (default: 20, max: 100)
 * - lastKey: Pagination key for next page
 * - tag: Filter by tag (uses GSI2)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    QueryCommand,
    QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;
const GSI1_NAME = process.env.GSI1_NAME ?? 'gsi1-status-date';
const GSI2_NAME = process.env.GSI2_NAME ?? 'gsi2-tag-date';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface Article {
    slug: string;
    title: string;
    description: string;
    date: string;
    author: string;
    tags: string[];
    status: string;
    imageUrl?: string;
    readingTime?: number;
}

interface ListResponse {
    articles: Article[];
    nextKey?: string;
    count: number;
}

/**
 * Parse pagination key from base64-encoded string
 */
function parseLastKey(lastKeyStr?: string): Record<string, unknown> | undefined {
    if (!lastKeyStr) return undefined;
    try {
        return JSON.parse(Buffer.from(lastKeyStr, 'base64').toString('utf8'));
    } catch {
        console.warn('Invalid lastKey format');
        return undefined;
    }
}

/**
 * Encode pagination key to base64 string
 */
function encodeNextKey(lastEvaluatedKey?: Record<string, unknown>): string | undefined {
    if (!lastEvaluatedKey) return undefined;
    return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
}

/**
 * Map DynamoDB item to Article response
 */
function mapToArticle(item: Record<string, unknown>): Article {
    return {
        slug: String(item.slug ?? ''),
        title: String(item.title ?? ''),
        description: String(item.description ?? ''),
        date: String(item.date ?? ''),
        author: String(item.author ?? ''),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        status: String(item.status ?? 'draft'),
        imageUrl: item.imageUrl ? String(item.imageUrl) : undefined,
        readingTime: item.readingTime ? Number(item.readingTime) : undefined,
    };
}

/**
 * Build CORS headers for response
 */
function buildHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
}

/**
 * List published articles using GSI1
 */
async function listPublishedArticles(
    limit: number,
    lastKey?: Record<string, unknown>
): Promise<{ items: Record<string, unknown>[]; lastEvaluatedKey?: Record<string, unknown> }> {
    const params: QueryCommandInput = {
        TableName: TABLE_NAME,
        IndexName: GSI1_NAME,
        KeyConditionExpression: 'gsi1pk = :status',
        ExpressionAttributeValues: {
            ':status': 'STATUS#published',
        },
        ScanIndexForward: false, // Most recent first
        Limit: limit,
        ExclusiveStartKey: lastKey,
    };

    console.log('Querying GSI1 for published articles:', JSON.stringify(params));

    const result = await docClient.send(new QueryCommand(params));
    return {
        items: (result.Items ?? []) as Record<string, unknown>[],
        lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    };
}

/**
 * List articles by tag using GSI2
 */
async function listArticlesByTag(
    tag: string,
    limit: number,
    lastKey?: Record<string, unknown>
): Promise<{ items: Record<string, unknown>[]; lastEvaluatedKey?: Record<string, unknown> }> {
    const params: QueryCommandInput = {
        TableName: TABLE_NAME,
        IndexName: GSI2_NAME,
        KeyConditionExpression: 'gsi2pk = :tag',
        ExpressionAttributeValues: {
            ':tag': `TAG#${tag}`,
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: lastKey,
    };

    console.log('Querying GSI2 for articles by tag:', JSON.stringify(params));

    const result = await docClient.send(new QueryCommand(params));
    return {
        items: (result.Items ?? []) as Record<string, unknown>[],
        lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    };
}

/**
 * Lambda handler
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('List articles request:', JSON.stringify({
        path: event.path,
        queryStringParameters: event.queryStringParameters,
    }));

    try {
        // Parse query parameters
        const queryParams = event.queryStringParameters ?? {};
        const requestedLimit = queryParams.limit ? parseInt(queryParams.limit, 10) : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);
        const lastKey = parseLastKey(queryParams.lastKey);
        const tag = queryParams.tag;

        // Query articles
        let result: { items: Record<string, unknown>[]; lastEvaluatedKey?: Record<string, unknown> };

        if (tag) {
            result = await listArticlesByTag(tag, limit, lastKey);
        } else {
            result = await listPublishedArticles(limit, lastKey);
        }

        // Map to response format
        const articles = result.items.map(mapToArticle);
        const response: ListResponse = {
            articles,
            count: articles.length,
            nextKey: encodeNextKey(result.lastEvaluatedKey),
        };

        console.log(`Returning ${articles.length} articles`);

        return {
            statusCode: 200,
            headers: buildHeaders(),
            body: JSON.stringify(response),
        };
    } catch (error) {
        console.error('Error listing articles:', error);

        return {
            statusCode: 500,
            headers: buildHeaders(),
            body: JSON.stringify({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : 'Unknown error',
            }),
        };
    }
};
