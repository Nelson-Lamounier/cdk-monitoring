/**
 * @format
 * Strategist Research Agent — KB Retrieval, Resume Parsing & Gap Analysis
 *
 * First agent in the 3-agent strategist pipeline. Receives the raw
 * job description, queries the Pinecone Knowledge Base for portfolio
 * and project data, fetches the latest resume from DynamoDB, and
 * produces a structured research brief with verified/partial/gap
 * skill classification.
 *
 * Uses Haiku 3.5 for cost-efficient extraction and analysis.
 *
 * Pipeline position: API → **Research** → Strategist → Coach → DynamoDB
 */

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';
import { sanitiseInput } from '../security/input-sanitiser.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistResearchResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Research Agent model — Haiku 3.5 for cost-efficient extraction */
const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? 'eu.anthropic.claude-haiku-3-5-20241022-v1:0';

/** Maximum output tokens */
const RESEARCH_MAX_TOKENS = 8192;

/** Thinking budget for analysis tasks */
const RESEARCH_THINKING_BUDGET = 4096;

/** Knowledge Base ID for Pinecone retrieval */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/** Maximum KB passages to retrieve */
const MAX_KB_PASSAGES = 15;

/** DynamoDB table for resume data (AI content table) */
const CONTENT_TABLE_NAME = process.env.CONTENT_TABLE_NAME ?? '';

// =============================================================================
// CLIENTS
// =============================================================================

const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// KNOWLEDGE BASE RETRIEVAL
// =============================================================================

/**
 * Multi-query KB retrieval for comprehensive portfolio context.
 *
 * Performs multiple targeted queries to retrieve:
 * 1. Skill-specific project evidence
 * 2. General portfolio summary
 * 3. GitHub activity and contributions
 *
 * @param jobDescription - The full job description text
 * @returns Concatenated KB passages with source citations
 */
async function queryKnowledgeBase(jobDescription: string): Promise<string> {
    if (!KNOWLEDGE_BASE_ID) {
        console.log('[strategist-research] KB retrieval skipped — no KNOWLEDGE_BASE_ID configured');
        return '';
    }

    // Build multiple targeted queries for comprehensive retrieval
    const queries = [
        jobDescription.substring(0, 1000),  // Primary: job requirements matching
        'resume professional experience skills qualifications',  // Portfolio overview
        'project architecture technical implementation deployment', // Project evidence
    ];

    const allPassages: string[] = [];

    for (const query of queries) {
        console.log(`[strategist-research] Querying KB with: "${query.substring(0, 80)}..."`);

        const command = new RetrieveCommand({
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            retrievalQuery: { text: query },
            retrievalConfiguration: {
                vectorSearchConfiguration: {
                    numberOfResults: MAX_KB_PASSAGES,
                },
            },
        });

        const response = await bedrockAgentClient.send(command);
        const results = response.retrievalResults ?? [];

        for (const result of results) {
            if (result.content?.text) {
                const source = result.location?.s3Location?.uri ?? 'unknown';
                const score = result.score ?? 0;
                allPassages.push(
                    `[Source: ${source}, Score: ${score.toFixed(3)}]\n${result.content.text}`,
                );
            }
        }
    }

    // Deduplicate passages by content (same passage may appear in multiple queries)
    const unique = [...new Set(allPassages)];
    console.log(`[strategist-research] KB returned ${unique.length} unique passages`);

    return unique.join('\n\n---\n\n');
}

// =============================================================================
// RESUME RETRIEVAL (DynamoDB)
// =============================================================================

/**
 * Fetch the latest resume data from the AI content DynamoDB table.
 *
 * Queries for ARTICLE#resume / METADATA entries which contain the
 * most recently published resume content.
 *
 * @returns Resume text if found, empty string otherwise
 */
async function fetchResumeFromDynamoDB(): Promise<string> {
    if (!CONTENT_TABLE_NAME) {
        console.log('[strategist-research] Resume fetch skipped — no CONTENT_TABLE_NAME configured');
        return '';
    }

    console.log(`[strategist-research] Fetching resume from DynamoDB: ${CONTENT_TABLE_NAME}`);

    const response = await ddbClient.send(new QueryCommand({
        TableName: CONTENT_TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND sk = :sk',
        ExpressionAttributeValues: {
            ':pk': 'ARTICLE#resume',
            ':sk': 'METADATA',
        },
        Limit: 1,
    }));

    const items = response.Items ?? [];
    if (items.length === 0) {
        console.warn('[strategist-research] No resume record found in DynamoDB');
        return '';
    }

    // The resume content may be stored as aiSummary, content, or body
    const item = items[0];
    const resumeContent = (item['content'] as string)
        ?? (item['aiSummary'] as string)
        ?? (item['body'] as string)
        ?? '';

    console.log(`[strategist-research] Resume retrieved: ${resumeContent.length} chars`);
    return resumeContent;
}

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Research Agent.
 *
 * Assembles the job description, KB context, and resume data into
 * a structured prompt for analysis.
 *
 * @param jobDescription - Sanitised job description text
 * @param kbContext - Concatenated KB passages
 * @param resumeData - Resume text from DynamoDB
 * @returns Formatted user message
 */
function buildResearchMessage(
    jobDescription: string,
    kbContext: string,
    resumeData: string,
): string {
    const sections: string[] = [
        '## Job Description',
        '--- BEGIN JOB DESCRIPTION ---',
        jobDescription,
        '--- END JOB DESCRIPTION ---',
        '',
    ];

    if (resumeData) {
        sections.push(
            '## Current Resume',
            '--- BEGIN RESUME ---',
            resumeData,
            '--- END RESUME ---',
            '',
        );
    }

    if (kbContext) {
        sections.push(
            '## Knowledge Base — Portfolio & Project Evidence',
            'The following passages were retrieved from the candidate\'s portfolio documentation:',
            '',
            kbContext,
            '',
        );
    }

    sections.push('Analyse this job description against the candidate\'s evidence and return the JSON research brief.');

    return sections.join('\n');
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Strategist Research Agent.
 */
const RESEARCH_CONFIG: AgentConfig = {
    agentName: 'strategist-research',
    modelId: RESEARCH_MODEL,
    maxTokens: RESEARCH_MAX_TOKENS,
    thinkingBudget: RESEARCH_THINKING_BUDGET,
    systemPrompt: RESEARCH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Strategist Research Agent.
 *
 * 1. Sanitises the job description input
 * 2. Queries the Pinecone KB for portfolio evidence
 * 3. Fetches the latest resume from DynamoDB
 * 4. Runs Haiku 3.5 to produce a structured research brief
 *
 * @param ctx - Pipeline context with job description
 * @returns Research result with verified/partial/gap skill classification
 */
export async function executeResearchAgent(
    ctx: StrategistPipelineContext,
): Promise<AgentResult<StrategistResearchResult>> {
    // 1. Sanitise input
    console.log(`[strategist-research] Pipeline ${ctx.pipelineId} — analysing JD for "${ctx.targetRole}"`);
    const { sanitised, warnings, injectionDetected } = sanitiseInput(ctx.jobDescription);

    if (injectionDetected) {
        console.warn(`[strategist-research] Injection attempt detected — proceeding with sanitised input`);
    }
    for (const warning of warnings) {
        console.warn(`[strategist-research] ${warning}`);
    }

    // 2. Query Knowledge Base (parallel with resume fetch)
    const [kbContext, resumeData] = await Promise.all([
        queryKnowledgeBase(sanitised),
        fetchResumeFromDynamoDB(),
    ]);

    // 3. Build user message
    const userMessage = buildResearchMessage(sanitised, kbContext, resumeData);

    // 4. Run agent
    const result = await runAgent<StrategistResearchResult>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            const parsed = parseJsonResponse<StrategistResearchResult>(text, 'strategist-research');

            // Ensure arrays are always arrays (defensive against LLM output)
            return {
                ...parsed,
                hardRequirements: Array.isArray(parsed.hardRequirements) ? parsed.hardRequirements : [],
                softRequirements: Array.isArray(parsed.softRequirements) ? parsed.softRequirements : [],
                implicitRequirements: Array.isArray(parsed.implicitRequirements) ? parsed.implicitRequirements : [],
                verifiedMatches: Array.isArray(parsed.verifiedMatches) ? parsed.verifiedMatches : [],
                partialMatches: Array.isArray(parsed.partialMatches) ? parsed.partialMatches : [],
                gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
                resumeData,
                kbContext,
            };
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            slug: ctx.applicationSlug,
            sourceKey: '',
            bucket: ctx.bucket,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
            retryAttempt: 0,
            startedAt: ctx.startedAt,
        },
    });

    console.log(
        `[strategist-research] Brief generated — fit="${result.data.overallFitRating}", ` +
        `verified=${result.data.verifiedMatches.length}, ` +
        `partial=${result.data.partialMatches.length}, ` +
        `gaps=${result.data.gaps.length}`,
    );

    return result;
}
