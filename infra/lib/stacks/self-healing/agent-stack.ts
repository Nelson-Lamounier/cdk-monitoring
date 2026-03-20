/**
 * @format
 * Self-Healing Agent Stack
 *
 * Creates the Self-Healing Agent Lambda — a TypeScript function using the
 * Bedrock ConverseCommand API with a native MCP tool-use loop.
 *
 * Resources:
 * - NodejsFunction (esbuild-bundled TypeScript handler)
 * - SQS Dead Letter Queue (encrypted, with configurable retention)
 * - IAM policy for Bedrock model invocation
 * - EventBridge rule (scoped CloudWatch Alarm → Lambda trigger)
 * - CloudWatch log group
 * - SSM parameters for cross-stack discovery
 */

import * as path from 'path';

import { NagSuppressions } from 'cdk-nag';

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for SelfHealingAgentStack
 */
export interface SelfHealingAgentStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'self-healing-dev') */
    readonly namePrefix: string;
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Bedrock foundation model ID */
    readonly foundationModel: string;
    /** Whether agent runs in dry-run mode (propose but do not execute) */
    readonly enableDryRun: boolean;
    /** System prompt for the agent */
    readonly systemPrompt: string;
    /** AgentCore Gateway URL (resolved from SSM in factory) */
    readonly gatewayUrl: string;
    /** DLQ message retention in days */
    readonly dlqRetentionDays: number;
    /** Reserved concurrent executions for cost control */
    readonly reservedConcurrency?: number;
    /** Maximum tokens per hour before alarm fires (FinOps guardrail) */
    readonly tokenBudgetPerHour?: number;
    /** Cognito OAuth2 token endpoint for client credentials flow */
    readonly cognitoTokenEndpoint: string;
    /** Cognito User Pool ID (for retrieving client secret at runtime) */
    readonly cognitoUserPoolId: string;
    /** Cognito User Pool Client ID for M2M auth */
    readonly cognitoClientId: string;
    /** OAuth2 scope strings (space-separated) for client credentials flow */
    readonly cognitoScopes: string;
    /** Email address for SNS remediation report notifications */
    readonly notificationEmail?: string;
}

/**
 * Agent Stack for Self-Healing Pipeline.
 *
 * Creates a TypeScript Lambda function using the Bedrock ConverseCommand
 * API with a native tool-use loop. When triggered by scoped CloudWatch
 * Alarms, the agent reasons about the failure, discovers available tools
 * via MCP, and orchestrates remediation.
 */
export class SelfHealingAgentStack extends cdk.Stack {
    /** The Self-Healing Agent Lambda function */
    public readonly agentFunction: lambdaNode.NodejsFunction;

    /** Dead Letter Queue for failed agent invocations */
    public readonly agentDlq: sqs.Queue;

    /** SNS topic for remediation report notifications */
    public readonly reportsTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: SelfHealingAgentStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // CloudWatch Log Group — Agent Lambda
        // =================================================================
        const logGroup = new logs.LogGroup(this, 'AgentLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-agent`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // SQS — Dead Letter Queue
        //
        // Captures failed agent invocations (Bedrock throttling, timeout,
        // MCP Gateway errors) so events are not silently lost.
        // =================================================================
        this.agentDlq = new sqs.Queue(this, 'AgentDlq', {
            queueName: `${namePrefix}-agent-dlq`,
            retentionPeriod: cdk.Duration.days(props.dlqRetentionDays),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // SNS — Remediation Report Notifications
        //
        // Publishes the agent's remediation report after each invocation
        // so the operator receives immediate email visibility.
        // =================================================================
        this.reportsTopic = new sns.Topic(this, 'ReportsTopic', {
            topicName: `${namePrefix}-agent-reports`,
            displayName: `Self-Healing Agent Reports (${namePrefix})`,
        });

        if (props.notificationEmail) {
            this.reportsTopic.addSubscription(
                new sns_subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        // =================================================================
        // Lambda — Self-Healing Agent (Bedrock ConverseCommand)
        //
        // TypeScript function using the Bedrock ConverseCommand API
        // with a native tool-use agentic loop. Bundled with esbuild
        // via NodejsFunction, matching the Bedrock publisher pattern.
        // =================================================================
        this.agentFunction = new lambdaNode.NodejsFunction(this, 'AgentFunction', {
            functionName: `${namePrefix}-agent`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', 'lambda', 'self-healing', 'index.ts'),
            handler: 'handler',
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            logGroup,
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                GATEWAY_URL: props.gatewayUrl,
                FOUNDATION_MODEL: props.foundationModel,
                DRY_RUN: props.enableDryRun ? 'true' : 'false',
                SYSTEM_PROMPT: props.systemPrompt,
                COGNITO_TOKEN_ENDPOINT: props.cognitoTokenEndpoint,
                COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
                COGNITO_CLIENT_ID: props.cognitoClientId,
                COGNITO_SCOPES: props.cognitoScopes,
                SNS_TOPIC_ARN: this.reportsTopic.topicArn,
            },
            description: `Self-healing remediation agent for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: [
                    // AWS SDK v3 is included in the Lambda runtime
                    '@aws-sdk/*',
                ],
            },
            deadLetterQueue: this.agentDlq,
            deadLetterQueueEnabled: true,
            retryAttempts: 2,
            // FinOps: cap parallel Bedrock agent invocations
            ...(props.reservedConcurrency !== undefined
                ? { reservedConcurrentExecutions: props.reservedConcurrency }
                : {}),
        });

        // =================================================================
        // CloudWatch Metric Filters — Token Usage Tracking
        //
        // Extracts inputTokens and outputTokens from the structured JSON
        // logs emitted by the handler. Publishes to custom CloudWatch
        // metrics for FinOps visibility and alarming.
        // =================================================================
        const metricNamespace = `${namePrefix}/SelfHealing`;

        new logs.MetricFilter(this, 'InputTokensMetric', {
            logGroup,
            filterPattern: logs.FilterPattern.exists('$.inputTokens'),
            metricNamespace,
            metricName: 'InputTokens',
            metricValue: '$.inputTokens',
            defaultValue: 0,
        });

        new logs.MetricFilter(this, 'OutputTokensMetric', {
            logGroup,
            filterPattern: logs.FilterPattern.exists('$.outputTokens'),
            metricNamespace,
            metricName: 'OutputTokens',
            metricValue: '$.outputTokens',
            defaultValue: 0,
        });

        // FinOps alarm: total tokens exceeds budget in a 1-hour window
        const tokenBudget = props.tokenBudgetPerHour ?? 100_000;

        new cloudwatch.Alarm(this, 'TokenBudgetAlarm', {
            alarmName: `${namePrefix}-agent-token-budget`,
            alarmDescription:
                `Self-healing agent consumed >${tokenBudget} input tokens in 1 hour. ` +
                'Investigate for runaway agent loops or unexpected alarm storms.',
            metric: new cloudwatch.MathExpression({
                expression: 'inputTokens + outputTokens',
                usingMetrics: {
                    inputTokens: new cloudwatch.Metric({
                        namespace: metricNamespace,
                        metricName: 'InputTokens',
                        statistic: 'Sum',
                        period: cdk.Duration.hours(1),
                    }),
                    outputTokens: new cloudwatch.Metric({
                        namespace: metricNamespace,
                        metricName: 'OutputTokens',
                        statistic: 'Sum',
                        period: cdk.Duration.hours(1),
                    }),
                },
            }),
            threshold: tokenBudget,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // CDK-Nag suppression: NODEJS_22_X is the latest Node.js LTS runtime
        NagSuppressions.addResourceSuppressions(
            this.agentFunction,
            [{ id: 'AwsSolutions-L1', reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime' }],
            true,
        );

        // =================================================================
        // IAM — Bedrock Model Invocation
        //
        // Cross-region inference profiles (eu.anthropic.*) route requests
        // to the underlying foundation model in ANY EU region. IAM must
        // cover both the inference profile and the foundation model.
        // =================================================================
        const baseModelId = props.foundationModel.replace(/^eu\./, '');
        this.agentFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'InvokeBedrockModel',
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
            ],
            resources: [
                // Cross-region inference profile (local region, account-scoped)
                `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.foundationModel}`,
                // Foundation model in ANY region (cross-region routing target)
                `arn:aws:bedrock:*::foundation-model/${baseModelId}`,
            ],
        }));

        // =================================================================
        // IAM — Cognito Client Secret Retrieval
        //
        // The agent retrieves the Cognito User Pool Client secret at runtime
        // to obtain a JWT via the client credentials flow for Gateway auth.
        // =================================================================
        if (props.cognitoUserPoolId) {
            this.agentFunction.addToRolePolicy(new iam.PolicyStatement({
                sid: 'DescribeCognitoClient',
                effect: iam.Effect.ALLOW,
                actions: ['cognito-idp:DescribeUserPoolClient'],
                resources: [
                    `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`,
                ],
            }));
        }

        // =================================================================
        // EventBridge Rule — CloudWatch Alarm → Agent
        //
        // Triggers on ALL CloudWatch alarms entering ALARM state.
        // Solo-developer setup — no prefix scoping needed.
        // =================================================================
        const alarmRule = new events.Rule(this, 'AlarmTriggerRule', {
            ruleName: `${namePrefix}-alarm-trigger`,
            description: `Triggers self-healing agent on CloudWatch Alarm state changes for ${namePrefix}`,
            eventPattern: {
                source: ['aws.cloudwatch'],
                detailType: ['CloudWatch Alarm State Change'],
                detail: {
                    state: {
                        value: ['ALARM'],
                    },
                },
            },
        });

        alarmRule.addTarget(new targets.LambdaFunction(this.agentFunction, {
            retryAttempts: 2,
        }));

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.agentFunction,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Bedrock model invocation requires foundation-model ARN with wildcard region pattern',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            this.reportsTopic,
            [{
                id: 'AwsSolutions-SNS2',
                reason: 'Remediation report topic — no sensitive data, default encryption sufficient',
            }, {
                id: 'AwsSolutions-SNS3',
                reason: 'Remediation report topic — enforceSSL not required for email-only delivery',
            }],
            true,
        );

        // Grant Lambda permission to publish to SNS
        this.reportsTopic.grantPublish(this.agentFunction);

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'AgentLambdaArnParam', {
            parameterName: `/${namePrefix}/agent-lambda-arn`,
            stringValue: this.agentFunction.functionArn,
            description: `Self-healing Agent Lambda ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentLambdaNameParam', {
            parameterName: `/${namePrefix}/agent-lambda-name`,
            stringValue: this.agentFunction.functionName,
            description: `Self-healing Agent Lambda name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentDlqUrlParam', {
            parameterName: `/${namePrefix}/agent-dlq-url`,
            stringValue: this.agentDlq.queueUrl,
            description: `Agent DLQ URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'AgentFunctionArn', {
            value: this.agentFunction.functionArn,
            description: 'Self-healing Agent Lambda ARN',
        });

        new cdk.CfnOutput(this, 'AgentFunctionName', {
            value: this.agentFunction.functionName,
            description: 'Self-healing Agent Lambda name',
        });

        new cdk.CfnOutput(this, 'AgentDlqUrl', {
            value: this.agentDlq.queueUrl,
            description: 'Agent Dead Letter Queue URL',
        });

        new cdk.CfnOutput(this, 'DryRunEnabled', {
            value: props.enableDryRun ? 'true' : 'false',
            description: 'Whether the agent is in dry-run mode',
        });

        new cdk.CfnOutput(this, 'ReportsTopicArn', {
            value: this.reportsTopic.topicArn,
            description: 'SNS topic ARN for remediation report notifications',
        });
    }
}
