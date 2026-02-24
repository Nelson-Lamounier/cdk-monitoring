/**
 * @format
 * Kubernetes Data Stack
 *
 * Consolidated data/storage resources for the K8s-hosted Next.js application.
 * This stack combines DynamoDB, S3, and application secrets.
 *
 * Domain: Data Layer (rarely changes)
 *
 * Resources:
 * 1. DynamoDB Personal Portfolio Table - Single-table design for articles and email subscriptions
 * 2. S3 Assets Bucket - Storage for images and media
 * 3. S3 Access Logs Bucket - Logs for assets bucket
 * 4. SSM Parameters - Cross-stack references and secrets
 *
 * NOTE: ECR has been migrated to SharedVpcStack. Applications discover
 *       ECR via SSM: /shared/ecr/{env}/repository-*
 *
 * @example
 * ```typescript
 * const dataStack = new KubernetesDataStack(app, 'K8s-Data-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     projectName: 'k8s',
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as cdk from 'aws-cdk-lib';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';

import { applyCommonSuppressions } from '../../../aspects/cdk-nag-aspect';
import { DynamoDbTableConstruct, S3BucketConstruct } from '../../../common/storage';
import {
    Environment,
    isProductionEnvironment,
    environmentRemovalPolicy,
    S3_INCOMPLETE_UPLOAD_EXPIRATION_DAYS,
    S3_CORS_DEFAULTS,
    S3_STORAGE_TRANSITION_DAYS,
    PORTFOLIO_GSI1_NAME,
    PORTFOLIO_GSI2_NAME,
    nextjsSsmPaths,
} from '../../../config';
import { getNextJsConfigs } from '../../../config/nextjs/configurations';
import { nextjsResourceNames, DYNAMO_TABLE_STEM } from '../../../config/nextjs/resource-names';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Props for KubernetesDataStack
 */
export interface KubernetesDataStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /** Project name @default 'k8s' */
    readonly projectName?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * KubernetesDataStack - Consolidated data layer for K8s-hosted application
 *
 * This stack consolidates all data/storage resources into a single deployment unit:
 *
 * Personal Portfolio DynamoDB Table (Single-table design):
 * - Primary Key: pk (String)
 * - Sort Key: sk (String)
 *
 * Entity: Articles
 * - pk: `ARTICLE#<slug>`, sk: `METADATA` | `CONTENT#<version>`
 * - GSI1: Query by status and date (gsi1pk: `STATUS#<status>`, gsi1sk: `<date>#<slug>`)
 * - GSI2: Query by tag (gsi2pk: `TAG#<tag>`, gsi2sk: `<date>#<slug>`)
 *
 * Entity: Email Subscriptions
 * - pk: `EMAIL#<email>`, sk: `SUBSCRIPTION`
 * - GSI1: List all subscriptions (gsi1pk: `ENTITY#EMAIL`, gsi1sk: `<timestamp>`)
 * - Attributes: email, name, source, status, subscribedAt, consentRecord, verifiedAt
 * - TTL: Pending (unverified) subscriptions expire after 48 hours
 *
 * S3 Assets Bucket:
 * - Stores article images, diagrams, and media files
 * - Versioning enabled for content recovery
 * - Block public access (serve via CloudFront only)
 * - Lifecycle policies for cost optimisation
 *
 * ═══════════════════════════════════════════════════════════════════
 * ⚠️ DAY-0 DATA SAFETY — MIGRATION RISK
 *
 * Even with removalPolicy: RETAIN, renaming a construct ID in CDK
 * (e.g., 'PortfolioTable' → 'UserTable') will ORPHAN the old
 * resource and CREATE a new, empty one.
 *
 * Mitigations:
 * 1. Never change DynamoDB/S3 construct IDs without a migration plan
 * 2. Pre-deploy verification: confirm table exists before cdk deploy
 * 3. Use CloudFormation ChangeSets to review resource replacements
 * 4. K8s integration: pods discover values via SSM → ExternalSecret
 *    → process.env.DYNAMODB_TABLE_NAME
 * ═══════════════════════════════════════════════════════════════════
 */
export class KubernetesDataStack extends cdk.Stack {
    // DynamoDB
    public readonly portfolioTable: dynamodb.Table;

    // S3
    public readonly assetsBucket: s3.Bucket;
    public readonly accessLogsBucket: s3.Bucket;

    // SSM
    public readonly ssmPrefix: string;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: KubernetesDataStackProps) {
        super(scope, id, {
            ...props,
        });

        const {
            targetEnvironment,
            projectName = 'k8s',
        } = props;

        this.targetEnvironment = targetEnvironment;
        const paths = nextjsSsmPaths(targetEnvironment, projectName);
        this.ssmPrefix = paths.prefix;

        // Get project-specific configuration
        const nextjsConfig = getNextJsConfigs(targetEnvironment);
        const isProduction = isProductionEnvironment(targetEnvironment);

        // Environment-aware settings
        const removalPolicy = environmentRemovalPolicy(targetEnvironment);
        const pointInTimeRecovery = true; // AwsSolutions-DDB3
        const deletionProtection = isProduction;

        // =================================================================
        // NOTE: ECR has been migrated to SharedVpcStack
        // Applications discover ECR via SSM: /shared/ecr/{env}/repository-*
        // =================================================================

        // =================================================================
        // KMS KEY FOR PRODUCTION ENCRYPTION
        // =================================================================

        const dynamoEncryptionKey = isProduction
            ? new kms.Key(this, 'DynamoDbEncryptionKey', {
                  alias: `${projectName}-dynamodb-${targetEnvironment}`,
                  description: `KMS key for DynamoDB encryption in ${targetEnvironment}`,
                  enableKeyRotation: true,
                  removalPolicy: cdk.RemovalPolicy.RETAIN,
              })
            : undefined;

        // =================================================================
        // S3 ACCESS LOGS BUCKET
        // =================================================================

        const accessLogsBucketConstruct = new S3BucketConstruct(this, 'AccessLogsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${projectName}-access-logs-${targetEnvironment}`,
                purpose: 'access-logs',
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy,
                autoDeleteObjects: !isProduction,
                versioned: true,
                lifecycleRules: [
                    {
                        id: 'delete-old-logs',
                        enabled: true,
                        expiration: cdk.Duration.days(90),
                        noncurrentVersionExpiration: cdk.Duration.days(30),
                    },
                ],
            },
        });
        this.accessLogsBucket = accessLogsBucketConstruct.bucket;

        const cfnAccessLogsBucket = this.accessLogsBucket.node.defaultChild as cdk.CfnResource;
        cfnAccessLogsBucket.addMetadata('checkov', {
            skip: [
                {
                    id: 'CKV_AWS_18',
                    comment: 'Access-logs destination bucket cannot log to itself — AWS limitation',
                },
            ],
        });

        // =================================================================
        // S3 ASSETS BUCKET
        // =================================================================

        const storageTransitions: s3.Transition[] | undefined =
            nextjsConfig.s3.enableIntelligentTiering
                ? [
                      {
                          storageClass: s3.StorageClass.INTELLIGENT_TIERING,
                          transitionAfter: cdk.Duration.days(S3_STORAGE_TRANSITION_DAYS),
                      },
                  ]
                : undefined;

        const assetsBucketConstruct = new S3BucketConstruct(this, 'AssetsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: nextjsResourceNames(projectName, targetEnvironment).assetsBucketName,
                purpose: 'article-assets',
                versioned: true,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                removalPolicy,
                autoDeleteObjects: !isProduction,
                accessLogsBucket: this.accessLogsBucket,
                accessLogsPrefix: 'assets-bucket/',
                lifecycleRules: [
                    {
                        id: 'archive-old-versions',
                        enabled: true,
                        noncurrentVersionExpiration: cdk.Duration.days(
                            nextjsConfig.s3.versionExpirationDays
                        ),
                        transitions: storageTransitions,
                    },
                    {
                        id: 'delete-incomplete-uploads',
                        enabled: true,
                        abortIncompleteMultipartUploadAfter: cdk.Duration.days(
                            S3_INCOMPLETE_UPLOAD_EXPIRATION_DAYS
                        ),
                    },
                ],
                cors: [
                    {
                        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
                        allowedOrigins: [...nextjsConfig.s3.corsOrigins],
                        allowedHeaders: [...S3_CORS_DEFAULTS.allowedHeaders],
                        maxAge: S3_CORS_DEFAULTS.maxAgeSeconds,
                    },
                ],
            },
        });

        this.assetsBucket = assetsBucketConstruct.bucket;

        // Grant CloudFront read access to S3 bucket (OAC style - service principal)
        //
        // ⚠️ DEPLOYMENT NOTE: This OAC policy uses the CloudFront service principal
        // with SourceAccount condition. If the CloudFront distribution ever moves
        // to a stack that cannot reference this Data Stack (circular export lock),
        // move this bucket policy to the CloudFront/Edge stack instead.
        this.assetsBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                sid: 'AllowCloudFrontOACAccess',
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
                actions: ['s3:GetObject'],
                resources: [this.assetsBucket.arnForObjects('*')],
                conditions: {
                    StringEquals: {
                        'AWS:SourceAccount': cdk.Stack.of(this).account,
                    },
                },
            })
        );

        // =================================================================
        // DYNAMODB PERSONAL PORTFOLIO TABLE (Single-Table Design)
        // =================================================================

        const portfolioTableConstruct = new DynamoDbTableConstruct(this, 'PortfolioTable', {
            envName: targetEnvironment,
            projectName,
            tableName: DYNAMO_TABLE_STEM,
            partitionKey: {
                name: 'pk',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'sk',
                type: dynamodb.AttributeType.STRING,
            },
            additionalAttributes: [
                { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
                { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
                { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
                { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
            ],
            globalSecondaryIndexes: [
                {
                    indexName: PORTFOLIO_GSI1_NAME,
                    partitionKey: 'gsi1pk',
                    sortKey: 'gsi1sk',
                    projectionType: dynamodb.ProjectionType.ALL,
                },
                {
                    indexName: PORTFOLIO_GSI2_NAME,
                    partitionKey: 'gsi2pk',
                    sortKey: 'gsi2sk',
                    projectionType: dynamodb.ProjectionType.ALL,
                },
            ],
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery,
            encryption: isProduction
                ? dynamodb.TableEncryption.CUSTOMER_MANAGED
                : dynamodb.TableEncryption.AWS_MANAGED,
            encryptionKey: dynamoEncryptionKey,
            deletionProtection,
            removalPolicy,

            timeToLive: {
                attributeName: 'ttl',
                enabled: true,
            },
            tags: {
                Purpose: 'Personal portfolio data storage - articles and email subscriptions',
                DataClassification: 'PII-Email',
                Application: 'Portfolio',
            },
        });

        this.portfolioTable = portfolioTableConstruct.table;

        // =================================================================
        // SSM PARAMETERS FOR CROSS-STACK REFERENCES
        //
        // Native StringParameter — no backing Lambda required.
        // Consumer stacks discover these via nextjsSsmPaths().
        // =================================================================

        new ssm.StringParameter(this, 'SsmPortfolioTableName', {
            parameterName: paths.dynamodbTableName,
            stringValue: this.portfolioTable.tableName,
            description: 'DynamoDB personal portfolio table name for K8s application',
        });

        new ssm.StringParameter(this, 'SsmAssetsBucketName', {
            parameterName: paths.assetsBucketName,
            stringValue: this.assetsBucket.bucketName,
            description: 'S3 assets bucket name for K8s application',
        });

        new ssm.StringParameter(this, 'SsmAwsRegion', {
            parameterName: paths.awsRegion,
            stringValue: cdk.Stack.of(this).region,
            description: 'AWS region for K8s application',
        });

        if (dynamoEncryptionKey) {
            new ssm.StringParameter(this, 'SsmDynamoDbKmsKeyArn', {
                parameterName: paths.dynamodbKmsKeyArn,
                stringValue: dynamoEncryptionKey.keyArn,
                description: 'KMS key ARN for DynamoDB encryption (cross-stack discovery)',
            });
        }

        // =================================================================
        // CDK NAG SUPPRESSIONS & TAGS
        // =================================================================

        applyCommonSuppressions(this);

        if (!isProduction) {
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${this.stackName}/Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler`,
                [
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'CDK-managed Lambda runtime for S3 auto-delete, not customizable',
                    },
                ],
                true
            );
        }

        NagSuppressions.addResourceSuppressions(this.accessLogsBucket, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Access logs bucket cannot log to itself - AWS limitation',
            },
        ]);

        // NOTE: AwsCustomResource Lambda suppression removed — SSM now uses native StringParameter

        // Stack tags
        cdk.Tags.of(this).add('Stack', 'KubernetesData');
        cdk.Tags.of(this).add('Layer', 'Data');

        // =================================================================
        // STACK OUTPUTS
        // =================================================================

        const exportPrefix = `${targetEnvironment}-${projectName}`;

        new cdk.CfnOutput(this, 'PortfolioTableName', {
            value: this.portfolioTable.tableName,
            description: 'DynamoDB table name for personal portfolio (articles, email subscriptions)',
            exportName: `${exportPrefix}-portfolio-table-name`,
        });

        new cdk.CfnOutput(this, 'PortfolioTableArn', {
            value: this.portfolioTable.tableArn,
            description: 'DynamoDB table ARN for IAM policies',
            exportName: `${exportPrefix}-portfolio-table-arn`,
        });

        new cdk.CfnOutput(this, 'PortfolioTableGsi1Name', {
            value: PORTFOLIO_GSI1_NAME,
            description: 'GSI1 name for querying by status/date (articles) or listing entities (email subscriptions)',
            exportName: `${exportPrefix}-portfolio-gsi1-name`,
        });

        new cdk.CfnOutput(this, 'PortfolioTableGsi2Name', {
            value: PORTFOLIO_GSI2_NAME,
            description: 'GSI2 name for querying articles by tag',
            exportName: `${exportPrefix}-portfolio-gsi2-name`,
        });

        new cdk.CfnOutput(this, 'AssetsBucketName', {
            value: this.assetsBucket.bucketName,
            description: 'S3 bucket name for article images and media',
            exportName: `${exportPrefix}-assets-bucket-name`,
        });

        new cdk.CfnOutput(this, 'AssetsBucketArn', {
            value: this.assetsBucket.bucketArn,
            description: 'S3 bucket ARN for IAM policies',
            exportName: `${exportPrefix}-assets-bucket-arn`,
        });

        new cdk.CfnOutput(this, 'AssetsBucketRegionalDomainName', {
            value: this.assetsBucket.bucketRegionalDomainName,
            description: 'S3 bucket regional domain name for CloudFront origin',
            exportName: `${exportPrefix}-assets-bucket-domain`,
        });

        new cdk.CfnOutput(this, 'SsmParameterPrefix', {
            value: this.ssmPrefix,
            description: 'SSM parameter path prefix for this environment',
        });
    }

    // =========================================================================
    // CROSS-STACK GRANT HELPERS
    // =========================================================================

    /**
     * Grant DynamoDB read access (GetItem, Query, Scan, BatchGetItem)
     * to the given principal, including all GSI indexes.
     *
     * Prefer this over manually constructing IAM statements with raw ARNs.
     *
     * @example
     * ```typescript
     * dataStack.grantTableRead(computeRole);
     * ```
     */
    public grantTableRead(grantee: iam.IGrantable): iam.Grant {
        return this.portfolioTable.grantReadData(grantee);
    }

    /**
     * Grant S3 read access to the assets bucket.
     *
     * @example
     * ```typescript
     * dataStack.grantAssetsBucketRead(computeRole);
     * ```
     */
    public grantAssetsBucketRead(grantee: iam.IGrantable): iam.Grant {
        return this.assetsBucket.grantRead(grantee);
    }
}
