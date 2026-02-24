/**
 * @format
 * Environment Configurations
 *
 * Cross-project environment identity: account, region, and shared utilities.
 * Uses enum for type safety as recommended by AWS CDK best practices.
 *
 * Project-specific resource behavior (policies, throttles, retention) belongs in:
 * - lib/config/monitoring/configurations.ts
 * - lib/config/nextjs/configurations.ts
 *
 * IMPORTANT: Environment values use FULL NAMES to match GitHub Environments:
 * - development (not 'dev')
 * - staging
 * - production (not 'prod')
 *
 * This ensures consistency across:
 * - GitHub Environments (secrets/variables)
 * - CDK CLI commands
 * - Stack names
 * - Pipeline workflows
 */

import * as cdk from 'aws-cdk-lib/core';

// =============================================================================
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

/**
 * Read a value from process.env at synth time.
 * Returns undefined if the variable is not set.
 */
function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

// =============================================================================
// ENVIRONMENT ENUM & RESOLUTION
// =============================================================================

/**
 * Environment enum - centralized definition for all environments.
 * Uses full names to match GitHub Environments.
 *
 * @example
 * import { Environment } from '../lib/config';
 * const env = Environment.DEVELOPMENT;
 *
 * // CLI usage:
 * // npx cdk deploy -c project=monitoring -c environment=development
 */
export enum Environment {
    DEVELOPMENT = 'development',
    STAGING = 'staging',
    PRODUCTION = 'production',
}

/**
 * Mapping from short names to full names for backward compatibility
 * Allows: -c environment=dev OR -c environment=development
 */
const SHORT_TO_FULL: Record<string, Environment> = {
    dev: Environment.DEVELOPMENT,
    staging: Environment.STAGING,
    prod: Environment.PRODUCTION,
};

/**
 * String union type derived from the Environment enum.
 * Prefer using the Environment enum directly for type safety.
 */
export type EnvironmentName = `${Environment}`;

// =============================================================================
// CROSS-PROJECT IDENTITY
// =============================================================================

/**
 * Cross-project environment identity.
 * Only contains values that are truly shared across ALL projects.
 * Project-specific resource behavior belongs in project config files.
 */
export interface EnvironmentConfig {
    /** AWS account ID for this environment */
    readonly account: string;
    /** Primary AWS region (default: eu-west-1) */
    readonly region: string;
    /** Edge region for CloudFront/ACM/WAF resources (always us-east-1) */
    readonly edgeRegion: string;
}

/**
 * Environment configurations — cross-project identity.
 * Each environment targets a dedicated AWS account.
 *
 * IMPORTANT: The primary region is hardcoded, NOT derived from
 * CDK_DEFAULT_REGION. When the Edge deploy job configures AWS credentials
 * for us-east-1, CDK_DEFAULT_REGION also becomes us-east-1, which would
 * cause SSM cross-region readers in the Edge stack to look in the wrong
 * region for ALB DNS and assets bucket parameters.
 */
const environments: Record<Environment, EnvironmentConfig> = {
    [Environment.DEVELOPMENT]: {
        account: '771826808455',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.STAGING]: {
        account: '692738841103',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.PRODUCTION]: {
        account: '607700977986',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
};

/**
 * Get environment configuration (cross-project identity)
 */
export function getEnvironmentConfig(env: Environment): EnvironmentConfig {
    return environments[env];
}

/**
 * Get CDK environment (account + region) for stack props.
 * Returns the per-environment account and region, ready for use as
 * the `env` prop in CDK stack instantiation.
 */
export function cdkEnvironment(env: Environment): cdk.Environment {
    const config = environments[env];
    return {
        account: config.account,
        region: config.region,
    };
}

/**
 * Get CDK environment for edge stacks (CloudFront, ACM, WAF).
 * These resources MUST be deployed in us-east-1.
 * Uses the same account as the environment but the edge region.
 */
export function cdkEdgeEnvironment(env: Environment): cdk.Environment {
    const config = environments[env];
    return {
        account: config.account,
        region: config.edgeRegion,
    };
}

// =============================================================================
// ENVIRONMENT UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if an environment is production.
 * Use this instead of inline `env === Environment.PRODUCTION` comparisons.
 */
export function isProductionEnvironment(env: Environment): boolean {
    return env === Environment.PRODUCTION;
}

/**
 * Get the CDK removal policy for an environment.
 * Production retains resources; non-production allows destruction.
 */
export function environmentRemovalPolicy(env: Environment): cdk.RemovalPolicy {
    return env === Environment.PRODUCTION
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;
}

/**
 * Resolve environment from context value.
 * Accepts both full names (development, staging, production) and
 * short names (dev, staging, prod) for backward compatibility.
 *
 * @param contextValue - Value from CDK context or environment variable
 * @returns Resolved Environment enum value
 *
 * @example
 * resolveEnvironment('development') // => Environment.DEVELOPMENT
 * resolveEnvironment('dev')         // => Environment.DEVELOPMENT
 * resolveEnvironment('prod')        // => Environment.PRODUCTION
 */
export function resolveEnvironment(contextValue?: string): Environment {
    const envValue = contextValue ?? fromEnv('ENVIRONMENT') ?? Environment.DEVELOPMENT;

    // Check if it's already a valid full environment name
    if (Object.values(Environment).includes(envValue as Environment)) {
        return envValue as Environment;
    }

    // Check if it's a short name and map to full name
    if (envValue in SHORT_TO_FULL) {
        const fullName = SHORT_TO_FULL[envValue];
        console.log(`Mapping short environment name '${envValue}' to '${fullName}'`);
        return fullName;
    }

    console.warn(`Unknown environment '${envValue}', defaulting to '${Environment.DEVELOPMENT}'`);
    return Environment.DEVELOPMENT;
}

/**
 * Check if a value is a valid Environment (accepts both full and short names)
 */
export function isValidEnvironment(value: string): value is Environment {
    // Check full names
    if (Object.values(Environment).includes(value as Environment)) {
        return true;
    }
    // Check short names
    return value in SHORT_TO_FULL;
}
