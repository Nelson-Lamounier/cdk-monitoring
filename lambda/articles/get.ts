/**
 * @format
 * Article Get Lambda Handler
 *
 * Retrieves a single article by slug from DynamoDB.
 *
 * Environment Variables:
 * - TABLE_NAME: DynamoDB table name
 *
 * Path Parameters:
 * - slug: Article slug (URL-friendly identifier)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;

interface Article {
    slug: string;
    title: string;
    description: string;
    content: string;
    date: string;
    author: string;
    tags: string[];
    status: string;
    imageUrl?: string;
    readingTime?: number;
    createdAt: string;
    updatedAt: string;
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
 * Map DynamoDB item to Article response
 */
function mapToArticle(item: Record<string, unknown>): Article {
    return {
        slug: String(item.slug ?? ''),
        title: String(item.title ?? ''),
        description: String(item.description ?? ''),
        content: String(item.content ?? ''),
        date: String(item.date ?? ''),
        author: String(item.author ?? ''),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        status: String(item.status ?? 'draft'),
        imageUrl: item.imageUrl ? String(item.imageUrl) : undefined,
        readingTime: item.readingTime ? Number(item.readingTime) : undefined,
        createdAt: String(item.createdAt ?? item.date ?? ''),
        updatedAt: String(item.updatedAt ?? item.date ?? ''),
    };
}

/**
 * Get article by slug from DynamoDB
 */
async function getArticleBySlug(slug: string): Promise<Record<string, unknown> | null> {
    console.log(`Fetching article with slug: ${slug}`);

    const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `ARTICLE#${slug}`,
            sk: 'METADATA',
        },
    }));

    if (!result.Item) {
        console.log(`Article not found: ${slug}`);
        return null;
    }

    console.log(`Found article: ${slug}`);
    return result.Item as Record<string, unknown>;
}

/**
 * Lambda handler
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Get article request:', JSON.stringify({
        path: event.path,
        pathParameters: event.pathParameters,
    }));

    try {
        // Get slug from path parameters
        const slug = event.pathParameters?.slug;

        if (!slug) {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Missing slug parameter',
                }),
            };
        }

        // Validate slug format (alphanumeric, hyphens only)
        if (!/^[a-z0-9-]+$/.test(slug)) {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Invalid slug format',
                }),
            };
        }

        // Fetch article
        const item = await getArticleBySlug(slug);

        if (!item) {
            return {
                statusCode: 404,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Not Found',
                    message: `Article not found: ${slug}`,
                }),
            };
        }

        // Check if article is published (or return anyway for preview)
        const article = mapToArticle(item);

        // Only return published articles (unless admin/preview mode)
        if (article.status !== 'published') {
            console.log(`Article ${slug} is not published (status: ${article.status})`);
            return {
                statusCode: 404,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Not Found',
                    message: `Article not found: ${slug}`,
                }),
            };
        }

        console.log(`Returning article: ${slug}`);

        return {
            statusCode: 200,
            headers: buildHeaders(),
            body: JSON.stringify(article),
        };
    } catch (error) {
        console.error('Error fetching article:', error);

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
