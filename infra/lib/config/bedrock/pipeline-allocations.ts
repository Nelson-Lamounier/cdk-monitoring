/**
 * @format
 * Bedrock Pipeline - Resource Allocations
 *
 * Lambda sizing and Bedrock model budget for the multi-agent pipeline.
 * Allocations are "how much" — memory, timeout, model selection.
 *
 * Usage:
 * ```typescript
 * import { getPipelineAllocations } from '../../config/bedrock/pipeline-allocations';
 * const allocs = getPipelineAllocations(Environment.DEVELOPMENT);
 * ```
 */

import { type DeployableEnvironment, Environment } from '../environments';
import { MODELS } from '../shared/model-registry';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Per-agent model allocation.
 */
export interface AgentModelAllocation {
    /** Foundation model ID for this agent */
    readonly modelId: string;
}

/**
 * Writer agent model allocation with token budgets.
 */
export interface WriterModelAllocation extends AgentModelAllocation {
    /** Maximum output tokens */
    readonly maxTokens: number;
    /** Adaptive Thinking budget tokens */
    readonly thinkingBudgetTokens: number;
}

/**
 * Lambda sizing for pipeline functions.
 */
export interface PipelineLambdaAllocation {
    /** Lambda memory in MB for agent Lambdas (Research, Writer, QA) */
    readonly agentMemoryMb: number;
    /** Lambda timeout in seconds for agent Lambdas */
    readonly agentTimeoutSeconds: number;
    /** Lambda memory in MB for the trigger function */
    readonly triggerMemoryMb: number;
    /** Lambda memory in MB for the publish function */
    readonly publishMemoryMb: number;
}

/**
 * Complete pipeline resource allocations.
 */
export interface PipelineAllocations {
    readonly lambda: PipelineLambdaAllocation;
    readonly research: AgentModelAllocation;
    readonly writer: WriterModelAllocation;
    readonly qa: AgentModelAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

export const PIPELINE_ALLOCATIONS: Record<DeployableEnvironment, PipelineAllocations> = {
    [Environment.DEVELOPMENT]: {
        lambda: {
            agentMemoryMb: 512,
            agentTimeoutSeconds: 300,
            triggerMemoryMb: 256,
            publishMemoryMb: 512,
        },
        research: {
            modelId: MODELS.ARTICLE_RESEARCH,
        },
        writer: {
            modelId: MODELS.ARTICLE_WRITER,
            maxTokens: 16384,
            thinkingBudgetTokens: 4096,
        },
        qa: {
            modelId: MODELS.ARTICLE_QA,
        },
    },

    [Environment.STAGING]: {
        lambda: {
            agentMemoryMb: 1024,
            agentTimeoutSeconds: 300,
            triggerMemoryMb: 256,
            publishMemoryMb: 512,
        },
        research: {
            modelId: MODELS.ARTICLE_RESEARCH,
        },
        writer: {
            modelId: MODELS.ARTICLE_WRITER,
            maxTokens: 16384,
            thinkingBudgetTokens: 10240,
        },
        qa: {
            modelId: MODELS.ARTICLE_QA,
        },
    },

    [Environment.PRODUCTION]: {
        lambda: {
            agentMemoryMb: 1024,
            agentTimeoutSeconds: 300,
            triggerMemoryMb: 256,
            publishMemoryMb: 512,
        },
        research: {
            modelId: MODELS.ARTICLE_RESEARCH,
        },
        writer: {
            modelId: MODELS.ARTICLE_WRITER,
            maxTokens: 16384,
            thinkingBudgetTokens: 16000,
        },
        qa: {
            modelId: MODELS.ARTICLE_QA,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get pipeline allocations for an environment.
 *
 * @param env - Target environment
 * @returns Pipeline resource allocations
 */
export function getPipelineAllocations(env: Environment): PipelineAllocations {
    return PIPELINE_ALLOCATIONS[env as DeployableEnvironment];
}
