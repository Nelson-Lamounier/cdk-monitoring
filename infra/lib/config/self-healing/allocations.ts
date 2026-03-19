/**
 * @format
 * Self-Healing Project — Resource Allocations
 *
 * Centralised resource allocations by environment.
 * Allocations are "how much" — Lambda sizing, timeouts, throttling.
 *
 * Usage:
 * ```typescript
 * import { getSelfHealingAllocations } from '../../config/self-healing';
 * const allocs = getSelfHealingAllocations(Environment.DEVELOPMENT);
 * const mem = allocs.agentLambda.memoryMb; // 512
 * ```
 */

import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Lambda allocation for the Strands Agent handler
 */
export interface AgentLambdaAllocation {
    /** Lambda memory in MB */
    readonly memoryMb: number;
    /** Lambda timeout in seconds (agent loops may take longer than typical handlers) */
    readonly timeoutSeconds: number;
    /** Reserved concurrent executions (caps parallel Bedrock agent calls) */
    readonly reservedConcurrency: number;
}

/**
 * AgentCore Gateway throttling allocation
 */
export interface GatewayAllocation {
    /** Sustained request rate limit (requests/second) */
    readonly throttlingRateLimit: number;
    /** Burst capacity (maximum concurrent requests) */
    readonly throttlingBurstLimit: number;
}

/**
 * Complete resource allocations for the Self-Healing project
 */
export interface SelfHealingAllocations {
    readonly agentLambda: AgentLambdaAllocation;
    readonly gateway: GatewayAllocation;
    /** DLQ message retention in days */
    readonly dlqRetentionDays: number;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Self-Healing resource allocations by environment.
 *
 * Agent Lambda needs higher memory and longer timeouts than typical handlers
 * because the Strands agentic loop involves multiple LLM round-trips and
 * tool invocations per execution.
 */
export const SELF_HEALING_ALLOCATIONS: Record<Environment, SelfHealingAllocations> = {
    [Environment.DEVELOPMENT]: {
        agentLambda: {
            memoryMb: 512,
            timeoutSeconds: 120,  // 2 minutes — sufficient for 3–4 tool calls
            reservedConcurrency: 1, // Strict cap — one agent at a time in dev
        },
        gateway: {
            throttlingRateLimit: 5,
            throttlingBurstLimit: 10,
        },
        dlqRetentionDays: 7,
    },

    [Environment.STAGING]: {
        agentLambda: {
            memoryMb: 1024,
            timeoutSeconds: 180,  // 3 minutes
            reservedConcurrency: 2,
        },
        gateway: {
            throttlingRateLimit: 10,
            throttlingBurstLimit: 20,
        },
        dlqRetentionDays: 14,
    },

    [Environment.PRODUCTION]: {
        agentLambda: {
            memoryMb: 1024,
            timeoutSeconds: 300,  // 5 minutes — allows complex multi-tool remediation
            reservedConcurrency: 2,
        },
        gateway: {
            throttlingRateLimit: 20,
            throttlingBurstLimit: 40,
        },
        dlqRetentionDays: 14,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Self-Healing allocations for an environment
 */
export function getSelfHealingAllocations(env: Environment): SelfHealingAllocations {
    return SELF_HEALING_ALLOCATIONS[env];
}
