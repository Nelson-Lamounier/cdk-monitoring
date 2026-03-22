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
 * const model = allocs.foundationModel; // 'eu.anthropic.claude-sonnet-4-6'
 * ```
 */

import { type DeployableEnvironment, Environment } from '../environments';

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
 * Knowledge Base allocation
 */
export interface KnowledgeBaseAllocation {
    /** Embedding model ID for vector generation */
    readonly embeddingsModel: string;
    /** Pinecone index connection string */
    readonly pineconeConnectionString: string;
    /** Pinecone namespace for data isolation */
    readonly pineconeNamespace: string;
}

/**
 * API Gateway throttling allocation
 */
export interface ApiGatewayAllocation {
    /** Sustained request rate limit (requests/second) */
    readonly throttlingRateLimit: number;
    /** Burst capacity (maximum concurrent requests) */
    readonly throttlingBurstLimit: number;
}

/**
 * Complete resource allocations for Bedrock project
 */
export interface BedrockAllocations {
    readonly agent: AgentAllocation;
    readonly knowledgeBase: KnowledgeBaseAllocation;
    readonly actionGroupLambda: ActionGroupLambdaAllocation;
    readonly apiLambda: ApiLambdaAllocation;
    readonly apiGateway: ApiGatewayAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource allocations by environment
 */
export const BEDROCK_ALLOCATIONS: Record<DeployableEnvironment, BedrockAllocations> = {
    [Environment.DEVELOPMENT]: {
        agent: {
            foundationModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
            idleSessionTtlInSeconds: 600, // 10 minutes
        },
        knowledgeBase: {
            embeddingsModel: 'amazon.titan-embed-text-v2:0',
            pineconeConnectionString: 'https://portfolio-kb-79dyhsi.svc.aped-4627-b74a.pinecone.io',
            pineconeNamespace: 'portfolio-dev',
        },
        actionGroupLambda: {
            memoryMb: 256,
            timeoutSeconds: 30,
        },
        apiLambda: {
            memoryMb: 256,
            timeoutSeconds: 60,
        },
        apiGateway: {
            throttlingRateLimit: 10,
            throttlingBurstLimit: 20,
        },
    },

    [Environment.STAGING]: {
        agent: {
            foundationModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
            idleSessionTtlInSeconds: 900, // 15 minutes
        },
        knowledgeBase: {
            embeddingsModel: 'amazon.titan-embed-text-v2:0',
            pineconeConnectionString: 'https://portfolio-kb-79dyhsi.svc.aped-4627-b74a.pinecone.io',
            pineconeNamespace: 'portfolio-stg',
        },
        actionGroupLambda: {
            memoryMb: 512,
            timeoutSeconds: 30,
        },
        apiLambda: {
            memoryMb: 512,
            timeoutSeconds: 60,
        },
        apiGateway: {
            throttlingRateLimit: 50,
            throttlingBurstLimit: 100,
        },
    },

    [Environment.PRODUCTION]: {
        agent: {
            foundationModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
            idleSessionTtlInSeconds: 1800, // 30 minutes
        },
        knowledgeBase: {
            embeddingsModel: 'amazon.titan-embed-text-v2:0',
            pineconeConnectionString: 'https://portfolio-kb-79dyhsi.svc.aped-4627-b74a.pinecone.io',
            pineconeNamespace: 'portfolio-prd',
        },
        actionGroupLambda: {
            memoryMb: 1024,
            timeoutSeconds: 60,
        },
        apiLambda: {
            memoryMb: 1024,
            timeoutSeconds: 120,
        },
        apiGateway: {
            throttlingRateLimit: 100,
            throttlingBurstLimit: 200,
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
    return BEDROCK_ALLOCATIONS[env as DeployableEnvironment];
}
