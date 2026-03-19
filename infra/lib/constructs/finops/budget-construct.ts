/**
 * @format
 * Budget Construct — Reusable AWS Budget with SNS Alerting
 *
 * Provisions an AWS Budget with configurable thresholds that publish
 * alerts to an SNS topic. Designed for multi-environment deployment
 * with different budgets per account.
 *
 * Cost: Free (AWS Budgets has no charge for the first 2 budgets per account;
 *        62 action-enabled budgets free).
 *
 * @example
 * ```typescript
 * new BudgetConstruct(this, 'MonthlyBudget', {
 *     budgetName: 'k8s-dev-monthly',
 *     monthlyLimitUsd: 100,
 *     alertsTopic: snsTopic,
 *     thresholds: [50, 80, 100],
 * });
 * ```
 */

import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =========================================================================
// PROPS
// =========================================================================

/**
 * Configuration for a single budget threshold notification.
 */
export interface BudgetThreshold {
    /** Percentage of budget to trigger alert (e.g. 80 = 80%) */
    readonly percentage: number;

    /** Comparison operator for the threshold */
    readonly comparisonOperator?: 'GREATER_THAN' | 'EQUAL_TO' | 'LESS_THAN';

    /** Whether the threshold uses actual or forecasted spend */
    readonly notificationType?: 'ACTUAL' | 'FORECASTED';
}

/**
 * Props for the Budget construct.
 */
export interface BudgetConstructProps {
    /** Human-readable name for the budget (e.g. 'k8s-dev-monthly') */
    readonly budgetName: string;

    /** Monthly spending limit in USD */
    readonly monthlyLimitUsd: number;

    /** SNS topic to receive budget alerts */
    readonly alertsTopic: sns.ITopic;

    /**
     * Percentage thresholds to trigger alerts.
     * Each threshold generates a separate notification rule.
     *
     * @default [50, 80, 100]
     */
    readonly thresholds?: ReadonlyArray<BudgetThreshold | number>;

    /**
     * Optional cost-allocation tag filters.
     * Scopes the budget to resources matching these tags.
     *
     * @example { project: 'k8s-platform', environment: 'development' }
     */
    readonly costFilters?: Record<string, ReadonlyArray<string>>;
}

// =========================================================================
// CONSTRUCT
// =========================================================================

/**
 * Reusable AWS Budget construct with SNS-based alerting.
 *
 * Creates a COST-type monthly budget with auto-reset at month end.
 * Integrates with existing SNS topics for notification delivery
 * to email, Slack, PagerDuty, or other subscribers.
 */
export class BudgetConstruct extends Construct {
    /** The underlying CloudFormation budget resource */
    public readonly budget: budgets.CfnBudget;

    constructor(scope: Construct, id: string, props: BudgetConstructProps) {
        super(scope, id);

        // Normalise thresholds — accept plain numbers or full config objects
        const defaultThresholds: ReadonlyArray<BudgetThreshold> = [
            { percentage: 50, notificationType: 'ACTUAL' },
            { percentage: 80, notificationType: 'ACTUAL' },
            { percentage: 100, notificationType: 'FORECASTED' },
        ];

        const thresholds: ReadonlyArray<BudgetThreshold> = props.thresholds
            ? props.thresholds.map((t) =>
                typeof t === 'number'
                    ? { percentage: t, notificationType: 'ACTUAL' as const }
                    : t,
            )
            : defaultThresholds;

        // Build notification entries
        const notificationsWithSubscribers = thresholds.map((threshold) => ({
            notification: {
                comparisonOperator: threshold.comparisonOperator ?? 'GREATER_THAN',
                notificationType: threshold.notificationType ?? 'ACTUAL',
                threshold: threshold.percentage,
                thresholdType: 'PERCENTAGE',
            },
            subscribers: [
                {
                    subscriptionType: 'SNS',
                    address: props.alertsTopic.topicArn,
                },
            ],
        }));

        // Build cost filters from tag map
        const costFilters = props.costFilters
            ? Object.entries(props.costFilters).reduce<Record<string, string[]>>(
                (acc, [key, values]) => {
                    // AWS Budgets uses TagKeyValue format: "tag-key$tag-value"
                    acc[`TagKeyValue`] = [
                        ...(acc['TagKeyValue'] ?? []),
                        ...values.map((v) => `user:${key}$${v}`),
                    ];
                    return acc;
                },
                {},
            )
            : undefined;

        this.budget = new budgets.CfnBudget(this, 'Budget', {
            budget: {
                budgetName: props.budgetName,
                budgetType: 'COST',
                timeUnit: 'MONTHLY',
                budgetLimit: {
                    amount: props.monthlyLimitUsd,
                    unit: 'USD',
                },
                ...(costFilters ? { costFilters } : {}),
            },
            notificationsWithSubscribers,
        });

        // Add description via metadata
        this.budget.addMetadata('Description', [
            `Monthly budget: $${props.monthlyLimitUsd} USD`,
            `Alerts at: ${thresholds.map((t) => `${t.percentage}%`).join(', ')}`,
            `Notifications: ${props.alertsTopic.topicArn}`,
        ].join(' | '));

        // Tag the budget itself
        cdk.Tags.of(this).add('managed-by', 'cdk');
    }
}
