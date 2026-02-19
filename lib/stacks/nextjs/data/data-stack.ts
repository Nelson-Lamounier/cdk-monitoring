/**
 * @format
 * NextJS Data Stack
 *
 * Consolidated data/storage resources for the Next.js application.
 * This stack combines ECR, DynamoDB, S3, and application secrets.
 *
 * Domain: Data Layer (rarely changes)
 *
 * Resources:
 * 1. ECR Repository - Container image storage
 * 2. DynamoDB Personal Portfolio Table - Single-table design for articles and email subscriptions
 * 3. S3 Assets Bucket - Storage for images and media
 * 4. S3 Access Logs Bucket - Logs for assets bucket
 * 5. SSM Parameters - Cross-stack references and secrets
 *
 * @example
 * ```typescript
 * const dataStack = new NextJsDataStack(app, 'NextJS-DataStack-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     projectName: 'nextjs',
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as cdk from 'aws-cdk-lib';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';

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
 * Props for NextJsDataStack
 */
export interface NextJsDataStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /** Project name @default 'nextjs' */
    readonly projectName?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * NextJsDataStack - Consolidated data layer for Next.js application
 *
 * This stack consolidates all data/storage resources into a single deployment unit:
 *
 * ECR Repository:
 * - Container image storage for Next.js frontend
 * - Tag mutability based on environment (mutable in dev, immutable in prod)
 * - Lifecycle policies for cleanup
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
 */
export class NextJsDataStack extends cdk.Stack {
    // DynamoDB
    public readonly portfolioTable: dynamodb.Table;

    // S3
    public readonly assetsBucket: s3.Bucket;
    public readonly accessLogsBucket: s3.Bucket;

    // SSM
    public readonly ssmPrefix: string;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NextJsDataStackProps) {
        super(scope, id, {
            ...props,
        });

        const {
            targetEnvironment,
            projectName = 'nextjs',
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
        // This is the logging destination for the Assets bucket.
        // It cannot log to itself (AWS circular-dependency limitation).
        // Suppressed: cdk-nag AwsSolutions-S1  |  Checkov CKV_AWS_18
        // =================================================================

        this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
            bucketName: `${projectName}-access-logs-${targetEnvironment}`,
            encryption: s3.BucketEncryption.S3_MANAGED, // Must be SSE-S3; KMS blocks S3 service principal log delivery
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: !isProduction,
            versioned: true, // CKV_AWS_21
            lifecycleRules: [
                {
                    id: 'delete-old-logs',
                    enabled: true,
                    expiration: cdk.Duration.days(90),
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
            ],
        });

        // Checkov CKV_AWS_18: suppress on the access-logs bucket (cannot log to itself)
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
        // Required because Edge stack (us-east-1) can't modify bucket policy for cross-region bucket
        // TODO: Tighten to AWS:SourceArn with the specific distribution ARN once
        //       the distribution ARN is published to SSM from the edge stack.
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
        // Entities: Articles, Email Subscriptions
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
        // Uses AwsCustomResource with PutParameter Overwrite:true to
        // support idempotent redeployment (avoids ParameterAlreadyExists)
        // =================================================================

        const ssmParameterArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${paths.prefix}/*`;
        const ssmPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
                resources: [ssmParameterArn],
            }),
        ]);

        this.createSsmParameter(
            'SsmPortfolioTableName', paths.dynamodbTableName,
            this.portfolioTable.tableName,
            'DynamoDB personal portfolio table name for Next.js application',
            ssmPolicy,
        );

        this.createSsmParameter(
            'SsmAssetsBucketName', paths.assetsBucketName,
            this.assetsBucket.bucketName,
            'S3 assets bucket name for Next.js application',
            ssmPolicy,
        );

        this.createSsmParameter(
            'SsmAwsRegion', paths.awsRegion,
            cdk.Stack.of(this).region,
            'AWS region for Next.js application',
            ssmPolicy,
        );

        // Publish DynamoDB KMS key ARN so the API stack can grant decrypt
        // permissions to Lambda roles (required for customer-managed encryption)
        if (dynamoEncryptionKey) {
            this.createSsmParameter(
                'SsmDynamoDbKmsKeyArn', paths.dynamodbKmsKeyArn,
                dynamoEncryptionKey.keyArn,
                'KMS key ARN for DynamoDB encryption (cross-stack discovery)',
                ssmPolicy,
            );
        }
        // =================================================================
        // CDK NAG SUPPRESSIONS & TAGS
        // =================================================================

        applyCommonSuppressions(this);

        // Suppress for CDK-managed S3 auto-delete Lambda
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

        // Access logs bucket self-logging suppression
        NagSuppressions.addResourceSuppressions(this.accessLogsBucket, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Access logs bucket cannot log to itself - AWS limitation',
            },
        ]);

        // Suppress for AwsCustomResource SSM parameter Lambda
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'CDK-managed Lambda runtime for AwsCustomResource SSM parameters, not customizable',
                },
            ],
            true
        );

        // Stack tags
        cdk.Tags.of(this).add('Stack', 'NextJsData');
        cdk.Tags.of(this).add('Layer', 'Data');

        // =================================================================
        // STACK OUTPUTS
        // =================================================================

        const exportPrefix = `${targetEnvironment}-${projectName}`;

        // NOTE: ECR outputs have been migrated to SharedVpcStack
        // Use SSM path: /shared/ecr/{env}/repository-* for ECR discovery

        // DynamoDB Outputs
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



        // S3 Outputs
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

        // SSM Outputs
        new cdk.CfnOutput(this, 'SsmParameterPrefix', {
            value: this.ssmPrefix,
            description: 'SSM parameter path prefix for this environment',
        });
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Creates an SSM parameter via AwsCustomResource with idempotent put/delete.
     * Centralises the repeated boilerplate for SSM parameter management.
     */
    private createSsmParameter(
        id: string,
        parameterName: string,
        value: string,
        description: string,
        policy: cr.AwsCustomResourcePolicy,
    ): void {
        new cr.AwsCustomResource(this, id, {
            onUpdate: {
                service: 'SSM',
                action: 'putParameter',
                parameters: {
                    Name: parameterName,
                    Value: value,
                    Type: 'String',
                    Description: description,
                    Overwrite: true,
                },
                physicalResourceId: cr.PhysicalResourceId.of(parameterName),
            },
            onDelete: {
                service: 'SSM',
                action: 'deleteParameter',
                parameters: { Name: parameterName },
            },
            policy,
        });
    }
}
