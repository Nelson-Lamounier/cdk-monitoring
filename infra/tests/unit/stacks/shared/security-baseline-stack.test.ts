/**
 * @format
 * Security Baseline Stack Unit Tests
 *
 * Tests for the SecurityBaselineStack:
 * - GuardDuty detector creation with minimal-cost defaults
 * - Security Hub enablement
 * - IAM Access Analyzer (account scope)
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
    // Feature Flags — All Disabled
    // =========================================================================
    describe('Feature Flags — All Disabled', () => {
        it('should create empty stack when all services disabled', () => {
            const { template } = _createSecurityStack({
                enableGuardDuty: false,
                enableSecurityHub: false,
                enableAccessAnalyzer: false,
            });

            StackAssertions.hasResourceCount(template, 'AWS::GuardDuty::Detector', 0);
            StackAssertions.hasResourceCount(template, 'AWS::SecurityHub::Hub', 0);
            StackAssertions.hasResourceCount(template, 'AWS::AccessAnalyzer::Analyzer', 0);
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
    });
});
