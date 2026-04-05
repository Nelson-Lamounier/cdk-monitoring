/**
 * @format
 * Bedrock Model Registry — Centralised Foundation Model Configuration
 *
 * Single source of truth for all Bedrock foundation model IDs used across
 * the portfolio infrastructure. When upgrading models (e.g. Sonnet 4.6 → 5.0),
 * change the constant here and all projects pick up the new model.
 *
 * Projects consuming these constants:
 * - **Bedrock ChatBot** — `config/bedrock/allocations.ts` (Agent model)
 * - **Article Pipeline** — `config/bedrock/content-allocations.ts` + `pipeline-allocations.ts`
 * - **Job Strategist** — `config/bedrock/strategist-allocations.ts`
 * - **Self-Healing Agent** — `config/self-healing/configurations.ts`
 *
 * Model ID format: `eu.<provider>.<model>` uses cross-region inference profiles
 * to route requests across EU regions for resilience and availability.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 */

// =============================================================================
// ANTHROPIC CLAUDE MODELS
// =============================================================================

/**
 * Claude Haiku 4.5 — lightweight model optimised for speed and efficiency.
 *
 * Use for chatbot agents, research, classification, and moderate-complexity tasks.
 * Supports Adaptive Thinking (reasoning). 200K context, 64K max output.
 *
 * Verified EU cross-region inference profile:
 * `eu.anthropic.claude-haiku-4-5-20251001-v1:0`
 *
 * Pricing (eu cross-region, as of March 2026):
 * - Input: $1.00/1M tokens
 * - Output: $5.00/1M tokens
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
 */
export const CLAUDE_HAIKU_4_5 = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Claude Sonnet 4.6 — high-reasoning model with extended thinking.
 *
 * Use for complex generation (article writing, QA review, self-healing diagnosis).
 *
 * Pricing (eu cross-region, as of March 2026):
 * - Input: $3.00/1M tokens
 * - Output: $15.00/1M tokens
 * - Thinking: $3.75/1M tokens (discounted cache reads)
 */
export const CLAUDE_SONNET_4_6 = 'eu.anthropic.claude-sonnet-4-6';

// =============================================================================
// AMAZON EMBEDDING MODELS
// =============================================================================

/**
 * Titan Embeddings V2 — Amazon's vector embedding model.
 *
 * Use for Knowledge Base document indexing (Pinecone).
 *
 * Pricing (eu, as of March 2026):
 * - $0.02/1M tokens
 */
export const TITAN_EMBED_TEXT_V2 = 'amazon.titan-embed-text-v2:0';

// =============================================================================
// ROLE-BASED MODEL ASSIGNMENTS
// =============================================================================

/**
 * Default model assignments by role.
 *
 * These are semantic aliases that map task types to models.
 * Change the assignment here to upgrade all consumers.
 *
 * @example
 * ```typescript
 * import { MODELS } from '../../config/shared/model-registry';
 * const writerModel = MODELS.ARTICLE_WRITER; // claude-sonnet-4-6
 * ```
 */
export const MODELS = {
    // ── ChatBot ─────────────────────────────────────────────────
    /** Portfolio chatbot agent (managed Bedrock Agent) */
    CHATBOT_AGENT: CLAUDE_HAIKU_4_5,

    // ── Article Pipeline ────────────────────────────────────────
    /** Research agent: KB retrieval, complexity analysis, outline */
    ARTICLE_RESEARCH: CLAUDE_HAIKU_4_5,
    /** Writer agent: full MDX article generation */
    ARTICLE_WRITER: CLAUDE_SONNET_4_6,
    /** QA agent: quality validation, tech accuracy, SEO */
    ARTICLE_QA: CLAUDE_SONNET_4_6,
    /** Monolithic publisher (legacy, pending deprecation) */
    ARTICLE_MONOLITH: CLAUDE_SONNET_4_6,

    // ── Self-Healing ────────────────────────────────────────────
    /** Strands agent: K8s diagnosis and remediation */
    SELF_HEALING_AGENT: CLAUDE_SONNET_4_6,

    // ── Job Strategist Pipeline ─────────────────────────────────
    /** Research agent: KB retrieval, resume parsing, gap analysis */
    JOB_STRATEGIST_RESEARCH: CLAUDE_HAIKU_4_5,
    /** Strategist agent: strategy generation, document crafting */
    JOB_STRATEGIST_WRITER: CLAUDE_SONNET_4_6,
    /** Interview Coach agent: stage-specific preparation */
    JOB_STRATEGIST_COACH: CLAUDE_HAIKU_4_5,

    // ── Knowledge Base ──────────────────────────────────────────
    /** Document embedding for Pinecone vector store */
    KB_EMBEDDINGS: TITAN_EMBED_TEXT_V2,
} as const;

/**
 * Type representing all available model role keys.
 */
export type ModelRole = keyof typeof MODELS;

// =============================================================================
// SYSTEM-DEFINED INFERENCE PROFILE ARNs
// =============================================================================

/**
 * ARN-format identifiers for cross-region system-defined inference profiles.
 *
 * Used exclusively as `copyFrom` source when creating Application Inference
 * Profiles via `CfnApplicationInferenceProfile`. The double `::` in each ARN
 * indicates that these are AWS-managed resources (no account ID).
 *
 * @remarks Do not use these directly for model invocation — use the short-form
 * model IDs in the `MODELS` object above. These ARNs are only for the
 * CloudFormation `ModelSource.CopyFrom` field.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-create.html
 */
export const SYSTEM_INFERENCE_PROFILES = {
    /** Cross-region inference profile ARN for Claude Haiku 4.5 */
    CLAUDE_HAIKU_4_5: `arn:aws:bedrock:eu-west-1::inference-profile/${CLAUDE_HAIKU_4_5}`,
    /** Cross-region inference profile ARN for Claude Sonnet 4.6 */
    CLAUDE_SONNET_4_6: `arn:aws:bedrock:eu-west-1::inference-profile/${CLAUDE_SONNET_4_6}`,
} as const;
