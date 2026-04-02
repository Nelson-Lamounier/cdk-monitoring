/**
 * @format
 * Resume Builder Handler — Step Functions Stage (Analysis Pipeline)
 *
 * Lambda handler invoked by Step Functions after the Strategist Agent.
 * Executes the Resume Builder Agent to produce a tailored resume,
 * then persists it to DynamoDB as a TAILORED_RESUME# record.
 *
 * Input:  { context, research, analysis }
 * Output: { context, research, analysis, tailoredResume }
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { executeResumeBuilderAgent } from '../agents/resume-builder-agent.js';
import type {
    AgentResult,
    ResumeBuilderHandlerInput,
    ResumeBuilderHandlerOutput,
    TailoredResumeResult,
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
 * Lambda handler for building and persisting the tailored resume.
 *
 * Writes:
 * 1. TAILORED_RESUME#<pipelineId> record with the full tailored StructuredResumeData
 * 2. Updated METADATA record with tailoredResumeAvailable flag
 *
 * @param event - Step Functions input with research and analysis results
 * @returns Updated pipeline output including tailored resume
 */
export const handler = async (
    event: ResumeBuilderHandlerInput,
): Promise<ResumeBuilderHandlerOutput> => {
    const { context, research, analysis } = event;
    const now = new Date().toISOString();

    // Guard: skip resume building if no resume data is available
    if (!context.resumeData) {
        console.warn(
            `[resume-builder] Pipeline ${context.pipelineId} — ` +
            `no resume data available, skipping resume building`,
        );

        return {
            context,
            research,
            analysis,
            tailoredResume: null,
        };
    }

    // Guard: skip if no suggestions to apply
    const suggestions = analysis.data.resumeSuggestions;
    const totalSuggestions =
        suggestions.additions.length +
        suggestions.reframes.length +
        suggestions.eslCorrections.length;

    if (totalSuggestions === 0) {
        console.log(
            `[resume-builder] Pipeline ${context.pipelineId} — ` +
            `no resume suggestions to apply, skipping`,
        );

        return {
            context,
            research,
            analysis,
            tailoredResume: null,
        };
    }

    console.log(
        `[resume-builder] Pipeline ${context.pipelineId} ` +
        `— building tailored resume for "${context.targetRole}"`,
    );

    // Execute the Resume Builder Agent
    const tailoredResumeResult: AgentResult<TailoredResumeResult> =
        await executeResumeBuilderAgent(
            context,
            context.resumeData,
            suggestions,
        );

    if (TABLE_NAME) {
        // 1. Store tailored resume — versioned by pipelineId
        console.log(
            `[resume-builder] Storing TAILORED_RESUME#${context.pipelineId}`,
        );
        await ddbClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: `TAILORED_RESUME#${context.pipelineId}`,
                tailoredResume: tailoredResumeResult.data.tailoredResume,
                changesSummary: tailoredResumeResult.data.changesSummary,
                additionsApplied: tailoredResumeResult.data.additionsApplied,
                reframesApplied: tailoredResumeResult.data.reframesApplied,
                eslCorrectionsApplied: tailoredResumeResult.data.eslCorrectionsApplied,
                createdAt: now,
                environment: context.environment,
            },
        }));

        // 2. Update METADATA with tailored resume availability flag
        console.log(
            `[resume-builder] Updating METADATA — tailoredResumeAvailable=true`,
        );
        await ddbClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `APPLICATION#${context.applicationSlug}`,
                sk: 'METADATA',
            },
            UpdateExpression: 'SET tailoredResumeAvailable = :available, updatedAt = :now',
            ExpressionAttributeValues: {
                ':available': true,
                ':now': now,
            },
        }));
    }

    console.log(
        `[resume-builder] Pipeline ${context.pipelineId} — tailored resume persisted ` +
        `(${tailoredResumeResult.data.changesSummary})`,
    );

    return {
        context,
        research,
        analysis,
        tailoredResume: tailoredResumeResult,
    };
};
