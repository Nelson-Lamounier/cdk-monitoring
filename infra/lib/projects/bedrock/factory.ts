/**
 * @format
 * Bedrock Project Factory
 *
 * Creates the Amazon Bedrock Agent infrastructure using a 4-stack architecture:
 * - DataStack: S3 bucket for Knowledge Base documents
 * - AgentStack: Bedrock Agent, Knowledge Base, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation
 * - ContentStack: MD-to-Blog pipeline (S3 event → Lambda → DynamoDB)
 *
 * Stacks created:
 * - Bedrock-Data-{environment}
 * - Bedrock-Agent-{environment}
 * - Bedrock-Api-{environment}
 * - Bedrock-Content-{environment}
 */

import * as cdk from 'aws-cdk-lib/core';

import { getBedrockAllocations } from '../../config/bedrock/allocations';
import { getBedrockConfigs } from '../../config/bedrock/configurations';
import { getContentAllocations } from '../../config/bedrock/content-allocations';
import { getContentConfigs } from '../../config/bedrock/content-configurations';
import { Environment, cdkEnvironment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    BedrockDataStack,
    BedrockAgentStack,
    BedrockApiStack,
    AiContentStack,
} from '../../stacks/bedrock';
import { stackId } from '../../utilities/naming';

// =========================================================================
// Factory Context
// =========================================================================

/**
 * Extended factory context with Bedrock-specific overrides.
 */
export interface BedrockFactoryContext extends ProjectFactoryContext {
    /** Override agent instruction from config */
    agentInstruction?: string;
    /** Override foundation model from config */
    foundationModel?: string;
}

/**
 * Bedrock project factory.
 * Creates Amazon Bedrock Agent infrastructure with Knowledge Bases,
 * Guardrails, Action Groups, API Gateway frontend, and MD-to-Blog pipeline.
 */
export class BedrockProjectFactory implements IProjectFactory<BedrockFactoryContext> {
    readonly project = Project.BEDROCK;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.BEDROCK).namespace;
    }

    createAllStacks(scope: cdk.App, context: BedrockFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const allocs = getBedrockAllocations(this.environment);
        const configs = getBedrockConfigs(this.environment);
        const contentAllocs = getContentAllocations(this.environment);
        const contentConfigs = getContentConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = `${this.namespace.toLowerCase()}-${this.environment}`;

        // Context overrides > typed config defaults
        const agentInstruction = context.agentInstruction ?? configs.agentInstruction;
        const foundationModel = context.foundationModel ?? allocs.agent.foundationModel;

        // =================================================================
        // Stack 1: Data (S3 bucket for Knowledge Base)
        //
        // Stateful resources with independent lifecycle.
        // Data persists across agent redeployments.
        // =================================================================
        const dataStack = new BedrockDataStack(
            scope,
            stackId(this.namespace, 'Data', this.environment),
            {
                namePrefix,
                createEncryptionKey: configs.createKmsKeys,
                removalPolicy: configs.removalPolicy,
                env,
            }
        );

        // =================================================================
        // Stack 2: Agent (Bedrock Agent + KB + Guardrail + Action Group)
        //
        // Core AI resources. References the Data stack's S3 bucket.
        // =================================================================
        const agentStack = new BedrockAgentStack(
            scope,
            stackId(this.namespace, 'Agent', this.environment),
            {
                namePrefix,
                foundationModel,
                agentInstruction,
                agentDescription: configs.agentDescription,
                idleSessionTtlInSeconds: allocs.agent.idleSessionTtlInSeconds,
                dataBucket: dataStack.dataBucket,
                enableContentFilters: configs.guardrail.enableContentFilters,
                blockedInputMessaging: configs.guardrail.blockedInputMessaging,
                blockedOutputsMessaging: configs.guardrail.blockedOutputMessaging,
                actionGroupLambdaMemoryMb: allocs.actionGroupLambda.memoryMb,
                actionGroupLambdaTimeoutSeconds: allocs.actionGroupLambda.timeoutSeconds,
                removalPolicy: configs.removalPolicy,
                env,
            }
        );
        agentStack.addDependency(dataStack);

        // =================================================================
        // Stack 3: API (API Gateway + Lambda for agent invocation)
        //
        // Serverless frontend. References Agent stack outputs.
        // =================================================================
        const apiStack = new BedrockApiStack(
            scope,
            stackId(this.namespace, 'Api', this.environment),
            {
                namePrefix,
                agentId: agentStack.agentId,
                agentAliasId: agentStack.agentAliasId,
                lambdaMemoryMb: allocs.apiLambda.memoryMb,
                lambdaTimeoutSeconds: allocs.apiLambda.timeoutSeconds,
                logRetention: configs.logRetention,
                removalPolicy: configs.removalPolicy,
                env,
            }
        );
        apiStack.addDependency(agentStack);

        // =================================================================
        // Stack 4: Content (MD-to-Blog Agentic Pipeline)
        //
        // Event-driven content transformation. References Data stack's
        // S3 bucket for drafts/ and published/ prefixes.
        // Independent of Agent/API stacks.
        // =================================================================
        const contentStack = new AiContentStack(
            scope,
            stackId(this.namespace, 'Content', this.environment),
            {
                namePrefix,
                assetsBucket: dataStack.dataBucket,
                draftPrefix: contentConfigs.s3.draftPrefix,
                publishedPrefix: contentConfigs.s3.publishedPrefix,
                contentPrefix: contentConfigs.s3.contentPrefix,
                draftSuffix: contentConfigs.s3.draftSuffix,
                foundationModel: contentAllocs.model.foundationModel,
                maxTokens: contentAllocs.model.maxTokens,
                thinkingBudgetTokens: contentAllocs.model.thinkingBudgetTokens,
                lambdaMemoryMb: contentAllocs.lambda.memoryMb,
                lambdaTimeoutSeconds: contentAllocs.lambda.timeoutSeconds,
                logRetention: contentConfigs.logRetention,
                removalPolicy: contentConfigs.removalPolicy,
                env,
            }
        );
        contentStack.addDependency(dataStack);

        const stacks: cdk.Stack[] = [dataStack, agentStack, apiStack, contentStack];

        cdk.Annotations.of(scope).addInfo(
            `Bedrock factory created ${stacks.length} stacks for ${this.environment}`,
        );

        return {
            stacks,
            stackMap: {
                data: dataStack,
                agent: agentStack,
                api: apiStack,
                content: contentStack,
            },
        };
    }
}
