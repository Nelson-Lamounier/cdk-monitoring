/**
 * @format
 * Analysis Persist Handler — Step Functions Terminal Stage (Analysis Pipeline)
 *
 * Lambda handler invoked by Step Functions as the final stage of the
 * analysis pipeline. Persists the Strategist Agent's full analysis to
 * DynamoDB and updates the application METADATA record.
 *
 * **S3 rehydration:** The Strategist Handler offloads the large
 * `analysisXml` to S3 to stay under the Step Functions 256KB payload
 * limit. This handler reads it back from S3 before persisting to DDB.
 *
 * Input:  { context, research, analysis }
 * Output: StrategistAnalysisPipelineOutput
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

import type {
    StrategistAnalysisPersistInput,
    StrategistAnalysisPipelineOutput,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** DynamoDB table for job application tracking */
const TABLE_NAME = process.env.TABLE_NAME ?? '';

/** S3 bucket for pipeline artefacts (shared assets bucket) */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

// =============================================================================
// CLIENTS
// =============================================================================

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Reads the analysisXml from S3 if it was offloaded by the Strategist Handler.
 * The Strategist Handler replaces the XML with an S3 URI sentinel: `s3://bucket/key`.
 *
 * @param analysisXml - Either the full XML string or an S3 URI sentinel
 * @returns The full XML string (rehydrated from S3 if needed)
 */
async function rehydrateAnalysisXml(analysisXml: string): Promise<string> {
    if (!analysisXml.startsWith('s3://')) {
        return analysisXml;
    }

    // Parse s3://bucket/key
    const uri = analysisXml.slice(5); // Remove 's3://'
    const slashIndex = uri.indexOf('/');
    const bucket = uri.slice(0, slashIndex);
    const key = uri.slice(slashIndex + 1);

    console.log(
        `[analysis-persist] Rehydrating analysisXml from S3: s3://${bucket}/${key}`,
    );

    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const xml = await response.Body?.transformToString('utf-8');

    if (!xml) {
        throw new Error(`Failed to read analysisXml from S3: s3://${bucket}/${key}`);
    }

    console.log(`[analysis-persist] Rehydrated analysisXml: ${(xml.length / 1024).toFixed(1)}KB`);
    return xml;
}

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

    // Rehydrate analysisXml from S3 if it was offloaded
    const analysisXml = await rehydrateAnalysisXml(analysis.data.analysisXml);

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
                analysisXml,
                coverLetter: analysis.data.coverLetter,
                analysisMetadata: analysis.data.metadata,
                research: research.data,
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

    // ─── Payload trimming ─────────────────────────────────────────
    // Even the terminal state output is subject to the 256KB limit.
    // All large data has already been written to DynamoDB above, so
    // we return only lightweight metadata for the execution output.
    // ──────────────────────────────────────────────────────────────

    const output: StrategistAnalysisPipelineOutput = {
        context,
        research: {
            ...research,
            data: {
                ...research.data,
                kbContext: '[persisted to DynamoDB]',
            },
        },
        analysis: {
            ...analysis,
            data: {
                ...analysis.data,
                analysisXml: '[persisted to DynamoDB]',
                coverLetter: analysis.data.coverLetter
                    ? '[persisted to DynamoDB]'
                    : null,
            },
        },
        applicationStatus: 'analysis-ready',
    };

    console.log(
        `[analysis-persist] Pipeline complete — ` +
        `fit="${analysis.data.metadata.overallFitRating}", ` +
        `cost=$${context.cumulativeCostUsd.toFixed(4)}`,
    );

    return output;
};
