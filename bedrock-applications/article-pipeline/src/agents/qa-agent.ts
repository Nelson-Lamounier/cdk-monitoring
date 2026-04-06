/**
 * @format
 * QA Agent — Combined Quality Assurance & Technical Accuracy
 *
 * Third and final agent in the lean 3-agent pipeline. Performs an
 * independent quality review of the Writer Agent's output across
 * 5 quality dimensions with an expanded scope:
 *
 * 1. Technical Accuracy (40%) — code, commands, AWS references
 * 2. SEO Compliance (15%) — meta description, headings, slug
 * 3. MDX Structure (15%) — frontmatter, components, Mermaid
 * 4. Metadata Quality (15%) — reading time, tags, confidence
 * 5. Content Quality (15%) — British English, narrative flow, voice
 *
 * Upgraded from Phase 1:
 * - Now uses Sonnet 4.6 (was Haiku) for deeper technical validation
 * - Uses the AgentRunner generic wrapper for consistent EMF metrics
 * - Expanded score semantics for pipeline-level gating
 *
 * Pipeline position: Research → Writer → **QA** → Review/Flagged
 */

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { QA_PERSONA_SYSTEM_PROMPT } from '../prompts/qa-persona.js';
import type {
    AgentConfig,
    AgentResult,
    DimensionResult,
    PipelineContext,
    QaIssue,
    QaRecommendation,
    QaValidationResult,
    WriterResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * QA Agent model — upgraded to Sonnet 4.6 for deeper validation.
 *
 * Phase 1 used Haiku 3.5 for cost savings. Phase 2 upgrades to
 * Sonnet because the QA agent now handles technical accuracy
 * validation (code snippet checking, claim verification) which
 * benefits from stronger reasoning.
 */
const QA_MODEL = process.env.QA_MODEL ?? 'eu.anthropic.claude-sonnet-4-6-20260310-v1:0';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? QA_MODEL;

/** Maximum output tokens for QA response (structured JSON with dimension scores and issues) */
const QA_MAX_TOKENS = 16384;

/** Thinking budget for QA agent — moderate for evaluation + tech accuracy */
const QA_THINKING_BUDGET = 8192;

/** QA pass threshold — articles scoring below this are retried or flagged */
export const QA_PASS_THRESHOLD = 80;

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for QA validation.
 *
 * Provides the QA agent with the full article content, metadata,
 * and the Research Agent's technical facts for cross-referencing.
 *
 * @param writer - Writer result with MDX content and metadata
 * @param technicalFacts - Facts extracted by the Research Agent
 * @param mode - Pipeline mode for context
 * @returns Formatted user message
 */
function buildQaMessage(
    writer: WriterResult,
    technicalFacts: string[],
    mode: string,
): string {
    const baseParts = [
        `Review the following blog article produced by an AI Writer agent.`,
        ``,
        `## Article Metadata (Writer Agent Output)`,
        `- Title: ${writer.metadata.title}`,
        `- Slug: ${writer.metadata.slug}`,
        `- Tags: ${writer.metadata.tags.join(', ')}`,
        `- Reading Time: ${writer.metadata.readingTime} minutes`,
        `- Description: ${writer.metadata.description}`,
        `- AI Summary: ${writer.metadata.aiSummary}`,
        `- Writer's Self-Rated Confidence: ${writer.metadata.technicalConfidence}/100`,
        `- Category: ${writer.metadata.category}`,
        `- Skills Demonstrated: ${writer.metadata.skillsDemonstrated.join(', ')}`,
        `- Generation Mode: ${mode}`,
        `- Shot List Count: ${writer.shotList.length}`,
    ];

    const techParts = technicalFacts.length > 0
        ? [
              ``,
              `## Technical Facts from Research Agent`,
              `Cross-reference the article content against these verified facts:`,
              ...technicalFacts.map(f => `- ${f}`),
          ]
        : [];

    const footerParts = [
        ``,
        `## Full Article Content`,
        ``,
        `--- BEGIN ARTICLE ---`,
        writer.content,
        `--- END ARTICLE ---`,
        ``,
        `Perform your quality review and return the JSON result object.`
    ];

    return [...baseParts, ...techParts, ...footerParts].join('\n');
}

// =============================================================================
// RESPONSE PARSER
// =============================================================================

/**
 * Clamp a value to the 0–100 range.
 *
 * @param val - Value to clamp
 * @returns Clamped number between 0 and 100
 */
function clampScore(val: unknown): number {
    const n = typeof val === 'number' ? val : 0;
    return Math.max(0, Math.min(100, n));
}

/**
 * Parse a dimension result from the QA response.
 *
 * @param raw - Raw dimension object from the parsed JSON
 * @returns Validated DimensionResult
 */
function parseDimension(raw: Record<string, unknown> | undefined): DimensionResult {
    return {
        score: clampScore(raw?.score),
        issues: Array.isArray(raw?.issues)
            ? (raw.issues as QaIssue[])
            : [],
    };
}

/**
 * Parse the QA Agent's JSON response into a typed result.
 *
 * @param responseText - Raw text response from Bedrock
 * @returns Validated QA result
 * @throws Error if required fields are missing or invalid
 */
function parseQaResponse(responseText: string): QaValidationResult {
    const parsed = parseJsonResponse<Record<string, unknown>>(responseText, 'qa');

    // Validate required fields
    if (typeof parsed.overallScore !== 'number') {
        throw new TypeError('QA Agent: Missing or invalid overallScore in response');
    }
    if (!['publish', 'revise', 'reject'].includes(parsed.recommendation as string)) {
        throw new TypeError(`QA Agent: Invalid recommendation "${String(parsed.recommendation)}"`);
    }
    if (typeof parsed.confidenceOverride !== 'number') {
        throw new TypeError('QA Agent: Missing or invalid confidenceOverride in response');
    }

    const dimensions = parsed.dimensions as Record<string, Record<string, unknown>> | undefined;

    return {
        overallScore: clampScore(parsed.overallScore),
        recommendation: parsed.recommendation as QaRecommendation,
        dimensions: {
            technicalAccuracy: parseDimension(dimensions?.technicalAccuracy),
            seoCompliance: parseDimension(dimensions?.seoCompliance),
            mdxStructure: parseDimension(dimensions?.mdxStructure),
            metadataQuality: parseDimension(dimensions?.metadataQuality),
            contentQuality: parseDimension(dimensions?.contentQuality),
        },
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.',
        confidenceOverride: clampScore(parsed.confidenceOverride),
    };
}

// =============================================================================
// QA AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the QA Agent.
 */
const QA_CONFIG: AgentConfig = {
    agentName: 'qa',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: QA_MAX_TOKENS,
    thinkingBudget: QA_THINKING_BUDGET,
    systemPrompt: QA_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the QA Agent.
 *
 * Performs independent quality validation of the Writer's output.
 * Returns a structured result with scores across 5 dimensions
 * and a publish/revise/reject recommendation.
 *
 * @param ctx - Pipeline context
 * @param writer - Writer result to validate
 * @param technicalFacts - Facts from Research Agent for cross-referencing
 * @param mode - Pipeline mode for context
 * @returns QA validation result with scores, issues, and recommendation
 */
export async function executeQaAgent(
    ctx: PipelineContext,
    writer: WriterResult,
    technicalFacts: string[],
    mode: string,
): Promise<AgentResult<QaValidationResult>> {
    const userMessage = buildQaMessage(writer, technicalFacts, mode);

    console.log(
        `[qa] Validating article "${writer.metadata.slug}" — ` +
        `contentLength=${writer.content.length} chars, ` +
        `writerConfidence=${writer.metadata.technicalConfidence}`,
    );

    const result = await runAgent<QaValidationResult>({
        config: QA_CONFIG,
        userMessage,
        parseResponse: parseQaResponse,
        pipelineContext: ctx,
    });

    // Count issues
    const totalIssues = Object.values(result.data.dimensions)
        .reduce((sum, dim) => sum + dim.issues.length, 0);
    const errorCount = Object.values(result.data.dimensions)
        .reduce((sum, dim) => sum + dim.issues.filter((i) => i.severity === 'error').length, 0);

    console.log(
        `[qa] Review complete — score=${result.data.overallScore}, ` +
        `recommendation=${result.data.recommendation}, ` +
        `confidenceOverride=${result.data.confidenceOverride} ` +
        `(writer rated: ${writer.metadata.technicalConfidence}), ` +
        `issues=${totalIssues} (${errorCount} errors), ` +
        `passed=${result.data.overallScore >= QA_PASS_THRESHOLD}`,
    );

    return result;
}
