/**
 * @format
 * Trigger Handler — S3 Event → Step Functions Execution
 *
 * Lambda handler triggered by S3 event notifications when a new
 * draft is uploaded to the drafts/ prefix. Creates a PipelineContext,
 * writes an initial "processing" record to DynamoDB so the frontend
 * can track progress, and starts a Step Functions execution.
 *
 * This replaces the direct S3 → monolithic Lambda trigger with
 * S3 → Trigger Lambda → Step Functions → 3 Agent Lambdas.
 */

import type { S3Event, S3Handler } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import type { PipelineContext, ResearchHandlerInput } from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Step Functions state machine ARN */
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

/** S3 bucket name (from event, but validated against env) */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** DynamoDB table for article metadata */
const TABLE_NAME = process.env.PIPELINE_TABLE_NAME ?? '';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// =============================================================================
// CLIENTS
// =============================================================================

const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for S3 event → Step Functions trigger.
 *
 * Receives S3 event notifications for new drafts, extracts the
 * slug from the object key, builds a PipelineContext, writes an
 * initial "processing" record to DynamoDB, and starts a Step
 * Functions execution.
 *
 * @param event - S3 event notification
 */
export const handler: S3Handler = async (event: S3Event): Promise<void> => {
    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

        // Extract slug from key: drafts/my-article.md → my-article
        const slugMatch = key.match(/^drafts\/(.+)\.md$/);
        if (!slugMatch) {
            console.warn(`[trigger] Ignoring non-draft key: ${key}`);
            continue;
        }
        const slug = slugMatch[1];
        const now = new Date().toISOString();
        const datePrefix = now.slice(0, 10); // YYYY-MM-DD

        console.log(`[trigger] New draft detected — slug="${slug}", key="${key}"`);

        // Build pipeline context
        const executionName = `${slug}-${Date.now()}`;

        const pipelineContext: PipelineContext = {
            pipelineId: executionName,
            slug,
            sourceKey: key,
            bucket: bucket || ASSETS_BUCKET,
            environment: ENVIRONMENT,
            cumulativeTokens: {
                input: 0,
                output: 0,
                thinking: 0,
            },
            cumulativeCostUsd: 0,
            retryAttempt: 0,
            startedAt: now,
        };

        // =================================================================
        // Write initial "processing" record to DynamoDB
        //
        // This allows the frontend admin dashboard to immediately show
        // the article as "processing" while the pipeline runs.
        // The QA handler will update this record to "review" on completion.
        // =================================================================
        if (TABLE_NAME) {
            console.log(`[trigger] Writing processing record: ARTICLE#${slug}`);
            await ddbClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    pk: `ARTICLE#${slug}`,
                    sk: 'METADATA',
                    status: 'processing',
                    pipelineId: executionName,
                    slug,
                    sourceKey: key,
                    startedAt: now,
                    updatedAt: now,
                    environment: ENVIRONMENT,
                    // GSI1 — STATUS#processing index for dashboard queries
                    gsi1pk: 'STATUS#processing',
                    gsi1sk: `${datePrefix}#${slug}`,
                },
                // Only write if no existing record OR if existing status is not "published"
                // This prevents overwriting a published article if the draft is re-uploaded
                ConditionExpression: 'attribute_not_exists(pk) OR #status <> :published',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':published': 'published' },
            }));
        } else {
            console.warn('[trigger] TABLE_NAME not set — skipping DynamoDB write');
        }

        // =================================================================
        // Start Step Functions execution
        // =================================================================
        console.log(`[trigger] Starting execution: ${executionName}`);

        // Build Step Functions input
        const sfnInput: ResearchHandlerInput = {
            context: pipelineContext,
        };

        const result = await sfnClient.send(new StartExecutionCommand({
            stateMachineArn: STATE_MACHINE_ARN,
            name: executionName,
            input: JSON.stringify(sfnInput),
        }));

        console.log(
            `[trigger] Execution started — arn=${result.executionArn ?? 'unknown'}, ` +
            `slug="${slug}"`,
        );
    }
};
