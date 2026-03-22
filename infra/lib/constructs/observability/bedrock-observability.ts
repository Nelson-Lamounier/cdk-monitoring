/**
 * @format
 * Bedrock Observability Construct
 *
 * Enables account-level Bedrock model invocation logging to CloudWatch Logs
 * via an AwsCustomResource (no L1/L2 construct exists for this API).
 *
 * This is a **per-region, per-account** setting — one deployment covers
 * all Bedrock invocations (Agents, ConverseCommand, InvokeModel) in the
 * account/region pair.
 *
 * AWS provides built-in GenAI Observability dashboards once logging is
 * enabled — no custom dashboard is needed.
 *
 * Cost: ~$0.50/GB ingestion + $0.03/GB/month storage.
 * With a 3-day retention and portfolio-level traffic, expect < £1/month.
 */

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';


import { Construct } from 'constructs';

// =============================================================================
// CONSTANTS
// =============================================================================

/** CloudWatch Log Group retention for model invocation logs */
const LOG_RETENTION_DAYS = 3;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for {@link BedrockObservabilityConstruct}.
 */
export interface BedrockObservabilityProps {
    /** Resource name prefix (e.g. 'shared-development') */
    readonly namePrefix: string;

    /** Log retention in days @default 3 */
    readonly logRetentionDays?: number;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Enables Bedrock model invocation logging to CloudWatch Logs.
 *
 * Uses `AwsCustomResource` to call the Bedrock
 * `PutModelInvocationLoggingConfiguration` API, which has no
 * CloudFormation or CDK L1/L2 construct.
 *
 * ## What Gets Logged
 *
 * - **Text data**: prompts, completions, token counts, latency
 * - **Image/Embedding/Video data**: disabled (cost optimisation)
 *
 * ## AWS GenAI Observability
 *
 * Once enabled, AWS automatically surfaces:
 * - Real-time dashboards (latency, errors, throttles)
 * - Evaluation scores and quality metrics
 * - Trace data and request flows for troubleshooting
 *
 * No custom dashboard is needed — use the AWS Console:
 * Amazon Bedrock → Observability → Model invocation logging
 */
export class BedrockObservabilityConstruct extends Construct {
    /** The CloudWatch Log Group receiving model invocation logs */
    public readonly logGroup: logs.LogGroup;

    /** The log group name for cross-stack reference */
    public readonly logGroupName: string;

    constructor(scope: Construct, id: string, props: BedrockObservabilityProps) {
        super(scope, id);

        const retentionDays = props.logRetentionDays ?? LOG_RETENTION_DAYS;

        // =================================================================
        // CloudWatch Log Group — Model Invocation Logs
        //
        // Bedrock writes structured JSON logs containing:
        // - modelId, inputTokenCount, outputTokenCount
        // - latency, status, errorCode
        // - input/output text (when text delivery is enabled)
        // =================================================================
        this.logGroupName = `/aws/bedrock/${props.namePrefix}/model-invocations`;

        this.logGroup = new logs.LogGroup(this, 'ModelInvocationLogGroup', {
            logGroupName: this.logGroupName,
            retention: retentionDays,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // =================================================================
        // AwsCustomResource — PutModelInvocationLoggingConfiguration
        //
        // Bedrock model invocation logging is an account-level API with
        // no CloudFormation resource type. We use AwsCustomResource to
        // call the Bedrock control plane API directly.
        //
        // On CREATE/UPDATE: enables logging with CloudWatch destination.
        // On DELETE: disables logging to clean up.
        // =================================================================
        const stack = cdk.Stack.of(this);

        const loggingConfig = {
            service: 'Bedrock',
            action: 'PutModelInvocationLoggingConfiguration',
            parameters: {
                loggingConfig: {
                    cloudWatchConfig: {
                        logGroupName: this.logGroupName,
                        roleArn: '', // Populated below after role creation
                        largeDataDeliveryS3Config: {
                            bucketName: '',
                            keyPrefix: '',
                        },
                    },
                    textDataDeliveryEnabled: true,
                    imageDataDeliveryEnabled: false,
                    embeddingDataDeliveryEnabled: false,
                    videoDataDeliveryEnabled: false,
                },
            },
            physicalResourceId: cr.PhysicalResourceId.of(
                `bedrock-invocation-logging-${props.namePrefix}`,
            ),
        };

        // IAM role for Bedrock to write to CloudWatch Logs
        const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
            roleName: `${props.namePrefix}-bedrock-logging`,
            assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
            description: 'Allows Amazon Bedrock to write model invocation logs to CloudWatch',
        });

        this.logGroup.grantWrite(bedrockLoggingRole);

        // Update the config with the role ARN
        loggingConfig.parameters.loggingConfig.cloudWatchConfig.roleArn =
            bedrockLoggingRole.roleArn;

        const customResource = new cr.AwsCustomResource(this, 'EnableLogging', {
            resourceType: 'Custom::BedrockModelInvocationLogging',
            onCreate: loggingConfig,
            onUpdate: loggingConfig,
            onDelete: {
                service: 'Bedrock',
                action: 'DeleteModelInvocationLogging',
                parameters: {},
                physicalResourceId: cr.PhysicalResourceId.of(
                    `bedrock-invocation-logging-${props.namePrefix}`,
                ),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    sid: 'BedrockLoggingApi',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'bedrock:PutModelInvocationLoggingConfiguration',
                        'bedrock:GetModelInvocationLoggingConfiguration',
                        'bedrock:DeleteModelInvocationLogging',
                    ],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    sid: 'PassLoggingRole',
                    effect: iam.Effect.ALLOW,
                    actions: ['iam:PassRole'],
                    resources: [bedrockLoggingRole.roleArn],
                    conditions: {
                        StringEquals: {
                            'iam:PassedToService': 'bedrock.amazonaws.com',
                        },
                    },
                }),
                new iam.PolicyStatement({
                    sid: 'CloudWatchLogsDelivery',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'logs:CreateLogDelivery',
                        'logs:DeleteLogDelivery',
                        'logs:PutResourcePolicy',
                        'logs:DescribeResourcePolicies',
                    ],
                    resources: ['*'],
                }),
            ]),
        });

        // Ensure log group exists before enabling logging
        customResource.node.addDependency(this.logGroup);

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            customResource,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Bedrock logging APIs and CloudWatch log delivery APIs require wildcard resource — they are account-level operations',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'AwsCustomResource uses a CDK-managed singleton Lambda — runtime version cannot be overridden',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            bedrockLoggingRole,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Bedrock service role for CloudWatch log delivery — scoped to the specific log group via grantWrite',
            }],
            true,
        );

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(stack, 'BedrockInvocationLogGroup', {
            description: 'CloudWatch Log Group for Bedrock model invocation logs',
            value: this.logGroupName,
        });
    }
}
