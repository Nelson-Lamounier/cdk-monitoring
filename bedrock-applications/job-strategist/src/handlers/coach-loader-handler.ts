/**
 * @format
 * Coach Loader Handler — Step Functions Entry Stage (Coaching Pipeline)
 *
 * Lambda handler invoked by Step Functions as the first stage of the
 * coaching pipeline. Loads the latest ANALYSIS# record from DynamoDB
 * so the Coach Agent can use it for stage-specific interview preparation.
 *
 * Input:  { context: StrategistPipelineContext }
 * Output: { context, analysis }
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import type {
    StrategistCoachLoaderInput,
    StrategistCoachHandlerInput,
    StrategistAnalysisResult,
    AgentResult,
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
 * Lambda handler for loading existing analysis from DynamoDB.
 *
 * Queries APPLICATION#<slug> for the latest ANALYSIS# sort key
 * (newest first by pipeline execution ID timestamp) and reconstructs
 * the StrategistAnalysisResult for the Coach Agent.
 *
 * @param event - Step Functions input with pipeline context
 * @returns Context plus the loaded analysis, ready for the Coach Handler
 * @throws Error if no analysis exists for the given application slug
 */
export const handler = async (
    event: StrategistCoachLoaderInput,
): Promise<StrategistCoachHandlerInput> => {
    const { context } = event;

    console.log(
        `[coach-loader] Pipeline ${context.pipelineId} ` +
        `— loading analysis for APPLICATION#${context.applicationSlug}`,
    );

    if (!TABLE_NAME) {
        throw new Error('[coach-loader] TABLE_NAME environment variable is not set');
    }

    // Query for the latest ANALYSIS# record (newest first)
    const result = await ddbClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
            ':pk': `APPLICATION#${context.applicationSlug}`,
            ':prefix': 'ANALYSIS#',
        },
        ScanIndexForward: false,  // Newest first (lexicographic — timestamp-based IDs)
        Limit: 1,
    }));

    if (!result.Items?.length) {
        throw new Error(
            `[coach-loader] No analysis found for APPLICATION#${context.applicationSlug}. ` +
            'Run the "analyse" pipeline first before requesting coaching.',
        );
    }

    const record = result.Items[0];

    console.log(
        `[coach-loader] Loaded analysis: sk="${record['sk']}", ` +
        `fit="${(record['metadata'] as Record<string, unknown>)?.['overallFitRating'] ?? 'unknown'}"`,
    );

    // Reconstruct the AgentResult<StrategistAnalysisResult>
    const analysis: AgentResult<StrategistAnalysisResult> = {
        data: {
            analysisXml: record['analysisXml'] as string,
            metadata: record['metadata'] as StrategistAnalysisResult['metadata'],
            coverLetter: record['coverLetter'] as string,
            resumeSuggestions: record['resumeSuggestions'] as StrategistAnalysisResult['resumeSuggestions'],
            resumeAdditions: (record['resumeAdditions'] as number) ?? 0,
            resumeReframes: (record['resumeReframes'] as number) ?? 0,
            eslCorrections: (record['eslCorrections'] as number) ?? 0,
        },
        tokenUsage: { input: 0, output: 0, thinking: 0 },
        estimatedCostUsd: 0,
    };

    return {
        context,
        analysis,
    };
};
