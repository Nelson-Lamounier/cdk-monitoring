/**
 * @format
 * BudgetConstruct Unit Tests
 *
 * Tests for the reusable BudgetConstruct:
 * - COST-type monthly budget creation
 * - SNS notification subscriber configuration
 * - Default and custom threshold handling
 * - Cost filter tag formatting
 * - Threshold normalisation (plain numbers vs full config objects)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib/core';

import { BudgetConstruct } from '../../../../lib/constructs/finops/budget-construct';
import { createTestApp } from '../../../fixtures';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_BUDGET_NAME = 'test-budget-monthly';
const TEST_MONTHLY_LIMIT = 100;

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create a BudgetConstruct inside a test stack with sensible defaults.
 */
function _createBudgetConstruct(
    overrides?: Partial<ConstructorParameters<typeof BudgetConstruct>[2]>,
): { stack: cdk.Stack; template: Template; topic: sns.Topic } {
    const app = createTestApp();
    const stack = new cdk.Stack(app, 'TestBudgetStack');

    const topic = new sns.Topic(stack, 'TestTopic', {
        topicName: 'test-alerts',
    });

    new BudgetConstruct(stack, 'TestBudget', {
        budgetName: TEST_BUDGET_NAME,
        monthlyLimitUsd: TEST_MONTHLY_LIMIT,
        alertsTopic: topic,
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, topic };
}

// =============================================================================
// Tests
// =============================================================================

describe('BudgetConstruct', () => {

    // =========================================================================
    // Budget Configuration
    // =========================================================================
    describe('Budget Configuration', () => {
        it('should create a COST-type monthly budget', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetType: 'COST',
                    TimeUnit: 'MONTHLY',
                }),
            });
        });

        it('should set the budget limit in USD', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetLimit: {
                        Amount: TEST_MONTHLY_LIMIT,
                        Unit: 'USD',
                    },
                }),
            });
        });

        it('should set the budget name', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetName: TEST_BUDGET_NAME,
                }),
            });
        });

        it('should accept custom limit values', () => {
            const customLimit = 250;
            const { template } = _createBudgetConstruct({
                monthlyLimitUsd: customLimit,
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
    });

    // =========================================================================
    // Default Thresholds
    // =========================================================================
    describe('Default Thresholds', () => {
        it('should create 3 notification rules by default', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({ Notification: Match.objectLike({ Threshold: 50 }) }),
                    Match.objectLike({ Notification: Match.objectLike({ Threshold: 80 }) }),
                    Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
                ]),
            });
        });

        it('should use ACTUAL type for 50% and 80% default thresholds', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({
                            Threshold: 50,
                            NotificationType: 'ACTUAL',
                        }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({
                            Threshold: 80,
                            NotificationType: 'ACTUAL',
                        }),
                    }),
                ]),
            });
        });

        it('should use FORECASTED type for 100% default threshold', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({
                            Threshold: 100,
                            NotificationType: 'FORECASTED',
                        }),
                    }),
                ]),
            });
        });

        it('should use GREATER_THAN comparison by default', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({
                            ComparisonOperator: 'GREATER_THAN',
                        }),
                    }),
                ]),
            });
        });

        it('should use PERCENTAGE threshold type', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({
                            ThresholdType: 'PERCENTAGE',
                        }),
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // Custom Thresholds
    // =========================================================================
    describe('Custom Thresholds', () => {
        it('should accept plain numbers as thresholds', () => {
            const { template } = _createBudgetConstruct({
                thresholds: [25, 75],
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 25, NotificationType: 'ACTUAL' }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 75, NotificationType: 'ACTUAL' }),
                    }),
                ]),
            });
        });

        it('should accept full BudgetThreshold objects', () => {
            const { template } = _createBudgetConstruct({
                thresholds: [
                    { percentage: 90, notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN' },
                ],
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({
                            Threshold: 90,
                            NotificationType: 'FORECASTED',
                            ComparisonOperator: 'GREATER_THAN',
                        }),
                    }),
                ]),
            });
        });

        it('should support mixed threshold formats', () => {
            const { template } = _createBudgetConstruct({
                thresholds: [
                    30,
                    { percentage: 60, notificationType: 'FORECASTED' },
                ],
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 30, NotificationType: 'ACTUAL' }),
                    }),
                    Match.objectLike({
                        Notification: Match.objectLike({ Threshold: 60, NotificationType: 'FORECASTED' }),
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // SNS Subscriber
    // =========================================================================
    describe('SNS Subscriber', () => {
        it('should subscribe to the alerts SNS topic', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                NotificationsWithSubscribers: Match.arrayWith([
                    Match.objectLike({
                        Subscribers: Match.arrayWith([
                            Match.objectLike({
                                SubscriptionType: 'SNS',
                            }),
                        ]),
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // Cost Filters
    // =========================================================================
    describe('Cost Filters', () => {
        it('should not include cost filters when none specified', () => {
            const { template } = _createBudgetConstruct();

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    BudgetType: 'COST',
                }),
            });

            // Verify no CostFilters key exists
            const budgets = template.findResources('AWS::Budgets::Budget');
            const budgetResource = Object.values(budgets)[0] as {
                Properties?: { Budget?: { CostFilters?: unknown } };
            };
            expect(budgetResource?.Properties?.Budget?.CostFilters).toBeUndefined();
        });

        it('should apply tag-based cost filters in AWS format', () => {
            const { template } = _createBudgetConstruct({
                costFilters: {
                    project: ['k8s-platform'],
                    environment: ['development'],
                },
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    CostFilters: {
                        TagKeyValue: Match.arrayWith([
                            'user:project$k8s-platform',
                            'user:environment$development',
                        ]),
                    },
                }),
            });
        });

        it('should support multiple values per tag key', () => {
            const { template } = _createBudgetConstruct({
                costFilters: {
                    environment: ['development', 'staging'],
                },
            });

            template.hasResourceProperties('AWS::Budgets::Budget', {
                Budget: Match.objectLike({
                    CostFilters: {
                        TagKeyValue: Match.arrayWith([
                            'user:environment$development',
                            'user:environment$staging',
                        ]),
                    },
                }),
            });
        });
    });
});
