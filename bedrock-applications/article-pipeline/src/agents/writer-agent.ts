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
    SuggestedReference,
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

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? WRITER_MODEL;

/** Maximum output tokens for Writer Agent response (full MDX articles need substantial headroom) */
const WRITER_MAX_TOKENS = Number.parseInt(process.env.MAX_TOKENS ?? '32768', 10);

/** Default thinking budget (overridden by Research Agent complexity tier) */
const DEFAULT_THINKING_BUDGET = Number.parseInt(process.env.THINKING_BUDGET_TOKENS ?? '16000', 10);

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
function buildContextSection(research: ResearchResult, retryAttempt: number, version: number): string[] {
    const parts: string[] = [];

    if (retryAttempt > 0) {
        parts.push(
            ``,
            `> ⚠️ This is retry attempt ${retryAttempt}. The previous version did not pass QA.`,
            `> Pay extra attention to technical accuracy and code correctness.`
        );
    }

    if (research.authorDirection) {
        parts.push(
            ``,
            `## ⚡ Author's Direction`,
            `> This is the author's specific creative direction for this article.`,
            `> Your article MUST directly address these instructions.`,
            `> Do NOT let KB context or standard templates override this direction.`,
            ``,
            research.authorDirection
        );
    }

    if (research.previousVersionContent) {
        const previousVersion = version - 1;
        parts.push(
            ``,
            `## 🔄 Previous Version (v${previousVersion})`,
            `> A previous version of this article already exists. The author has submitted`,
            `> a NEW prompt with DIFFERENT creative direction (see "Author's Direction" above).`,
            `> You MUST generate a substantially different article that addresses the new direction.`,
            `> Do NOT simply rephrase, extend, or lightly edit the previous version.`,
            ``,
            `--- BEGIN PREVIOUS VERSION ---`,
            research.previousVersionContent,
            `--- END PREVIOUS VERSION ---`
        );
    }

    // KB context (if KB-augmented mode)
    if (research.kbPassages.length > 0) {
        parts.push(
            ``,
            `## Knowledge Base Context`,
            `The following passages are from the project's real infrastructure documentation:`,
            ``
        );
        for (const [i, passage] of research.kbPassages.entries()) {
            parts.push(
                `### KB Passage ${i + 1} (relevance: ${passage.score.toFixed(3)})`,
                passage.text,
                ``
            );
        }
    }

    return parts;
}

function buildOutlineAndFactsSection(research: ResearchResult): string[] {
    const parts: string[] = [];

    // Research brief — outline
    if (research.outline.length > 0) {
        parts.push(
            ``,
            `## Proposed Article Outline`,
            `The Research Agent suggests the following structure:`,
            ``
        );
        for (const section of research.outline) {
            const visualMarker = section.needsVisual ? ' 📊' : '';
            parts.push(`- **${section.heading}** (~${section.wordBudget} words)${visualMarker}`);
            if (section.keyPoints.length > 0) {
                parts.push(...section.keyPoints.map(point => `  - ${point}`));
            }
        }
    }

    // Technical facts
    if (research.technicalFacts.length > 0) {
        parts.push(
            ``,
            `## Verified Technical Facts`,
            `These facts were extracted from the draft and KB. Preserve them accurately:`,
            ``,
            ...research.technicalFacts.map(fact => `- ${fact}`)
        );
    }

    return parts;
}

function buildSeoSection(research: ResearchResult): string[] {
    const parts: string[] = [];

    if (research.seoResearch) {
        parts.push(
            ``,
            `## SEO Research Brief`,
            `- Primary Keyword: ${research.seoResearch.primaryKeyword}`
        );
        if (research.seoResearch.secondaryKeywords.length > 0) {
            parts.push(`- Secondary Keywords: ${research.seoResearch.secondaryKeywords.join(', ')}`);
        }
        if (research.seoResearch.suggestedReferences.length > 0) {
            parts.push(
                ``,
                `### Suggested Authoritative References`,
                `The Research Agent identified these external links for credibility:`,
                ...research.seoResearch.suggestedReferences.flatMap(ref => 
                    ref.relevance 
                        ? [`- **${ref.label}**: [${ref.url}](${ref.url})`, `  *Relevance: ${ref.relevance}*`] 
                        : [`- **${ref.label}**: [${ref.url}](${ref.url})`]
                )
            );
        }
    }

    return parts;
}

function buildWriterMessage(
    research: ResearchResult,
    retryAttempt: number,
    version: number,
): string {
    const parts: string[] = [
        `## Content Generation Request`,
        `- Pipeline Mode: ${research.mode}`,
        `- Complexity: ${research.complexity.tier} — ${research.complexity.reason}`,
        `- Suggested Title: ${research.suggestedTitle}`,
        `- Suggested Tags: ${research.suggestedTags.join(', ')}`,
        ...buildContextSection(research, retryAttempt, version),
        ...buildOutlineAndFactsSection(research),
        ...buildSeoSection(research),
        ``,
        `## Source Draft`,
        `--- BEGIN DRAFT ---`,
        research.draftContent,
        `--- END DRAFT ---`,
        ``,
        `Generate the complete MDX article. Return the JSON output as specified in your system prompt.`
    ];

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
function parseArticleMetadata(metadata: Record<string, unknown>): ArticleMetadata {
    return {
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
        primaryKeyword: typeof metadata.primaryKeyword === 'string' ? metadata.primaryKeyword : undefined,
        secondaryKeywords: Array.isArray(metadata.secondaryKeywords)
            ? metadata.secondaryKeywords.filter((k): k is string => typeof k === 'string')
            : undefined,
    };
}

function parseShotListArray(rawShotList: unknown[]): ShotListItem[] {
    return rawShotList
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
            id: typeof item.id === 'string' ? item.id : 'unknown',
            type: ['diagram', 'screenshot', 'hero'].includes(item.type as string)
                ? (item.type as 'diagram' | 'screenshot' | 'hero')
                : 'diagram',
            instruction: typeof item.instruction === 'string' ? item.instruction : '',
            context: typeof item.context === 'string' ? item.context : '',
        }));
}

function parseSuggestedReferencesArray(rawRefs: unknown[]): SuggestedReference[] {
    return rawRefs
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
            label: typeof r.label === 'string' ? r.label : '',
            url: typeof r.url === 'string' ? r.url : '',
            relevance: typeof r.relevance === 'string' ? r.relevance : '',
            usedInline: typeof r.usedInline === 'boolean' ? r.usedInline : false,
        }))
        .filter((r) => r.label && r.url);
}

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

    const validatedMetadata = parseArticleMetadata(metadata);
    const rawShotList = Array.isArray(parsed.shotList) ? parsed.shotList : [];
    const shotList = parseShotListArray(rawShotList);
    const rawRefs = Array.isArray(parsed.suggestedReferences) ? parsed.suggestedReferences : [];
    const suggestedReferences = parseSuggestedReferencesArray(rawRefs);

    return {
        content: parsed.content,
        metadata: validatedMetadata,
        shotList,
        suggestedReferences: suggestedReferences.length > 0 ? suggestedReferences : undefined,
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
        modelId: EFFECTIVE_MODEL_ID,
        maxTokens: WRITER_MAX_TOKENS,
        thinkingBudget,
        systemPrompt: BLOG_PERSONA_SYSTEM_PROMPT,
    };

    const userMessage = buildWriterMessage(research, ctx.retryAttempt, ctx.version);

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
