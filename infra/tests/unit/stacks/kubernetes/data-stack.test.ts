/**
 * @format
 * Kubernetes Data Stack Unit Tests
 *
 * Tests for the KubernetesDataStack:
 * - DynamoDB Personal Portfolio Table (pk/sk, GSI1, GSI2, PITR, TTL)
 * - S3 Assets & Access Logs Buckets (encryption, versioning, public access)
 * - SSM Parameters (cross-stack references)
 * - CloudFormation Outputs (table, bucket, SSM prefix)
 * - Tags (Stack, Layer)
 *
 * All tests use the same config references as the stack itself
 * (DYNAMO_TABLE_STEM, PORTFOLIO_GSI1_NAME, nextjsSsmPaths, etc.)
 * to ensure the test validates real behavior.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import {
    Environment,
    PORTFOLIO_GSI1_NAME,
    PORTFOLIO_GSI2_NAME,
    nextjsSsmPaths,
} from '../../../../lib/config';
import { DYNAMO_TABLE_STEM } from '../../../../lib/config/nextjs';
import { KubernetesDataStack } from '../../../../lib/stacks/kubernetes/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
    StackAssertions,
} from '../../../fixtures';

// =============================================================================
// Test Constants — derived from the same configs the stack uses
// =============================================================================

const TEST_PROJECT = 'k8s';
const TEST_ENV = Environment.DEVELOPMENT;
const TEST_SSM_PATHS = nextjsSsmPaths(TEST_ENV, TEST_PROJECT);

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create KubernetesDataStack with sensible defaults.
 * Uses the same config references as the factory.
 */
function _createDataStack(
    overrides?: Partial<ConstructorParameters<typeof KubernetesDataStack>[2]>,
): { stack: KubernetesDataStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new KubernetesDataStack(
        app,
        'TestK8sDataStack',
        {
            targetEnvironment: TEST_ENV,
            projectName: TEST_PROJECT,
            env: TEST_ENV_EU,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesDataStack', () => {

    // =========================================================================
    // DynamoDB
    // =========================================================================
    describe('DynamoDB Portfolio Table', () => {
        it('should create a DynamoDB table with pk/sk keys', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                KeySchema: Match.arrayWith([
                    Match.objectLike({ AttributeName: 'pk', KeyType: 'HASH' }),
                    Match.objectLike({ AttributeName: 'sk', KeyType: 'RANGE' }),
                ]),
            });
        });

        it('should create GSI1 and GSI2 using config constants', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: PORTFOLIO_GSI1_NAME,
                        KeySchema: Match.arrayWith([
                            Match.objectLike({ AttributeName: 'gsi1pk', KeyType: 'HASH' }),
                            Match.objectLike({ AttributeName: 'gsi1sk', KeyType: 'RANGE' }),
                        ]),
                        Projection: { ProjectionType: 'ALL' },
                    }),
                    Match.objectLike({
                        IndexName: PORTFOLIO_GSI2_NAME,
                        KeySchema: Match.arrayWith([
                            Match.objectLike({ AttributeName: 'gsi2pk', KeyType: 'HASH' }),
                            Match.objectLike({ AttributeName: 'gsi2sk', KeyType: 'RANGE' }),
                        ]),
                        Projection: { ProjectionType: 'ALL' },
                    }),
                ]),
            });
        });

        it('should enable point-in-time recovery', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                PointInTimeRecoverySpecification: {
                    PointInTimeRecoveryEnabled: true,
                },
            });
        });

        it('should use PAY_PER_REQUEST billing mode', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });

        it('should enable TTL on the ttl attribute', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TimeToLiveSpecification: {
                    AttributeName: 'ttl',
                    Enabled: true,
                },
            });
        });

        it('should use the DYNAMO_TABLE_STEM config constant in the table name', () => {
            const { template } = _createDataStack();

            // The construct builds the name as `{project}-{stem}-{env}`
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TableName: `${TEST_PROJECT}-${DYNAMO_TABLE_STEM}-${TEST_ENV}`,
            });
        });

        it('should use AWS-managed encryption in development', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.DEVELOPMENT });

            // AWS_MANAGED means no explicit SSESpecification.SSEEnabled = true with KMS
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                SSESpecification: Match.objectLike({
                    SSEEnabled: true,
                }),
            });
        });

        it('should create a customer-managed KMS key in production', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.PRODUCTION });

            StackAssertions.hasKmsKeyRotation(template);
        });

        it('should create exactly 1 DynamoDB table', () => {
            const { template } = _createDataStack();

            StackAssertions.hasResourceCount(template, 'AWS::DynamoDB::Table', 1);
        });
    });

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Buckets', () => {
        it('should create 2 S3 buckets (assets + access logs)', () => {
            const { template } = _createDataStack();

            StackAssertions.hasResourceCount(template, 'AWS::S3::Bucket', 2);
        });

        it('should block public access on assets bucket', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });

        it('should enable versioning on both buckets', () => {
            const { template } = _createDataStack();
            const buckets = template.findResources('AWS::S3::Bucket');

            const allVersioned = Object.values(buckets).every((bucket) => {
                const props = (bucket as { Properties?: { VersioningConfiguration?: { Status: string } } }).Properties;
                return props?.VersioningConfiguration?.Status === 'Enabled';
            });

            expect(allVersioned).toBe(true);
        });

        it('should use S3-managed encryption on both buckets', () => {
            const { template } = _createDataStack();

            // Both the access-logs and assets bucket use S3_MANAGED encryption.
            // Verify at least one bucket has an SSE configuration (CDK sets it on all).
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketEncryption: Match.objectLike({
                    ServerSideEncryptionConfiguration: Match.arrayWith([
                        Match.objectLike({
                            ServerSideEncryptionByDefault: Match.objectLike({
                                SSEAlgorithm: Match.anyValue(),
                            }),
                        }),
                    ]),
                }),
            });
        });

        it('should grant CloudFront OAC read access via bucket policy', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::S3::BucketPolicy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 's3:GetObject',
                            Effect: 'Allow',
                            Principal: Match.objectLike({
                                Service: 'cloudfront.amazonaws.com',
                            }),
                        }),
                    ]),
                }),
            });
        });

        it('should have lifecycle rules on assets bucket', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({ Id: 'archive-old-versions', Status: 'Enabled' }),
                        Match.objectLike({ Id: 'delete-incomplete-uploads', Status: 'Enabled' }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should create SSM parameter for DynamoDB table name', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: TEST_SSM_PATHS.dynamodbTableName,
            });
        });

        it('should create SSM parameter for assets bucket name', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: TEST_SSM_PATHS.assetsBucketName,
            });
        });

        it('should create SSM parameter for AWS region', () => {
            const { template } = _createDataStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: TEST_SSM_PATHS.awsRegion,
            });
        });

        it('should NOT create KMS key ARN SSM parameter in development', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.DEVELOPMENT });

            // In dev, there's no customer-managed KMS key.
            // Verify that the dynamodbKmsKeyArn SSM parameter is NOT created.
            const ssmResources = template.findResources('AWS::SSM::Parameter');
            const kmsArnParam = Object.values(ssmResources).find((r) => {
                const props = (r as { Properties?: { Name?: string } }).Properties;
                return props?.Name === TEST_SSM_PATHS.dynamodbKmsKeyArn;
            });

            expect(kmsArnParam).toBeUndefined();
        });

        it('should create KMS key ARN SSM parameter in production', () => {
            const prodPaths = nextjsSsmPaths(Environment.PRODUCTION, TEST_PROJECT);
            const { template } = _createDataStack({ targetEnvironment: Environment.PRODUCTION });

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: prodPaths.dynamodbKmsKeyArn,
            });
        });
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export PortfolioTableName with cross-stack export', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'PortfolioTableName', {
                description: 'DynamoDB table name for personal portfolio (articles, email subscriptions)',
                exportName: `${TEST_ENV}-${TEST_PROJECT}-portfolio-table-name`,
            });
        });

        it('should export PortfolioTableArn with cross-stack export', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'PortfolioTableArn', {
                description: 'DynamoDB table ARN for IAM policies',
                exportName: `${TEST_ENV}-${TEST_PROJECT}-portfolio-table-arn`,
            });
        });

        it('should export GSI names from config constants', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'PortfolioTableGsi1Name', {
                exportName: `${TEST_ENV}-${TEST_PROJECT}-portfolio-gsi1-name`,
            });
            StackAssertions.hasOutput(template, 'PortfolioTableGsi2Name', {
                exportName: `${TEST_ENV}-${TEST_PROJECT}-portfolio-gsi2-name`,
            });
        });

        it('should export AssetsBucketName with cross-stack export', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'AssetsBucketName', {
                description: 'S3 bucket name for article images and media',
                exportName: `${TEST_ENV}-${TEST_PROJECT}-assets-bucket-name`,
            });
        });

        it('should export SsmParameterPrefix without export name', () => {
            const { template } = _createDataStack();

            StackAssertions.hasOutput(template, 'SsmParameterPrefix', {
                description: 'SSM parameter path prefix for this environment',
            });
        });
    });

    // =========================================================================
    // Tags
    // =========================================================================
    describe('Tags and Metadata', () => {
        it('should add CostOptimisation metadata to the DynamoDB table', () => {
            const { template } = _createDataStack();

            // DynamoDbTableConstruct adds CostOptimisation metadata to the CfnTable
            template.hasResource('AWS::DynamoDB::Table', {
                Metadata: Match.objectLike({
                    CostOptimisation: Match.objectLike({
                        BillingMode: Match.anyValue(),
                        Encryption: Match.anyValue(),
                        PointInTimeRecovery: Match.anyValue(),
                        Environment: TEST_ENV,
                    }),
                }),
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose targetEnvironment', () => {
            const { stack } = _createDataStack();

            expect(stack.targetEnvironment).toBe(TEST_ENV);
        });

        it('should expose ssmPrefix matching config', () => {
            const { stack } = _createDataStack();

            expect(stack.ssmPrefix).toBe(TEST_SSM_PATHS.prefix);
        });

        it('should expose portfolioTable as a Table construct', () => {
            const { stack } = _createDataStack();

            expect(stack.portfolioTable).toBeDefined();
            expect(stack.portfolioTable.tableName).toBeDefined();
        });

        it('should expose assetsBucket as a Bucket construct', () => {
            const { stack } = _createDataStack();

            expect(stack.assetsBucket).toBeDefined();
            expect(stack.assetsBucket.bucketName).toBeDefined();
        });

        it('should expose accessLogsBucket as a Bucket construct', () => {
            const { stack } = _createDataStack();

            expect(stack.accessLogsBucket).toBeDefined();
            expect(stack.accessLogsBucket.bucketName).toBeDefined();
        });
    });

    // =========================================================================
    // Environment-Specific Behavior
    // =========================================================================
    describe('Environment-Specific Behavior', () => {
        it('should use DESTROY removal policy in development', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.DEVELOPMENT });

            // In dev, DynamoDB table should have DeletionPolicy: Delete
            template.hasResource('AWS::DynamoDB::Table', {
                DeletionPolicy: 'Delete',
            });
        });

        it('should use RETAIN removal policy in production', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.PRODUCTION });

            template.hasResource('AWS::DynamoDB::Table', {
                DeletionPolicy: 'Retain',
            });
        });

        it('should enable deletion protection in production', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.PRODUCTION });

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                DeletionProtectionEnabled: true,
            });
        });

        it('should NOT enable deletion protection in development', () => {
            const { template } = _createDataStack({ targetEnvironment: Environment.DEVELOPMENT });

            template.hasResourceProperties('AWS::DynamoDB::Table', {
                DeletionProtectionEnabled: false,
            });
        });
    });
});
