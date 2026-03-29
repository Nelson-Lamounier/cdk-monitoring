/**
 * @format
 * AI Content Stack Unit Tests
 *
 * Tests for the AiContentStack:
 * - DynamoDB table with correct keys and billing mode
 * - Lambda function with correct runtime, bundling, and environment
 * - S3 event notification on drafts/ prefix
 * - IAM policy for Bedrock InvokeModel
 * - SSM parameter exports
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
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
const FOUNDATION_MODEL = 'anthropic.claude-sonnet-4-6';
const TEST_BUCKET_NAME = `${NAME_PREFIX}-kb-data`;

/**
 * Helper to create AiContentStack with a mock S3 bucket.
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
            draftPrefix: 'drafts/',
            publishedPrefix: 'published/',
            contentPrefix: 'content/',
            draftSuffix: '.md',
            foundationModel: FOUNDATION_MODEL,
            maxTokens: 8192,
            thinkingBudgetTokens: 8192,
            lambdaMemoryMb: 512,
            lambdaTimeoutSeconds: 120,
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
    // Lambda — Publisher Function
    // =========================================================================
    describe('Lambda PublisherFunction', () => {
        const { template } = createContentStack();

        it('should use Node.js 22 runtime', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs22.x',
            });
        });

        it('should set the correct function name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-ai-publisher`,
            });
        });

        it('should configure required environment variables', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        DRAFT_PREFIX: 'drafts/',
                        PUBLISHED_PREFIX: 'published/',
                        CONTENT_PREFIX: 'content/',
                        FOUNDATION_MODEL: FOUNDATION_MODEL,
                        MAX_TOKENS: '8192',
                        THINKING_BUDGET_TOKENS: '8192',
                    }),
                },
            });
        });

        it('should set 512 MB memory', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                MemorySize: 512,
            });
        });

        it('should set 120 second timeout', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Timeout: 120,
            });
        });

        it('should enable X-Ray Active tracing', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                TracingConfig: {
                    Mode: 'Active',
                },
            });
        });

        it('should configure ENVIRONMENT env var for EMF metrics', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        ENVIRONMENT: 'development',
                    }),
                },
            });
        });
    });

    // =========================================================================
    // Lambda Log Group
    // =========================================================================
    describe('CloudWatch Log Group', () => {
        const { template } = createContentStack();

        it('should create a log group for the publisher function', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/lambda/${NAME_PREFIX}-ai-publisher`,
                RetentionInDays: 7,
            });
        });
    });

    // =========================================================================
    // DynamoDB GSI — gsi1-status-date
    // =========================================================================
    describe('DynamoDB GSI', () => {
        const { template } = createContentStack();

        it('should create GSI1 with gsi1pk as partition key and gsi1sk as sort key', () => {
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

        it('should create GSI2 with gsi2pk as partition key and gsi2sk as sort key', () => {
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
    // SQS Dead Letter Queue
    // =========================================================================
    describe('SQS Dead Letter Queue', () => {
        const { template } = createContentStack();

        it('should create the publisher DLQ', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: `${NAME_PREFIX}-publisher-dlq`,
            });
        });

        it('should enable SQS managed encryption on the DLQ', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: `${NAME_PREFIX}-publisher-dlq`,
                SqsManagedSseEnabled: true,
            });
        });
    });

    // =========================================================================
    // IAM — Bedrock InvokeModel permission
    // =========================================================================
    describe('IAM Policies', () => {
        const { template } = createContentStack();

        it('should grant Bedrock InvokeModel permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'bedrock:InvokeModel',
                                'bedrock:InvokeModelWithResponseStream',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createContentStack();

        it('should create SSM parameter for content table name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/content-table-name`,
            });
        });

        it('should create SSM parameter for publisher function ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/publisher-function-arn`,
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

        it('should output the publisher function ARN', () => {
            template.hasOutput('PublisherFunctionArn', {});
        });

        it('should output the publisher function name', () => {
            template.hasOutput('PublisherFunctionName', {});
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

        it('should expose publisherFunction', () => {
            expect(stack.publisherFunction).toBeDefined();
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
    });
});
