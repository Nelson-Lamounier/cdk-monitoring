/**
 * @format
 * AI Content Stack
 *
 * Event-driven MD-to-Blog pipeline for the Bedrock project.
 * Transforms raw `.md` files uploaded to `drafts/` into polished `.mdx`
 * blog posts in `published/`, writing AI-enhanced metadata to DynamoDB.
 *
 * Architecture (Metadata Brain model):
 *   S3 (drafts/*.md) → Lambda (Converse API)
 *     → S3 (published/*.mdx + content/v{n}/*.mdx)
 *     → DynamoDB (ARTICLE#slug / METADATA + CONTENT#v{ts})
 *
 * DynamoDB stores only AI-enhanced metadata and an s3Key pointer.
 * Content blobs live in S3, bypassing the 400KB DynamoDB item limit.
 *
 * Uses Claude 4.6 Sonnet via the Bedrock Converse API with:
 * - Prompt Caching (cachePoint content blocks)
 * - Adaptive Thinking (inferenceConfig.thinking)
 */

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';
import * as path from 'path';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for AiContentStack
 */
export interface AiContentStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** The S3 bucket for raw drafts and published output (from DataStack) */
    readonly assetsBucket: s3.IBucket;
    /** S3 key prefix for raw draft markdown files */
    readonly draftPrefix: string;
    /** S3 key prefix for published MDX output */
    readonly publishedPrefix: string;
    /** S3 key prefix for versioned content blobs (Metadata Brain) */
    readonly contentPrefix: string;
    /** S3 object suffix filter for event notifications */
    readonly draftSuffix: string;
    /** Foundation model ID for Converse API */
    readonly foundationModel: string;
    /** Maximum output tokens */
    readonly maxTokens: number;
    /** Adaptive Thinking budget tokens */
    readonly thinkingBudgetTokens: number;
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * AI Content Stack — MD-to-Blog Agentic Pipeline (Metadata Brain).
 *
 * Creates:
 * - DynamoDB table for AI-enhanced article metadata (Metadata Brain model)
 * - Lambda function using Bedrock Converse API (Claude 4.6)
 * - S3 event notification on drafts/ prefix
 *
 * DynamoDB entity schema:
 *   pk: ARTICLE#<slug>
 *   sk: METADATA          — latest AI-enhanced metadata + s3Key pointer
 *   sk: CONTENT#v<ts>     — versioned content pointer with s3Key
 *
 * Content blobs are stored in S3 at content/v{n}/<slug>.mdx.
 */
export class AiContentStack extends cdk.Stack {
    /** DynamoDB table for AI-enhanced article metadata */
    public readonly contentTable: dynamodb.TableV2;

    /** Lambda function for content transformation */
    public readonly publisherFunction: lambdaNode.NodejsFunction;

    /** The S3 bucket (for grantContentRead) */
    private readonly assetsBucket: s3.IBucket;

    /** The content prefix (for grantContentRead) */
    private readonly contentPrefix: string;

    /** Table name (for SSM export) */
    public readonly tableName: string;

    constructor(scope: Construct, id: string, props: AiContentStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;
        this.assetsBucket = props.assetsBucket;
        this.contentPrefix = props.contentPrefix;

        // =================================================================
        // DynamoDB — Article Metadata Table (Metadata Brain)
        //
        // pk: ARTICLE#<slug>  (e.g. 'ARTICLE#deploying-k8s-on-aws')
        // sk: METADATA        (latest AI-enhanced metadata)
        // sk: CONTENT#v<ts>   (versioned content pointer)
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
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            removalPolicy: props.removalPolicy,
        });
        this.tableName = this.contentTable.tableName;

        // =================================================================
        // Lambda — Content Publisher (Bedrock Converse API)
        //
        // Uses NodejsFunction for esbuild bundling from the
        // bedrock-publisher package.
        //
        // ── VPC ISOLATION ROADMAP ──────────────────────────────────────
        // Currently runs OUTSIDE the VPC. All traffic (S3, DynamoDB,
        // Bedrock) uses public AWS endpoints over TLS. Data never leaves
        // the AWS backbone, but does not use VPC Endpoints.
        //
        // To enable full VPC isolation (IP never touches public internet):
        //
        // 1. SharedVpcStack — add ISOLATED subnets:
        //    subnetConfiguration: [
        //      { name: 'Public',  subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        //      { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        //    ]
        //
        // 2. SharedVpcStack — add Bedrock Runtime Interface Endpoint:
        //    vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
        //      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
        //      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        //      privateDnsEnabled: true,
        //    });
        //    Cost: ~$7.20/mo per AZ (2 AZs = ~$14.40/mo)
        //    S3 + DynamoDB Gateway Endpoints are already provisioned (free).
        //
        // 3. This Lambda — add VPC + subnet config:
        //    vpc: sharedVpc,
        //    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        //    (Import VPC via Vpc.fromLookup with 'shared-vpc-{env}' name tag)
        //
        // Note: PRIVATE_ISOLATED subnets have NO internet access at all.
        //       If the Lambda needs outbound internet (e.g., external APIs),
        //       use PRIVATE_WITH_EGRESS + a NAT Gateway (~$32/mo per AZ).
        // ───────────────────────────────────────────────────────────────
        this.publisherFunction = new lambdaNode.NodejsFunction(this, 'PublisherFunction', {
            functionName: `${namePrefix}-ai-publisher`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-publisher', 'src', 'index.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            environment: {
                ASSETS_BUCKET: props.assetsBucket.bucketName,
                DRAFT_PREFIX: props.draftPrefix,
                PUBLISHED_PREFIX: props.publishedPrefix,
                CONTENT_PREFIX: props.contentPrefix,
                TABLE_NAME: this.contentTable.tableName,
                FOUNDATION_MODEL: props.foundationModel,
                MAX_TOKENS: String(props.maxTokens),
                THINKING_BUDGET_TOKENS: String(props.thinkingBudgetTokens),
            },
            description: `MD-to-Blog publisher using ${props.foundationModel} for ${namePrefix}`,
            logGroup: new logs.LogGroup(this, 'PublisherLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-ai-publisher`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: [
                    // AWS SDK v3 is included in the Lambda runtime
                    '@aws-sdk/*',
                ],
            },
        });

        // =================================================================
        // IAM — Bedrock InvokeModel permission
        // =================================================================
        this.publisherFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'InvokeBedrockModel',
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
            ],
            resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/${props.foundationModel}`,
            ],
        }));

        // =================================================================
        // IAM — S3 read/write on specific prefixes
        //
        // Lambda reads from drafts/, writes to published/ AND content/
        // =================================================================
        props.assetsBucket.grantRead(this.publisherFunction, `${props.draftPrefix}*`);
        props.assetsBucket.grantWrite(this.publisherFunction, `${props.publishedPrefix}*`);
        props.assetsBucket.grantWrite(this.publisherFunction, `${props.contentPrefix}*`);

        // =================================================================
        // IAM — DynamoDB write access
        // =================================================================
        this.contentTable.grantWriteData(this.publisherFunction);

        // =================================================================
        // S3 Event Notification — Trigger on new drafts
        // =================================================================
        props.assetsBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(this.publisherFunction),
            {
                prefix: props.draftPrefix,
                suffix: props.draftSuffix,
            },
        );

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'ContentTableNameParam', {
            parameterName: `/${namePrefix}/content-table-name`,
            stringValue: this.contentTable.tableName,
            description: `AI Content metadata table name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'PublisherFunctionArnParam', {
            parameterName: `/${namePrefix}/publisher-function-arn`,
            stringValue: this.publisherFunction.functionArn,
            description: `AI Publisher Lambda ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'ContentTableName', {
            value: this.contentTable.tableName,
            description: 'AI Content metadata table name',
        });

        new cdk.CfnOutput(this, 'PublisherFunctionArn', {
            value: this.publisherFunction.functionArn,
            description: 'AI Publisher Lambda function ARN',
        });

        new cdk.CfnOutput(this, 'PublisherFunctionName', {
            value: this.publisherFunction.functionName,
            description: 'AI Publisher Lambda function name',
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
