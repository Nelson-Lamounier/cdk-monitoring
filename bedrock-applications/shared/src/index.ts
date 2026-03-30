/**
 * @format
 * Shared Module — Barrel Export
 *
 * Single entry point for all shared utilities, types, and metrics
 * used by the article pipeline, self-healing, and chatbot agents.
 *
 * Consumers import from this barrel rather than reaching into
 * individual files, keeping import paths shallow and manageable.
 *
 * @example
 * ```typescript
 * import { runAgent, parseJsonResponse } from '../../../shared/src/index.js';
 * import type { AgentConfig, PipelineContext } from '../../../shared/src/index.js';
 * ```
 */

// ─── Agent Runner ────────────────────────────────────────────────────────────
export {
    runAgent,
    parseJsonResponse,
    AgentExecutionError,
} from './agent-runner.js';

export type { RunAgentOptions } from './agent-runner.js';

// ─── Metrics & Cost Estimation ───────────────────────────────────────────────
export {
    estimateInvocationCost,
    StageTimer,
    emitPipelineMetrics,
    emitFailureMetrics,
} from './metrics.js';

export type {
    TokenUsage,
    PipelineMetricsContext,
    StageDurations,
    FailureMetricsContext,
    FailureStage,
} from './metrics.js';

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
    // Pipeline context
    ArticleStatus,
    PipelineMode,
    ComplexityTier,
    PipelineContext,

    // Agent configuration
    AgentName,
    AgentConfig,
    AgentResult,

    // Research Agent
    ComplexitySignals,
    ComplexityAnalysis,
    KbPassage,
    OutlineSection,
    ResearchResult,

    // Writer Agent
    ShotListItem,
    ArticleMetadata,
    WriterResult,

    // QA Agent
    IssueSeverity,
    QaRecommendation,
    QaIssue,
    DimensionResult,
    QaValidationResult,

    // Step Functions state shapes
    ResearchHandlerInput,
    WriterHandlerInput,
    QaHandlerInput,
    PipelineOutput,
} from './types.js';

// ─── Structured Logger ───────────────────────────────────────────────────────
export { log, createLogger } from './logger.js';

export type { LogLevel, LogFunction } from './logger.js';

// ─── EMF Metric Emission ─────────────────────────────────────────────────────
export { emitEmfMetric } from './emf.js';

export type { EmfMetricEntry } from './emf.js';
