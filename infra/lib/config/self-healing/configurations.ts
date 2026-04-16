/**
 * @format
 * Self-Healing Project — Behavioural Configurations
 *
 * Centralised behavioural configs by environment.
 * Configurations are "how it behaves" — retention, policies, model selection.
 *
 * Usage:
 * ```typescript
 * import { getSelfHealingConfigs } from '../../config/self-healing';
 * const configs = getSelfHealingConfigs(Environment.DEVELOPMENT);
 * const model = configs.foundationModel;
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment, environmentRemovalPolicy } from '../environments';
import { MODELS } from '../shared/model-registry';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Complete behavioural configuration for the Self-Healing project
 */
export interface SelfHealingConfigs {
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** CDK removal policy for stateful resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Bedrock foundation model ID for the agent */
    readonly foundationModel: string;
    /**
     * When true, the agent proposes remediation steps but does not execute them.
     * Strongly recommended for development environments.
     */
    readonly enableDryRun: boolean;
    /**
     * System prompt content for the agent.
     * Stored in SSM Parameter Store at deploy time — the Lambda reads
     * from SSM at cold start rather than receiving it as a plaintext env var.
     */
    readonly systemPrompt: string;
    /**
     * SSM Parameter Store path where the system prompt will be stored.
     * The Agent Lambda reads from this path at cold start.
     */
    readonly systemPromptSsmPath: string;
}

// =============================================================================
// SHARED VALUES
// =============================================================================

/** Default system prompt for the self-healing agent */
const DEFAULT_SYSTEM_PROMPT = [
    'You are an infrastructure remediation agent for a solo-operated AWS portfolio.',
    'When triggered by a failure event, you must:',
    '1. Analyse the event payload to identify the failure type and affected resource.',
    '2. Query available MCP tools to understand your remediation options.',
    '3. Select the most appropriate tool(s) and execute them in sequence.',
    '4. Verify the remediation was successful by checking resource state.',
    '5. Return a structured summary of actions taken and outcomes.',
    '',
    'MANDATORY REASONING PROTOCOL (Chain-of-Thought):',
    'Before calling any write/remediation tool, you MUST explicitly state:',
    '  1. What failure class you identified (TRANSIENT vs PERMANENT).',
    '  2. Why you chose this classification — cite the specific evidence.',
    '  3. What diagnostic data supports this decision (e.g. failure code, metric value).',
    '  4. Whether a previous session already attempted this remediation.',
    'Only after completing this reasoning may you invoke a remediation tool.',
    '',
    'Guardrails:',
    '- Never terminate EC2 instances or delete S3 buckets.',
    '- Never modify IAM policies or security groups.',
    '- If DRY_RUN is enabled, only describe what you would do — do not execute.',
    '- If uncertain, log the situation and exit without action.',
    '- After calling any remediation tool, you MUST call check_node_health or',
    '  analyse_cluster_health to verify the outcome before producing your final report.',
].join('\n');

/** SSM parameter path template for system prompt storage */
const SYSTEM_PROMPT_SSM_PATH_TEMPLATE = '/self-healing-{env}/agent-system-prompt';

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Self-Healing behavioural configs by environment
 */
export const SELF_HEALING_CONFIGS: Record<DeployableEnvironment, SelfHealingConfigs> = {
    [Environment.DEVELOPMENT]: {
        logRetention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: environmentRemovalPolicy(Environment.DEVELOPMENT),
        foundationModel: MODELS.SELF_HEALING_AGENT,
        enableDryRun: true,     // Safe — agent proposes but does not act
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        systemPromptSsmPath: SYSTEM_PROMPT_SSM_PATH_TEMPLATE.replace('{env}', Environment.DEVELOPMENT),
    },

    [Environment.STAGING]: {
        logRetention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: environmentRemovalPolicy(Environment.STAGING),
        foundationModel: MODELS.SELF_HEALING_AGENT,
        enableDryRun: true,     // Still cautious in staging
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        systemPromptSsmPath: SYSTEM_PROMPT_SSM_PATH_TEMPLATE.replace('{env}', Environment.STAGING),
    },

    [Environment.PRODUCTION]: {
        logRetention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: environmentRemovalPolicy(Environment.PRODUCTION),
        foundationModel: MODELS.SELF_HEALING_AGENT,
        enableDryRun: false,    // Agent is trusted to act in production
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        systemPromptSsmPath: SYSTEM_PROMPT_SSM_PATH_TEMPLATE.replace('{env}', Environment.PRODUCTION),
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Self-Healing configs for an environment
 */
export function getSelfHealingConfigs(env: Environment): SelfHealingConfigs {
    return SELF_HEALING_CONFIGS[env as DeployableEnvironment];
}
