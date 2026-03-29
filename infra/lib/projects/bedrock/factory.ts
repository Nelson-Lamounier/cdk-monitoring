/**
 * @format
 * Bedrock Project Factory
 *
 * Creates the Amazon Bedrock Agent infrastructure using a 6-stack architecture:
 * - DataStack: S3 bucket for content pipeline documents
 * - KbStack: Bedrock Knowledge Base backed by Pinecone
 * - AgentStack: Bedrock Agent, Guardrail, Action Group
 * - ApiStack: API Gateway + Lambda for agent invocation
 * - ContentStack: MD-to-Blog pipeline (S3 event → Lambda → DynamoDB)
 * - PipelineStack: Multi-agent Step Functions pipeline (Research → Writer → QA)
 *
 * Stacks created:
 * - Bedrock-Data-{environment}
 * - Bedrock-Kb-{environment}
 * - Bedrock-Agent-{environment}
 * - Bedrock-Api-{environment}
 * - Bedrock-Content-{environment}
 * - Bedrock-Pipeline-{environment}
 */

import * as cdk from 'aws-cdk-lib/core';

import { getBedrockAllocations } from '../../config/bedrock/allocations';
import { getBedrockConfigs } from '../../config/bedrock/configurations';
import { getContentAllocations } from '../../config/bedrock/content-allocations';
import { getContentConfigs } from '../../config/bedrock/content-configurations';
import { getPipelineAllocations } from '../../config/bedrock/pipeline-allocations';
import { getPipelineConfigs } from '../../config/bedrock/pipeline-configurations';
import { Environment, cdkEnvironment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    BedrockDataStack,
    BedrockKbStack,
    BedrockAgentStack,
    BedrockApiStack,
    AiContentStack,
    BedrockPipelineStack,
} from '../../stacks/bedrock';
import { stackId, flatName } from '../../utilities/naming';

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
 * Creates Amazon Bedrock Agent infrastructure with Guardrails,
 * Action Groups, API Gateway frontend, and MD-to-Blog pipeline.
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
        const pipelineAllocs = getPipelineAllocations(this.environment);
        const pipelineConfigs = getPipelineConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = flatName('bedrock', '', this.environment);

        // Context overrides > typed config defaults
        const agentInstruction = context.agentInstruction ?? configs.agentInstruction;
        const foundationModel = context.foundationModel ?? allocs.agent.foundationModel;

        // =================================================================
        // Stack 1: Data (S3 bucket for content pipeline)
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
        // Stack 2: Knowledge Base (Pinecone-backed vector store)
        //
        // Creates the Bedrock KB that embeds and retrieves repo docs.
        // Uses Pinecone free tier — zero idle cost.
        // Must be created before Agent so it can be associated.
        // =================================================================
        const kbStack = new BedrockKbStack(
            scope,
            stackId(this.namespace, 'Kb', this.environment),
            {
                namePrefix,
                embeddingsModel: allocs.knowledgeBase.embeddingsModel,
                dataBucketArn: dataStack.dataBucket.bucketArn,
                pineconeConnectionString: allocs.knowledgeBase.pineconeConnectionString,
                pineconeSecretName: configs.knowledgeBase.pineconeSecretName,
                pineconeNamespace: allocs.knowledgeBase.pineconeNamespace,
                kbDescription: configs.knowledgeBase.description,
                kbInstruction: configs.knowledgeBase.instruction,
                removalPolicy: configs.removalPolicy,
                env,
            }
        );
        kbStack.addDependency(dataStack);

        // =================================================================
        // Stack 3: Agent (Bedrock Agent + Guardrail + Action Group + KB)
        //
        // Core AI resources. Knowledge Base is wired here so the chatbot
        // can answer portfolio questions from Pinecone-indexed documents.
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
                enableContentFilters: configs.guardrail.enableContentFilters,
                blockedInputMessaging: configs.guardrail.blockedInputMessaging,
                blockedOutputsMessaging: configs.guardrail.blockedOutputMessaging,
                actionGroupLambdaMemoryMb: allocs.actionGroupLambda.memoryMb,
                actionGroupLambdaTimeoutSeconds: allocs.actionGroupLambda.timeoutSeconds,
                removalPolicy: configs.removalPolicy,
                knowledgeBase: kbStack.knowledgeBase,
                env,
            }
        );
        agentStack.addDependency(dataStack);
        agentStack.addDependency(kbStack);

        // =================================================================
        // Stack 4: API (API Gateway + Lambda for agent invocation)
        //
        // Serverless frontend. References Agent stack outputs.
        // =================================================================
        const apiStack = new BedrockApiStack(
            scope,
            stackId(this.namespace, 'Api', this.environment),
            {
                namePrefix,
                lambdaMemoryMb: allocs.apiLambda.memoryMb,
                lambdaTimeoutSeconds: allocs.apiLambda.timeoutSeconds,
                logRetention: configs.logRetention,
                removalPolicy: configs.removalPolicy,
                enableApiKey: configs.api.enableApiKey,
                allowedOrigins: configs.api.allowedOrigins,
                throttlingRateLimit: allocs.apiGateway.throttlingRateLimit,
                throttlingBurstLimit: allocs.apiGateway.throttlingBurstLimit,
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
                assetsBucketName: dataStack.bucketName,
                draftPrefix: contentConfigs.s3.draftPrefix,
                publishedPrefix: contentConfigs.s3.publishedPrefix,
                contentPrefix: contentConfigs.s3.contentPrefix,
                draftSuffix: contentConfigs.s3.draftSuffix,
                foundationModel: contentAllocs.model.foundationModel,
                maxTokens: contentAllocs.model.maxTokens,
                thinkingBudgetTokens: contentAllocs.model.thinkingBudgetTokens,
                lambdaMemoryMb: contentAllocs.lambda.memoryMb,
                lambdaTimeoutSeconds: contentAllocs.lambda.timeoutSeconds,
                lambdaReservedConcurrency: contentAllocs.lambda.reservedConcurrency,
                logRetention: contentConfigs.logRetention,
                removalPolicy: contentConfigs.removalPolicy,
                knowledgeBaseId: kbStack.knowledgeBaseId,
                knowledgeBaseArn: kbStack.knowledgeBaseArn,
                environmentName: this.environment,
                env,
            }
        );
        contentStack.addDependency(dataStack);
        contentStack.addDependency(kbStack);

        // =================================================================
        // Stack 6: Pipeline (Multi-Agent Step Functions)
        //
        // Shadow-mode pipeline running alongside the monolith.
        // Uses separate Lambdas per agent with Step Functions orchestration.
        // Will replace ContentStack after validation (Phase 2c).
        // =================================================================
        const pipelineStack = new BedrockPipelineStack(
            scope,
            stackId(this.namespace, 'Pipeline', this.environment),
            {
                namePrefix,
                assetsBucketName: dataStack.bucketName,
                tableName: contentStack.tableName,
                researchModel: pipelineAllocs.research.modelId,
                writerModel: pipelineAllocs.writer.modelId,
                qaModel: pipelineAllocs.qa.modelId,
                writerMaxTokens: pipelineAllocs.writer.maxTokens,
                writerThinkingBudgetTokens: pipelineAllocs.writer.thinkingBudgetTokens,
                agentLambdaMemoryMb: pipelineAllocs.lambda.agentMemoryMb,
                agentLambdaTimeoutSeconds: pipelineAllocs.lambda.agentTimeoutSeconds,
                triggerLambdaMemoryMb: pipelineAllocs.lambda.triggerMemoryMb,
                publishLambdaMemoryMb: pipelineAllocs.lambda.publishMemoryMb,
                logRetention: pipelineConfigs.logRetention,
                removalPolicy: pipelineConfigs.removalPolicy,
                knowledgeBaseId: kbStack.knowledgeBaseId,
                knowledgeBaseArn: kbStack.knowledgeBaseArn,
                environmentName: this.environment,
                draftPrefix: pipelineConfigs.s3.draftPrefix,
                publishedPrefix: pipelineConfigs.s3.publishedPrefix,
                contentPrefix: pipelineConfigs.s3.contentPrefix,
                reviewPrefix: pipelineConfigs.s3.reviewPrefix,
                archivedPrefix: pipelineConfigs.s3.archivedPrefix,
                isrEndpoint: pipelineConfigs.isrEndpoint,
                env,
            }
        );
        pipelineStack.addDependency(dataStack);
        pipelineStack.addDependency(contentStack); // Uses contentStack's DynamoDB table

        const stacks: cdk.Stack[] = [dataStack, kbStack, agentStack, apiStack, contentStack, pipelineStack];

        cdk.Annotations.of(scope).addInfo(
            `Bedrock factory created ${stacks.length} stacks for ${this.environment}`,
        );

        return {
            stacks,
            stackMap: {
                data: dataStack,
                kb: kbStack,
                agent: agentStack,
                api: apiStack,
                content: contentStack,
                pipeline: pipelineStack,
            },
        };
    }
}
