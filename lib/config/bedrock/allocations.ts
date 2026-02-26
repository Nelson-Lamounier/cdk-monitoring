/**
 * @format
 * Bedrock Project - Resource Allocations
 *
 * Centralized resource allocations by environment.
 * Allocations are "how much" - model selection, Lambda sizing, timeouts.
 *
 * Usage:
 * ```typescript
 * import { getBedrockAllocations } from '../../config/bedrock';
 * const allocs = getBedrockAllocations(Environment.PRODUCTION);
 * const model = allocs.foundationModel; // 'anthropic.claude-sonnet-4-6'
 * ```
 */

import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Bedrock Agent allocation
 */
export interface AgentAllocation {
    /** Foundation model ID for the Bedrock Agent */
    readonly foundationModel: string;
    /** Agent idle session timeout in seconds */
    readonly idleSessionTtlInSeconds: number;
}

/**
 * Lambda allocation for Action Group handlers
 */
export interface ActionGroupLambdaAllocation {
    /** Lambda memory in MB */
    readonly memoryMb: number;
    /** Lambda timeout in seconds */
    readonly timeoutSeconds: number;
}

/**
 * Lambda allocation for API invoke handler
 */
export interface ApiLambdaAllocation {
    /** Lambda memory in MB */
    readonly memoryMb: number;
    /** Lambda timeout in seconds */
    readonly timeoutSeconds: number;
}

/**
 * Complete resource allocations for Bedrock project
 */
export interface BedrockAllocations {
    readonly agent: AgentAllocation;
    readonly actionGroupLambda: ActionGroupLambdaAllocation;
    readonly apiLambda: ApiLambdaAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource allocations by environment
 */
export const BEDROCK_ALLOCATIONS: Record<Environment, BedrockAllocations> = {
    [Environment.DEVELOPMENT]: {
        agent: {
            foundationModel: 'anthropic.claude-sonnet-4-6',
            idleSessionTtlInSeconds: 600, // 10 minutes
        },
        actionGroupLambda: {
            memoryMb: 256,
            timeoutSeconds: 30,
        },
        apiLambda: {
            memoryMb: 256,
            timeoutSeconds: 60,
        },
    },

    [Environment.STAGING]: {
        agent: {
            foundationModel: 'anthropic.claude-sonnet-4-6',
            idleSessionTtlInSeconds: 900, // 15 minutes
        },
        actionGroupLambda: {
            memoryMb: 512,
            timeoutSeconds: 30,
        },
        apiLambda: {
            memoryMb: 512,
            timeoutSeconds: 60,
        },
    },

    [Environment.PRODUCTION]: {
        agent: {
            foundationModel: 'anthropic.claude-sonnet-4-6',
            idleSessionTtlInSeconds: 1800, // 30 minutes
        },
        actionGroupLambda: {
            memoryMb: 1024,
            timeoutSeconds: 60,
        },
        apiLambda: {
            memoryMb: 1024,
            timeoutSeconds: 120,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Bedrock allocations for an environment
 */
export function getBedrockAllocations(env: Environment): BedrockAllocations {
    return BEDROCK_ALLOCATIONS[env];
}
