/**
 * @format
 * Crossplane Stack Unit Tests
 *
 * Tests for the CrossplaneStack:
 * - IAM user creation with correct naming and path
 * - Tightly scoped S3, SQS, KMS, and Tagging IAM policies
 * - Access key + Secrets Manager credential storage
 * - CDK-nag suppression for AwsSolutions-SMG4
 * - Stack outputs (user ARN, secret ARN, managed services)
 * - Stack properties (targetEnvironment, crossplaneIam)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { CrossplaneStack } from '../../../../lib/stacks/shared/crossplane-stack';
import {
    TEST_ENV_EU,
    createTestApp,
    StackAssertions,
} from '../../../fixtures';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_ENV = Environment.DEVELOPMENT;
const TEST_NAME_PREFIX = 'shared-dev';
const CROSSPLANE_USER_NAME = `${TEST_NAME_PREFIX}-crossplane`;
const CROSSPLANE_SECRET_NAME = `${TEST_NAME_PREFIX}/crossplane/aws-credentials`;
const SERVICE_ACCOUNT_PATH = '/service-accounts/';
const DEFAULT_MANAGED_SERVICES = ['s3', 'sqs'];

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create CrossplaneStack with sensible defaults.
 */
function _createCrossplaneStack(
    overrides?: Partial<ConstructorParameters<typeof CrossplaneStack>[2]>,
): { stack: CrossplaneStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new CrossplaneStack(
        app,
        'TestCrossplaneStack',
        {
            targetEnvironment: TEST_ENV,
            namePrefix: TEST_NAME_PREFIX,
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

describe('CrossplaneStack', () => {

    // =========================================================================
    // IAM User
    // =========================================================================
    describe('IAM User', () => {
        it('should create a dedicated IAM user for Crossplane', () => {
            const { template } = _createCrossplaneStack();

            StackAssertions.hasResourceCount(template, 'AWS::IAM::User', 1);
        });

        it('should name the user with the name prefix', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::User', {
                UserName: CROSSPLANE_USER_NAME,
            });
        });

        it('should place the user under the service-accounts path', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::User', {
                Path: SERVICE_ACCOUNT_PATH,
            });
        });
    });

    // =========================================================================
    // IAM Policies — S3
    // =========================================================================
    describe('IAM Policy — S3', () => {
        it('should grant S3 management permissions by default', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneS3Management',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should scope S3 permissions to crossplane-prefixed buckets', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneS3Management',
                            Resource: Match.arrayWith([
                                `arn:aws:s3:::crossplane-${TEST_NAME_PREFIX}-*`,
                                `arn:aws:s3:::crossplane-${TEST_NAME_PREFIX}-*/*`,
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('should include essential S3 CRUD actions', () => {
            const { template } = _createCrossplaneStack();

            const essentialActions = [
                's3:CreateBucket',
                's3:DeleteBucket',
                's3:PutEncryptionConfiguration',
                's3:PutBucketVersioning',
                's3:PutBucketPublicAccessBlock',
            ];

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneS3Management',
                            Action: Match.arrayWith(essentialActions),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // IAM Policies — SQS
    // =========================================================================
    describe('IAM Policy — SQS', () => {
        it('should grant SQS management permissions by default', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneSqsManagement',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should scope SQS permissions to crossplane-prefixed queues', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneSqsManagement',
                            Resource: `arn:aws:sqs:*:*:crossplane-${TEST_NAME_PREFIX}-*`,
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // IAM Policies — KMS
    // =========================================================================
    describe('IAM Policy — KMS', () => {
        it('should grant KMS usage permissions', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneKmsUsage',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should condition KMS access on the managed-by tag', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneKmsUsage',
                            Condition: {
                                StringLike: {
                                    'aws:RequestTag/managed-by': 'crossplane',
                                },
                            },
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // IAM Policies — Tagging
    // =========================================================================
    describe('IAM Policy — Tagging', () => {
        it('should grant resource tagging permissions', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneTaggingOperations',
                            Effect: 'Allow',
                            Action: Match.arrayWith([
                                'tag:GetResources',
                                'tag:TagResources',
                                'tag:UntagResources',
                            ]),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // Managed Services — Configurable
    // =========================================================================
    describe('Managed Services Configuration', () => {
        it('should only include SQS policies when s3 is excluded', () => {
            const { template } = _createCrossplaneStack({
                managedServices: ['sqs'],
            });

            // SQS policy should exist
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CrossplaneSqsManagement',
                        }),
                    ]),
                }),
            });

            // S3 policy should NOT exist — verify by checking no S3 statement
            const policyResources = template.findResources('AWS::IAM::Policy');
            const policies = Object.values(policyResources);
            const allStatements = policies.flatMap(
                (p) => (p.Properties?.PolicyDocument?.Statement ?? []) as Array<{ Sid?: string }>,
            );
            const s3Statement = allStatements.find((s) => s.Sid === 'CrossplaneS3Management');
            expect(s3Statement).toBeUndefined();
        });
    });

    // =========================================================================
    // Secrets Manager — Credential Storage
    // =========================================================================
    describe('Secrets Manager', () => {
        it('should create a Secrets Manager secret for credentials', () => {
            const { template } = _createCrossplaneStack();

            StackAssertions.hasResourceCount(template, 'AWS::SecretsManager::Secret', 1);
        });

        it('should name the secret using the naming convention', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Name: CROSSPLANE_SECRET_NAME,
            });
        });

        it('should include environment in the description', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::SecretsManager::Secret', {
                Description: Match.stringLikeRegexp(TEST_ENV),
            });
        });
    });

    // =========================================================================
    // Access Key
    // =========================================================================
    describe('Access Key', () => {
        it('should create an IAM access key for the user', () => {
            const { template } = _createCrossplaneStack();

            StackAssertions.hasResourceCount(template, 'AWS::IAM::AccessKey', 1);
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should output the Crossplane user ARN', () => {
            const { template } = _createCrossplaneStack();

            StackAssertions.hasOutput(template, 'CrossplaneUserArn', {
                description: 'IAM User ARN for Crossplane',
            });
        });

        it('should output the credential secret ARN with export name', () => {
            const { template } = _createCrossplaneStack();

            StackAssertions.hasOutput(template, 'CrossplaneCredentialSecretArn', {
                description: 'Secrets Manager ARN storing Crossplane AWS credentials',
                exportName: `${TEST_NAME_PREFIX}-crossplane-credential-arn`,
            });
        });

        it('should output the managed services list', () => {
            const { template } = _createCrossplaneStack();

            StackAssertions.hasOutput(template, 'CrossplaneManagedServices', {
                description: 'AWS services Crossplane can manage',
                value: DEFAULT_MANAGED_SERVICES.join(', '),
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose targetEnvironment', () => {
            const { stack } = _createCrossplaneStack();

            expect(stack.targetEnvironment).toBe(TEST_ENV);
        });

        it('should expose crossplaneIam construct', () => {
            const { stack } = _createCrossplaneStack();

            expect(stack.crossplaneIam).toBeDefined();
            expect(stack.crossplaneIam.user).toBeDefined();
            expect(stack.crossplaneIam.credentialSecret).toBeDefined();
            expect(stack.crossplaneIam.accessKey).toBeDefined();
        });
    });

    // =========================================================================
    // Tags
    // =========================================================================
    describe('Tags', () => {
        it('should tag resources with managed-by=cdk', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::User', {
                Tags: Match.arrayWith([
                    Match.objectLike({
                        Key: 'managed-by',
                        Value: 'cdk',
                    }),
                ]),
            });
        });

        it('should tag resources with purpose=crossplane-credentials', () => {
            const { template } = _createCrossplaneStack();

            template.hasResourceProperties('AWS::IAM::User', {
                Tags: Match.arrayWith([
                    Match.objectLike({
                        Key: 'purpose',
                        Value: 'crossplane-credentials',
                    }),
                ]),
            });
        });
    });
});
