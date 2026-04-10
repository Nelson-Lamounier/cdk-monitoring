/**
 * @format
 * AI Content Stack — Data Layer
 *
 * Manages the DynamoDB article metadata table and SSM parameter exports
 * for the Bedrock content pipeline.
 *
 * DynamoDB entity schema:
 *   pk: ARTICLE#<slug>
 *   sk: METADATA          — latest AI-enhanced metadata + s3Key pointer
 *   sk: CONTENT#v<ts>     — versioned content pointer with s3Key
 *
 * Content blobs are stored in S3 at content/v{n}/<slug>.mdx.
 *
 * The multi-agent Pipeline stack (BedrockPipelineStack) handles article
 * generation via Step Functions. The admin dashboard triggers executions.
 *
 * @deprecated The monolith Lambda publisher has been removed. Article
 * generation is now handled by BedrockPipelineStack (Step Functions).
 * This stack is retained for the DynamoDB table and SSM exports.
 */

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for AiContentStack (Data Layer)
 *
 * After the monolith deprecation, this stack only creates the DynamoDB
 * table, SSM parameter exports, and grant helpers. Lambda/Bedrock/SQS
 * configuration has moved to BedrockPipelineStack.
 */
export interface AiContentStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Name of the S3 bucket for content blobs (from DataStack) */
    readonly assetsBucketName: string;
    /** S3 key prefix for published MDX output */
    readonly publishedPrefix: string;
    /** S3 key prefix for versioned content blobs (Metadata Brain) */
    readonly contentPrefix: string;
    /** CloudWatch log retention (kept for any future stack-level logging) */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Runtime environment name (e.g. 'development') */
    readonly environmentName: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * AI Content Stack — Data Layer.
 *
 * Creates:
 * - DynamoDB table for AI-enhanced article metadata (Metadata Brain model)
 * - SSM parameter exports for cross-stack consumption
 * - Grant helper for consumer applications (Next.js on K8s)
 *
 * Article generation is handled by BedrockPipelineStack (Step Functions).
 */
export class AiContentStack extends cdk.Stack {
    /** DynamoDB table for AI-enhanced article metadata */
    public readonly contentTable: dynamodb.TableV2;

    /** The S3 bucket (for grantContentRead) */
    private readonly assetsBucket: s3.IBucket;

    /** The content prefix (for grantContentRead) */
    private readonly contentPrefix: string;

    /** Table name (for cross-stack consumption) */
    public readonly tableName: string;

    constructor(scope: Construct, id: string, props: AiContentStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;
        this.contentPrefix = props.contentPrefix;

        // Import the bucket by name to avoid cross-stack notification handler
        // placement, which causes cyclic dependencies (Data ↔ Content).
        const assetsBucket = s3.Bucket.fromBucketName(
            this,
            'ImportedAssetsBucket',
            props.assetsBucketName,
        );
        this.assetsBucket = assetsBucket;

        // =================================================================
        // DynamoDB — Article Metadata Table (Metadata Brain)
        //
        // pk: ARTICLE#<slug>  (e.g. 'ARTICLE#deploying-k8s-on-aws')
        // sk: METADATA        (latest AI-enhanced metadata)
        // sk: CONTENT#v<ts>   (versioned content pointer)
        //
        // GSI: gsi1-status-date
        //   gsi1pk: STATUS#published    → groups articles by status
        //   gsi1sk: YYYY-MM-DD#<slug>   → date + slug for sort order
        //   Query: all published articles, newest first (frontend listing)
        //
        // Content blobs live in S3 — table stores only s3Key pointers,
        // AI summaries, reading time, and technical confidence scores.
        // =================================================================
        this.contentTable = new dynamodb.TableV2(this, 'AiContentTable', {
            tableName: `${namePrefix}-ai-content`,
            partitionKey: {
                name: 'pk',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'sk',
                type: dynamodb.AttributeType.STRING,
            },
            billing: dynamodb.Billing.onDemand(),
            pointInTimeRecovery: true,
            removalPolicy: props.removalPolicy,
        });

        // GSIs must be added via addGlobalSecondaryIndex() on Table
        this.contentTable.addGlobalSecondaryIndex({
            indexName: 'gsi1-status-date',
            partitionKey: {
                name: 'gsi1pk',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'gsi1sk',
                type: dynamodb.AttributeType.STRING,
            },
            // ALL projection — frontend listing needs title, tags,
            // aiSummary, readingTime etc. without separate GetItem calls
            projectionType: dynamodb.ProjectionType.ALL,
        });

        this.contentTable.addGlobalSecondaryIndex({
            indexName: 'gsi2-tag-date',
            partitionKey: {
                name: 'gsi2pk',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'gsi2sk',
                type: dynamodb.AttributeType.STRING,
            },
            // ALL projection — tag filtering: gsi2pk=TAG#<tag>,
            // gsi2sk=<date>#<slug> for reverse-chronological tag pages
            projectionType: dynamodb.ProjectionType.ALL,
        });

        this.tableName = this.contentTable.tableName;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'ContentTableNameParam', {
            parameterName: `/${namePrefix}/content-table-name`,
            stringValue: this.contentTable.tableName,
            description: `AI Content metadata table name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ContentTableArnParam', {
            parameterName: `/${namePrefix}/content-table-arn`,
            stringValue: this.contentTable.tableArn,
            description: `AI Content table ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AssetsBucketNameParam', {
            parameterName: `/${namePrefix}/assets-bucket-name`,
            stringValue: this.assetsBucket.bucketName,
            description: `Assets bucket name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'PublishedPrefixParam', {
            parameterName: `/${namePrefix}/published-prefix`,
            stringValue: props.publishedPrefix,
            description: `S3 prefix for published MDX content`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'ContentTableName', {
            value: this.contentTable.tableName,
            description: 'AI Content metadata table name',
        });
    }

    // =====================================================================
    // PUBLIC GRANT HELPERS
    // =====================================================================

    /**
     * Grant read access to article content for a consuming application.
     *
     * This replaces the "God Mode" pattern with scoped, least-privilege
     * access. Grants:
     * - DynamoDB read (GetItem, Query, Scan) on the content table
     * - S3 read on the content/ prefix (versioned content blobs)
     *
     * Use this when the Next.js app on K8s needs to:
     * 1. Query ARTICLE#slug / METADATA from DynamoDB
     * 2. Fetch the MDX content blob from S3 using the s3Key pointer
     *
     * @param grantee - The IAM principal to grant read access to
     *
     * @example
     * ```typescript
     * contentStack.grantContentRead(k8sWorkerRole);
     * ```
     */
    public grantContentRead(grantee: iam.IGrantable): void {
        this.contentTable.grantReadData(grantee);
        this.assetsBucket.grantRead(grantee, `${this.contentPrefix}*`);
    }
}
