/**
 * @format
 * Infrastructure Dashboard Construct
 *
 * CloudWatch dashboard providing pre-deployment observability into
 * the self-managed Kubernetes infrastructure. Surfaces critical
 * metrics before Grafana/Prometheus are operational.
 *
 * Cost: $3.00/month (dashboard) + negligible API calls.
 * All metrics are standard AWS service metrics — no custom PutMetricData.
 *
 * @example
 * ```typescript
 * new InfrastructureDashboard(this, 'Dashboard', {
 *     namePrefix: 'k8s-dev',
 *     region: 'eu-west-1',
 *     ec2: {
 *         controlPlaneAsgName: 'k8s-dev-control-plane',
 *         appWorkerAsgName: 'k8s-dev-app-worker',
 *         monitoringWorkerAsgName: 'k8s-dev-mon-worker',
 *     },
 *     nlb: { loadBalancerFullName: 'net/k8s-dev-nlb/abc123' },
 *     stateMachine: { name: 'k8s-dev-bootstrap-orchestrator' },
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
 * EC2 Auto Scaling Group references for dashboard metrics.
 */
export interface DashboardEc2Config {
    /** Control plane ASG name */
    readonly controlPlaneAsgName: string;
    /** Application worker ASG name */
    readonly appWorkerAsgName: string;
    /** Monitoring worker ASG name */
    readonly monitoringWorkerAsgName: string;
}

/**
 * NLB references for dashboard metrics.
 */
export interface DashboardNlbConfig {
    /**
     * Full NLB name as reported by CloudWatch.
     * Format: `net/{lb-name}/{lb-id}`
     * Resolved at deploy time via SSM or direct reference.
     */
    readonly loadBalancerFullName: string;
    /** HTTP target group full name (optional — omit if unknown at synth) */
    readonly httpTargetGroupFullName?: string;
    /** HTTPS target group full name (optional — omit if unknown at synth) */
    readonly httpsTargetGroupFullName?: string;
}

/**
 * Step Functions state machine reference for dashboard metrics.
 */
export interface DashboardStateMachineConfig {
    /** State machine name (not ARN) */
    readonly name: string;
}

/**
 * Lambda function references for dashboard metrics.
 */
export interface DashboardLambdaConfig {
    /** Lambda function name */
    readonly functionName: string;
    /** Human-readable label for the dashboard widget */
    readonly label: string;
}

/**
 * CloudFront distribution reference for dashboard metrics.
 */
export interface DashboardCloudFrontConfig {
    /** CloudFront distribution ID */
    readonly distributionId: string;
}

/**
 * Props for {@link InfrastructureDashboard}.
 */
export interface InfrastructureDashboardProps {
    /** Resource name prefix (e.g. `k8s-dev`) */
    readonly namePrefix: string;

    /** AWS region for dimensional metrics */
    readonly region: string;

    /** EC2 ASG configuration */
    readonly ec2: DashboardEc2Config;

    /** NLB configuration */
    readonly nlb: DashboardNlbConfig;

    /** Step Functions state machine configuration (optional) */
    readonly stateMachine?: DashboardStateMachineConfig;

    /** Lambda functions to monitor (optional) */
    readonly lambdaFunctions?: DashboardLambdaConfig[];

    /** CloudFront distribution (optional — deployed in us-east-1) */
    readonly cloudFront?: DashboardCloudFrontConfig;

    /** Dashboard period in seconds @default 300 (5 minutes) */
    readonly periodSeconds?: number;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/** Default metric period (5 minutes) */
const DEFAULT_PERIOD_SECONDS = 300;

/** Dashboard widget height (grid units) */
const WIDGET_HEIGHT = 6;

/** Dashboard full-width (grid units) */
const FULL_WIDTH = 24;

/** Half-width for side-by-side layout */
const HALF_WIDTH = 12;

/**
 * CloudWatch dashboard providing infrastructure observability
 * before Grafana/Prometheus are deployed.
 *
 * Covers: EC2 health, NLB targets, Step Functions, Lambda errors,
 * and optionally CloudFront/WAF metrics.
 */
export class InfrastructureDashboard extends Construct {
    /** The CloudWatch Dashboard resource */
    public readonly dashboard: cloudwatch.Dashboard;

    /** Dashboard name for reference */
    public readonly dashboardName: string;

    constructor(scope: Construct, id: string, props: InfrastructureDashboardProps) {
        super(scope, id);

        const period = cdk.Duration.seconds(props.periodSeconds ?? DEFAULT_PERIOD_SECONDS);
        this.dashboardName = `${props.namePrefix}-infrastructure`;

        this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
            dashboardName: this.dashboardName,
            defaultInterval: cdk.Duration.hours(6),
        });

        // =================================================================
        // Section 1: EC2 Instance Health
        // =================================================================
        this.dashboard.addWidgets(
            new cloudwatch.TextWidget({
                markdown: '# 🖥️ EC2 Instance Health',
                width: FULL_WIDTH,
                height: 1,
            }),
        );

        const asgEntries: Array<{ name: string; label: string }> = [
            { name: props.ec2.controlPlaneAsgName, label: 'Control Plane' },
            { name: props.ec2.appWorkerAsgName, label: 'App Worker' },
            { name: props.ec2.monitoringWorkerAsgName, label: 'Mon Worker' },
        ];

        // CPU Utilisation (all 3 ASGs side-by-side)
        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'CPU Utilisation (by ASG)',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: asgEntries.map(({ name, label }) =>
                    new cloudwatch.Metric({
                        namespace: 'AWS/EC2',
                        metricName: 'CPUUtilization',
                        dimensionsMap: { AutoScalingGroupName: name },
                        label,
                        period,
                        statistic: 'Average',
                    }),
                ),
                leftYAxis: { min: 0, max: 100, label: 'Percent' },
            }),
            new cloudwatch.GraphWidget({
                title: 'Status Check Failed (by ASG)',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: asgEntries.map(({ name, label }) =>
                    new cloudwatch.Metric({
                        namespace: 'AWS/EC2',
                        metricName: 'StatusCheckFailed',
                        dimensionsMap: { AutoScalingGroupName: name },
                        label,
                        period,
                        statistic: 'Maximum',
                    }),
                ),
                leftYAxis: { min: 0, label: 'Count' },
            }),
        );

        // Network IO
        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'Network In (by ASG)',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: asgEntries.map(({ name, label }) =>
                    new cloudwatch.Metric({
                        namespace: 'AWS/EC2',
                        metricName: 'NetworkIn',
                        dimensionsMap: { AutoScalingGroupName: name },
                        label,
                        period,
                        statistic: 'Sum',
                    }),
                ),
                leftYAxis: { min: 0, label: 'Bytes' },
            }),
            new cloudwatch.GraphWidget({
                title: 'Network Out (by ASG)',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: asgEntries.map(({ name, label }) =>
                    new cloudwatch.Metric({
                        namespace: 'AWS/EC2',
                        metricName: 'NetworkOut',
                        dimensionsMap: { AutoScalingGroupName: name },
                        label,
                        period,
                        statistic: 'Sum',
                    }),
                ),
                leftYAxis: { min: 0, label: 'Bytes' },
            }),
        );

        // =================================================================
        // Section 2: NLB Health
        // =================================================================
        this.dashboard.addWidgets(
            new cloudwatch.TextWidget({
                markdown: '# 🔀 Network Load Balancer',
                width: FULL_WIDTH,
                height: 1,
            }),
        );

        const nlbDimensions = {
            LoadBalancer: props.nlb.loadBalancerFullName,
        };

        this.dashboard.addWidgets(
            new cloudwatch.GraphWidget({
                title: 'NLB Active Flows',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/NetworkELB',
                        metricName: 'ActiveFlowCount',
                        dimensionsMap: nlbDimensions,
                        label: 'Active Flows',
                        period,
                        statistic: 'Average',
                    }),
                    new cloudwatch.Metric({
                        namespace: 'AWS/NetworkELB',
                        metricName: 'NewFlowCount',
                        dimensionsMap: nlbDimensions,
                        label: 'New Flows',
                        period,
                        statistic: 'Sum',
                    }),
                ],
            }),
            new cloudwatch.GraphWidget({
                title: 'NLB Processed Bytes',
                width: HALF_WIDTH,
                height: WIDGET_HEIGHT,
                left: [
                    new cloudwatch.Metric({
                        namespace: 'AWS/NetworkELB',
                        metricName: 'ProcessedBytes',
                        dimensionsMap: nlbDimensions,
                        label: 'Bytes Processed',
                        period,
                        statistic: 'Sum',
                    }),
                ],
                leftYAxis: { min: 0, label: 'Bytes' },
            }),
        );

        // Target health (if target group names are provided)
        if (props.nlb.httpTargetGroupFullName || props.nlb.httpsTargetGroupFullName) {
            const targetHealthMetrics: cloudwatch.IMetric[] = [];
            const unhealthyMetrics: cloudwatch.IMetric[] = [];

            const targetGroups = [
                { name: props.nlb.httpTargetGroupFullName, label: 'HTTP' },
                { name: props.nlb.httpsTargetGroupFullName, label: 'HTTPS' },
            ].filter((tg): tg is { name: string; label: string } => Boolean(tg.name));

            for (const tg of targetGroups) {
                const tgDimensions = {
                    LoadBalancer: props.nlb.loadBalancerFullName,
                    TargetGroup: tg.name,
                };

                targetHealthMetrics.push(
                    new cloudwatch.Metric({
                        namespace: 'AWS/NetworkELB',
                        metricName: 'HealthyHostCount',
                        dimensionsMap: tgDimensions,
                        label: `${tg.label} Healthy`,
                        period,
                        statistic: 'Average',
                    }),
                );

                unhealthyMetrics.push(
                    new cloudwatch.Metric({
                        namespace: 'AWS/NetworkELB',
                        metricName: 'UnHealthyHostCount',
                        dimensionsMap: tgDimensions,
                        label: `${tg.label} Unhealthy`,
                        period,
                        statistic: 'Average',
                    }),
                );
            }

            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'NLB Target Health',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: targetHealthMetrics,
                    right: unhealthyMetrics,
                    rightYAxis: { min: 0, label: 'Unhealthy' },
                    leftYAxis: { min: 0, label: 'Healthy' },
                }),
            );
        }

        // =================================================================
        // Section 3: Step Functions (Bootstrap Orchestrator)
        // =================================================================
        if (props.stateMachine) {
            this.dashboard.addWidgets(
                new cloudwatch.TextWidget({
                    markdown: '# ⚙️ Bootstrap Orchestrator (Step Functions)',
                    width: FULL_WIDTH,
                    height: 1,
                }),
            );

            const sfnDimensions = {
                StateMachineArn: cdk.Stack.of(this).formatArn({
                    service: 'states',
                    resource: 'stateMachine',
                    resourceName: props.stateMachine.name,
                    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
            };

            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'Executions (Started / Succeeded / Failed)',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: [
                        new cloudwatch.Metric({
                            namespace: 'AWS/States',
                            metricName: 'ExecutionsStarted',
                            dimensionsMap: sfnDimensions,
                            label: 'Started',
                            period,
                            statistic: 'Sum',
                        }),
                        new cloudwatch.Metric({
                            namespace: 'AWS/States',
                            metricName: 'ExecutionsSucceeded',
                            dimensionsMap: sfnDimensions,
                            label: 'Succeeded',
                            period,
                            statistic: 'Sum',
                        }),
                        new cloudwatch.Metric({
                            namespace: 'AWS/States',
                            metricName: 'ExecutionsFailed',
                            dimensionsMap: sfnDimensions,
                            label: 'Failed',
                            period,
                            statistic: 'Sum',
                            color: '#d13212',
                        }),
                    ],
                }),
                new cloudwatch.GraphWidget({
                    title: 'Execution Duration',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: [
                        new cloudwatch.Metric({
                            namespace: 'AWS/States',
                            metricName: 'ExecutionTime',
                            dimensionsMap: sfnDimensions,
                            label: 'Duration (ms)',
                            period,
                            statistic: 'Average',
                        }),
                    ],
                    leftYAxis: { min: 0, label: 'Milliseconds' },
                }),
            );
        }

        // =================================================================
        // Section 4: Lambda Functions
        // =================================================================
        if (props.lambdaFunctions && props.lambdaFunctions.length > 0) {
            this.dashboard.addWidgets(
                new cloudwatch.TextWidget({
                    markdown: '# λ Lambda Functions',
                    width: FULL_WIDTH,
                    height: 1,
                }),
            );

            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'Lambda Errors',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: props.lambdaFunctions.map(({ functionName, label }) =>
                        new cloudwatch.Metric({
                            namespace: 'AWS/Lambda',
                            metricName: 'Errors',
                            dimensionsMap: { FunctionName: functionName },
                            label,
                            period,
                            statistic: 'Sum',
                            color: '#d13212',
                        }),
                    ),
                }),
                new cloudwatch.GraphWidget({
                    title: 'Lambda Duration',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: props.lambdaFunctions.map(({ functionName, label }) =>
                        new cloudwatch.Metric({
                            namespace: 'AWS/Lambda',
                            metricName: 'Duration',
                            dimensionsMap: { FunctionName: functionName },
                            label,
                            period,
                            statistic: 'Average',
                        }),
                    ),
                    leftYAxis: { min: 0, label: 'Milliseconds' },
                }),
            );

            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'Lambda Invocations',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: props.lambdaFunctions.map(({ functionName, label }) =>
                        new cloudwatch.Metric({
                            namespace: 'AWS/Lambda',
                            metricName: 'Invocations',
                            dimensionsMap: { FunctionName: functionName },
                            label,
                            period,
                            statistic: 'Sum',
                        }),
                    ),
                }),
                new cloudwatch.GraphWidget({
                    title: 'Lambda Throttles',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: props.lambdaFunctions.map(({ functionName, label }) =>
                        new cloudwatch.Metric({
                            namespace: 'AWS/Lambda',
                            metricName: 'Throttles',
                            dimensionsMap: { FunctionName: functionName },
                            label,
                            period,
                            statistic: 'Sum',
                            color: '#ff9900',
                        }),
                    ),
                }),
            );
        }

        // =================================================================
        // Section 5: CloudFront (us-east-1 metrics — cross-region)
        // =================================================================
        if (props.cloudFront) {
            this.dashboard.addWidgets(
                new cloudwatch.TextWidget({
                    markdown: '# 🌐 CloudFront CDN',
                    width: FULL_WIDTH,
                    height: 1,
                }),
            );

            const cfDimensions = {
                DistributionId: props.cloudFront.distributionId,
                Region: 'Global',
            };

            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'CloudFront Requests',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: [
                        new cloudwatch.Metric({
                            namespace: 'AWS/CloudFront',
                            metricName: 'Requests',
                            dimensionsMap: cfDimensions,
                            region: 'us-east-1',
                            label: 'Requests',
                            period,
                            statistic: 'Sum',
                        }),
                    ],
                }),
                new cloudwatch.GraphWidget({
                    title: 'CloudFront Error Rates',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: [
                        new cloudwatch.Metric({
                            namespace: 'AWS/CloudFront',
                            metricName: '4xxErrorRate',
                            dimensionsMap: cfDimensions,
                            region: 'us-east-1',
                            label: '4xx Rate',
                            period,
                            statistic: 'Average',
                            color: '#ff9900',
                        }),
                        new cloudwatch.Metric({
                            namespace: 'AWS/CloudFront',
                            metricName: '5xxErrorRate',
                            dimensionsMap: cfDimensions,
                            region: 'us-east-1',
                            label: '5xx Rate',
                            period,
                            statistic: 'Average',
                            color: '#d13212',
                        }),
                    ],
                    leftYAxis: { min: 0, max: 100, label: 'Percent' },
                }),
            );

            this.dashboard.addWidgets(
                new cloudwatch.GraphWidget({
                    title: 'CloudFront Bytes Downloaded',
                    width: HALF_WIDTH,
                    height: WIDGET_HEIGHT,
                    left: [
                        new cloudwatch.Metric({
                            namespace: 'AWS/CloudFront',
                            metricName: 'BytesDownloaded',
                            dimensionsMap: cfDimensions,
                            region: 'us-east-1',
                            label: 'Downloaded',
                            period,
                            statistic: 'Sum',
                        }),
                    ],
                    leftYAxis: { min: 0, label: 'Bytes' },
                }),
            );
        }
    }
}
