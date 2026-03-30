/**
 * @format
 * Research Agent — KB Retrieval, Complexity Analysis & Outline Generation
 *
 * First agent in the lean 3-agent pipeline. Analyses the raw draft,
 * retrieves context from the Bedrock Knowledge Base (Pinecone), classifies
 * content complexity, and produces a structured research brief.
 *
 * Uses Haiku 4.5 for cost efficiency — the research task is extraction
 * and analysis, not creative generation.
 *
 * Pipeline position: S3 Event → **Research** → Writer → QA → Review
 */

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';
import type {
    AgentConfig,
    AgentResult,
    ComplexityAnalysis,
    ComplexityTier,
    KbPassage,
    PipelineContext,
    PipelineMode,
    ResearchResult,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Research Agent model — set by CDK via RESEARCH_MODEL environment variable.
 * Must not be hardcoded to ensure the model registry remains the single source of truth.
 */
const RESEARCH_MODEL = process.env.RESEARCH_MODEL;
if (!RESEARCH_MODEL) {
    throw new Error(
        'Missing required environment variable RESEARCH_MODEL. ' +
        'This must be set by CDK infrastructure (e.g. eu.anthropic.claude-haiku-4-5-20251001-v1:0)',
    );
}

/** Maximum output tokens for Research Agent response */
const RESEARCH_MAX_TOKENS = 8192;

/** Thinking budget for Research Agent — moderate for analysis tasks */
const RESEARCH_THINKING_BUDGET = 4096;

/** Knowledge Base ID for Pinecone retrieval (empty = disabled) */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/** Character threshold for KB-augmented mode detection */
const KB_AUGMENTED_THRESHOLD = 500;

/** Maximum KB passages to retrieve */
const MAX_KB_PASSAGES = 10;

// =============================================================================
// CLIENTS
// =============================================================================

const s3Client = new S3Client({});
const bedrockAgentClient = new BedrockAgentRuntimeClient({});

// =============================================================================
// COMPLEXITY ANALYSIS
// =============================================================================

/**
 * Budget tokens per complexity tier.
 * These values are used by the Writer Agent for Adaptive Thinking.
 */
const TIER_BUDGETS: Record<ComplexityTier, number> = {
    LOW: 2_048,
    MID: 8_192,
    HIGH: 16_000,
};

/**
 * Analyse the raw markdown to classify its technical complexity.
 *
 * Signals inspected:
 * 1. Length — character count correlates with breadth of content
 * 2. Code density — ratio of fenced-code-block chars to total chars
 * 3. Code block count — number of distinct fenced blocks
 * 4. YAML/config blocks — yaml/yml/hcl code fences (IaC indicator)
 * 5. Heading depth — number of unique headings (structural complexity)
 *
 * @param markdown - The raw markdown content
 * @returns Complexity analysis with tier, budget, and signals
 */
export function analyseComplexity(markdown: string): ComplexityAnalysis {
    const charCount = markdown.length;

    // Count fenced code blocks and their total character length
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = markdown.match(codeBlockRegex) ?? [];
    const codeBlockCount = codeBlocks.length;
    const codeChars = codeBlocks.reduce((sum, block) => sum + block.length, 0);
    const codeRatio = charCount > 0 ? codeChars / charCount : 0;

    // Count IaC-specific code fences
    const iacFenceRegex = /```(?:ya?ml|hcl|terraform|toml|dockerfile|Dockerfile)/gi;
    const yamlFrontmatterBlocks = (markdown.match(iacFenceRegex) ?? []).length;

    // Count unique headings
    const headingRegex = /^#{1,4}\s+.+$/gm;
    const uniqueHeadingCount = (markdown.match(headingRegex) ?? []).length;

    // Classification logic
    let tier: ComplexityTier;
    let reason: string;

    const isLong = charCount > 8_000;
    const isCodeHeavy = codeRatio > 0.30;
    const hasManyCodeBlocks = codeBlockCount >= 6;
    const hasIacBlocks = yamlFrontmatterBlocks >= 2;
    const isStructurallyComplex = uniqueHeadingCount >= 8;

    const heavySignals = [isLong && isCodeHeavy, hasManyCodeBlocks, hasIacBlocks, isStructurallyComplex];
    const heavyCount = heavySignals.filter(Boolean).length;

    if (heavyCount >= 2) {
        tier = 'HIGH';
        reason = `Dense technical content (${codeBlockCount} code blocks, ${(codeRatio * 100).toFixed(0)}% code, ${yamlFrontmatterBlocks} IaC fences, ${uniqueHeadingCount} headings)`;
    } else if (isLong || hasManyCodeBlocks || isCodeHeavy) {
        tier = 'MID';
        reason = `Moderate complexity (${codeBlockCount} code blocks, ${(codeRatio * 100).toFixed(0)}% code, ${charCount.toLocaleString()} chars)`;
    } else {
        tier = 'LOW';
        reason = `Light content (${codeBlockCount} code blocks, ${charCount.toLocaleString()} chars)`;
    }

    return {
        tier,
        budgetTokens: TIER_BUDGETS[tier],
        reason,
        signals: {
            charCount,
            codeBlockCount,
            codeRatio: Math.round(codeRatio * 100) / 100,
            yamlFrontmatterBlocks,
            uniqueHeadingCount,
        },
    };
}

// =============================================================================
// KNOWLEDGE BASE RETRIEVAL
// =============================================================================

/**
 * Query the Bedrock Knowledge Base (Pinecone) for relevant context.
 *
 * Uses the Bedrock Retrieve API to fetch passages that match
 * the draft content. Returns empty array if KB is disabled.
 *
 * @param query - The search query (draft content or brief)
 * @returns Array of KB passages with scores and source URIs
 */
async function queryKnowledgeBase(query: string): Promise<KbPassage[]> {
    if (!KNOWLEDGE_BASE_ID) {
        console.log('[research] KB retrieval skipped — no KNOWLEDGE_BASE_ID configured');
        return [];
    }

    console.log(`[research] Querying KB '${KNOWLEDGE_BASE_ID}' with ${query.length} chars`);

    const command = new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: {
            text: query.substring(0, 1000), // KB query has a max length
        },
        retrievalConfiguration: {
            vectorSearchConfiguration: {
                numberOfResults: MAX_KB_PASSAGES,
            },
        },
    });

    const response = await bedrockAgentClient.send(command);
    const results = response.retrievalResults ?? [];

    const passages: KbPassage[] = results
        .filter((r) => r.content?.text)
        .map((r) => ({
            text: r.content!.text!,
            score: r.score ?? 0,
            sourceUri: r.location?.s3Location?.uri ?? 'unknown',
        }));

    console.log(`[research] KB returned ${passages.length} passages (top score: ${passages[0]?.score.toFixed(3) ?? 'N/A'})`);

    return passages;
}

// =============================================================================
// S3 DRAFT READING
// =============================================================================

/**
 * Read the raw markdown draft from S3.
 *
 * @param bucket - S3 bucket name
 * @param key - S3 object key
 * @returns Draft content as UTF-8 string
 * @throws Error if the S3 object body is empty
 */
async function readDraftFromS3(bucket: string, key: string): Promise<string> {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));

    if (!response.Body) {
        throw new Error(`S3 GetObject returned empty body for s3://${bucket}/${key}`);
    }

    return response.Body.transformToString('utf-8');
}

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Research Agent.
 *
 * Includes the draft content and any KB context for analysis.
 *
 * @param draftContent - Raw markdown draft
 * @param kbPassages - Retrieved KB passages
 * @param mode - Pipeline mode (KB-augmented vs legacy)
 * @returns Formatted user message
 */
function buildResearchMessage(
    draftContent: string,
    kbPassages: KbPassage[],
    mode: PipelineMode,
): string {
    const parts: string[] = [
        `## Pipeline Mode: ${mode}`,
        ``,
    ];

    if (kbPassages.length > 0) {
        parts.push(`## Knowledge Base Context`);
        parts.push(`The following ${kbPassages.length} passages were retrieved from the project's infrastructure documentation:`);
        parts.push(``);

        for (const [i, passage] of kbPassages.entries()) {
            parts.push(`### Passage ${i + 1} (score: ${passage.score.toFixed(3)}, source: ${passage.sourceUri})`);
            parts.push(passage.text);
            parts.push(``);
        }
    }

    parts.push(`## Draft Content`);
    parts.push(`--- BEGIN DRAFT ---`);
    parts.push(draftContent);
    parts.push(`--- END DRAFT ---`);
    parts.push(``);
    parts.push(`Analyse this draft and return the JSON research brief.`);

    return parts.join('\n');
}

// =============================================================================
// RESEARCH AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Research Agent.
 */
const RESEARCH_CONFIG: AgentConfig = {
    agentName: 'research',
    modelId: RESEARCH_MODEL,
    maxTokens: RESEARCH_MAX_TOKENS,
    thinkingBudget: RESEARCH_THINKING_BUDGET,
    systemPrompt: RESEARCH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Research Agent.
 *
 * Reads the draft from S3, queries the Knowledge Base, classifies
 * complexity, and generates a structured research brief.
 *
 * @param ctx - Pipeline context with bucket, sourceKey
 * @returns Research result with mode, complexity, KB passages, and outline
 */
export async function executeResearchAgent(
    ctx: PipelineContext,
): Promise<AgentResult<ResearchResult>> {
    // 1. Read draft from S3
    console.log(`[research] Reading draft from s3://${ctx.bucket}/${ctx.sourceKey}`);
    const draftContent = await readDraftFromS3(ctx.bucket, ctx.sourceKey);

    // 2. Detect pipeline mode
    const mode: PipelineMode = draftContent.length <= KB_AUGMENTED_THRESHOLD
        ? 'kb-augmented'
        : 'legacy-transform';
    console.log(`[research] Mode: ${mode} (draft length: ${draftContent.length} chars)`);

    // 3. Query Knowledge Base (for KB-augmented mode, or always for supplementary context)
    const kbPassages = await queryKnowledgeBase(draftContent);

    // 4. Perform local complexity analysis (fast, no LLM needed)
    const localComplexity = analyseComplexity(draftContent);
    console.log(`[research] Local complexity: ${localComplexity.tier} — ${localComplexity.reason}`);

    // 5. Build user message and run agent
    const userMessage = buildResearchMessage(draftContent, kbPassages, mode);

    const result = await runAgent<ResearchResult>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            const parsed = parseJsonResponse<Record<string, unknown>>(text, 'research');

            // Merge local complexity analysis with LLM-generated outline
            return {
                mode,
                draftContent,
                complexity: localComplexity, // Use local analysis (deterministic)
                kbPassages,
                outline: Array.isArray(parsed.outline) ? parsed.outline : [],
                technicalFacts: Array.isArray(parsed.technicalFacts) ? parsed.technicalFacts : [],
                suggestedTitle: typeof parsed.suggestedTitle === 'string'
                    ? parsed.suggestedTitle
                    : 'Untitled Article',
                suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags : [],
            } as ResearchResult;
        },
        pipelineContext: ctx,
    });

    console.log(
        `[research] Brief generated — title="${result.data.suggestedTitle}", ` +
        `sections=${result.data.outline.length}, facts=${result.data.technicalFacts.length}`,
    );

    return result;
}
