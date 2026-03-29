/**
 * @format
 * Trigger Handler — S3 Event → Step Functions Execution
 *
 * Lambda handler triggered by S3 event notifications when a new
 * draft is uploaded to the drafts/ prefix. Creates a PipelineContext
 * and starts a Step Functions execution.
 *
 * This replaces the direct S3 → monolithic Lambda trigger with
 * S3 → Trigger Lambda → Step Functions → 3 Agent Lambdas.
 */

import type { S3Event, S3Handler } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

import type { PipelineContext, ResearchHandlerInput } from '../../shared/src/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Step Functions state machine ARN */
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

/** S3 bucket name (from event, but validated against env) */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// =============================================================================
// CLIENT
// =============================================================================

const sfnClient = new SFNClient({});

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for S3 event → Step Functions trigger.
 *
 * Receives S3 event notifications for new drafts, extracts the
 * slug from the object key, builds a PipelineContext, and starts
 * a Step Functions execution.
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

        console.log(`[trigger] New draft detected — slug="${slug}", key="${key}"`);

        // Build pipeline context
        const pipelineContext: PipelineContext = {
            pipelineId: '', // Will be set to execution ARN
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
            startedAt: new Date().toISOString(),
        };

        // Build Step Functions input
        const sfnInput: ResearchHandlerInput = {
            context: pipelineContext,
        };

        // Start Step Functions execution
        const executionName = `${slug}-${Date.now()}`;
        console.log(`[trigger] Starting execution: ${executionName}`);

        const result = await sfnClient.send(new StartExecutionCommand({
            stateMachineArn: STATE_MACHINE_ARN,
            name: executionName,
            input: JSON.stringify(sfnInput),
        }));

        // Update pipelineId with the actual execution ARN
        console.log(
            `[trigger] Execution started — arn=${result.executionArn ?? 'unknown'}, ` +
            `slug="${slug}"`,
        );
    }
};
