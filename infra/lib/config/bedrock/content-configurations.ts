/**
 * @format
 * Bedrock Content Pipeline - Resource Configurations
 *
 * Pipeline behaviour: S3 prefixes, DynamoDB settings, log retention.
 * Configurations are "how it behaves" — policies, prefixes, retention.
 *
 * Usage:
 * ```typescript
 * import { getContentConfigs } from '../../config/bedrock';
 * const configs = getContentConfigs(Environment.PRODUCTION);
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * S3 prefix configuration for the content pipeline
 */
export interface ContentS3Config {
    /** S3 key prefix for raw draft markdown files */
    readonly draftPrefix: string;
    /** S3 key prefix for published MDX output */
    readonly publishedPrefix: string;
    /** S3 key prefix for versioned content blobs (Metadata Brain) */
    readonly contentPrefix: string;
    /** S3 object suffix filter for event notifications */
    readonly draftSuffix: string;
}

/**
 * Complete resource configurations for the content pipeline
 */
export interface ContentConfigs {
    /** S3 prefix settings */
    readonly s3: ContentS3Config;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

export const CONTENT_CONFIGS: Record<Environment, ContentConfigs> = {
    [Environment.DEVELOPMENT]: {
        s3: {
            draftPrefix: 'drafts/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            draftSuffix: '.md',
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.STAGING]: {
        s3: {
            draftPrefix: 'drafts/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            draftSuffix: '.md',
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.PRODUCTION]: {
        s3: {
            draftPrefix: 'drafts/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            draftSuffix: '.md',
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get content pipeline configurations for an environment
 */
export function getContentConfigs(env: Environment): ContentConfigs {
    return CONTENT_CONFIGS[env];
}
