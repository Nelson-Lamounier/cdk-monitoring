/**
 * @format
 * Coach Handler — Step Functions Terminal Stage (Coaching Pipeline)
 *
 * Lambda handler invoked by Step Functions as the final stage of the
 * coaching pipeline. Receives the loaded analysis, executes the
 * Interview Coach Agent, and persists coaching results to DynamoDB.
 *
 * Input:  { context, analysis }
 * Output: StrategistCoachPipelineOutput
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { executeCoachAgent } from '../agents/coach-agent.js';
import type {
    StrategistCoachHandlerInput,
    StrategistCoachPipelineOutput,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** DynamoDB table for job application tracking */
const TABLE_NAME = process.env.TABLE_NAME ?? '';

// =============================================================================
// CLIENTS
// =============================================================================

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for the Interview Coach Agent.
 *
 * Executes coaching preparation and persists:
 * 1. Updated METADATA record with status='interviewing' and new stage
 * 2. INTERVIEW#<stage> record with coaching data
 *
 * @param event - Step Functions input with analysis (loaded from DDB or piped)
 * @returns Coaching pipeline output with final status
 */
export const handler = async (
    event: StrategistCoachHandlerInput,
): Promise<StrategistCoachPipelineOutput> => {
    const { context, analysis } = event;
    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);

    console.log(
        `[strategist-coach-handler] Pipeline ${context.pipelineId} ` +
        `— coaching for "${context.interviewStage}" stage`,
    );

    // Execute coach agent
    const coaching = await executeCoachAgent(context, analysis.data);

    // Persist to DynamoDB
    if (TABLE_NAME) {
        // 1. Update METADATA record — advance stage and status
        console.log(`[strategist-coach-handler] Updating APPLICATION#${context.applicationSlug} METADATA`);
        await ddbClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: 'METADATA',
            },
            UpdateExpression: `SET #status = :status, interviewStage = :stage,
                updatedAt = :now, pipelineId = :pipelineId,
                gsi1pk = :gsi1pk, gsi1sk = :gsi1sk,
                totalCostUsd = totalCostUsd + :cost,
                totalCoachingTokens = :tokens`,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':status': 'interviewing',
                ':stage': context.interviewStage,
                ':now': now,
                ':pipelineId': context.pipelineId,
                ':gsi1pk': 'APP_STATUS#interviewing',
                ':gsi1sk': `${datePrefix}#${context.applicationSlug}`,
                ':cost': context.cumulativeCostUsd,
                ':tokens': context.cumulativeTokens,
            },
        }));

        // 2. Store interview coaching data for this specific stage
        console.log(`[strategist-coach-handler] Storing INTERVIEW#${context.interviewStage}`);
        await ddbClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: `INTERVIEW#${context.interviewStage}`,
                interviewPrep: JSON.stringify(coaching.data),
                stage: coaching.data.stage,
                stageDescription: coaching.data.stageDescription,
                technicalQuestionCount: coaching.data.technicalQuestions.length,
                behaviouralQuestionCount: coaching.data.behaviouralQuestions.length,
                createdAt: now,
                environment: context.environment,
            },
        }));
    }

    const output: StrategistCoachPipelineOutput = {
        context,
        coaching,
        applicationStatus: 'interviewing',
    };

    console.log(
        `[strategist-coach-handler] Coaching complete — ` +
        `stage="${context.interviewStage}", ` +
        `technical=${coaching.data.technicalQuestions.length}, ` +
        `cost=$${context.cumulativeCostUsd.toFixed(4)}`,
    );

    return output;
};
