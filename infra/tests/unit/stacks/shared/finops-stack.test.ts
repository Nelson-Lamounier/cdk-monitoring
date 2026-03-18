/**
 * @format
 * FinOps Stack Unit Tests
 *
 * Tests for the FinOpsStack:
 * - SNS topic creation with correct naming
 * - Email subscription (optional)
 * - AWS Budgets service principal publishing permission
 * - Budget construct integration with configurable thresholds
 * - Stack outputs (topic ARN, budget limit)
 * - Stack properties (targetEnvironment, public accessors)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { FinOpsStack } from '../../../../lib/stacks/shared/finops-stack';
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
const DEFAULT_MONTHLY_LIMIT = 100;
const DEFAULT_THRESHOLDS = [50, 80, 100];

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create FinOpsStack with sensible defaults.
 */
function _createFinOpsStack(
    overrides?: Partial<ConstructorParameters<typeof FinOpsStack>[2]>,
): { stack: FinOpsStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new FinOpsStack(
        app,
        'TestFinOpsStack',
        {
            targetEnvironment: TEST_ENV,
            namePrefix: TEST_NAME_PREFIX,
            budgetConfig: {
                monthlyLimitUsd: DEFAULT_MONTHLY_LIMIT,
                thresholds: DEFAULT_THRESHOLDS,
            },
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

describe('FinOpsStack', () => {

    // =========================================================================
    // SNS Topic
    // =========================================================================
    describe('SNS Topic', () => {
        it('should create an SNS topic for FinOps alerts', () => {
            const { template } = _createFinOpsStack();

            StackAssertions.hasResourceCount(template, 'AWS::SNS::Topic', 1);
        });

        it('should name the topic using the name prefix', () => {
            const { template } = _createFinOpsStack();

            template.hasResourceProperties('AWS::SNS::Topic', {
                TopicName: `${TEST_NAME_PREFIX}-finops-alerts`,
            });
        });

        it('should set the display name with environment', () => {
            const { template } = _createFinOpsStack();

            template.hasResourceProperties('AWS::SNS::Topic', {
                DisplayName: `FinOps Alerts (${TEST_ENV})`,
            });
        });

        it('should grant AWS Budgets permission to publish', () => {
            const { template } = _createFinOpsStack();

            template.hasResourceProperties('AWS::SNS::TopicPolicy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Allow',
                            Action: 'sns:Publish',
                            Principal: Match.objectLike({
                                Service: 'budgets.amazonaws.com',
                            }),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // Email Subscription
    // =========================================================================
    describe('Email Subscription', () => {
        it('should not create email subscription when no email provided', () => {
            const { template } = _createFinOpsStack();

            StackAssertions.hasResourceCount(template, 'AWS::SNS::Subscription', 0);
        });

        it('should create email subscription when email provided', () => {
            const { template } = _createFinOpsStack({
                notificationEmail: 'finops@example.com',
            });

            StackAssertions.hasResourceCount(template, 'AWS::SNS::Subscription', 1);
        });

        it('should use the correct email address and protocol', () => {
            const testEmail = 'costs@example.com';
            const { template } = _createFinOpsStack({
                notificationEmail: testEmail,
            });

            template.hasResourceProperties('AWS::SNS::Subscription', {
                Protocol: 'email',
                Endpoint: testEmail,
            });
        });
    });

    // =========================================================================
    // Budget Integration
    // =========================================================================
    describe('Budget Integration', () => {
        it('should create an AWS Budget resource', () => {
            const { template } = _createFinOpsStack();

            StackAssertions.hasResourceCount(template, 'AWS::Budgets::Budget', 1);
        });

        it('should set the budget name using the name prefix', () => {
            const { template } = _createFinOpsStack();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetName: `${TEST_NAME_PREFIX}-monthly`,
                }),
            });
        });

        it('should configure the monthly limit from budget config', () => {
            const { template } = _createFinOpsStack();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetLimit: {
                        Amount: DEFAULT_MONTHLY_LIMIT,
                        Unit: 'USD',
                    },
                }),
            });
        });

        it('should create notification rules for each threshold', () => {
            const { template } = _createFinOpsStack();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 50 }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 80 }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 100 }),
                    }),
                ]),
            });
        });

        it('should accept custom budget limits', () => {
            const customLimit = 500;
            const { template } = _createFinOpsStack({
                budgetConfig: {
                    monthlyLimitUsd: customLimit,
                    thresholds: DEFAULT_THRESHOLDS,
                },
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetLimit: {
                        Amount: customLimit,
                        Unit: 'USD',
                    },
                }),
            });
        });

        it('should accept custom thresholds', () => {
            const customThresholds = [30, 60, 90];
            const { template } = _createFinOpsStack({
                budgetConfig: {
                    monthlyLimitUsd: DEFAULT_MONTHLY_LIMIT,
                    thresholds: customThresholds,
                },
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 30 }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 60 }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 90 }),
                    }),
                ]),
            });
        });

        it('should forward cost filters to the budget construct', () => {
            const { template } = _createFinOpsStack({
                costFilters: {
                    project: ['k8s-platform'],
                },
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    CostFilters: {
                        TagKeyValue: Match.arrayWith([
                            'user:project$k8s-platform',
                        ]),
                    },
                }),
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should output the FinOps topic ARN', () => {
            const { template } = _createFinOpsStack();

            StackAssertions.hasOutput(template, 'FinOpsTopicArn', {
                description: 'SNS Topic ARN for FinOps budget alerts',
                exportName: `${TEST_NAME_PREFIX}-finops-topic-arn`,
            });
        });

        it('should output the monthly budget limit', () => {
            const { template } = _createFinOpsStack();

            StackAssertions.hasOutput(template, 'MonthlyBudgetLimit', {
                description: 'Monthly budget limit in USD',
                value: `$${DEFAULT_MONTHLY_LIMIT}`,
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose targetEnvironment', () => {
            const { stack } = _createFinOpsStack();

            expect(stack.targetEnvironment).toBe(TEST_ENV);
        });

        it('should expose alertsTopic', () => {
            const { stack, template } = _createFinOpsStack();

            expect(stack.alertsTopic).toBeDefined();

            // topicName is a token at synth time — verify via template instead
            template.hasResourceProperties('AWS::SNS::Topic', {
                TopicName: `${TEST_NAME_PREFIX}-finops-alerts`,
            });
        });

        it('should expose budget construct', () => {
            const { stack } = _createFinOpsStack();

            expect(stack.budget).toBeDefined();
            expect(stack.budget.budget).toBeDefined();
        });
    });
});
