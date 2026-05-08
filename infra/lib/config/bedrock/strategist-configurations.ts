/**
 * @format
 * Bedrock Strategist Pipeline — Resource Configurations
 *
 * Pipeline behaviour: log retention, removal policy, API settings.
 * Configurations are "how it behaves" — policies, throttles, origins.
 *
 * Usage:
 * ```typescript
 * import { getStrategistConfigs } from '../../config/bedrock/strategist-configurations';
 * const configs = getStrategistConfigs(Environment.PRODUCTION);
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * API Gateway configuration for the strategist pipeline.
 */
export interface StrategistApiConfig {
    /** Whether to require API key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins */
    readonly allowedOrigins: string[];
    /** Sustained request rate limit (requests/second) */
    readonly throttlingRateLimit: number;
    /** Burst capacity (maximum concurrent requests) */
    readonly throttlingBurstLimit: number;
}

/**
 * Complete resource configurations for the strategist pipeline.
 */
export interface StrategistConfigurations {
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** API Gateway configuration */
    readonly api: StrategistApiConfig;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

export const STRATEGIST_CONFIGS: Record<DeployableEnvironment, StrategistConfigurations> = {
    [Environment.DEVELOPMENT]: {
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        api: {
            enableApiKey: true,
            allowedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
            throttlingRateLimit: 5,
            throttlingBurstLimit: 10,
        },
    },

    [Environment.STAGING]: {
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://staging.nelsonlamounier.com'],
            throttlingRateLimit: 5,
            throttlingBurstLimit: 10,
        },
    },

    [Environment.PRODUCTION]: {
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com', 'https://www.nelsonlamounier.com'],
            throttlingRateLimit: 5,
            throttlingBurstLimit: 10,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get strategist pipeline configurations for an environment.
 *
 * @param env - Target environment
 * @returns Strategist pipeline configurations
 */
export function getStrategistConfigs(env: Environment): StrategistConfigurations {
    return STRATEGIST_CONFIGS[env as DeployableEnvironment];
}
