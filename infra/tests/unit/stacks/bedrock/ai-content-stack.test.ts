/**
 * @format
 * AI Content Stack Unit Tests
 *
 * Tests for the AiContentStack (Data Layer):
 * - DynamoDB table with correct keys, billing mode, and GSIs
 * - SSM parameter exports (table name, table ARN, bucket name, published prefix)
 * - Stack outputs
 * - Public properties (contentTable, tableName)
 * - grantContentRead helper
 *
 * The monolith Lambda, DLQ, S3 event notification, and Bedrock IAM
 * have been deprecated and moved to BedrockPipelineStack.
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { AiContentStack } from '../../../../lib/stacks/bedrock/ai-content-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-development';
const TEST_BUCKET_NAME = `${NAME_PREFIX}-kb-data`;

/**
 * Helper to create AiContentStack with the simplified data-layer props.
 *
 * Uses Bucket.fromBucketName to import the bucket so that
 * no cross-stack resource dependencies are created.
 */
function createContentStack(
    overrides?: Partial<ConstructorParameters<typeof AiContentStack>[2]>,
): { stack: AiContentStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new AiContentStack(
        app,
        'TestAiContentStack',
        {
            namePrefix: NAME_PREFIX,
            assetsBucketName: TEST_BUCKET_NAME,
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            logRetention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            environmentName: 'development',
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

describe('AiContentStack', () => {

    // =========================================================================
    // DynamoDB — AiContentTable
    // =========================================================================
    describe('DynamoDB AiContentTable', () => {
        const { template } = createContentStack();

        it('should create a DynamoDB table with pk/sk keys', () => {
            template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                KeySchema: Match.arrayWith([
                    Match.objectLike({ AttributeName: 'pk', KeyType: 'HASH' }),
                    Match.objectLike({ AttributeName: 'sk', KeyType: 'RANGE' }),
                ]),
            });
        });

        it('should use PAY_PER_REQUEST billing mode', () => {
            template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });

        it('should enable point-in-time recovery', () => {
            template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                Replicas: Match.arrayWith([
                    Match.objectLike({
                        PointInTimeRecoverySpecification: {
                            PointInTimeRecoveryEnabled: true,
                        },
                    }),
                ]),
            });
        });

        it('should set the correct table name', () => {
            template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                TableName: `${NAME_PREFIX}-ai-content`,
            });
        });
    });

    // =========================================================================
    // DynamoDB GSIs
    // =========================================================================
    describe('DynamoDB GSIs', () => {
        const { template } = createContentStack();

        it('should create GSI1 (gsi1-status-date) for article listing', () => {
            template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: 'gsi1-status-date',
                        KeySchema: Match.arrayWith([
                            Match.objectLike({ AttributeName: 'gsi1pk', KeyType: 'HASH' }),
                            Match.objectLike({ AttributeName: 'gsi1sk', KeyType: 'RANGE' }),
                        ]),
                    }),
                ]),
            });
        });

        it('should create GSI2 (gsi2-tag-date) for tag filtering', () => {
            template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: 'gsi2-tag-date',
                        KeySchema: Match.arrayWith([
                            Match.objectLike({ AttributeName: 'gsi2pk', KeyType: 'HASH' }),
                            Match.objectLike({ AttributeName: 'gsi2sk', KeyType: 'RANGE' }),
                        ]),
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createContentStack();

        it('should export content table name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/content-table-name`,
            });
        });

        it('should export content table ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/content-table-arn`,
            });
        });

        it('should export assets bucket name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/assets-bucket-name`,
            });
        });

        it('should export published prefix', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/published-prefix`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createContentStack();

        it('should output the content table name', () => {
            template.hasOutput('ContentTableName', {});
        });
    });

    // =========================================================================
    // Public Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createContentStack();

        it('should expose contentTable', () => {
            expect(stack.contentTable).toBeDefined();
        });

        it('should expose tableName', () => {
            expect(stack.tableName).toBeDefined();
        });
    });

    // =========================================================================
    // grantContentRead Helper
    // =========================================================================
    describe('grantContentRead', () => {
        it('should expose grantContentRead method', () => {
            const { stack } = createContentStack();
            expect(typeof stack.grantContentRead).toBe('function');
        });

        it('should grant DynamoDB read access when called', () => {
            // Create a fresh stack with grant applied BEFORE synthesis
            const freshApp = createTestApp();
            const freshStack = new AiContentStack(
                freshApp,
                'TestGrantStack',
                {
                    namePrefix: NAME_PREFIX,
                    assetsBucketName: TEST_BUCKET_NAME,
                    publishedPrefix: 'published/',
                    contentPrefix: 'content/',
                    logRetention: logs.RetentionDays.ONE_WEEK,
                    removalPolicy: cdk.RemovalPolicy.DESTROY,
                    environmentName: 'development',
                    env: TEST_ENV_EU,
                },
            );

            const testRole = new iam.Role(freshStack, 'TestConsumerRole', {
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            });
            freshStack.grantContentRead(testRole);

            const freshTemplate = Template.fromStack(freshStack);
            freshTemplate.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.anyValue(),
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // No Monolith Resources (deprecation guard)
    // =========================================================================
    describe('Deprecated resources are absent', () => {
        const { template } = createContentStack();

        it('should not create any Lambda functions', () => {
            template.resourceCountIs('AWS::Lambda::Function', 0);
        });

        it('should not create any SQS queues', () => {
            template.resourceCountIs('AWS::SQS::Queue', 0);
        });
    });
});
