/**
 * @format
 * Bedrock Data Stack Unit Tests
 *
 * Tests for the BedrockDataStack:
 * - S3 data bucket with security hardening
 * - S3 access logs bucket
 * - KMS key creation (when enabled)
 * - SSM parameter exports
 * - Stack outputs
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockDataStack } from '../../../../lib/stacks/bedrock/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-development';

/**
 * Helper to create BedrockDataStack with sensible defaults.
 */
function createDataStack(
    overrides?: Partial<ConstructorParameters<typeof BedrockDataStack>[2]>,
): { stack: BedrockDataStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new BedrockDataStack(
        app,
        'TestBedrockDataStack',
        {
            namePrefix: NAME_PREFIX,
            createEncryptionKey: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
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

describe('BedrockDataStack', () => {

    // =========================================================================
    // S3 — Data Bucket
    // =========================================================================
    describe('S3 Data Bucket', () => {
        const { template } = createDataStack();

        it('should create the data bucket with correct name', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-kb-data`,
            });
        });

        it('should block all public access on the data bucket', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-kb-data`,
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });

        it('should enable versioning on the data bucket', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-kb-data`,
                VersioningConfiguration: {
                    Status: 'Enabled',
                },
            });
        });

        it('should configure server access logging to the access logs bucket', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-kb-data`,
                LoggingConfiguration: Match.objectLike({
                    LogFilePrefix: 'data-bucket/',
                }),
            });
        });
    });

    // =========================================================================
    // S3 — Access Logs Bucket
    // =========================================================================
    describe('S3 Access Logs Bucket', () => {
        const { template } = createDataStack();

        it('should create the access logs bucket', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-access-logs`,
            });
        });

        it('should block all public access on the access logs bucket', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-access-logs`,
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });

        it('should configure lifecycle rules on the access logs bucket', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${NAME_PREFIX}-access-logs`,
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            ExpirationInDays: 90,
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // KMS Key (production mode)
    // =========================================================================
    describe('KMS Encryption Key', () => {
        it('should NOT create a KMS key when createEncryptionKey is false', () => {
            const { template } = createDataStack({ createEncryptionKey: false });
            template.resourceCountIs('AWS::KMS::Key', 0);
        });

        it('should create a KMS key when createEncryptionKey is true', () => {
            const { template } = createDataStack({ createEncryptionKey: true });
            template.resourceCountIs('AWS::KMS::Key', 1);
        });

        it('should enable key rotation on the KMS key', () => {
            const { template } = createDataStack({ createEncryptionKey: true });
            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createDataStack();

        it('should create SSM parameter for bucket name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/data-bucket-name`,
            });
        });

        it('should create SSM parameter for bucket ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/data-bucket-arn`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createDataStack();

        it('should output the data bucket name', () => {
            template.hasOutput('DataBucketName', {});
        });

        it('should output the data bucket ARN', () => {
            template.hasOutput('DataBucketArn', {});
        });

        it('should output the access logs bucket name', () => {
            template.hasOutput('AccessLogsBucketName', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createDataStack();

        it('should expose dataBucket', () => {
            expect(stack.dataBucket).toBeDefined();
        });

        it('should expose accessLogsBucket', () => {
            expect(stack.accessLogsBucket).toBeDefined();
        });

        it('should expose bucketName', () => {
            expect(stack.bucketName).toBeDefined();
        });

        it('should not expose encryptionKey when createEncryptionKey is false', () => {
            expect(stack.encryptionKey).toBeUndefined();
        });
    });
});
