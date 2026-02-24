/**
 * @format
 * S3 Bucket Construct
 *
 * Reusable S3 bucket construct with security best practices.
 *
 * Features:
 * - Encryption at rest (SSE-S3 or SSE-KMS)
 * - Block all public access by default
 * - Versioning (environment-aware defaults)
 * - Lifecycle rules for cost optimization
 * - Access logging (optional)
 * - CORS configuration (optional)
 * - Automatic environment-appropriate settings
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment, isProductionEnvironment, environmentRemovalPolicy } from '../../config';

// =============================================================================
// Configuration Interface
// =============================================================================

/**
 * S3 Bucket Configuration
 */
export interface S3BucketConfig {
    /**
     * Unique bucket name
     * Must be globally unique across AWS
     */
    readonly bucketName: string;

    /**
     * Bucket purpose (for tagging)
     */
    readonly purpose: string;

    /**
     * Encryption type
     * @default S3_MANAGED (SSE-S3)
     */
    readonly encryption?: s3.BucketEncryption;

    /**
     * KMS key for encryption (only used if encryption is KMS)
     */
    readonly encryptionKey?: kms.IKey;

    /**
     * Enable versioning
     * @default false for dev, true for prod
     */
    readonly versioned?: boolean;

    /**
     * Lifecycle rules for automatic object expiration
     */
    readonly lifecycleRules?: s3.LifecycleRule[];

    /**
     * Removal policy
     * @default DESTROY for dev, RETAIN for prod
     */
    readonly removalPolicy?: cdk.RemovalPolicy;

    /**
     * Enable auto-delete objects on stack deletion
     * @default true for dev, false for prod
     */
    readonly autoDeleteObjects?: boolean;

    /**
     * Block all public access
     * @default BLOCK_ALL
     */
    readonly blockPublicAccess?: s3.BlockPublicAccess;

    /**
     * Access logs bucket
     */
    readonly accessLogsBucket?: s3.IBucket;

    /**
     * Access logs prefix
     */
    readonly accessLogsPrefix?: string;

    /**
     * CORS rules for cross-origin access
     */
    readonly cors?: s3.CorsRule[];
}

// =============================================================================
// Props
// =============================================================================

/**
 * Props for S3BucketConstruct
 */
export interface S3BucketConstructProps {
    /** Target environment */
    readonly environment: Environment;

    /** Bucket configuration */
    readonly config: S3BucketConfig;

    /** Name prefix @default 's3' */
    readonly namePrefix?: string;
}

// =============================================================================
// Construct
// =============================================================================

/**
 * S3 Bucket Construct
 *
 * Creates an S3 bucket with security best practices and environment-appropriate
 * defaults.
 *
 * @example
 * ```typescript
 * const bucket = new S3BucketConstruct(this, 'LogsBucket', {
 *     environment: Environment.PRODUCTION,
 *     config: {
 *         bucketName: `app-logs-${stack.account}`,
 *         purpose: 'Application Logs',
 *         versioned: true,
 *         lifecycleRules: [{
 *             id: 'ArchiveOldLogs',
 *             enabled: true,
 *             transitions: [{
 *                 storageClass: s3.StorageClass.GLACIER,
 *                 transitionAfter: cdk.Duration.days(90),
 *             }],
 *             expiration: cdk.Duration.days(365),
 *         }],
 *     },
 * });
 * ```
 */
export class S3BucketConstruct extends Construct {
    /** The S3 bucket */
    public readonly bucket: s3.Bucket;

    /** Bucket name */
    public readonly bucketName: string;

    /** Bucket ARN */
    public readonly bucketArn: string;

    /** Target environment */
    public readonly environment: Environment;

    constructor(scope: Construct, id: string, props: S3BucketConstructProps) {
        super(scope, id);

        const { environment, config } = props;
        this.environment = environment;

        // ========================================
        // CONFIGURATION (using centralized config)
        // ========================================
        const envRemovalPolicy = environmentRemovalPolicy(environment);
        const isProduction = isProductionEnvironment(environment);

        // Resolve with environment-appropriate defaults
        const encryption = config.encryption ?? s3.BucketEncryption.S3_MANAGED;
        const versioned = config.versioned ?? isProduction;
        const removalPolicy = config.removalPolicy ?? envRemovalPolicy;
        const autoDeleteObjects = config.autoDeleteObjects
            ?? (!isProduction && removalPolicy === cdk.RemovalPolicy.DESTROY);
        const blockPublicAccess = config.blockPublicAccess ?? s3.BlockPublicAccess.BLOCK_ALL;

        // ========================================
        // VALIDATION
        // ========================================
        if (!cdk.Token.isUnresolved(config.bucketName)) {
            this.validateBucketName(config.bucketName);
        }

        // ========================================
        // S3 BUCKET
        // ========================================
        this.bucket = new s3.Bucket(this, 'Bucket', {
            bucketName: config.bucketName,
            encryption,
            encryptionKey: config.encryptionKey,
            versioned,
            removalPolicy,
            autoDeleteObjects,
            blockPublicAccess,
            enforceSSL: true,
            cors: config.cors,
            lifecycleRules: config.lifecycleRules,
            serverAccessLogsBucket: config.accessLogsBucket,
            serverAccessLogsPrefix: config.accessLogsPrefix,
        });

        this.bucketName = config.bucketName;
        this.bucketArn = this.bucket.bucketArn;

        // ========================================
        // OUTPUTS
        // ========================================
        new cdk.CfnOutput(this, 'BucketName', {
            value: this.bucket.bucketName,
            description: `S3 bucket name for ${config.purpose}`,
        });

        new cdk.CfnOutput(this, 'BucketArn', {
            value: this.bucket.bucketArn,
            description: `S3 bucket ARN for ${config.purpose}`,
        });

        // ========================================
        // COMPONENT-SPECIFIC TAGS
        // (Environment/Project/ManagedBy via TaggingAspect)
        // ========================================
        cdk.Tags.of(this.bucket).add('Component', 'S3-Bucket');
        cdk.Tags.of(this.bucket).add('Purpose', config.purpose);

        // ========================================
        // PRODUCTION WARNINGS
        // ========================================
        if (isProduction) {
            if (removalPolicy === cdk.RemovalPolicy.DESTROY) {
                cdk.Annotations.of(this).addWarning(
                    `Production bucket ${config.bucketName} has DESTROY removal policy. ` +
                    'Consider using RETAIN to prevent accidental data loss.',
                );
            }

            if (!versioned) {
                cdk.Annotations.of(this).addWarning(
                    `Production bucket ${config.bucketName} has versioning disabled. ` +
                    'Enable versioning to protect against accidental deletions.',
                );
            }

            if (encryption === s3.BucketEncryption.UNENCRYPTED) {
                cdk.Annotations.of(this).addError(
                    `Production bucket ${config.bucketName} is unencrypted. ` +
                    'Encryption is required for production buckets.',
                );
            }
        }
    }

    // =========================================================================
    // VALIDATION
    // =========================================================================

    /**
     * Validate bucket name meets S3 requirements
     */
    private validateBucketName(bucketName: string): void {
        if (!bucketName || bucketName.length < 3 || bucketName.length > 63) {
            throw new Error(
                `Invalid bucket name: ${bucketName}. ` +
                `Must be between 3 and 63 characters (got ${bucketName?.length ?? 0}).`,
            );
        }

        const bucketNameRegex = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
        if (!bucketNameRegex.test(bucketName)) {
            throw new Error(
                `Invalid bucket name: ${bucketName}. ` +
                'Must use lowercase letters, numbers, hyphens, and periods. ' +
                'Must start and end with letter or number.',
            );
        }

        if (bucketName.includes('..')) {
            throw new Error(
                `Invalid bucket name: ${bucketName}. ` +
                'Cannot contain consecutive periods.',
            );
        }
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /**
     * Grant read permissions to a principal
     */
    public grantRead(identity: iam.IGrantable): iam.Grant {
        return this.bucket.grantRead(identity);
    }

    /**
     * Grant write permissions to a principal
     */
    public grantWrite(identity: iam.IGrantable): iam.Grant {
        return this.bucket.grantWrite(identity);
    }

    /**
     * Grant read/write permissions to a principal
     */
    public grantReadWrite(identity: iam.IGrantable): iam.Grant {
        return this.bucket.grantReadWrite(identity);
    }

    /**
     * Grant delete permissions to a principal
     */
    public grantDelete(identity: iam.IGrantable): iam.Grant {
        return this.bucket.grantDelete(identity);
    }
}
