/**
 * @format
 * Bedrock Agent Stack
 *
 * Core AI stack for the Bedrock Agent project.
 * Creates the Bedrock Agent, Knowledge Base (vector store with S3),
 * Guardrail, Action Group Lambda, and Agent Alias.
 *
 * Uses @cdklabs/generative-ai-cdk-constructs for L2 Bedrock constructs.
 */

import {
    bedrock,
} from '@cdklabs/generative-ai-cdk-constructs';

import * as cdkBedrock from 'aws-cdk-lib/aws-bedrock';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for BedrockAgentStack
 */
export interface BedrockAgentStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Foundation model ID (e.g. 'anthropic.claude-sonnet-4-6') */
    readonly foundationModel: string;
    /** Agent instruction prompt */
    readonly agentInstruction: string;
    /** Agent description */
    readonly agentDescription: string;
    /** Idle session timeout in seconds */
    readonly idleSessionTtlInSeconds: number;
    /** S3 bucket for Knowledge Base data source (from DataStack) */
    readonly dataBucket: s3.IBucket;
    /** Whether to enable content filters on the guardrail */
    readonly enableContentFilters: boolean;
    /** Blocked input messaging for guardrail */
    readonly blockedInputMessaging: string;
    /** Blocked output messaging for guardrail */
    readonly blockedOutputsMessaging: string;
    /** Lambda memory for Action Group handler (MB) */
    readonly actionGroupLambdaMemoryMb: number;
    /** Lambda timeout for Action Group handler (seconds) */
    readonly actionGroupLambdaTimeoutSeconds: number;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * Agent Stack for Bedrock.
 *
 * Creates the Bedrock Agent with Knowledge Base, Guardrail,
 * Action Group, and Agent Alias.
 */
export class BedrockAgentStack extends cdk.Stack {
    /** The Bedrock Agent */
    public readonly agent: bedrock.Agent;

    /** The Agent Alias for stable invocations */
    public readonly agentAlias: bedrock.AgentAlias;

    /** The Knowledge Base */
    public readonly knowledgeBase: bedrock.VectorKnowledgeBase;

    /** The Guardrail */
    public readonly guardrail: bedrock.Guardrail;

    /** The Action Group Lambda function */
    public readonly actionGroupFunction: lambda.Function;

    /** Agent ID */
    public readonly agentId: string;

    /** Agent Alias ID */
    public readonly agentAliasId: string;

    constructor(scope: Construct, id: string, props: BedrockAgentStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // Guardrail — Content Filtering & Topic Denial
        // =================================================================
        this.guardrail = new bedrock.Guardrail(this, 'Guardrail', {
            name: `${namePrefix}-guardrail`,
            description: `Content guardrail for ${namePrefix} agent`,
            blockedInputMessaging: props.blockedInputMessaging,
            blockedOutputsMessaging: props.blockedOutputsMessaging,
        });

        // Add content filters via the method API
        if (props.enableContentFilters) {
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.SEXUAL,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.VIOLENCE,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.HATE,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.INSULTS,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.MISCONDUCT,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.HIGH,
            });
            this.guardrail.addContentFilter({
                type: bedrock.ContentFilterType.PROMPT_ATTACK,
                inputStrength: bedrock.ContentFilterStrength.HIGH,
                outputStrength: bedrock.ContentFilterStrength.NONE,
            });
        }

        // =================================================================
        // Knowledge Base — Vector store with S3 data source
        // =================================================================
        this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
            embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
            description: `Knowledge base for ${namePrefix} agent`,
        });

        // Add S3 data source to Knowledge Base
        new bedrock.S3DataSource(this, 'KBDataSource', {
            bucket: props.dataBucket,
            knowledgeBase: this.knowledgeBase,
            dataSourceName: `${namePrefix}-s3-source`,
        });

        // =================================================================
        // Action Group Lambda — Custom action handler
        // =================================================================
        this.actionGroupFunction = new lambda.Function(this, 'ActionGroupHandler', {
            functionName: `${namePrefix}-action-group`,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline([
                '// Infrastructure stub — business logic deployed from separate monorepo package',
                'exports.handler = async (event) => ({',
                '  messageVersion: "1.0",',
                '  response: {',
                '    actionGroup: event.actionGroup,',
                '    apiPath: event.apiPath,',
                '    httpMethod: event.httpMethod,',
                '    httpStatusCode: 200,',
                '    responseBody: { "application/json": { body: "{}" } },',
                '  },',
                '});',
            ].join('\n')),
            memorySize: props.actionGroupLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.actionGroupLambdaTimeoutSeconds),
            description: `Action Group handler for ${namePrefix} agent`,
        });

        // =================================================================
        // Bedrock Agent
        // =================================================================
        this.agent = new bedrock.Agent(this, 'Agent', {
            name: `${namePrefix}-agent`,
            description: props.agentDescription,
            foundationModel: bedrock.BedrockFoundationModel.fromCdkFoundationModelId(
                new cdkBedrock.FoundationModelIdentifier(props.foundationModel),
            ),
            instruction: props.agentInstruction,
            idleSessionTTL: cdk.Duration.seconds(props.idleSessionTtlInSeconds),
        });

        // Wire Knowledge Base, Guardrail, and Action Group via methods
        this.agent.addKnowledgeBase(this.knowledgeBase);
        this.agent.addGuardrail(this.guardrail);

        this.agent.addActionGroup(new bedrock.AgentActionGroup({
            name: `${namePrefix}-actions`,
            description: `Custom actions for ${namePrefix} agent`,
            executor: bedrock.ActionGroupExecutor.fromlambdaFunction(this.actionGroupFunction),
            apiSchema: bedrock.ApiSchema.fromInline(JSON.stringify({
                openapi: '3.0.0',
                info: {
                    title: `${namePrefix} Actions`,
                    version: '1.0.0',
                    description: `Action group API for ${namePrefix} agent`,
                },
                paths: {
                    '/get-info': {
                        get: {
                            summary: 'Get portfolio information',
                            description: 'Retrieves information about the portfolio',
                            operationId: 'getInfo',
                            responses: {
                                '200': {
                                    description: 'Successful response',
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: {
                                                    message: { type: 'string' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            })),
        }));

        // =================================================================
        // Agent Alias — Stable identifier for invocations
        // =================================================================
        this.agentAlias = new bedrock.AgentAlias(this, 'AgentAlias', {
            agent: this.agent,
            aliasName: `${namePrefix}-live`,
            description: `Live alias for ${namePrefix} agent`,
        });

        this.agentId = this.agent.agentId;
        this.agentAliasId = this.agentAlias.aliasId;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'AgentIdParam', {
            parameterName: `/${namePrefix}/agent-id`,
            stringValue: this.agent.agentId,
            description: `Bedrock Agent ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentArnParam', {
            parameterName: `/${namePrefix}/agent-arn`,
            stringValue: this.agent.agentArn,
            description: `Bedrock Agent ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'AgentAliasIdParam', {
            parameterName: `/${namePrefix}/agent-alias-id`,
            stringValue: this.agentAlias.aliasId,
            description: `Bedrock Agent Alias ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'KnowledgeBaseIdParam', {
            parameterName: `/${namePrefix}/knowledge-base-id`,
            stringValue: this.knowledgeBase.knowledgeBaseId,
            description: `Knowledge Base ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'AgentId', {
            value: this.agent.agentId,
            description: 'Bedrock Agent ID',
        });

        new cdk.CfnOutput(this, 'AgentArn', {
            value: this.agent.agentArn,
            description: 'Bedrock Agent ARN',
        });

        new cdk.CfnOutput(this, 'AgentAliasId', {
            value: this.agentAlias.aliasId,
            description: 'Bedrock Agent Alias ID',
        });

        new cdk.CfnOutput(this, 'KnowledgeBaseId', {
            value: this.knowledgeBase.knowledgeBaseId,
            description: 'Knowledge Base ID',
        });

        new cdk.CfnOutput(this, 'GuardrailId', {
            value: this.guardrail.guardrailId,
            description: 'Guardrail ID',
        });
    }
}
