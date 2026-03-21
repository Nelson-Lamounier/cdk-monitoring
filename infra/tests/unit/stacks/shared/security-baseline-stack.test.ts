/**
 * @format
 * Security Baseline Stack Unit Tests
 *
 * Tests for the SecurityBaselineStack:
 * - GuardDuty detector creation with minimal-cost defaults
 * - Security Hub enablement
 * - IAM Access Analyzer (account scope)
 * - CloudTrail management trail with S3 lifecycle
 * - EventBridge CloudFormation failure detection
 * - Feature flag toggling
 * - SNS notification topic (optional)
 * - Stack outputs
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { SecurityBaselineStack } from '../../../../lib/stacks/shared/security-baseline-stack';
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

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create SecurityBaselineStack with sensible defaults.
 */
function _createSecurityStack(
    overrides?: Partial<ConstructorParameters<typeof SecurityBaselineStack>[2]>,
): { stack: SecurityBaselineStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new SecurityBaselineStack(
        app,
        'TestSecurityBaselineStack',
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

describe('SecurityBaselineStack', () => {

    // =========================================================================
    // GuardDuty
    // =========================================================================
    describe('GuardDuty', () => {
        it('should create a GuardDuty detector by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::GuardDuty::Detector', {
                Enable: true,
            });
        });

        it('should set finding publishing frequency to FIFTEEN_MINUTES by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::GuardDuty::Detector', {
                FindingPublishingFrequency: 'FIFTEEN_MINUTES',
            });
        });

        it('should disable S3 data event protection by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::GuardDuty::Detector', {
                Features: Match.arrayWith([
                    Match.objectLike({
                        Name: 'S3_DATA_EVENTS',
                        Status: 'DISABLED',
                    }),
                ]),
            });
        });

        it('should disable EKS audit log monitoring by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::GuardDuty::Detector', {
                Features: Match.arrayWith([
                    Match.objectLike({
                        Name: 'EKS_AUDIT_LOGS',
                        Status: 'DISABLED',
                    }),
                ]),
            });
        });

        it('should disable malware protection by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::GuardDuty::Detector', {
                Features: Match.arrayWith([
                    Match.objectLike({
                        Name: 'EBS_MALWARE_PROTECTION',
                        Status: 'DISABLED',
                    }),
                ]),
            });
        });

        it('should disable runtime monitoring by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::GuardDuty::Detector', {
                Features: Match.arrayWith([
                    Match.objectLike({
                        Name: 'RUNTIME_MONITORING',
                        Status: 'DISABLED',
                    }),
                ]),
            });
        });

        it('should not create detector when enableGuardDuty is false', () => {
            const { template } = _createSecurityStack({ enableGuardDuty: false });

            StackAssertions.hasResourceCount(template, 'AWS::GuardDuty::Detector', 0);
        });
    });

    // =========================================================================
    // Security Hub
    // =========================================================================
    describe('Security Hub', () => {
        it('should create Security Hub by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::SecurityHub::Hub', {
                AutoEnableControls: true,
                ControlFindingGenerator: 'SECURITY_CONTROL',
                EnableDefaultStandards: false,
            });
        });

        it('should not create Security Hub when enableSecurityHub is false', () => {
            const { template } = _createSecurityStack({ enableSecurityHub: false });

            StackAssertions.hasResourceCount(template, 'AWS::SecurityHub::Hub', 0);
        });
    });

    // =========================================================================
    // IAM Access Analyzer
    // =========================================================================
    describe('IAM Access Analyzer', () => {
        it('should create account-level analyzer by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::AccessAnalyzer::Analyzer', {
                AnalyzerName: `${TEST_NAME_PREFIX}-access-analyzer`,
                Type: 'ACCOUNT',
            });
        });

        it('should not create analyzer when enableAccessAnalyzer is false', () => {
            const { template } = _createSecurityStack({ enableAccessAnalyzer: false });

            StackAssertions.hasResourceCount(template, 'AWS::AccessAnalyzer::Analyzer', 0);
        });
    });

    // =========================================================================
    // SNS Notifications
    // =========================================================================
    describe('SNS Notifications', () => {
        it('should not create SNS topic when no email provided', () => {
            const { template } = _createSecurityStack();

            StackAssertions.hasResourceCount(template, 'AWS::SNS::Topic', 0);
        });

        it('should create SNS topic with email subscription when email provided', () => {
            const { template } = _createSecurityStack({
                notificationEmail: 'alerts@example.com',
            });

            StackAssertions.hasResourceCount(template, 'AWS::SNS::Topic', 1);

            template.hasResourceProperties('AWS::SNS::Subscription', {
                Protocol: 'email',
                Endpoint: 'alerts@example.com',
            });
        });
    });

    // =========================================================================
    // CloudTrail
    // =========================================================================
    describe('CloudTrail', () => {
        it('should create a CloudTrail trail by default', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::CloudTrail::Trail', {
                TrailName: `${TEST_NAME_PREFIX}-management-trail`,
                IsMultiRegionTrail: false,
                IncludeGlobalServiceEvents: true,
                EnableLogFileValidation: true,
            });
        });

        it('should create an S3 bucket for CloudTrail logs', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${TEST_NAME_PREFIX}-cloudtrail-logs`,
                PublicAccessBlockConfiguration: Match.objectLike({
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                }),
            });
        });

        it('should configure S3 lifecycle expiry for CloudTrail logs', () => {
            const { template } = _createSecurityStack();

            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: `${TEST_NAME_PREFIX}-cloudtrail-logs`,
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            ExpirationInDays: 90,
                            Status: 'Enabled',
                        }),
                    ]),
                }),
            });
        });

        it('should not create trail when enableCloudTrail is false', () => {
            const { template } = _createSecurityStack({ enableCloudTrail: false });

            StackAssertions.hasResourceCount(template, 'AWS::CloudTrail::Trail', 0);
        });

        it('should respect custom retention days', () => {
            const { template } = _createSecurityStack({ cloudTrailRetentionDays: 30 });

            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            ExpirationInDays: 30,
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // EventBridge — CloudFormation Failure Detection
    // =========================================================================
    describe('EventBridge — CloudFormation Failure Detection', () => {
        it('should create an EventBridge rule when notification email is provided', () => {
            const { template } = _createSecurityStack({
                notificationEmail: 'alerts@example.com',
            });

            template.hasResourceProperties('AWS::Events::Rule', {
                Name: `${TEST_NAME_PREFIX}-cfn-failure-alerts`,
                EventPattern: Match.objectLike({
                    source: ['aws.cloudformation'],
                    'detail-type': ['CloudFormation Stack Status Change'],
                }),
            });
        });

        it('should filter for CloudFormation failure states', () => {
            const { template } = _createSecurityStack({
                notificationEmail: 'alerts@example.com',
            });

            template.hasResourceProperties('AWS::Events::Rule', {
                EventPattern: Match.objectLike({
                    detail: {
                        'status-details': {
                            status: [
                                'UPDATE_ROLLBACK_COMPLETE',
                                'UPDATE_ROLLBACK_FAILED',
                                'UPDATE_FAILED',
                                'CREATE_FAILED',
                                'DELETE_FAILED',
                            ],
                        },
                    },
                }),
            });
        });

        it('should not create rule when no notification email provided', () => {
            const { template } = _createSecurityStack();

            StackAssertions.hasResourceCount(template, 'AWS::Events::Rule', 0);
        });

        it('should not create rule when enableCfnDriftAlerts is false', () => {
            const { template } = _createSecurityStack({
                notificationEmail: 'alerts@example.com',
                enableCfnDriftAlerts: false,
            });

            StackAssertions.hasResourceCount(template, 'AWS::Events::Rule', 0);
        });
    });

    // =========================================================================
    // Feature Flags — All Disabled
    // =========================================================================
    describe('Feature Flags — All Disabled', () => {
        it('should create minimal stack when all services disabled', () => {
            const { template } = _createSecurityStack({
                enableGuardDuty: false,
                enableSecurityHub: false,
                enableAccessAnalyzer: false,
                enableCloudTrail: false,
                enableCfnDriftAlerts: false,
            });

            StackAssertions.hasResourceCount(template, 'AWS::GuardDuty::Detector', 0);
            StackAssertions.hasResourceCount(template, 'AWS::SecurityHub::Hub', 0);
            StackAssertions.hasResourceCount(template, 'AWS::AccessAnalyzer::Analyzer', 0);
            StackAssertions.hasResourceCount(template, 'AWS::CloudTrail::Trail', 0);
            StackAssertions.hasResourceCount(template, 'AWS::Events::Rule', 0);
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should output GuardDuty detector ID', () => {
            const { template } = _createSecurityStack();

            StackAssertions.hasOutput(template, 'GuardDutyDetectorId', {
                description: 'GuardDuty Detector ID',
            });
        });

        it('should output Access Analyzer ARN', () => {
            const { template } = _createSecurityStack();

            StackAssertions.hasOutput(template, 'AccessAnalyzerArn', {
                description: 'IAM Access Analyzer ARN',
            });
        });

        it('should output CloudTrail trail ARN', () => {
            const { template } = _createSecurityStack();

            StackAssertions.hasOutput(template, 'CloudTrailArn', {
                description: 'CloudTrail Management Trail ARN',
            });
        });

        it('should output CloudTrail S3 bucket name', () => {
            const { template } = _createSecurityStack();

            StackAssertions.hasOutput(template, 'CloudTrailBucket', {
                description: 'S3 bucket for CloudTrail logs',
            });
        });

        it('should output EventBridge rule ARN when notification email provided', () => {
            const { template } = _createSecurityStack({
                notificationEmail: 'alerts@example.com',
            });

            StackAssertions.hasOutput(template, 'CfnFailureRuleArn', {
                description: 'EventBridge rule ARN for CloudFormation failure alerts',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose targetEnvironment', () => {
            const { stack } = _createSecurityStack();

            expect(stack.targetEnvironment).toBe(TEST_ENV);
        });

        it('should expose baseline construct', () => {
            const { stack } = _createSecurityStack();

            expect(stack.baseline).toBeDefined();
            expect(stack.baseline.guardDutyDetector).toBeDefined();
            expect(stack.baseline.securityHub).toBeDefined();
            expect(stack.baseline.accessAnalyzer).toBeDefined();
        });

        it('should expose CloudTrail resources', () => {
            const { stack } = _createSecurityStack();

            expect(stack.baseline.trail).toBeDefined();
            expect(stack.baseline.trailBucket).toBeDefined();
        });
    });
});
