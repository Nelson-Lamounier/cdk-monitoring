/**
 * @format
 * Self-Healing Gateway Stack
 *
 * Creates the AgentCore Gateway using the official L2 construct from
 * `@aws-cdk/aws-bedrock-agentcore-alpha`. The Gateway acts as the central
 * MCP-compatible tool discovery and invocation layer for the Self-Healing
 * Agent in the companion AgentStack.
 *
 * Resources:
 * - AgentCore Gateway (L2 construct — CloudFormation-managed lifecycle)
 * - Default Cognito authoriser for M2M (machine-to-machine) JWT auth
 * - 2 Lambda tool functions (diagnose-alarm, ebs-detach)
 * - SSM parameters for cross-stack discovery
 * - CloudWatch log group for Gateway invocations
 *
 * The L2 construct automatically provisions:
 * - IAM role for tool invocation (no manual role required)
 * - Cognito User Pool + Client for OAuth 2.0 client credentials flow
 * - MCP protocol configuration (MCP 2025-03-26, SEMANTIC search)
 */

import * as path from 'path';

import {
    Gateway,
    ToolSchema,
    SchemaDefinitionType,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';


/**
 * Props for SelfHealingGatewayStack
 */
export interface SelfHealingGatewayStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'self-healing-dev') */
    readonly namePrefix: string;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
}

/**
 * Gateway Stack for Self-Healing Pipeline.
 *
 * Creates an AgentCore Gateway using the official L2 construct and
 * registers tool Lambda functions as MCP-compatible tools accessible
 * to the Bedrock ConverseCommand agent.
 */
export class SelfHealingGatewayStack extends cdk.Stack {
    /** The AgentCore Gateway L2 construct */
    public readonly gateway: Gateway;

    /** The Gateway URL endpoint */
    public readonly gatewayUrl: string;

    /** The Gateway unique identifier */
    public readonly gatewayId: string;

    constructor(scope: Construct, id: string, props: SelfHealingGatewayStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // CloudWatch Log Group — Gateway invocations
        // =================================================================
        const gatewayLogGroup = new logs.LogGroup(this, 'GatewayLogGroup', {
            logGroupName: `/aws/agentcore/${namePrefix}-gateway`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // AgentCore Gateway — L2 Construct
        //
        // Creates a fully CloudFormation-managed MCP Gateway with:
        // - Auto-generated IAM role for Lambda tool invocation
        // - Default Cognito authoriser (M2M client credentials flow)
        // - MCP protocol v2025-03-26 with SEMANTIC search
        // =================================================================
        this.gateway = new Gateway(this, 'Gateway', {
            gatewayName: `${namePrefix}-gateway`,
            description: `Self-healing MCP tool gateway for ${namePrefix}`,
        });

        // Expose gateway URL and ID — populated by CloudFormation after deploy
        this.gatewayUrl = this.gateway.gatewayUrl ?? `https://${namePrefix}-gateway.bedrock.${this.region}.amazonaws.com`;
        this.gatewayId = this.gateway.gatewayId;

        // =================================================================
        // Tool Lambda 1: Diagnose Alarm
        //
        // Queries CloudWatch for alarm configuration, current state,
        // and recent metric datapoints. Returns a structured diagnostic
        // report that helps the agent understand what went wrong.
        // =================================================================
        const diagnoseAlarmFn = new lambdaNode.NodejsFunction(this, 'DiagnoseAlarmFunction', {
            functionName: `${namePrefix}-tool-diagnose-alarm`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', 'lambda', 'self-healing', 'tools', 'diagnose-alarm', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'DiagnoseAlarmLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-diagnose-alarm`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: diagnose CloudWatch alarms for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant CloudWatch read access for alarm diagnosis
        diagnoseAlarmFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ReadCloudWatchAlarms',
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:DescribeAlarms',
                'cloudwatch:GetMetricData',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 2: EBS Volume Detach
        //
        // Detaches tagged EBS volumes from terminating instances and
        // completes ASG lifecycle actions. Existing production Lambda
        // reused as an MCP tool.
        // =================================================================
        const ebsDetachFn = new lambdaNode.NodejsFunction(this, 'EbsDetachFunction', {
            functionName: `${namePrefix}-tool-ebs-detach`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', 'lambda', 'ebs-detach', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.minutes(3),
            logGroup: new logs.LogGroup(this, 'EbsDetachLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-ebs-detach`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: EBS volume detach for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant EC2 + ASG permissions for EBS detachment
        ebsDetachFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ManageEbsVolumes',
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:DescribeVolumes',
                'ec2:DescribeInstances',
                'ec2:DetachVolume',
            ],
            resources: ['*'],
        }));

        ebsDetachFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'CompleteLifecycleAction',
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:CompleteLifecycleAction'],
            resources: ['*'],
        }));

        // =================================================================
        // Register Tools with AgentCore Gateway
        //
        // Each tool is registered via addLambdaTarget() with an inline
        // ToolSchema defining the MCP tool interface. The L2 construct
        // automatically grants the Gateway's IAM role permission to
        // invoke each Lambda function.
        // =================================================================
        this.gateway.addLambdaTarget('DiagnoseAlarmTarget', {
            gatewayTargetName: 'diagnose-alarm',
            description: 'Analyse a CloudWatch Alarm and return diagnostic information',
            lambdaFunction: diagnoseAlarmFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'diagnose_alarm',
                description: 'Analyse a CloudWatch Alarm and return diagnostic information about the affected resource, including alarm configuration, threshold, recent metric datapoints, and affected resources.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        alarmName: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Name of the CloudWatch Alarm to diagnose',
                        },
                    },
                    required: ['alarmName'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        alarmName: { type: SchemaDefinitionType.STRING, description: 'Alarm name' },
                        exists: { type: SchemaDefinitionType.BOOLEAN, description: 'Whether the alarm exists' },
                        state: { type: SchemaDefinitionType.STRING, description: 'Current alarm state' },
                        stateReason: { type: SchemaDefinitionType.STRING, description: 'Reason for current state' },
                        recentDatapoints: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Recent metric values (last 30 minutes)',
                            items: { type: SchemaDefinitionType.NUMBER },
                        },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('EbsDetachTarget', {
            gatewayTargetName: 'ebs-detach',
            description: 'Detach EBS volumes from a terminating EC2 instance',
            lambdaFunction: ebsDetachFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'ebs_detach',
                description: 'Detach tagged EBS volumes from a terminating or unhealthy EC2 instance. Completes the ASG lifecycle action after detachment.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        EC2InstanceId: {
                            type: SchemaDefinitionType.STRING,
                            description: 'The EC2 instance ID to detach volumes from',
                        },
                        AutoScalingGroupName: {
                            type: SchemaDefinitionType.STRING,
                            description: 'The Auto Scaling group name',
                        },
                        LifecycleHookName: {
                            type: SchemaDefinitionType.STRING,
                            description: 'The lifecycle hook name',
                        },
                        LifecycleActionToken: {
                            type: SchemaDefinitionType.STRING,
                            description: 'The lifecycle action token',
                        },
                    },
                    required: ['EC2InstanceId'],
                },
            }]),
        });

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Gateway L2 construct auto-generates IAM role with least-privilege for registered Lambda targets',
            }, {
                id: 'AwsSolutions-COG1',
                reason: 'Cognito User Pool is auto-created by Gateway L2 for M2M auth — password policy not applicable for client credentials flow',
            }, {
                id: 'AwsSolutions-COG2',
                reason: 'MFA not applicable for M2M client credentials flow — no end-user authentication involved',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            diagnoseAlarmFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'CloudWatch DescribeAlarms and GetMetricData require wildcard resource — alarm ARN is not known at synthesis time',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            ebsDetachFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DetachVolume and DescribeVolumes require wildcard — volumes and instances are dynamic',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'GatewayUrlParam', {
            parameterName: `/${namePrefix}/gateway-url`,
            stringValue: this.gatewayUrl,
            description: `AgentCore Gateway URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'GatewayIdParam', {
            parameterName: `/${namePrefix}/gateway-id`,
            stringValue: this.gatewayId,
            description: `AgentCore Gateway ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gatewayUrl,
            description: 'AgentCore Gateway endpoint URL',
        });

        new cdk.CfnOutput(this, 'GatewayId', {
            value: this.gatewayId,
            description: 'AgentCore Gateway identifier',
        });

        new cdk.CfnOutput(this, 'GatewayArn', {
            value: this.gateway.gatewayArn,
            description: 'AgentCore Gateway ARN',
        });

        // Suppress log group output for gateway
        void gatewayLogGroup;
    }
}
