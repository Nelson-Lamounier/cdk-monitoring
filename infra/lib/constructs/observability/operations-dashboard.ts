/**
 * @format
 * Operations Dashboard — Deployment Execution Traceability
 *
 * CloudWatch dashboard providing runtime visibility into the K8s
 * deployment pipeline. Complements the pre-existing InfrastructureDashboard
 * (EC2/NLB health) with operational execution tracing:
 *
 *   Section 1: AMI Build Pipeline       (Image Builder status + logs)
 *   Section 2: SSM Bootstrap Execution  (Automation success/fail + SFn logs)
 *   Section 3: Drift Enforcement        (Association compliance + RunCommand logs)
 *   Section 4: Self-Healing Pipeline    (Agent + tool Lambda metrics + logs)
 *
 * Panel Style Philosophy:
 *   - SingleValueWidget → instant pass/fail at a glance (counts)
 *   - LogQueryWidget    → click to drill into full log context on failure
 *   - GraphWidget       → trend lines for invocations/errors over time
 *
 * Cost: $3.00/month (one additional dashboard).
 *
 * @example
 * ```typescript
 * new OperationsDashboard(this, 'OpsDashboard', {
 *     namePrefix: 'k8s-dev',
 *     region: 'eu-west-1',
 *     ssmPrefix: '/k8s/development',
 * });
 * ```
 */

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Self-healing pipeline Lambda function configuration.
 */
export interface OpsDashboardSelfHealingConfig {
    /** Agent Lambda function name (e.g. `self-healing-dev-agent`) */
    readonly agentFunctionName: string;
    /** Tool Lambda function names with labels */
    readonly toolFunctions: ReadonlyArray<{
        readonly functionName: string;
        readonly label: string;
    }>;
}

/**
 * Props for {@link OperationsDashboard}.
 */
export interface OperationsDashboardProps {
    /** Resource name prefix (e.g. `k8s-dev`) */
    readonly namePrefix: string;

    /** AWS region for dimensional metrics */
    readonly region: string;

    /** SSM parameter prefix (e.g. `/k8s/development`) — used to derive log group names */
    readonly ssmPrefix: string;

    /**
     * Self-healing pipeline configuration.
     * Omit to skip the Self-Healing section.
     */
    readonly selfHealing?: OpsDashboardSelfHealingConfig;

    /** Dashboard period in seconds @default 300 (5 minutes) */
    readonly periodSeconds?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default metric period (5 minutes) */
const DEFAULT_PERIOD_SECONDS = 300;

/** Dashboard widget height (grid units) */
const WIDGET_HEIGHT = 6;

/** Full-width for section headers and log queries */
const FULL_WIDTH = 24;

/** Half-width for side-by-side layout */
const HALF_WIDTH = 12;

/** Third-width for triple-column layout */
const THIRD_WIDTH = 8;

/** Log query widget height (taller for readability) */
const LOG_WIDGET_HEIGHT = 8;

/** Red colour for errors/failures */
const COLOUR_RED = '#d13212';

/** Amber colour for warnings */
const COLOUR_AMBER = '#ff9900';

/** Green colour for success */
const COLOUR_GREEN = '#1d8102';

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Operations Dashboard — deployment execution traceability.
 *
 * Provides a single-pane view of AMI builds, SSM bootstrap execution,
 * drift enforcement compliance, and self-healing pipeline activity.
 *
 * ## Design Principles
 *
 * 1. **Glanceable status** — SingleValueWidgets for pass/fail counts
 * 2. **Drill-down on failure** — LogQueryWidgets link directly to logs
 * 3. **Correct widget types** — graphs for trends, numbers for status
 * 4. **No confusion** — each section focuses on one operational concern
 */
export class OperationsDashboard extends Construct {
    /** The CloudWatch Dashboard resource */
    public readonly dashboard: cloudwatch.Dashboard;

    /** Dashboard name for reference */
    public readonly dashboardName: string;

    constructor(scope: Construct, id: string, props: OperationsDashboardProps) {
        super(scope, id);

        const period = cdk.Duration.seconds(props.periodSeconds ?? DEFAULT_PERIOD_SECONDS);
        const { namePrefix, ssmPrefix } = props;

        this.dashboardName = `${namePrefix}-operations`;

        this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
            dashboardName: this.dashboardName,
            defaultInterval: cdk.Duration.hours(6),
        });

        // =================================================================
        // Section 1: AMI Build Pipeline
        // =================================================================
        this.addAmiSection(namePrefix);

        // =================================================================
        // Section 2: SSM Bootstrap Execution
        // =================================================================
        this.addBootstrapSection(namePrefix, ssmPrefix, period);

        // =================================================================
        // Section 3: Drift Enforcement
        // =================================================================
        this.addDriftSection(ssmPrefix);

        // =================================================================
        // Section 4: Self-Healing Pipeline
        // =================================================================
        if (props.selfHealing) {
            this.addSelfHealingSection(props.selfHealing, namePrefix, period);
        }
    }

    // -----------------------------------------------------------------
    // Section 1: AMI Build Pipeline
    // -----------------------------------------------------------------

    /**
     * AMI Build section — Image Builder execution visibility.
     *
     * Uses SSM Automation metrics (the AMI build triggers SSM RunCommand
     * steps under the hood) and CloudWatch Logs Insights queries to
     * surface build status and recent build output.
     */
    private addAmiSection(namePrefix: string): void {
        this.dashboard.addWidgets(
            new cloudwatch.TextWidget({
                markdown: '# 🖼️ AMI Build Pipeline\nImage Builder execution status and recent build output.',
                width: FULL_WIDTH,
                height: 1,
            }),
        );

        // Image Builder doesn't emit native CloudWatch metrics,
        // so we use Logs Insights against the SSM RunCommand logs
        // (Image Builder steps execute via SSM on the build instance).
        this.dashboard.addWidgets(
            new cloudwatch.LogQueryWidget({
                title: 'AMI Build — Recent Component Output',
                logGroupNames: [`/aws/imagebuilder/${namePrefix}-golden-ami`],
                width: FULL_WIDTH,
                height: LOG_WIDGET_HEIGHT,
                queryLines: [
                    'fields @timestamp, @message',
                    'sort @timestamp desc',
                    'limit 50',
                ],
            }),
        );
    }

    // -----------------------------------------------------------------
    // Section 2: SSM Bootstrap Execution
    // -----------------------------------------------------------------

    /**
     * SSM Bootstrap section — Step Functions orchestrator + SSM execution.
     *
     * - SingleValueWidgets show execution success/fail counts
     * - LogQueryWidgets surface orchestrator logs and bootstrap errors
     */
    private addBootstrapSection(
        namePrefix: string,
        ssmPrefix: string,
        period: cdk.Duration,
    ): void {
        const sfnLogGroup = `/aws/vendedlogs/states/${namePrefix}-bootstrap-orchestrator`;
        const routerLogGroup = `/aws/lambda/${namePrefix}-bootstrap-router`;

        this.dashboard.addWidgets(
            new cloudwatch.TextWidget({
                markdown: '# ⚙️ SSM Bootstrap Execution\nStep Functions orchestrator and SSM Automation document execution.',
                width: FULL_WIDTH,
                height: 1,
            }),
        );

        // Step Functions execution counts — glanceable status
        const sfnArn = cdk.Stack.of(this).formatArn({
            service: 'states',
            resource: 'stateMachine',
            resourceName: `${namePrefix}-bootstrap-orchestrator`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        });

        const sfnDimensions = { StateMachineArn: sfnArn };

        this.dashboard.addWidgets(
            new cloudwatch.SingleValueWidget({
                title: 'Bootstrap — Succeeded',
                width: THIRD_WIDTH,
                height: 4,
                metrics: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/States',
                        metricName: 'ExecutionsSucceeded',
                        dimensionsMap: sfnDimensions,
                        label: 'Succeeded',
                        period,
                        statistic: 'Sum',
                        color: COLOUR_GREEN,
                    }),
                ],
            }),
            new cloudwatch.SingleValueWidget({
                title: 'Bootstrap — Failed',
                width: THIRD_WIDTH,
                height: 4,
                metrics: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/States',
                        metricName: 'ExecutionsFailed',
                        dimensionsMap: sfnDimensions,
                        label: 'Failed',
                        period,
                        statistic: 'Sum',
                        color: COLOUR_RED,
                    }),
                ],
            }),
            new cloudwatch.SingleValueWidget({
                title: 'Bootstrap — Running',
                width: THIRD_WIDTH,
                height: 4,
                metrics: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/States',
                        metricName: 'ExecutionsStarted',
                        dimensionsMap: sfnDimensions,
                        label: 'Started',
                        period,
                        statistic: 'Sum',
                        color: COLOUR_AMBER,
                    }),
                ],
            }),
        );

        // Orchestrator execution logs — drill-down
        this.dashboard.addWidgets(
            new cloudwatch.LogQueryWidget({
                title: 'Orchestrator — Recent Execution Logs',
                logGroupNames: [sfnLogGroup],
                width: HALF_WIDTH,
                height: LOG_WIDGET_HEIGHT,
                queryLines: [
                    'fields @timestamp, detail.status, detail.name, @message',
                    'sort @timestamp desc',
                    'limit 30',
                ],
            }),
            new cloudwatch.LogQueryWidget({
                title: 'Router Lambda — Errors',
                logGroupNames: [routerLogGroup],
                width: HALF_WIDTH,
                height: LOG_WIDGET_HEIGHT,
                queryLines: [
                    'fields @timestamp, @message',
                    'filter @message like /ERROR|Error|error|Traceback/',
                    'sort @timestamp desc',
                    'limit 20',
                ],
            }),
        );

        // SSM RunCommand output — bootstrap step detail
        this.dashboard.addWidgets(
            new cloudwatch.LogQueryWidget({
                title: 'SSM RunCommand — Bootstrap Step Output',
                logGroupNames: [`/ssm${ssmPrefix}/runcommand`],
                width: FULL_WIDTH,
                height: LOG_WIDGET_HEIGHT,
                queryLines: [
                    'fields @timestamp, @message',
                    'filter @message like /STEP|FAIL|ERROR|SUCCESS|✓|✗/',
                    'sort @timestamp desc',
                    'limit 40',
                ],
            }),
        );
    }

    // -----------------------------------------------------------------
    // Section 3: Drift Enforcement
    // -----------------------------------------------------------------

    /**
     * Drift Enforcement section — SSM Association compliance visibility.
     *
     * - SingleValueWidgets show RunCommand success/fail counts
     * - LogQueryWidget surfaces drift detection and remediation events
     */
    private addDriftSection(ssmPrefix: string): void {
        this.dashboard.addWidgets(
            new cloudwatch.TextWidget({
                markdown: '# 🔄 Drift Enforcement\nSSM State Manager Association — kernel modules, sysctl, and service compliance.',
                width: FULL_WIDTH,
                height: 1,
            }),
        );

        // SSM RunCommand metrics for the drift enforcement document
        this.dashboard.addWidgets(
            new cloudwatch.SingleValueWidget({
                title: 'RunCommand — Success',
                width: HALF_WIDTH,
                height: 4,
                metrics: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/SSM-RunCommand',
                        metricName: 'CommandsSucceeded',
                        label: 'Succeeded',
                        period: cdk.Duration.hours(1),
                        statistic: 'Sum',
                        color: COLOUR_GREEN,
                    }),
                ],
            }),
            new cloudwatch.SingleValueWidget({
                title: 'RunCommand — Failed',
                width: HALF_WIDTH,
                height: 4,
                metrics: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/SSM-RunCommand',
                        metricName: 'CommandsFailed',
                        label: 'Failed',
                        period: cdk.Duration.hours(1),
                        statistic: 'Sum',
                        color: COLOUR_RED,
                    }),
                ],
            }),
        );

        // Drift detection and remediation log entries
        this.dashboard.addWidgets(
            new cloudwatch.LogQueryWidget({
                title: 'Drift Enforcement — Detection & Remediation Events',
                logGroupNames: [`/ssm${ssmPrefix}/runcommand`],
                width: FULL_WIDTH,
                height: LOG_WIDGET_HEIGHT,
                queryLines: [
                    'fields @timestamp, @message',
                    'filter @message like /DRIFT|COMPLIANT|RESULT|✓|✗|modprobe|sysctl|systemctl/',
                    'sort @timestamp desc',
                    'limit 30',
                ],
            }),
        );
    }

    // -----------------------------------------------------------------
    // Section 4: Self-Healing Pipeline
    // -----------------------------------------------------------------

    /**
     * Self-Healing Pipeline section — agent and tool Lambda visibility.
     *
     * - GraphWidgets show invocation and error trends
     * - LogQueryWidget surfaces agent reasoning and tool execution logs
     */
    private addSelfHealingSection(
        config: OpsDashboardSelfHealingConfig,
        namePrefix: string,
        period: cdk.Duration,
    ): void {
        this.dashboard.addWidgets(
            new cloudwatch.TextWidget({
                markdown: '# 🤖 Self-Healing Pipeline\nBedrock agent invocations, tool execution, and remediation logs.',
                width: FULL_WIDTH,
                height: 1,
            }),
        );

        // Agent Lambda — invocations and errors
        const agentDimensions = { FunctionName: config.agentFunctionName };

        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Agent — Invocations & Errors',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/Lambda',
                        metricName: 'Invocations',
                        dimensionsMap: agentDimensions,
                        label: 'Invocations',
                        period,
                        statistic: 'Sum',
                    }),
                ],
                right: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/Lambda',
                        metricName: 'Errors',
                        dimensionsMap: agentDimensions,
                        label: 'Errors',
                        period,
                        statistic: 'Sum',
                        color: COLOUR_RED,
                    }),
                ],
                leftYAxis: { min: 0, label: 'Invocations' },
                rightYAxis: { min: 0, label: 'Errors' },
            }),
            new cloudwatch.GraphWidget({
                title: 'Agent — Duration',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/Lambda',
                        metricName: 'Duration',
                        dimensionsMap: agentDimensions,
                        label: 'Duration',
                        period,
                        statistic: 'Average',
                    }),
                ],
                leftYAxis: { min: 0, label: 'Milliseconds' },
            }),
        );

        // Tool Lambdas — invocations and errors (stacked)
        if (config.toolFunctions.length > 0) {
            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'Tools — Invocations',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: config.toolFunctions.map(({ functionName, label }) =>
                        new cloudwatch.Metric({
                            namespace: 'AWS/Lambda',
                            metricName: 'Invocations',
                            dimensionsMap: { FunctionName: functionName },
                            label,
                            period,
                            statistic: 'Sum',
                        }),
                    ),
                    leftYAxis: { min: 0, label: 'Count' },
                }),
                new cloudwatch.GraphWidget({
                    title: 'Tools — Errors',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: config.toolFunctions.map(({ functionName, label }) =>
                        new cloudwatch.Metric({
                            namespace: 'AWS/Lambda',
                            metricName: 'Errors',
                            dimensionsMap: { FunctionName: functionName },
                            label,
                            period,
                            statistic: 'Sum',
                            color: COLOUR_RED,
                        }),
                    ),
                    leftYAxis: { min: 0, label: 'Count' },
                }),
            );
        }

        // Agent execution logs — drill-down
        this.dashboard.addWidgets(
            new cloudwatch.LogQueryWidget({
                title: 'Agent — Execution Logs (Reasoning & Actions)',
                logGroupNames: [`/aws/lambda/${config.agentFunctionName}`],
                width: FULL_WIDTH,
                height: LOG_WIDGET_HEIGHT,
                queryLines: [
                    'fields @timestamp, @message',
                    'filter @message like /invoking|tool|action|remediat|REPORT|ERROR/',
                    'sort @timestamp desc',
                    'limit 30',
                ],
            }),
        );
    }
}
