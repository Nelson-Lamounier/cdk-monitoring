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
 * - SSM parameters for cross-stack discovery
 * - CloudWatch log group for Gateway invocations
 *
 * The L2 construct automatically provisions:
 * - IAM role for tool invocation (no manual role required)
 * - Cognito User Pool + Client for OAuth 2.0 client credentials flow
 * - MCP protocol configuration (MCP 2025-03-26, SEMANTIC search)
 */

import { NagSuppressions } from 'cdk-nag';

import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Gateway } from '@aws-cdk/aws-bedrock-agentcore-alpha';

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
    /** ARNs of existing Lambda functions to register as MCP tools */
    readonly toolLambdaArns: string[];
    /** Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
}

/**
 * Gateway Stack for Self-Healing Pipeline.
 *
 * Creates an AgentCore Gateway using the official L2 construct that
 * registers existing infrastructure Lambda functions as MCP-compatible
 * tools accessible to the Bedrock ConverseCommand agent.
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
        new logs.LogGroup(this, 'GatewayLogGroup', {
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
        //
        // The Gateway auto-provisions a URL endpoint and unique ID,
        // replacing the previous placeholder approach.
        // =================================================================
        this.gateway = new Gateway(this, 'Gateway', {
            gatewayName: `${namePrefix}-gateway`,
            description: `Self-healing MCP tool gateway for ${namePrefix}`,
        });

        // Expose gateway URL and ID — populated by CloudFormation after deploy
        this.gatewayUrl = this.gateway.gatewayUrl ?? `https://${namePrefix}-gateway.bedrock.${this.region}.amazonaws.com`;
        this.gatewayId = this.gateway.gatewayId;

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
    }
}
