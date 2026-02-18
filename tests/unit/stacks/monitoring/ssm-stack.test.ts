/**
 * @format
 * Monitoring SSM Stack Unit Tests
 *
 * Tests for the MonitoringSsmStack:
 * - SSM Run Command document creation with correct parameters and steps
 * - S3 scripts bucket with proper encryption and access controls
 * - S3 BucketDeployment for monitoring stack files
 * - SSM discovery parameters (document name, bucket name)
 * - Stack outputs
 * - Stack properties
 */

import { Template, Match } from 'aws-cdk-lib/assertions';

import {
    MonitoringSsmStack,
    MonitoringSsmStackProps,
} from '../../../../lib/stacks/monitoring/ssm/ssm-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create MonitoringSsmStack for testing.
 */
function createSsmStack(
    props?: Partial<MonitoringSsmStackProps>,
): { stack: MonitoringSsmStack; template: Template } {
    const app = createTestApp();

    const stack = new MonitoringSsmStack(app, 'TestSsmStack', {
        env: TEST_ENV_EU,
        namePrefix: props?.namePrefix ?? 'monitoring-development',
        grafanaAdminPassword: props?.grafanaAdminPassword ?? 'test-password',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

// =============================================================================
// TESTS
// =============================================================================

describe('MonitoringSsmStack', () => {
    // =========================================================================
    // S3 Scripts Bucket
    // =========================================================================
    describe('S3 Scripts Bucket', () => {
        it('should create an S3 bucket with correct naming convention', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: Match.stringLikeRegexp('^monitoring-development-scripts-'),
            });
        });

        it('should enable S3-managed encryption', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketEncryption: Match.objectLike({
                    ServerSideEncryptionConfiguration: Match.arrayWith([
                        Match.objectLike({
                            ServerSideEncryptionByDefault: {
                                SSEAlgorithm: 'AES256',
                            },
                        }),
                    ]),
                }),
            });
        });

        it('should block all public access', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });

        it('should enforce SSL via bucket policy', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::S3::BucketPolicy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Deny',
                            Condition: {
                                Bool: { 'aws:SecureTransport': 'false' },
                            },
                        }),
                    ]),
                }),
            });
        });

        it('should use custom name prefix in bucket name', () => {
            const { template } = createSsmStack({
                namePrefix: 'monitoring-production',
            });

            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: Match.stringLikeRegexp('^monitoring-production-scripts-'),
            });
        });
    });

    // =========================================================================
    // S3 BucketDeployment
    // =========================================================================
    describe('S3 BucketDeployment', () => {
        it('should create a BucketDeployment custom resource', () => {
            const { template } = createSsmStack();

            // BucketDeployment creates a Custom::CDKBucketDeployment resource
            template.hasResource('Custom::CDKBucketDeployment', {});
        });
    });

    // =========================================================================
    // SSM Run Command Document
    // =========================================================================
    describe('SSM Run Command Document', () => {
        it('should create an SSM document with correct name', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'monitoring-development-configure-monitoring-stack',
                DocumentType: 'Command',
            });
        });

        it('should use custom name prefix in document name', () => {
            const { template } = createSsmStack({
                namePrefix: 'monitoring-production',
            });

            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'monitoring-production-configure-monitoring-stack',
            });
        });

        it('should define required parameters in the document', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Document', {
                Content: Match.objectLike({
                    parameters: Match.objectLike({
                        S3BucketName: Match.objectLike({
                            type: 'String',
                        }),
                        GrafanaPassword: Match.objectLike({
                            type: 'String',
                        }),
                        NamePrefix: Match.objectLike({
                            type: 'String',
                        }),
                        Region: Match.objectLike({
                            type: 'String',
                        }),
                        MonitoringDir: Match.objectLike({
                            type: 'String',
                        }),
                    }),
                }),
            });
        });

        it('should have the correct number of execution steps', () => {
            const { template } = createSsmStack();

            // The document should have mainSteps with 5 steps
            template.hasResourceProperties('AWS::SSM::Document', {
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({ name: 'DownloadMonitoringStack' }),
                        Match.objectLike({ name: 'ConfigureEnvironment' }),
                        Match.objectLike({ name: 'StartMonitoringStack' }),
                        Match.objectLike({ name: 'RegisterEndpointsInSsm' }),
                        Match.objectLike({ name: 'ConfigureGitHubActionsExporter' }),
                    ]),
                }),
            });
        });

        it('should use aws:runShellScript action type', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Document', {
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({
                            action: 'aws:runShellScript',
                        }),
                    ]),
                }),
            });
        });

        it('should include tags on the SSM document', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Document', {
                Tags: Match.arrayWith([
                    Match.objectLike({
                        Key: 'Project',
                        Value: 'monitoring-development',
                    }),
                    Match.objectLike({
                        Key: 'Purpose',
                        Value: 'configure-monitoring-stack',
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // SSM Discovery Parameters
    // =========================================================================
    describe('SSM Discovery Parameters', () => {
        it('should create SSM parameter for document name', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: '/monitoring-development/ssm/document-name',
                Value: 'monitoring-development-configure-monitoring-stack',
            });
        });

        it('should create SSM parameter for scripts bucket name', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: '/monitoring-development/ssm/scripts-bucket-name',
            });
        });

        it('should create SSM parameter for execution policy ARN', () => {
            const { template } = createSsmStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: '/monitoring-development/ssm/execution-policy-arn',
            });
        });

        it('should use custom name prefix in SSM parameter paths', () => {
            const { template } = createSsmStack({
                namePrefix: 'monitoring-staging',
            });

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/monitoring-staging/ssm/document-name',
                Value: 'monitoring-staging-configure-monitoring-stack',
            });

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/monitoring-staging/ssm/scripts-bucket-name',
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export SSM document name', () => {
            const { template } = createSsmStack();

            template.hasOutput('SsmDocumentName', {
                Value: 'monitoring-development-configure-monitoring-stack',
                Description: 'SSM Run Command document name',
            });
        });

        it('should export scripts bucket name', () => {
            const { template } = createSsmStack();

            template.hasOutput('ScriptsBucketName', {
                Description: 'S3 bucket containing monitoring stack scripts',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose documentName', () => {
            const { stack } = createSsmStack();

            expect(stack.documentName).toBe('monitoring-development-configure-monitoring-stack');
        });

        it('should expose scriptsBucket', () => {
            const { stack } = createSsmStack();

            expect(stack.scriptsBucket).toBeDefined();
        });

        it('should use default namePrefix when not provided', () => {
            const app = createTestApp();
            const stack = new MonitoringSsmStack(app, 'DefaultStack', {
                env: TEST_ENV_EU,
            });

            expect(stack.documentName).toBe('monitoring-configure-monitoring-stack');
        });

        it('should use default grafanaAdminPassword when not provided', () => {
            const { template } = createSsmStack({
                grafanaAdminPassword: undefined,
            });

            template.hasResourceProperties('AWS::SSM::Document', {
                Content: Match.objectLike({
                    parameters: Match.objectLike({
                        GrafanaPassword: Match.objectLike({
                            default: 'admin',
                        }),
                    }),
                }),
            });
        });
    });

    // =========================================================================
    // Resource Count Verification
    // =========================================================================
    describe('Resource Counts', () => {
        it('should create exactly 2 S3 buckets (scripts + access logs)', () => {
            const { template } = createSsmStack();

            template.resourceCountIs('AWS::S3::Bucket', 2);
        });

        it('should create exactly 1 SSM document', () => {
            const { template } = createSsmStack();

            template.resourceCountIs('AWS::SSM::Document', 1);
        });

        it('should create exactly 3 SSM parameters (document name + bucket name + execution policy ARN)', () => {
            const { template } = createSsmStack();

            template.resourceCountIs('AWS::SSM::Parameter', 3);
        });
    });
});
