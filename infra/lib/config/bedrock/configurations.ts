/**
 * @format
 * Bedrock Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, instructions) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getBedrockConfigs } from '../../config/bedrock';
 * const configs = getBedrockConfigs(Environment.PRODUCTION);
 * const instruction = configs.agentInstruction;
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Guardrail configuration
 */
export interface GuardrailConfig {
    /** Whether to enable content filtering */
    readonly enableContentFilters: boolean;
    /** Blocked input messaging */
    readonly blockedInputMessaging: string;
    /** Blocked output messaging */
    readonly blockedOutputMessaging: string;
}

/**
 * API Gateway configuration
 */
export interface ApiConfig {
    /** Whether to require API Key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins */
    readonly allowedOrigins: string[];
}

/**
 * Complete resource configurations for Bedrock project
 */
export interface BedrockConfigs {
    /** Agent instruction prompt — defines agent behavior */
    readonly agentInstruction: string;
    /** Agent description */
    readonly agentDescription: string;
    /** Guardrail configuration */
    readonly guardrail: GuardrailConfig;
    /** API Gateway configuration */
    readonly api: ApiConfig;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Whether to create customer-managed KMS keys */
    readonly createKmsKeys: boolean;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Bedrock resource configurations by environment
 */
export const BEDROCK_CONFIGS: Record<DeployableEnvironment, BedrockConfigs> = {
    [Environment.DEVELOPMENT]: {
        agentInstruction:
            'You are a helpful AI assistant for the portfolio application. ' +
            'You can answer questions about the portfolio, provide information ' +
            'about projects and skills, and help visitors navigate the site.',
        agentDescription: 'Portfolio AI assistant (development)',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['*'],
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.STAGING]: {
        agentInstruction:
            'You are a helpful AI assistant for the portfolio application. ' +
            'You can answer questions about the portfolio, provide information ' +
            'about projects and skills, and help visitors navigate the site.',
        agentDescription: 'Portfolio AI assistant (staging)',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://staging.nelsonlamounier.com'],
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        agentInstruction:
            'You are a helpful AI assistant for the portfolio application. ' +
            'You can answer questions about the portfolio, provide information ' +
            'about projects and skills, and help visitors navigate the site. ' +
            'Always be professional and accurate in your responses.',
        agentDescription: 'Portfolio AI assistant',
        guardrail: {
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputMessaging: 'Sorry, I cannot provide that response.',
        },
        api: {
            enableApiKey: true,
            allowedOrigins: ['https://nelsonlamounier.com'],
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Bedrock configurations for an environment
 */
export function getBedrockConfigs(env: Environment): BedrockConfigs {
    return BEDROCK_CONFIGS[env as DeployableEnvironment];
}
