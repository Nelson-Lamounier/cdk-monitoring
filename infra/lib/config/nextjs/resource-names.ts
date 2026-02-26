/**
 * @format
 * NextJS Shared Resource Naming Constants
 *
 * Single source of truth for resource names used across multiple stacks.
 * Both the data stack (which creates resources) and the factory (which
 * constructs IAM ARNs) import from here — preventing silent naming drift.
 */

import { Environment } from '../environments';

// =========================================================================
// Raw name stems (the middle segment passed to CDK constructs)
// =========================================================================

/** DynamoDB table name stem (used by DynamoDbTableConstruct) */
export const DYNAMO_TABLE_STEM = 'personal-portfolio';

/** S3 assets bucket purpose stem (used by S3BucketConstruct) */
export const ASSETS_BUCKET_STEM = 'article-assets';

// =========================================================================
// Fully-qualified names (for IAM ARN construction)
// =========================================================================

/**
 * Resolved resource names for a given environment.
 */
export interface NextjsResourceNames {
    /**
     * Full DynamoDB table name: `{namePrefix}-personal-portfolio-{env}`
     * Matches what DynamoDbTableConstruct creates internally.
     */
    readonly dynamoTableName: string;
    /**
     * Full S3 assets bucket name: `{namePrefix}-article-assets-{env}`
     * Matches what S3BucketConstruct creates.
     */
    readonly assetsBucketName: string;
}

/**
 * Build deterministic, fully-qualified resource names for a Next.js environment.
 * Use these for IAM ARN patterns in the factory / compute stack.
 *
 * @param namePrefix - Project name prefix (e.g. 'nextjs')
 * @param environment - Target deployment environment
 *
 * @example
 * ```typescript
 * const names = nextjsResourceNames('nextjs', Environment.DEVELOPMENT);
 * names.dynamoTableName  // 'nextjs-personal-portfolio-development'
 * names.assetsBucketName // 'nextjs-article-assets-development'
 * ```
 */
export function nextjsResourceNames(
    namePrefix: string,
    environment: Environment,
): NextjsResourceNames {
    return {
        dynamoTableName: `${namePrefix}-${DYNAMO_TABLE_STEM}-${environment}`,
        assetsBucketName: `${namePrefix}-${ASSETS_BUCKET_STEM}-${environment}`,
    };
}
