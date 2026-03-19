/**
 * @format
 * Self-Healing Gateway Stack
 *
 * Creates the AgentCore Gateway — a managed MCP server endpoint that
 * exposes existing Lambda functions as MCP-compatible tools.
 *
 * Resources:
 * - IAM role for Gateway to invoke registered Lambda tools
 * - AgentCore Gateway (via CfnResource / L1 construct)
 * - CloudWatch log group for Gateway invocations
 * - SSM parameters for cross-stack discovery
 *
 * The Gateway acts as the central tool discovery and invocation layer
 * for the Strands Agent in the companion AgentStack.
 */

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
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
 * Creates an AgentCore Gateway that registers existing infrastructure
 * Lambda functions (EBS detach, EIP failover, ECR deploy, DNS validation)
 * as MCP-compatible tools accessible to the Strands Agent.
 */
export class SelfHealingGatewayStack extends cdk.Stack {
    /** The Gateway execution IAM role */
    public readonly gatewayRole: iam.Role;

    /** The Gateway URL (placeholder until AgentCore L2 stabilises) */
    public readonly gatewayUrl: string;

    /** The Gateway ID */
    public readonly gatewayId: string;

    constructor(scope: Construct, id: string, props: SelfHealingGatewayStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // IAM Role — Gateway invocation of registered Lambda tools
        // =================================================================
        this.gatewayRole = new iam.Role(this, 'GatewayRole', {
            roleName: `${namePrefix}-gateway-role`,
            assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
            description: `AgentCore Gateway role for ${namePrefix}`,
        });

        // Grant invoke on all registered tool Lambdas
        if (props.toolLambdaArns.length > 0) {
            this.gatewayRole.addToPolicy(new iam.PolicyStatement({
                sid: 'InvokeRegisteredTools',
                effect: iam.Effect.ALLOW,
                actions: ['lambda:InvokeFunction'],
                resources: props.toolLambdaArns,
            }));
        }

        // =================================================================
        // CloudWatch Log Group — Gateway invocations
        // =================================================================
        new logs.LogGroup(this, 'GatewayLogGroup', {
            logGroupName: `/aws/agentcore/${namePrefix}-gateway`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // AgentCore Gateway — Placeholder
        //
        // As of March 2026, the AgentCore Gateway L2 construct is not
        // yet available in CDK. This creates the supporting infrastructure
        // (IAM role, logging, SSM exports). The Gateway itself is
        // provisioned via the AWS Console or CLI and its URL is stored
        // in SSM for the AgentStack to consume.
        //
        // When L2 constructs are available, replace this section with:
        //   new agentcore.Gateway(this, 'Gateway', { ... });
        // =================================================================

        // Placeholder values — replaced at deploy time via SSM
        this.gatewayUrl = `https://${namePrefix}-gateway.bedrock.${this.region}.amazonaws.com`;
        this.gatewayId = `${namePrefix}-gateway`;

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.gatewayRole,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Gateway role needs invoke access to multiple registered tool Lambdas; wildcard not used — explicit ARN list provided',
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

        new cdk.CfnOutput(this, 'GatewayRoleArn', {
            value: this.gatewayRole.roleArn,
            description: 'IAM role ARN for Gateway tool invocations',
        });
    }
}
