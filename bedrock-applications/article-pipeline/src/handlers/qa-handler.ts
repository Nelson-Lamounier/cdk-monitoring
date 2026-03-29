/**
 * @format
 * QA Handler — Step Functions Entry Point
 *
 * Lambda handler invoked by Step Functions as the third stage
 * in the multi-agent pipeline. Validates the Writer's output,
 * writes the article to the review/ S3 prefix, and persists
 * metadata to DynamoDB with the appropriate status.
 *
 * This is the terminal Step Functions state for content generation.
 * The Publish Handler is invoked separately by the admin dashboard.
 *
 * Input: { context: PipelineContext, research: ..., writer: ... }
 * Output: PipelineOutput with pass/fail verdict and article status
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { executeQaAgent, QA_PASS_THRESHOLD } from '../agents/qa-agent.js';
import type {
    ArticleStatus,
    PipelineOutput,
    QaHandlerInput,
} from '../../shared/src/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** S3 bucket for article content */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** DynamoDB table for article metadata */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? process.env.TABLE_NAME ?? '';

/** S3 prefix for articles awaiting review */
const REVIEW_PREFIX = process.env.REVIEW_PREFIX ?? 'review/';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// =============================================================================
// CLIENTS
// =============================================================================

const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// S3 + DYNAMODB PERSISTENCE
// =============================================================================

/**
 * Write the article MDX to the review/ S3 prefix.
 *
 * Articles are written here pending manual approval. The Publish Handler
 * later moves them to published/ when approved.
 *
 * @param bucket - S3 bucket name
 * @param slug - Article slug
 * @param content - Full MDX content
 */
async function writeToReviewPrefix(
    bucket: string,
    slug: string,
    content: string,
): Promise<void> {
    const key = `${REVIEW_PREFIX}${slug}.mdx`;
    console.log(`[qa-handler] Writing review content to s3://${bucket}/${key}`);

    await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: 'text/mdx',
    }));
}

/**
 * Write article metadata to DynamoDB with the appropriate status.
 *
 * Creates a METADATA record for the article with the pipeline-assigned
 * status and all generated metadata fields.
 *
 * @param tableName - DynamoDB table name
 * @param output - Complete pipeline output
 */
async function writeMetadataToDynamoDB(
    tableName: string,
    output: PipelineOutput,
): Promise<void> {
    const { writer, qa, context, articleStatus } = output;
    const now = new Date().toISOString();

    const item = {
        pk: `ARTICLE#${writer.data.metadata.slug}`,
        sk: 'METADATA',
        status: articleStatus,
        title: writer.data.metadata.title,
        description: writer.data.metadata.description,
        tags: writer.data.metadata.tags,
        slug: writer.data.metadata.slug,
        publishDate: writer.data.metadata.publishDate,
        readingTime: writer.data.metadata.readingTime,
        category: writer.data.metadata.category,
        aiSummary: writer.data.metadata.aiSummary,
        technicalConfidence: qa.data.confidenceOverride, // QA overrides Writer's score
        skillsDemonstrated: writer.data.metadata.skillsDemonstrated,
        processingNote: writer.data.metadata.processingNote,
        shotListCount: writer.data.shotList.length,
        contentRef: `s3://${ASSETS_BUCKET}/${REVIEW_PREFIX}${writer.data.metadata.slug}.mdx`,
        // Pipeline metadata
        pipelineId: context.pipelineId,
        pipelineRetryAttempt: context.retryAttempt,
        pipelineCostUsd: context.cumulativeCostUsd,
        pipelineTokens: context.cumulativeTokens,
        // QA metadata
        qaScore: qa.data.overallScore,
        qaRecommendation: qa.data.recommendation,
        qaSummary: qa.data.summary,
        qaDimensions: qa.data.dimensions,
        // Timestamps
        generatedAt: now,
        updatedAt: now,
        environment: ENVIRONMENT,
    };

    console.log(`[qa-handler] Writing DynamoDB METADATA — status=${articleStatus}, qaScore=${qa.data.overallScore}`);

    await ddbClient.send(new PutCommand({
        TableName: tableName,
        Item: item,
    }));
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for the QA Agent.
 *
 * Validates the Writer's output, determines the article status,
 * writes to S3 review prefix, and persists metadata to DynamoDB.
 *
 * @param event - Step Functions input with context, research, and writer results
 * @returns Complete pipeline output with pass/fail verdict
 */
export const handler = async (event: QaHandlerInput): Promise<PipelineOutput> => {
    console.log(
        `[qa-handler] Pipeline ${event.context.pipelineId} — ` +
        `slug: ${event.context.slug}, retryAttempt: ${event.context.retryAttempt}`,
    );

    // 1. Execute QA Agent
    const qa = await executeQaAgent(
        event.context,
        event.writer.data,
        event.research.data.technicalFacts,
        event.research.data.mode,
    );

    // 2. Determine article status
    const passed = qa.data.overallScore >= QA_PASS_THRESHOLD;
    const articleStatus: ArticleStatus = passed ? 'review' : 'flagged';

    console.log(
        `[qa-handler] QA verdict — score=${qa.data.overallScore}, ` +
        `threshold=${QA_PASS_THRESHOLD}, passed=${passed}, status=${articleStatus}`,
    );

    // 3. Build pipeline output
    const output: PipelineOutput = {
        context: event.context,
        research: event.research,
        writer: event.writer,
        qa,
        passed,
        articleStatus,
    };

    // 4. Write MDX to review/ S3 prefix
    await writeToReviewPrefix(ASSETS_BUCKET, event.writer.data.metadata.slug, event.writer.data.content);

    // 5. Write metadata to DynamoDB
    await writeMetadataToDynamoDB(TABLE_NAME, output);

    // 6. Emit pipeline-level EMF metrics
    const pipelineEmf = {
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
                {
                    Namespace: 'BedrockMultiAgent',
                    Dimensions: [['Environment']],
                    Metrics: [
                        { Name: 'PipelineCompleted', Unit: 'Count' },
                        { Name: 'PipelineCostUsd', Unit: 'None' },
                        { Name: 'PipelineQaScore', Unit: 'None' },
                        { Name: 'PipelineRetryCount', Unit: 'Count' },
                        { Name: 'PipelinePassed', Unit: 'Count' },
                    ],
                },
            ],
        },
        Environment: ENVIRONMENT,
        Slug: event.context.slug,
        PipelineCompleted: 1,
        PipelineCostUsd: event.context.cumulativeCostUsd,
        PipelineQaScore: qa.data.overallScore,
        PipelineRetryCount: event.context.retryAttempt,
        PipelinePassed: passed ? 1 : 0,
    };
    console.log(JSON.stringify(pipelineEmf));

    return output;
};
