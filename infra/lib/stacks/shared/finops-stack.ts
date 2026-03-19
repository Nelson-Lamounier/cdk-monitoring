/**
 * @format
 * FinOps Stack — Cost Governance & Visibility
 *
 * Deploys account-level cost governance resources:
 *   - AWS Budgets with SNS alerting (monthly cost thresholds)
 *   - SNS topic for FinOps notifications
 *   - Cost & Usage Report export to S3 (optional, prod-only)
 *
 * Deploy once per account/region alongside the Security Baseline:
 *
 * @example
 * ```bash
 * npx cdk deploy -c project=shared -c environment=development 'Shared-FinOps-development'
 * ```
 *
 * Cost: Free (first 2 budgets/account). SNS: negligible.
 */

import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

import { Construct } from 'constructs';

import type { Environment } from '../../config/environments';
import { BudgetConstruct } from '../../common/finops/budget-construct';

// =========================================================================
// PROPS
// =========================================================================

/**
 * Monthly budget configuration per environment.
 */
export interface BudgetConfig {
    /** Monthly spending limit in USD */
    readonly monthlyLimitUsd: number;

    /** Percentage thresholds to trigger alerts @default [50, 80, 100] */
    readonly thresholds?: ReadonlyArray<number>;
}

/**
 * Props for FinOpsStack.
 */
export interface FinOpsStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** Resource name prefix (e.g. 'shared-dev') */
    readonly namePrefix: string;

    /**
     * Email address for FinOps alert notifications.
     * Receives budget threshold alerts via SNS email subscription.
     */
    readonly notificationEmail?: string;

    /**
     * Monthly budget configuration.
     * Recommended values:
     *   - development: $100
     *   - staging: $200
     *   - production: $500
     */
    readonly budgetConfig: BudgetConfig;

    /**
     * Optional cost-allocation tag filters to scope the budget.
     * When set, the budget only tracks resources matching these tags.
     *
     * @example { project: ['k8s-platform'] }
     */
    readonly costFilters?: Record<string, ReadonlyArray<string>>;
}

// =========================================================================
// STACK
// =========================================================================

/**
 * FinOps Stack — Account-Level Cost Governance.
 *
 * Creates budget alerts with SNS notifications to provide
 * proactive cost visibility. Designed for multi-environment
 * deployment with different thresholds per account.
 *
 * Integration points:
 * - SNS → Email (direct subscription)
 * - SNS → Grafana (via CloudWatch Alarm data source)
 * - SNS → Slack/PagerDuty (via SNS subscription or Chatbot)
 */
export class FinOpsStack extends cdk.Stack {
    /** SNS topic for FinOps alerts */
    public readonly alertsTopic: sns.Topic;

    /** The budget construct */
    public readonly budget: BudgetConstruct;

    /** Target environment this stack was deployed for */
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: FinOpsStackProps) {
        super(scope, id, props);

        this.targetEnvironment = props.targetEnvironment;

        // =================================================================
        // SNS TOPIC — FinOps Notifications
        // =================================================================
        this.alertsTopic = new sns.Topic(this, 'FinOpsAlertsTopic', {
            topicName: `${props.namePrefix}-finops-alerts`,
            displayName: `FinOps Alerts (${props.targetEnvironment})`,
            enforceSSL: true,
        });

        // Email subscription (if provided)
        if (props.notificationEmail) {
            this.alertsTopic.addSubscription(
                new subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        // Grant AWS Budgets permission to publish to this topic
        this.alertsTopic.grantPublish(
            new iam.ServicePrincipal('budgets.amazonaws.com'),
        );

        // =================================================================
        // AWS BUDGET — Monthly Cost Budget with Alerts
        // =================================================================
        const thresholds = props.budgetConfig.thresholds ?? [50, 80, 100];

        this.budget = new BudgetConstruct(this, 'MonthlyBudget', {
            budgetName: `${props.namePrefix}-monthly`,
            monthlyLimitUsd: props.budgetConfig.monthlyLimitUsd,
            alertsTopic: this.alertsTopic,
            thresholds: thresholds.map((percentage) => ({ percentage })),
            costFilters: props.costFilters,
        });

        // =================================================================
        // STACK OUTPUTS
        // =================================================================
        new cdk.CfnOutput(this, 'FinOpsTopicArn', {
            description: 'SNS Topic ARN for FinOps budget alerts',
            value: this.alertsTopic.topicArn,
            exportName: `${props.namePrefix}-finops-topic-arn`,
        });

        new cdk.CfnOutput(this, 'MonthlyBudgetLimit', {
            description: 'Monthly budget limit in USD',
            value: `$${props.budgetConfig.monthlyLimitUsd}`,
        });
    }
}
