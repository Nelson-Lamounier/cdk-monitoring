/**
 * @format
 * Bedrock Content Pipeline - Resource Allocations
 *
 * Lambda sizing and Bedrock model budget for the MD-to-Blog pipeline.
 * Allocations are "how much" — memory, timeout, thinking budget.
 *
 * Usage:
 * ```typescript
 * import { getContentAllocations } from '../../config/bedrock';
 * const allocs = getContentAllocations(Environment.PRODUCTION);
 * ```
 */

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Lambda allocation for the content pipeline handler
 */
export interface ContentLambdaAllocation {
    /** Lambda memory in MB */
    readonly memoryMb: number;
    /** Lambda timeout in seconds */
    readonly timeoutSeconds: number;
    /** Reserved concurrent executions (caps parallel Bedrock calls) */
    readonly reservedConcurrency: number;
}

/**
 * Bedrock model allocation for content generation
 */
export interface ContentModelAllocation {
    /** Foundation model ID */
    readonly foundationModel: string;
    /** Maximum output tokens for the Converse API response */
    readonly maxTokens: number;
    /** Adaptive Thinking budget tokens */
    readonly thinkingBudgetTokens: number;
}

/**
 * Complete resource allocations for the content pipeline
 */
export interface ContentAllocations {
    readonly lambda: ContentLambdaAllocation;
    readonly model: ContentModelAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

export const CONTENT_ALLOCATIONS: Record<DeployableEnvironment, ContentAllocations> = {
    [Environment.DEVELOPMENT]: {
        lambda: {
            memoryMb: 512,
            timeoutSeconds: 300,
            reservedConcurrency: 2,
        },
        model: {
            foundationModel: 'eu.anthropic.claude-sonnet-4-6',
            maxTokens: 16384,
            thinkingBudgetTokens: 4096,
        },
    },

    [Environment.STAGING]: {
        lambda: {
            memoryMb: 1024,
            timeoutSeconds: 300,
            reservedConcurrency: 3,
        },
        model: {
            foundationModel: 'eu.anthropic.claude-sonnet-4-6',
            maxTokens: 16384,
            thinkingBudgetTokens: 10240,
        },
    },

    [Environment.PRODUCTION]: {
        lambda: {
            memoryMb: 1024,
            timeoutSeconds: 300,
            reservedConcurrency: 5,
        },
        model: {
            foundationModel: 'eu.anthropic.claude-sonnet-4-6',
            maxTokens: 16384,
            thinkingBudgetTokens: 16000,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get content pipeline allocations for an environment
 */
export function getContentAllocations(env: Environment): ContentAllocations {
    return CONTENT_ALLOCATIONS[env as DeployableEnvironment];
}
