/**
 * @format
 * Self-Healing Project Factory
 *
 * Creates the Self-Healing pipeline infrastructure using a 2-stack architecture:
 * - GatewayStack: AgentCore Gateway (MCP server for tool discovery)
 * - AgentStack: Bedrock ConverseCommand agent Lambda (MCP client for remediation)
 *
 * Stacks created:
 * - SelfHealing-Gateway-{environment}
 * - SelfHealing-Agent-{environment}
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment, cdkEnvironment } from '../../config/environments';
import { Project, getProjectConfig } from '../../config/projects';
import { getSelfHealingAllocations } from '../../config/self-healing/allocations';
import { getSelfHealingConfigs } from '../../config/self-healing/configurations';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    SelfHealingGatewayStack,
    SelfHealingAgentStack,
} from '../../stacks/self-healing';
import { stackId, flatName } from '../../utilities/naming';

// =========================================================================
// Factory Context
// =========================================================================

/**
 * Extended factory context with Self-Healing-specific overrides.
 */
export interface SelfHealingFactoryContext extends ProjectFactoryContext {
    /** Override foundation model from config */
    foundationModel?: string;
}

/**
 * Self-Healing project factory.
 * Creates AgentCore Gateway and Bedrock agent infrastructure
 * for automated pipeline failure remediation.
 */
export class SelfHealingProjectFactory implements IProjectFactory<SelfHealingFactoryContext> {
    readonly project = Project.SELF_HEALING;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.SELF_HEALING).namespace;
    }

    createAllStacks(scope: cdk.App, context: SelfHealingFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const allocs = getSelfHealingAllocations(this.environment);
        const configs = getSelfHealingConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = flatName('self-healing', '', this.environment);

        // Context overrides > typed config defaults
        const foundationModel = context.foundationModel ?? configs.foundationModel;

        // =================================================================
        // Stack 1: Gateway (AgentCore Gateway — MCP tool server)
        //
        // Creates tool Lambda functions (diagnose-alarm, ebs-detach)
        // and registers them with the Gateway as MCP targets.
        // Must be created before the Agent stack.
        // =================================================================
        const gatewayStack = new SelfHealingGatewayStack(
            scope,
            stackId(this.namespace, 'Gateway', this.environment),
            {
                namePrefix,
                logRetention: configs.logRetention,
                removalPolicy: configs.removalPolicy,
                throttlingRateLimit: allocs.gateway.throttlingRateLimit,
                throttlingBurstLimit: allocs.gateway.throttlingBurstLimit,
                env,
            }
        );

        // =================================================================
        // Stack 2: Agent (Bedrock ConverseCommand Lambda — MCP client)
        //
        // Connects to the Gateway to discover tools and orchestrate
        // remediation logic. Triggered by scoped CloudWatch Alarms.
        // =================================================================
        const agentStack = new SelfHealingAgentStack(
            scope,
            stackId(this.namespace, 'Agent', this.environment),
            {
                namePrefix,
                lambdaMemoryMb: allocs.agentLambda.memoryMb,
                lambdaTimeoutSeconds: allocs.agentLambda.timeoutSeconds,
                logRetention: configs.logRetention,
                removalPolicy: configs.removalPolicy,
                foundationModel,
                enableDryRun: configs.enableDryRun,
                systemPrompt: configs.systemPrompt,
                gatewayUrl: gatewayStack.gatewayUrl,
                dlqRetentionDays: allocs.dlqRetentionDays,
                reservedConcurrency: allocs.agentLambda.reservedConcurrency,
                cognitoTokenEndpoint: gatewayStack.tokenEndpointUrl,
                cognitoUserPoolId: gatewayStack.userPoolId,
                cognitoClientId: gatewayStack.userPoolClientId,
                cognitoScopes: gatewayStack.oauthScopes,
                notificationEmail: process.env.NOTIFICATION_EMAIL,
                env,
            }
        );
        agentStack.addDependency(gatewayStack);

        const stacks: cdk.Stack[] = [gatewayStack, agentStack];

        cdk.Annotations.of(scope).addInfo(
            `Self-Healing factory created ${stacks.length} stacks for ${this.environment}`,
        );

        return {
            stacks,
            stackMap: {
                gateway: gatewayStack,
                agent: agentStack,
            },
        };
    }
}
