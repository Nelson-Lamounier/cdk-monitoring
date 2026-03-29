/**
 * @format
 * Writer Agent — Full MDX Article Generation
 *
 * Second agent in the lean 3-agent pipeline. Takes the structured
 * research brief from the Research Agent and generates a complete
 * MDX article with frontmatter, components, and visual directives.
 *
 * Uses Sonnet 4.6 for creative writing — the Writer task requires
 * top-tier reasoning, narrative voice, and technical accuracy.
 *
 * Pipeline position: Research → **Writer** → QA → Review
 */

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { BLOG_PERSONA_SYSTEM_PROMPT } from '../prompts/blog-persona.js';
import type {
    AgentConfig,
    AgentResult,
    ArticleMetadata,
    PipelineContext,
    ResearchResult,
    ShotListItem,
    WriterResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Writer Agent model — uses Sonnet 4.6 for creative generation.
 * Falls back to cross-region Sonnet profile if not set.
 */
const WRITER_MODEL = process.env.FOUNDATION_MODEL ?? 'eu.anthropic.claude-sonnet-4-6-20260310-v1:0';

/** Maximum output tokens for Writer Agent response */
const WRITER_MAX_TOKENS = parseInt(process.env.MAX_TOKENS ?? '8192', 10);

/** Default thinking budget (overridden by Research Agent complexity tier) */
const DEFAULT_THINKING_BUDGET = parseInt(process.env.THINKING_BUDGET_TOKENS ?? '16000', 10);

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Writer Agent.
 *
 * Provides the Writer with the Research Agent's structured brief,
 * including KB context, complexity classification, and proposed outline.
 *
 * @param research - Research result from the Research Agent
 * @param retryAttempt - Current retry attempt (0-based)
 * @returns Formatted user message
 */
function buildWriterMessage(research: ResearchResult, retryAttempt: number): string {
    const parts: string[] = [];

    // Header with mode and complexity
    parts.push(`## Content Generation Request`);
    parts.push(`- Pipeline Mode: ${research.mode}`);
    parts.push(`- Complexity: ${research.complexity.tier} — ${research.complexity.reason}`);
    parts.push(`- Suggested Title: ${research.suggestedTitle}`);
    parts.push(`- Suggested Tags: ${research.suggestedTags.join(', ')}`);

    if (retryAttempt > 0) {
        parts.push(``);
        parts.push(`> ⚠️ This is retry attempt ${retryAttempt}. The previous version did not pass QA.`);
        parts.push(`> Pay extra attention to technical accuracy and code correctness.`);
    }

    // KB context (if KB-augmented mode)
    if (research.kbPassages.length > 0) {
        parts.push(``);
        parts.push(`## Knowledge Base Context`);
        parts.push(`The following passages are from the project's real infrastructure documentation:`);
        parts.push(``);

        for (const [i, passage] of research.kbPassages.entries()) {
            parts.push(`### KB Passage ${i + 1} (relevance: ${passage.score.toFixed(3)})`);
            parts.push(passage.text);
            parts.push(``);
        }
    }

    // Research brief — outline
    if (research.outline.length > 0) {
        parts.push(``);
        parts.push(`## Proposed Article Outline`);
        parts.push(`The Research Agent suggests the following structure:`);
        parts.push(``);

        for (const section of research.outline) {
            const visualMarker = section.needsVisual ? ' 📊' : '';
            parts.push(`- **${section.heading}** (~${section.wordBudget} words)${visualMarker}`);
            for (const point of section.keyPoints) {
                parts.push(`  - ${point}`);
            }
        }
    }

    // Technical facts
    if (research.technicalFacts.length > 0) {
        parts.push(``);
        parts.push(`## Verified Technical Facts`);
        parts.push(`These facts were extracted from the draft and KB. Preserve them accurately:`);
        parts.push(``);
        for (const fact of research.technicalFacts) {
            parts.push(`- ${fact}`);
        }
    }

    // Raw draft content
    parts.push(``);
    parts.push(`## Source Draft`);
    parts.push(`--- BEGIN DRAFT ---`);
    parts.push(research.draftContent);
    parts.push(`--- END DRAFT ---`);
    parts.push(``);
    parts.push(`Generate the complete MDX article. Return the JSON output as specified in your system prompt.`);

    return parts.join('\n');
}

// =============================================================================
// RESPONSE PARSER
// =============================================================================

/**
 * Parse the Writer Agent's JSON response into a typed WriterResult.
 *
 * @param responseText - Raw text response from Bedrock
 * @returns Validated WriterResult
 * @throws Error if required fields are missing
 */
function parseWriterResponse(responseText: string): WriterResult {
    const parsed = parseJsonResponse<Record<string, unknown>>(responseText, 'writer');

    // Validate required fields
    if (typeof parsed.content !== 'string' || parsed.content.length === 0) {
        throw new TypeError('Writer Agent: Missing or empty "content" in response');
    }

    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata !== 'object') {
        throw new TypeError('Writer Agent: Missing "metadata" object in response');
    }

    // Build validated metadata
    const validatedMetadata: ArticleMetadata = {
        title: typeof metadata.title === 'string' ? metadata.title : 'Untitled Article',
        description: typeof metadata.description === 'string' ? metadata.description : '',
        tags: Array.isArray(metadata.tags) ? metadata.tags.filter((t): t is string => typeof t === 'string') : [],
        slug: typeof metadata.slug === 'string' ? metadata.slug : 'untitled',
        publishDate: typeof metadata.publishDate === 'string' ? metadata.publishDate : new Date().toISOString().split('T')[0],
        readingTime: typeof metadata.readingTime === 'number' ? metadata.readingTime : 8,
        category: typeof metadata.category === 'string' ? metadata.category : 'DevOps',
        aiSummary: typeof metadata.aiSummary === 'string' ? metadata.aiSummary : '',
        technicalConfidence: typeof metadata.technicalConfidence === 'number'
            ? Math.max(0, Math.min(100, metadata.technicalConfidence))
            : 70,
        skillsDemonstrated: Array.isArray(metadata.skillsDemonstrated)
            ? metadata.skillsDemonstrated.filter((s): s is string => typeof s === 'string')
            : [],
        processingNote: typeof metadata.processingNote === 'string' ? metadata.processingNote : '',
    };

    // Build validated shot list
    const rawShotList = Array.isArray(parsed.shotList) ? parsed.shotList : [];
    const shotList: ShotListItem[] = rawShotList
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
            id: typeof item.id === 'string' ? item.id : 'unknown',
            type: ['diagram', 'screenshot', 'hero'].includes(item.type as string)
                ? (item.type as 'diagram' | 'screenshot' | 'hero')
                : 'diagram',
            instruction: typeof item.instruction === 'string' ? item.instruction : '',
            context: typeof item.context === 'string' ? item.context : '',
        }));

    return {
        content: parsed.content as string,
        metadata: validatedMetadata,
        shotList,
    };
}

// =============================================================================
// WRITER AGENT EXECUTION
// =============================================================================

/**
 * Execute the Writer Agent.
 *
 * Takes the Research Agent's structured brief and generates a
 * complete MDX article with frontmatter, visual directives, and
 * structured metadata.
 *
 * The thinking budget is dynamically set based on the Research
 * Agent's complexity classification.
 *
 * @param ctx - Pipeline context
 * @param research - Research result from the first agent
 * @returns Writer result with MDX content, metadata, and shot list
 */
export async function executeWriterAgent(
    ctx: PipelineContext,
    research: ResearchResult,
): Promise<AgentResult<WriterResult>> {
    // Dynamic thinking budget based on complexity
    const thinkingBudget = Math.min(
        research.complexity.budgetTokens,
        DEFAULT_THINKING_BUDGET,
    );

    const writerConfig: AgentConfig = {
        agentName: 'writer',
        modelId: WRITER_MODEL,
        maxTokens: WRITER_MAX_TOKENS,
        thinkingBudget,
        systemPrompt: BLOG_PERSONA_SYSTEM_PROMPT,
    };

    const userMessage = buildWriterMessage(research, ctx.retryAttempt);

    console.log(
        `[writer] Generating article — complexity=${research.complexity.tier}, ` +
        `thinkingBudget=${thinkingBudget}, retryAttempt=${ctx.retryAttempt}`,
    );

    const result = await runAgent<WriterResult>({
        config: writerConfig,
        userMessage,
        parseResponse: parseWriterResponse,
        pipelineContext: ctx,
    });

    console.log(
        `[writer] Article generated — title="${result.data.metadata.title}", ` +
        `slug="${result.data.metadata.slug}", readingTime=${result.data.metadata.readingTime}min, ` +
        `confidence=${result.data.metadata.technicalConfidence}, ` +
        `shotListCount=${result.data.shotList.length}`,
    );

    return result;
}
