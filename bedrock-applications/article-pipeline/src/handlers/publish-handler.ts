/**
 * @format
 * Publish Handler — Admin-Invoked Article Approval/Rejection
 *
 * This Lambda is invoked by the Next.js admin dashboard (via AWS SDK)
 * when an administrator approves or rejects an article from the review queue.
 *
 * It is NOT part of the Step Functions state machine. It runs separately,
 * triggered by the admin's action in the dashboard.
 *
 * Approve flow:
 * 1. Copy MDX from review/{slug}.mdx → published/{slug}.mdx
 * 2. Copy MDX to content/v{n}/{slug}.mdx (versioned snapshot)
 * 3. Delete review/{slug}.mdx
 * 4. Update DynamoDB status → 'published', set publishedAt
 * 5. Fire ISR revalidation via POST /api/revalidate
 *
 * Reject flow:
 * 1. Copy MDX from review/{slug}.mdx → archived/{slug}.mdx
 * 2. Delete review/{slug}.mdx
 * 3. Update DynamoDB status → 'rejected', set rejectedAt
 */

import {
    S3Client,
    CopyObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Actions available to the admin for article review.
 */
export type PublishAction = 'approve' | 'reject';

/**
 * Input event from the admin dashboard.
 */
export interface PublishHandlerInput {
    /** Article slug to approve or reject */
    readonly slug: string;
    /** Pipeline execution ID for audit trail */
    readonly pipelineId?: string;
    /** Admin action: approve or reject */
    readonly action: PublishAction;
}

/**
 * Output response to the admin dashboard.
 */
export interface PublishHandlerOutput {
    /** Whether the operation succeeded */
    readonly success: boolean;
    /** Article slug processed */
    readonly slug: string;
    /** Action performed */
    readonly action: PublishAction;
    /** New article status */
    readonly status: string;
    /** Human-readable message */
    readonly message: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** S3 bucket for article content */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** DynamoDB table for article metadata */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? process.env.TABLE_NAME ?? '';

/** S3 prefixes */
const REVIEW_PREFIX = process.env.REVIEW_PREFIX ?? 'review/';
const PUBLISHED_PREFIX = process.env.PUBLISHED_PREFIX ?? 'published/';
const CONTENT_PREFIX = process.env.CONTENT_PREFIX ?? 'content/';
const ARCHIVED_PREFIX = process.env.ARCHIVED_PREFIX ?? 'archived/';

/** ISR revalidation endpoint (Next.js app) */
const ISR_ENDPOINT = process.env.ISR_ENDPOINT ?? '';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// =============================================================================
// CLIENTS
// =============================================================================

const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// S3 OPERATIONS
// =============================================================================

/**
 * Copy an S3 object from one key to another within the same bucket.
 *
 * @param bucket - S3 bucket name
 * @param sourceKey - Source object key
 * @param destKey - Destination object key
 */
async function copyS3Object(bucket: string, sourceKey: string, destKey: string): Promise<void> {
    console.log(`[publish] S3 copy: ${sourceKey} → ${destKey}`);
    await s3Client.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceKey}`,
        Key: destKey,
    }));
}

/**
 * Delete an S3 object.
 *
 * @param bucket - S3 bucket name
 * @param key - Object key to delete
 */
async function deleteS3Object(bucket: string, key: string): Promise<void> {
    console.log(`[publish] S3 delete: ${key}`);
    await s3Client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
}

// =============================================================================
// DYNAMODB OPERATIONS
// =============================================================================

/**
 * Update article status in DynamoDB.
 *
 * @param slug - Article slug
 * @param status - New status ('published' or 'rejected')
 * @param timestampField - DynamoDB field for the timestamp
 */
async function updateArticleStatus(
    slug: string,
    status: string,
    timestampField: string,
): Promise<void> {
    const now = new Date().toISOString();

    console.log(`[publish] DynamoDB update: ARTICLE#${slug} → status=${status}`);

    await ddbClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `ARTICLE#${slug}`,
            sk: 'METADATA',
        },
        UpdateExpression: `SET #status = :status, ${timestampField} = :ts, updatedAt = :ts, contentRef = :contentRef`,
        ExpressionAttributeNames: {
            '#status': 'status',
        },
        ExpressionAttributeValues: {
            ':status': status,
            ':ts': now,
            ':contentRef': `s3://${ASSETS_BUCKET}/${PUBLISHED_PREFIX}${slug}.mdx`,
        },
    }));
}

// =============================================================================
// ISR REVALIDATION
// =============================================================================

/**
 * Trigger ISR revalidation for the published article.
 *
 * Posts to the Next.js /api/revalidate endpoint to bust the cache
 * for the article page, making it immediately available.
 *
 * @param slug - Article slug to revalidate
 */
async function triggerIsrRevalidation(slug: string): Promise<void> {
    if (!ISR_ENDPOINT) {
        console.log('[publish] ISR revalidation skipped — no ISR_ENDPOINT configured');
        return;
    }

    const url = `${ISR_ENDPOINT}?path=/articles/${slug}`;
    console.log(`[publish] Triggering ISR revalidation: ${url}`);

    try {
        const response = await fetch(url, { method: 'POST' });
        console.log(`[publish] ISR response: ${response.status}`);
    } catch (error) {
        // ISR failure is non-fatal — the page will be regenerated on next request
        console.warn(`[publish] ISR revalidation failed (non-fatal): ${String(error)}`);
    }
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for article approval/rejection.
 *
 * Invoked by the Next.js admin dashboard via AWS SDK Lambda.invoke().
 *
 * @param event - Publish action event with slug and action
 * @returns Operation result for the admin dashboard
 */
export const handler = async (event: PublishHandlerInput): Promise<PublishHandlerOutput> => {
    const { slug, action, pipelineId } = event;

    console.log(`[publish] ${action.toUpperCase()} article "${slug}" (pipelineId: ${pipelineId ?? 'N/A'})`);

    const reviewKey = `${REVIEW_PREFIX}${slug}.mdx`;

    try {
        if (action === 'approve') {
            // Generate version number from timestamp
            const version = Date.now();
            const publishedKey = `${PUBLISHED_PREFIX}${slug}.mdx`;
            const contentKey = `${CONTENT_PREFIX}v${version}/${slug}.mdx`;

            // 1. Copy to published/ and content/v{n}/
            await Promise.all([
                copyS3Object(ASSETS_BUCKET, reviewKey, publishedKey),
                copyS3Object(ASSETS_BUCKET, reviewKey, contentKey),
            ]);

            // 2. Delete from review/
            await deleteS3Object(ASSETS_BUCKET, reviewKey);

            // 3. Update DynamoDB status
            await updateArticleStatus(slug, 'published', 'publishedAt');

            // 4. Trigger ISR revalidation
            await triggerIsrRevalidation(slug);

            // 5. Emit approval metric
            const emf = {
                _aws: {
                    Timestamp: Date.now(),
                    CloudWatchMetrics: [{
                        Namespace: 'BedrockMultiAgent',
                        Dimensions: [['Environment']],
                        Metrics: [{ Name: 'ArticlePublished', Unit: 'Count' }],
                    }],
                },
                Environment: ENVIRONMENT,
                Slug: slug,
                ArticlePublished: 1,
            };
            console.log(JSON.stringify(emf));

            return {
                success: true,
                slug,
                action,
                status: 'published',
                message: `Article "${slug}" published successfully`,
            };
        } else {
            // Reject flow
            const archivedKey = `${ARCHIVED_PREFIX}${slug}.mdx`;

            // 1. Copy to archived/
            await copyS3Object(ASSETS_BUCKET, reviewKey, archivedKey);

            // 2. Delete from review/
            await deleteS3Object(ASSETS_BUCKET, reviewKey);

            // 3. Update DynamoDB status
            await updateArticleStatus(slug, 'rejected', 'rejectedAt');

            // 4. Emit rejection metric
            const emf = {
                _aws: {
                    Timestamp: Date.now(),
                    CloudWatchMetrics: [{
                        Namespace: 'BedrockMultiAgent',
                        Dimensions: [['Environment']],
                        Metrics: [{ Name: 'ArticleRejected', Unit: 'Count' }],
                    }],
                },
                Environment: ENVIRONMENT,
                Slug: slug,
                ArticleRejected: 1,
            };
            console.log(JSON.stringify(emf));

            return {
                success: true,
                slug,
                action,
                status: 'rejected',
                message: `Article "${slug}" rejected and archived`,
            };
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[publish] Failed to ${action} article "${slug}": ${err.message}`);

        return {
            success: false,
            slug,
            action,
            status: 'error',
            message: `Failed to ${action} article: ${err.message}`,
        };
    }
};
