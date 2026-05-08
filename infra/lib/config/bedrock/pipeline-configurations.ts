/**
 * @format
 * Bedrock Pipeline - Resource Configurations
 *
 * Pipeline behaviour: S3 prefixes, log retention, removal policy.
 * Configurations are "how it behaves" — policies, prefixes, retention.
 *
 * Usage:
 * ```typescript
 * import { getPipelineConfigs } from '../../config/bedrock/pipeline-configurations';
 * const configs = getPipelineConfigs(Environment.DEVELOPMENT);
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * S3 prefix configuration for the multi-agent pipeline.
 */
export interface PipelineS3Config {
    /** S3 key prefix for raw draft markdown files */
    readonly draftPrefix: string;
    /** S3 key prefix for QA-reviewed articles awaiting approval */
    readonly reviewPrefix: string;
    /** S3 key prefix for approved, published MDX output */
    readonly publishedPrefix: string;
    /** S3 key prefix for versioned content blobs */
    readonly contentPrefix: string;
    /** S3 key prefix for archived/rejected articles */
    readonly archivedPrefix: string;
}

/**
 * Complete pipeline configurations.
 */
export interface PipelineConfigs {
    /** S3 prefix settings */
    readonly s3: PipelineS3Config;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for ephemeral resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** ISR revalidation endpoint URL (optional) */
    readonly isrEndpoint?: string;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

export const PIPELINE_CONFIGS: Record<DeployableEnvironment, PipelineConfigs> = {
    [Environment.DEVELOPMENT]: {
        s3: {
            draftPrefix: 'drafts/',
            reviewPrefix: 'review/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            archivedPrefix: 'archived/',
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.STAGING]: {
        s3: {
            draftPrefix: 'drafts/',
            reviewPrefix: 'review/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            archivedPrefix: 'archived/',
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.PRODUCTION]: {
        s3: {
            draftPrefix: 'drafts/',
            reviewPrefix: 'review/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            archivedPrefix: 'archived/',
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get pipeline configurations for an environment.
 *
 * @param env - Target environment
 * @returns Pipeline configurations
 */
export function getPipelineConfigs(env: Environment): PipelineConfigs {
    return PIPELINE_CONFIGS[env as DeployableEnvironment];
}
