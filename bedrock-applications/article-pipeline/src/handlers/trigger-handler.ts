/**
 * @format
 * Trigger Handler — S3 Event → Step Functions Execution
 *
 * Lambda handler triggered by S3 event notifications when a new
 * draft is uploaded to the drafts/ prefix. Creates a PipelineContext,
 * writes an initial "processing" VERSION record to DynamoDB so the
 * frontend can track progress, and starts a Step Functions execution.
 *
 * Versioning: Each pipeline run creates a VERSION#v<n> record.
 * The METADATA record is only updated on admin approval (publish-handler).
 * This ensures the published state is preserved during regeneration.
 */

import type { S3Event, S3Handler } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

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
// VERSION RESOLUTION
// =============================================================================

/**
 * Determine the next version number for a given article slug.
 *
 * Queries DynamoDB for the highest existing VERSION# sort key under
 * the article partition and returns the next auto-increment integer.
 *
 * @param slug - Article slug (partition key suffix)
 * @returns Next version number (1-based)
 */
async function resolveNextVersion(slug: string): Promise<number> {
    if (!TABLE_NAME) {
        console.warn('[trigger] TABLE_NAME not set — defaulting to version 1');
        return 1;
    }

    const result = await ddbClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
            ':pk': `ARTICLE#${slug}`,
            ':skPrefix': 'VERSION#',
        },
        ProjectionExpression: 'sk',
        ScanIndexForward: false, // descending — highest version first
        Limit: 1,
    }));

    if (result.Items && result.Items.length > 0) {
        const latestSk = result.Items[0].sk as string;
        // sk format: VERSION#v<n> — extract the integer
        const versionRegex = /^VERSION#v(\d+)$/;
        const versionMatch = versionRegex.exec(latestSk);
        if (versionMatch) {
            const latestVersion = Number.parseInt(versionMatch[1], 10);
            console.log(`[trigger] Latest version for "${slug}": v${latestVersion} → next: v${latestVersion + 1}`);
            return latestVersion + 1;
        }
    }

    console.log(`[trigger] No existing versions for "${slug}" — starting at v1`);
    return 1;
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for S3 event → Step Functions trigger.
 *
 * Receives S3 event notifications for new drafts, extracts the
 * slug from the object key, resolves the next version number,
 * builds a PipelineContext, writes an initial VERSION#v<n> record
 * to DynamoDB, and starts a Step Functions execution.
 *
 * @param event - S3 event notification
 */
export const handler: S3Handler = async (event: S3Event): Promise<void> => {
    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replaceAll('+', ' '));

        // Extract slug from key: drafts/my-article.md → my-article
        const slugRegex = /^drafts\/(.+)\.md$/;
        const slugMatch = slugRegex.exec(key);
        if (!slugMatch) {
            console.warn(`[trigger] Ignoring non-draft key: ${key}`);
            continue;
        }
        const slug = slugMatch[1];
        const now = new Date().toISOString();
        const datePrefix = now.slice(0, 10); // YYYY-MM-DD

        console.log(`[trigger] New draft detected — slug="${slug}", key="${key}"`);

        // =================================================================
        // Resolve next version number
        // =================================================================
        const version = await resolveNextVersion(slug);

        // Build pipeline context (now includes version)
        const executionName = `${slug}-${Date.now()}`;

        const pipelineContext: PipelineContext = {
            pipelineId: executionName,
            slug,
            sourceKey: key,
            bucket: bucket || ASSETS_BUCKET,
            environment: ENVIRONMENT,
            version,
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
        // Write initial VERSION#v<n> "processing" record to DynamoDB
        //
        // This allows the frontend admin dashboard to immediately show
        // the version as "processing" while the pipeline runs.
        // The QA handler will update this VERSION record on completion.
        // The METADATA record is NOT touched — it preserves the currently
        // published state (if any) until admin approval.
        // =================================================================
        if (TABLE_NAME) {
            const versionSk = `VERSION#v${version}`;
            console.log(`[trigger] Writing processing record: ARTICLE#${slug} / ${versionSk}`);
            await ddbClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    pk: `ARTICLE#${slug}`,
                    sk: versionSk,
                    version,
                    status: 'processing',
                    pipelineId: executionName,
                    slug,
                    sourceKey: key,
                    createdAt: now,
                    updatedAt: now,
                    environment: ENVIRONMENT,
                    // GSI1 — STATUS#processing index for dashboard queries
                    gsi1pk: 'STATUS#processing',
                    gsi1sk: `${datePrefix}#${slug}#v${version}`,
                },
            }));
        } else {
            console.warn('[trigger] TABLE_NAME not set — skipping DynamoDB write');
        }

        // =================================================================
        // Start Step Functions execution
        // =================================================================
        console.log(`[trigger] Starting execution: ${executionName} (version: v${version})`);

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
            `slug="${slug}", version=v${version}`,
        );
    }
};
