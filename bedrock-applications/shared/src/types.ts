/**
 * @format
 * Multi-Agent Pipeline — Shared Types
 *
 * Core type definitions shared across all agents in the lean 3-agent
 * content pipeline. These types define the data contracts for:
 *
 * - Pipeline context (correlation, state, cost tracking)
 * - Agent configuration (model, tokens, thinking budget)
 * - Agent results (typed output wrapper)
 * - Article lifecycle status
 * - Research, writer, and QA agent input/output shapes
 *
 * All types are designed for Step Functions state passing — they must
 * be JSON-serialisable and fit within the 256KB payload limit.
 */

import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { TokenUsage } from './metrics.js';

// =============================================================================
// PIPELINE CONTEXT
// =============================================================================

/**
 * Article lifecycle status in DynamoDB.
 *
 * Applies to both METADATA records (aggregate status) and VERSION#v<n>
 * records (per-version status).
 *
 * - `processing`  — Pipeline is actively running for this version
 * - `review`      — QA passed; awaiting manual approval in admin dashboard
 * - `flagged`     — QA failed after max retries; requires admin override or rejection
 * - `published`   — Approved by admin; live on the production site
 * - `rejected`    — Rejected by admin; moved to archived/ S3 prefix
 * - `failed`      — Pipeline execution failed (agent error, timeout, etc.)
 * - `superseded`  — Previously published, replaced by a newer version
 */
export type ArticleStatus =
    | 'processing'
    | 'review'
    | 'flagged'
    | 'published'
    | 'rejected'
    | 'failed'
    | 'superseded';

/**
 * Pipeline generation mode.
 *
 * - `kb-augmented`     — Short brief triggers KB retrieval + article synthesis
 * - `legacy-transform` — Full markdown draft transformed into polished MDX
 */
export type PipelineMode = 'kb-augmented' | 'legacy-transform';

/**
 * Content complexity tier classification.
 * Drives adaptive thinking budget allocation.
 */
export type ComplexityTier = 'LOW' | 'MID' | 'HIGH';

/**
 * Correlation context passed through the entire Step Functions pipeline.
 *
 * Each agent reads from and appends to this context, accumulating
 * token usage, cost, and timing data across the pipeline execution.
 *
 * Must remain JSON-serialisable for Step Functions state passing.
 */
export interface PipelineContext {
    /** Unique pipeline execution ID (Step Functions execution ARN) */
    readonly pipelineId: string;

    /** Article slug extracted from S3 key (e.g. 'devsecops-pipeline') */
    readonly slug: string;

    /** S3 key of the original draft (e.g. 'drafts/devsecops-pipeline.md') */
    readonly sourceKey: string;

    /** S3 bucket name containing drafts and output */
    readonly bucket: string;

    /** Runtime environment (e.g. 'development', 'production') */
    readonly environment: string;

    /**
     * Auto-increment version number for this pipeline run.
     *
     * Determined by the trigger handler by querying the latest
     * VERSION# sort key and incrementing by 1.
     * Maps to DynamoDB sk: VERSION#v{version}
     */
    readonly version: number;

    /** Cumulative token usage across all agents */
    cumulativeTokens: {
        input: number;
        output: number;
        thinking: number;
    };

    /** Cumulative estimated cost in USD across all agents */
    cumulativeCostUsd: number;

    /** Pipeline retry attempt counter (0-based, incremented by Step Functions) */
    retryAttempt: number;

    /** ISO timestamp of pipeline start */
    readonly startedAt: string;
}

// =============================================================================
// AGENT CONFIGURATION
// =============================================================================

/**
 * Agent name identifiers for all Bedrock pipelines.
 *
 * Includes both the article pipeline (research/writer/qa) and the
 * Job Strategist pipeline (strategist-research/strategist-writer/strategist-coach).
 */
export type AgentName =
    | 'research' | 'writer' | 'qa'
    | 'strategist-research' | 'strategist-writer' | 'strategist-coach';

/**
 * Model-agnostic configuration for a single agent.
 *
 * Each agent handler reads its config from environment variables
 * at startup, but this interface defines the shape for CDK
 * configuration and unit testing.
 */
export interface AgentConfig {
    /** Agent identifier for logging and metrics */
    readonly agentName: AgentName;

    /** Bedrock model ID (e.g. 'eu.anthropic.claude-haiku-4-5-20251001-v1:0') */
    readonly modelId: string;

    /** Maximum output tokens for the Converse API call */
    readonly maxTokens: number;

    /** Thinking budget tokens (0 = thinking disabled) */
    readonly thinkingBudget: number;

    /** System prompt content blocks for the Converse API */
    readonly systemPrompt: SystemContentBlock[];
}

// =============================================================================
// AGENT RESULTS
// =============================================================================

/**
 * Standardised wrapper for agent outputs.
 *
 * Every agent returns its domain-specific output plus execution
 * metadata (tokens, duration, cost). This wrapper enables consistent
 * EMF metric emission and pipeline context accumulation.
 *
 * @template T - The agent-specific output type
 */
export interface AgentResult<T> {
    /** Agent-specific output data */
    readonly data: T;

    /** Token usage from this agent's Bedrock call */
    readonly tokenUsage: TokenUsage;

    /** Execution duration in milliseconds */
    readonly durationMs: number;

    /** Agent name for logging and metrics */
    readonly agentName: AgentName;

    /** Model ID used for this invocation */
    readonly modelId: string;

    /** Estimated cost in USD for this invocation */
    readonly costUsd: number;
}

// =============================================================================
// RESEARCH AGENT TYPES
// =============================================================================

/**
 * Signals extracted from complexity analysis of the raw draft.
 */
export interface ComplexitySignals {
    /** Total character count of the draft */
    readonly charCount: number;
    /** Number of fenced code blocks */
    readonly codeBlockCount: number;
    /** Ratio of code characters to total characters (0.0–1.0) */
    readonly codeRatio: number;
    /** Number of IaC-specific code fences (yaml, hcl, terraform) */
    readonly yamlFrontmatterBlocks: number;
    /** Number of unique headings */
    readonly uniqueHeadingCount: number;
}

/**
 * Complexity analysis result from the Research Agent.
 */
export interface ComplexityAnalysis {
    /** Classified tier: LOW, MID, or HIGH */
    readonly tier: ComplexityTier;
    /** Thinking budget tokens for the Writer based on tier */
    readonly budgetTokens: number;
    /** Human-readable reason for classification */
    readonly reason: string;
    /** Raw signal values */
    readonly signals: ComplexitySignals;
}

/**
 * A single Knowledge Base passage retrieved from Pinecone.
 */
export interface KbPassage {
    /** The text content of the retrieved passage */
    readonly text: string;
    /** Retrieval confidence score (0.0–1.0) */
    readonly score: number;
    /** Source document URI */
    readonly sourceUri: string;
}

/**
 * Outline section generated by the Research Agent.
 */
export interface OutlineSection {
    /** Section heading */
    readonly heading: string;
    /** Suggested word count for this section */
    readonly wordBudget: number;
    /** Key points to cover */
    readonly keyPoints: string[];
    /** Whether this section needs a visual (MermaidChart or ImageRequest) */
    readonly needsVisual: boolean;
}

/**
 * Complete output from the Research Agent.
 *
 * Provides the Writer Agent with structured context including
 * KB-retrieved facts, complexity analysis, and a proposed outline.
 */
export interface ResearchResult {
    /** Pipeline mode determined by draft length */
    readonly mode: PipelineMode;

    /** Raw draft content from S3 */
    readonly draftContent: string;

    /** Complexity analysis of the draft */
    readonly complexity: ComplexityAnalysis;

    /** Knowledge Base passages (empty array in legacy-transform mode) */
    readonly kbPassages: KbPassage[];

    /** Proposed article outline */
    readonly outline: OutlineSection[];

    /** Key technical facts extracted from draft and KB context */
    readonly technicalFacts: string[];

    /** Suggested article title (from draft or KB analysis) */
    readonly suggestedTitle: string;

    /** Suggested tags based on content analysis */
    readonly suggestedTags: string[];
}

// =============================================================================
// WRITER AGENT TYPES
// =============================================================================

/**
 * A single shot list entry from the Writer's visual direction.
 *
 * Image types: `diagram`, `screenshot`, `hero` — correspond to `<ImageRequest />`
 * Video types: `tutorial`, `demo`, `walkthrough` — correspond to `<VideoRequest />`
 *
 * The `hero` type can be used for either an `<ImageRequest>` or a `<VideoRequest>`,
 * but NOT both in the same article.
 */
export interface ShotListItem {
    /** Unique kebab-case identifier matching the inline `<ImageRequest>` or `<VideoRequest>` */
    readonly id: string;
    /** Visual type — image: diagram, screenshot, hero; video: tutorial, demo, walkthrough */
    readonly type: 'diagram' | 'screenshot' | 'hero' | 'tutorial' | 'demo' | 'walkthrough';
    /** Clear instruction for producing the visual asset */
    readonly instruction: string;
    /** Why this visual matters for the reader */
    readonly context: string;
    /** (Video only) Suggested duration, e.g. '2-3min' or '30-45sec' */
    readonly duration?: string;
}

/**
 * Article metadata produced by the Writer Agent.
 */
export interface ArticleMetadata {
    /** Human-readable article title */
    readonly title: string;
    /** SEO meta description (150–160 characters) */
    readonly description: string;
    /** 3–6 lowercase technical tags */
    readonly tags: string[];
    /** URL-friendly slug (kebab-case) */
    readonly slug: string;
    /** ISO date string (YYYY-MM-DD) */
    readonly publishDate: string;
    /** Estimated reading time in minutes */
    readonly readingTime: number;
    /** Article category */
    readonly category: string;
    /** 2–3 sentence SEO teaser */
    readonly aiSummary: string;
    /** Writer's self-rated technical confidence (0–100) */
    readonly technicalConfidence: number;
    /** Skills demonstrated in the article */
    readonly skillsDemonstrated: string[];
    /** Writer's note about the draft processing */
    readonly processingNote: string;
}

/**
 * Complete output from the Writer Agent.
 */
export interface WriterResult {
    /** Full MDX content with frontmatter and components */
    readonly content: string;

    /** Article metadata extracted from the Writer's JSON output */
    readonly metadata: ArticleMetadata;

    /** Director's Shot List — manifest of visual assets */
    readonly shotList: ShotListItem[];
}

// =============================================================================
// QA AGENT TYPES (extended from Phase 1)
// =============================================================================

/**
 * Severity classification for QA issues.
 */
export type IssueSeverity = 'info' | 'warning' | 'error';

/**
 * Publication recommendation from the QA Agent.
 */
export type QaRecommendation = 'publish' | 'revise' | 'reject';

/**
 * A single issue identified during QA review.
 */
export interface QaIssue {
    /** Issue severity classification */
    readonly severity: IssueSeverity;
    /** Specific location in the article (section, code block, line) */
    readonly location: string;
    /** Description of the issue */
    readonly description: string;
    /** Concrete fix recommendation */
    readonly fix: string;
}

/**
 * Score and issues for a single quality dimension.
 */
export interface DimensionResult {
    /** Score out of 100 */
    readonly score: number;
    /** Issues found in this dimension (empty array = clean) */
    readonly issues: QaIssue[];
}

/**
 * Complete QA validation result from the QA Agent.
 *
 * Extended from Phase 1 to include tech accuracy and SEO checks.
 */
export interface QaValidationResult {
    /** Weighted overall quality score (0–100) */
    readonly overallScore: number;
    /** Publication recommendation */
    readonly recommendation: QaRecommendation;
    /** Per-dimension breakdown */
    readonly dimensions: {
        readonly technicalAccuracy: DimensionResult;
        readonly seoCompliance: DimensionResult;
        readonly mdxStructure: DimensionResult;
        readonly metadataQuality: DimensionResult;
        readonly contentQuality: DimensionResult;
    };
    /** Human-readable review summary */
    readonly summary: string;
    /** Independent technical confidence score (replaces Writer's self-rating) */
    readonly confidenceOverride: number;
}

// =============================================================================
// ARTICLE VERSION RECORD (DynamoDB sk: VERSION#v<n>)
// =============================================================================

/**
 * Immutable snapshot of a single pipeline run for an article.
 *
 * Stored in DynamoDB as:
 *   pk: ARTICLE#<slug>
 *   sk: VERSION#v<n>
 *
 * Each pipeline execution creates exactly one VERSION record.
 * These records are never overwritten — they form an append-only
 * history of all content generation runs for a given article.
 */
export interface ArticleVersionRecord {
    /** Partition key: ARTICLE#<slug> */
    readonly pk: string;
    /** Sort key: VERSION#v<n> */
    readonly sk: string;
    /** Auto-increment version number */
    readonly version: number;
    /** Pipeline execution ID */
    readonly pipelineId: string;
    /** Version lifecycle status */
    readonly status: ArticleStatus;
    /** Article slug (denormalised for convenience) */
    readonly slug: string;
    /** Pointer to S3 content: s3://bucket/review/v{n}/{slug}.mdx */
    readonly contentRef: string;
    /** QA overall score (0–100), set after QA completes */
    readonly qaScore?: number;
    /** QA recommendation (publish/revise/reject) */
    readonly qaRecommendation?: string;
    /** QA summary text */
    readonly qaSummary?: string;
    /** Cumulative pipeline cost in USD */
    readonly pipelineCostUsd?: number;
    /** Cumulative token usage */
    readonly pipelineTokens?: {
        readonly input: number;
        readonly output: number;
        readonly thinking: number;
    };
    /** ISO timestamp — when this version was created */
    readonly createdAt: string;
    /** ISO timestamp — last update */
    readonly updatedAt: string;
    /** ISO timestamp — when this version was published (if approved) */
    readonly publishedAt?: string;
    /** ISO timestamp — when this version was rejected (if rejected) */
    readonly rejectedAt?: string;
    /** Runtime environment */
    readonly environment: string;
}

// =============================================================================
// STEP FUNCTIONS STATE SHAPES
// =============================================================================

/**
 * Input to each agent handler from Step Functions.
 *
 * Each handler receives the pipeline context plus any preceding
 * agent results. The shapes grow as data flows through the pipeline.
 */
export interface ResearchHandlerInput {
    readonly context: PipelineContext;
}

/**
 * Output from the Research Handler, input to the Writer Handler.
 */
export interface WriterHandlerInput {
    readonly context: PipelineContext;
    readonly research: AgentResult<ResearchResult>;
}

/**
 * Output from the Writer Handler, input to the QA Handler.
 */
export interface QaHandlerInput {
    readonly context: PipelineContext;
    readonly research: AgentResult<ResearchResult>;
    readonly writer: AgentResult<WriterResult>;
}

/**
 * Output from the QA Handler — terminal state of the pipeline.
 */
export interface PipelineOutput {
    readonly context: PipelineContext;
    readonly research: AgentResult<ResearchResult>;
    readonly writer: AgentResult<WriterResult>;
    readonly qa: AgentResult<QaValidationResult>;
    /** Whether the article passed QA (score ≥ 80) */
    readonly passed: boolean;
    /** Final article status written to DynamoDB */
    readonly articleStatus: ArticleStatus;
}
