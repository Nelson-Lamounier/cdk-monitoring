/**
 * @format
 * Coach Handler — Step Functions Terminal Stage
 *
 * Lambda handler invoked by Step Functions as the final stage.
 * Receives the full analysis, executes the Interview Coach Agent,
 * persists results to DynamoDB, and returns the pipeline output.
 *
 * Input: { context, research, analysis }
 * Output: StrategistPipelineOutput
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { executeCoachAgent } from '../agents/coach-agent.js';
import type {
    StrategistCoachHandlerInput,
    StrategistPipelineOutput,
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
 * Executes coaching preparation, persists:
 * 1. Updated METADATA record with status and fit rating
 * 2. ANALYSIS#<pipelineId> record with full XML
 * 3. INTERVIEW#<stage> record with coaching data
 *
 * @param event - Step Functions input with research and analysis
 * @returns Complete pipeline output
 */
export const handler = async (
    event: StrategistCoachHandlerInput,
): Promise<StrategistPipelineOutput> => {
    const { context, research, analysis } = event;
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
        // 1. Update METADATA record
        console.log(`[strategist-coach-handler] Updating APPLICATION#${context.applicationSlug} METADATA`);
        await ddbClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: 'METADATA',
            },
            UpdateExpression: `SET #status = :status, fitRating = :fitRating, 
                recommendation = :recommendation, updatedAt = :now,
                pipelineId = :pipelineId, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk,
                totalCostUsd = :cost, totalTokens = :tokens`,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':status': 'analysis-ready',
                ':fitRating': analysis.data.metadata.overallFitRating,
                ':recommendation': analysis.data.metadata.applicationRecommendation,
                ':now': now,
                ':pipelineId': context.pipelineId,
                ':gsi1pk': 'APP_STATUS#analysis-ready',
                ':gsi1sk': `${datePrefix}#${context.applicationSlug}`,
                ':cost': context.cumulativeCostUsd,
                ':tokens': context.cumulativeTokens,
            },
        }));

        // 2. Store full analysis XML
        console.log(`[strategist-coach-handler] Storing ANALYSIS#${context.pipelineId}`);
        await ddbClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: `ANALYSIS#${context.pipelineId}`,
                analysisXml: analysis.data.analysisXml,
                coverLetter: analysis.data.coverLetter,
                metadata: analysis.data.metadata,
                resumeAdditions: analysis.data.resumeAdditions,
                resumeReframes: analysis.data.resumeReframes,
                eslCorrections: analysis.data.eslCorrections,
                createdAt: now,
                environment: context.environment,
            },
        }));

        // 3. Store interview coaching data
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

    const output: StrategistPipelineOutput = {
        context,
        research,
        analysis,
        coaching,
        applicationStatus: 'analysis-ready',
    };

    console.log(
        `[strategist-coach-handler] Pipeline complete — ` +
        `fit="${analysis.data.metadata.overallFitRating}", ` +
        `cost=$${context.cumulativeCostUsd.toFixed(4)}`,
    );

    return output;
};
