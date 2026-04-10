/**
 * @format
 * Strategist Data Stack Unit Tests
 *
 * Tests for the StrategistDataStack (Job Strategist Data Layer):
 * - DynamoDB table with correct pk/sk keys and billing mode
 * - GSI1 (gsi1-status-date) for admin listing by status
 * - Point-in-time recovery enabled
 * - SSM parameter exports (table name, table ARN)
 * - Stack outputs
 * - Public properties (strategistTable, tableName)
 * - grantStrategistRead helper
 *
 * Note: The stack uses `AWS::DynamoDB::Table` (not `AWS::DynamoDB::GlobalTable`)
 * because the underlying CDK construct is `Table`, not `TableV2`.
 * `TableV2` was replaced to eliminate CDK 2.243.0 `policyResource`/
 * `encryptedResource` deprecation warnings emitted by its grant*() path.
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { StrategistDataStack } from '../../../../lib/stacks/bedrock/strategist-data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Constants
// =============================================================================

const NAME_PREFIX = 'bedrock-development';
const TEST_BUCKET_NAME = `${NAME_PREFIX}-kb-data`;
const TABLE_NAME = `${NAME_PREFIX}-job-strategist`;

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create StrategistDataStack with sensible defaults.
 *
 * @param overrides - Partial props to override defaults
 * @returns Stack, template, and app for testing
 */
function createStrategistDataStack(
    overrides?: Partial<ConstructorParameters<typeof StrategistDataStack>[2]>,
): { stack: StrategistDataStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new StrategistDataStack(
        app,
        'TestStrategistDataStack',
        {
            namePrefix: NAME_PREFIX,
            assetsBucketName: TEST_BUCKET_NAME,
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

describe('StrategistDataStack', () => {

    // =========================================================================
    // DynamoDB — Strategist Table
    // =========================================================================
    describe('DynamoDB Strategist Table', () => {
        const { template } = createStrategistDataStack();

        it('should create a DynamoDB table with pk/sk keys', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                KeySchema: Match.arrayWith([
                    Match.objectLike({ AttributeName: 'pk', KeyType: 'HASH' }),
                    Match.objectLike({ AttributeName: 'sk', KeyType: 'RANGE' }),
                ]),
            });
        });

        it('should use PAY_PER_REQUEST billing mode', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });

        it('should set the correct table name', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TableName: TABLE_NAME,
            });
        });

        it('should enable point-in-time recovery', () => {
            // AWS::DynamoDB::Table emits PITR at the top-level PointInTimeRecoverySpecification,
            // unlike AWS::DynamoDB::GlobalTable which uses Replicas[].PointInTimeRecoverySpecification
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                PointInTimeRecoverySpecification: {
                    PointInTimeRecoveryEnabled: true,
                },
            });
        });

        it('should define pk, sk, gsi1pk, and gsi1sk attributes', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                AttributeDefinitions: Match.arrayWith([
                    Match.objectLike({ AttributeName: 'pk', AttributeType: 'S' }),
                    Match.objectLike({ AttributeName: 'sk', AttributeType: 'S' }),
                    Match.objectLike({ AttributeName: 'gsi1pk', AttributeType: 'S' }),
                    Match.objectLike({ AttributeName: 'gsi1sk', AttributeType: 'S' }),
                ]),
            });
        });
    });

    // =========================================================================
    // DynamoDB GSIs
    // =========================================================================
    describe('DynamoDB GSIs', () => {
        const { template } = createStrategistDataStack();

        it('should create GSI1 (gsi1-status-date) for application listing', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
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

        it('should have exactly 1 GSI', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({ IndexName: 'gsi1-status-date' }),
                ]),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createStrategistDataStack();

        it('should export strategist table name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/strategist-table-name`,
            });
        });

        it('should export strategist table ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/strategist-table-arn`,
            });
        });

        it('should create exactly 2 SSM parameters', () => {
            template.resourceCountIs('AWS::SSM::Parameter', 2);
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createStrategistDataStack();

        it('should output the strategist table name', () => {
            template.hasOutput('StrategistTableName', {});
        });

        it('should output the strategist table ARN', () => {
            template.hasOutput('StrategistTableArn', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createStrategistDataStack();

        it('should expose strategistTable', () => {
            expect(stack.strategistTable).toBeDefined();
        });

        it('should expose tableName', () => {
            expect(stack.tableName).toBeDefined();
        });

        it('should have tableName as a non-empty string', () => {
            expect(typeof stack.tableName).toBe('string');
            expect(stack.tableName.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // grantStrategistRead Helper
    // =========================================================================
    describe('grantStrategistRead', () => {
        it('should expose grantStrategistRead method', () => {
            const { stack } = createStrategistDataStack();
            expect(typeof stack.grantStrategistRead).toBe('function');
        });

        it('should grant DynamoDB read access when called', () => {
            const freshApp = createTestApp();
            const freshStack = new StrategistDataStack(
                freshApp,
                'TestGrantStack',
                {
                    namePrefix: NAME_PREFIX,
                    assetsBucketName: TEST_BUCKET_NAME,
                    removalPolicy: cdk.RemovalPolicy.DESTROY,
                    environmentName: 'development',
                    env: TEST_ENV_EU,
                },
            );

            const testRole = new iam.Role(freshStack, 'TestConsumerRole', {
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            });
            freshStack.grantStrategistRead(testRole);

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
    // Resource Count Guards
    // =========================================================================
    describe('Resource count guards', () => {
        const { template } = createStrategistDataStack();

        it('should create exactly 1 DynamoDB table', () => {
            template.resourceCountIs('AWS::DynamoDB::Table', 1);
        });

        it('should not create any Lambda functions', () => {
            template.resourceCountIs('AWS::Lambda::Function', 0);
        });

        it('should not create any SQS queues', () => {
            template.resourceCountIs('AWS::SQS::Queue', 0);
        });

        it('should not create any S3 buckets (data comes from DataStack)', () => {
            template.resourceCountIs('AWS::S3::Bucket', 0);
        });
    });

    // =========================================================================
    // Removal Policy Override
    // =========================================================================
    describe('Removal policy', () => {
        it('should apply RETAIN removal policy when specified', () => {
            const { template } = createStrategistDataStack({
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });
            template.hasResource('AWS::DynamoDB::Table', {
                DeletionPolicy: 'Retain',
                UpdateReplacePolicy: 'Retain',
            });
        });

        it('should apply DESTROY removal policy when specified', () => {
            const { template } = createStrategistDataStack({
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });
            template.hasResource('AWS::DynamoDB::Table', {
                DeletionPolicy: 'Delete',
            });
        });
    });
});
