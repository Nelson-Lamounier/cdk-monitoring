/**
 * @format
 * Analysis Persist Handler — Step Functions Terminal Stage (Analysis Pipeline)
 *
 * Lambda handler invoked by Step Functions as the final stage of the
 * analysis pipeline. Persists the Strategist Agent's full analysis to
 * DynamoDB and updates the application METADATA record.
 *
 * Input:  { context, research, analysis }
 * Output: StrategistAnalysisPipelineOutput
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import type {
    StrategistAnalysisPersistInput,
    StrategistAnalysisPipelineOutput,
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
 * Lambda handler for persisting analysis results.
 *
 * Writes:
 * 1. Updated METADATA record with status='analysis-ready' and fit rating
 * 2. ANALYSIS#<pipelineId> record with full XML, suggestions, and cover letter
 *
 * @param event - Step Functions input with research and analysis results
 * @returns Analysis pipeline output with final status
 */
export const handler = async (
    event: StrategistAnalysisPersistInput,
): Promise<StrategistAnalysisPipelineOutput> => {
    const { context, research, analysis } = event;
    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);

    console.log(
        `[analysis-persist] Pipeline ${context.pipelineId} ` +
        `— persisting analysis for "${context.targetRole}"`,
    );

    if (TABLE_NAME) {
        // 1. Update METADATA record
        console.log(`[analysis-persist] Updating APPLICATION#${context.applicationSlug} METADATA`);
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

        // 2. Store full analysis — versioned by pipelineId
        console.log(`[analysis-persist] Storing ANALYSIS#${context.pipelineId}`);
        await ddbClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: `ANALYSIS#${context.pipelineId}`,
                analysisXml: analysis.data.analysisXml,
                coverLetter: analysis.data.coverLetter,
                metadata: analysis.data.metadata,
                resumeSuggestions: analysis.data.resumeSuggestions,
                // Deprecated counts — kept for backward compatibility
                resumeAdditions: analysis.data.resumeAdditions,
                resumeReframes: analysis.data.resumeReframes,
                eslCorrections: analysis.data.eslCorrections,
                createdAt: now,
                environment: context.environment,
            },
        }));
    }

    const output: StrategistAnalysisPipelineOutput = {
        context,
        research,
        analysis,
        applicationStatus: 'analysis-ready',
    };

    console.log(
        `[analysis-persist] Pipeline complete — ` +
        `fit="${analysis.data.metadata.overallFitRating}", ` +
        `cost=$${context.cumulativeCostUsd.toFixed(4)}`,
    );

    return output;
};
