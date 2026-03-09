/**
 * @format
 * Bedrock API Stack
 *
 * API Gateway + Lambda frontend for the Bedrock Agent.
 * Provides a secured REST endpoint to invoke the agent.
 *
 * Security features:
 * - API Key authentication with Usage Plan + throttling
 * - Request body validation
 * - CloudWatch access logging
 * - Scoped CORS origins
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
    /** Whether to enable API Key authentication */
    readonly enableApiKey: boolean;
    /** Allowed CORS origins */
    readonly allowedOrigins: string[];
    /** API Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** API Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
}

/**
 * API Stack for Bedrock Agent.
 *
 * Creates a secured REST API Gateway backed by a Lambda function that
 * invokes the Bedrock Agent using the AWS SDK.
 */
export class BedrockApiStack extends cdk.Stack {
    /** The API Gateway REST API */
    public readonly api: apigateway.RestApi;

    /** The invoke Lambda function */
    public readonly invokeFunction: lambda.Function;

    /** The API URL */
    public readonly apiUrl: string;

    /** The API Key (if enabled) */
    public readonly apiKey?: apigateway.IApiKey;

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
        // CloudWatch Log Group — API Gateway Access Logging
        // =================================================================
        const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
            logGroupName: `/aws/apigateway/${namePrefix}-agent-api`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

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
                accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
                    caller: true,
                    httpMethod: true,
                    ip: true,
                    protocol: true,
                    requestTime: true,
                    resourcePath: true,
                    responseLength: true,
                    status: true,
                    user: true,
                }),
                throttlingRateLimit: props.throttlingRateLimit,
                throttlingBurstLimit: props.throttlingBurstLimit,
            },
            defaultCorsPreflightOptions: {
                allowOrigins: props.allowedOrigins,
                allowMethods: ['POST', 'OPTIONS'],
                allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
            },
        });

        // =================================================================
        // Request Validator — Validate body on POST /invoke
        // =================================================================
        const requestValidator = new apigateway.RequestValidator(this, 'InvokeRequestValidator', {
            restApi: this.api,
            requestValidatorName: `${namePrefix}-invoke-validator`,
            validateRequestBody: true,
            validateRequestParameters: false,
        });

        // Define request model for the invoke endpoint
        const invokeModel = this.api.addModel('InvokeRequestModel', {
            contentType: 'application/json',
            modelName: 'InvokeRequest',
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ['prompt'],
                properties: {
                    prompt: {
                        type: apigateway.JsonSchemaType.STRING,
                        minLength: 1,
                        maxLength: 10000,
                        description: 'The user prompt to send to the Bedrock Agent',
                    },
                    sessionId: {
                        type: apigateway.JsonSchemaType.STRING,
                        description: 'Optional session ID for conversation continuity',
                    },
                },
            },
        });

        // =================================================================
        // POST /invoke — Invoke the agent
        // =================================================================
        const invokeResource = this.api.root.addResource('invoke');
        invokeResource.addMethod('POST', new apigateway.LambdaIntegration(this.invokeFunction), {
            apiKeyRequired: props.enableApiKey,
            requestValidator,
            requestModels: {
                'application/json': invokeModel,
            },
            methodResponses: [
                { statusCode: '200' },
                { statusCode: '400' },
                { statusCode: '500' },
            ],
        });

        // =================================================================
        // API Key + Usage Plan (throttling + quota)
        // =================================================================
        if (props.enableApiKey) {
            this.apiKey = this.api.addApiKey('AgentApiKey', {
                apiKeyName: `${namePrefix}-agent-api-key`,
                description: `API Key for ${namePrefix} Bedrock Agent API`,
            });

            const usagePlan = this.api.addUsagePlan('AgentUsagePlan', {
                name: `${namePrefix}-usage-plan`,
                description: `Usage plan for ${namePrefix} Bedrock Agent API`,
                throttle: {
                    rateLimit: props.throttlingRateLimit,
                    burstLimit: props.throttlingBurstLimit,
                },
                quota: {
                    limit: 10000,
                    period: apigateway.Period.MONTH,
                },
            });

            usagePlan.addApiKey(this.apiKey);
            usagePlan.addApiStage({
                stage: this.api.deploymentStage,
            });
        }

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
