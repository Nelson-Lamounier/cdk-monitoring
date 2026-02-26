/**
 * @format
 * Bedrock API Stack
 *
 * API Gateway + Lambda frontend for the Bedrock Agent.
 * Provides a REST endpoint to invoke the agent.
 */

import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for BedrockApiStack
 */
export interface BedrockApiStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Bedrock Agent ID (from AgentStack) */
    readonly agentId: string;
    /** Bedrock Agent Alias ID (from AgentStack) */
    readonly agentAliasId: string;
    /** Lambda memory in MB */
    readonly lambdaMemoryMb: number;
    /** Lambda timeout in seconds */
    readonly lambdaTimeoutSeconds: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * API Stack for Bedrock Agent.
 *
 * Creates a REST API Gateway backed by a Lambda function that
 * invokes the Bedrock Agent using the AWS SDK.
 */
export class BedrockApiStack extends cdk.Stack {
    /** The API Gateway REST API */
    public readonly api: apigateway.RestApi;

    /** The invoke Lambda function */
    public readonly invokeFunction: lambda.Function;

    /** The API URL */
    public readonly apiUrl: string;

    constructor(scope: Construct, id: string, props: BedrockApiStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // Invoke Lambda — Calls Bedrock Agent via SDK
        // =================================================================
        this.invokeFunction = new lambda.Function(this, 'InvokeFunction', {
            functionName: `${namePrefix}-invoke-agent`,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline([
                '// Infrastructure stub — business logic deployed from separate monorepo package',
                'exports.handler = async (event) => ({',
                '  statusCode: 200,',
                '  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },',
                '  body: JSON.stringify({ message: "stub — deploy application code" }),',
                '});',
            ].join('\n')),
            memorySize: props.lambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.lambdaTimeoutSeconds),
            environment: {
                AGENT_ID: props.agentId,
                AGENT_ALIAS_ID: props.agentAliasId,
            },
            description: `Agent invocation handler for ${namePrefix}`,
        });

        // Grant Bedrock Agent invoke permissions
        this.invokeFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'InvokeBedrockAgent',
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeAgent',
            ],
            resources: [
                `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${props.agentId}/${props.agentAliasId}`,
            ],
        }));

        // =================================================================
        // API Gateway — REST API
        // =================================================================
        this.api = new apigateway.RestApi(this, 'AgentApi', {
            restApiName: `${namePrefix}-agent-api`,
            description: `REST API for ${namePrefix} Bedrock Agent`,
            deployOptions: {
                stageName: 'v1',
                tracingEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
            },
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: ['POST', 'OPTIONS'],
                allowHeaders: ['Content-Type', 'Authorization'],
            },
        });

        // POST /invoke — Invoke the agent
        const invokeResource = this.api.root.addResource('invoke');
        invokeResource.addMethod('POST', new apigateway.LambdaIntegration(this.invokeFunction), {
            methodResponses: [
                { statusCode: '200' },
                { statusCode: '400' },
                { statusCode: '500' },
            ],
        });

        this.apiUrl = this.api.url;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'ApiUrlParam', {
            parameterName: `/${namePrefix}/api-url`,
            stringValue: this.api.url,
            description: `API Gateway URL for ${namePrefix} agent`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: this.api.url,
            description: 'API Gateway URL',
        });

        new cdk.CfnOutput(this, 'ApiId', {
            value: this.api.restApiId,
            description: 'API Gateway REST API ID',
        });
    }
}
