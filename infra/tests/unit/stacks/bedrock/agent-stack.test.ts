/**
 * @format
 * Bedrock Agent Stack Unit Tests
 *
 * Tests for the Bedrock Agent, Guardrail, Action Group, and Agent Alias.
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockAgentStack } from '../../../../lib/stacks/bedrock/agent-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-development';
const FOUNDATION_MODEL = 'anthropic.claude-sonnet-4-6';

// =============================================================================
// Tests
// =============================================================================

describe('BedrockAgentStack', () => {
    let stack: BedrockAgentStack;

    beforeAll(() => {
        const app = createTestApp();

        stack = new BedrockAgentStack(
            app,
            'TestBedrockAgentStack',
            {
                namePrefix: NAME_PREFIX,
                foundationModel: FOUNDATION_MODEL,
                agentInstruction: 'You are a helpful AI assistant for testing.',
                agentDescription: 'Test agent',
                idleSessionTtlInSeconds: 600,
                enableContentFilters: true,
                blockedInputMessaging: 'Sorry, I cannot process that request.',
                blockedOutputsMessaging: 'Sorry, I cannot provide that response.',
                actionGroupLambdaMemoryMb: 256,
                actionGroupLambdaTimeoutSeconds: 30,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                env: TEST_ENV_EU,
            },
        );
    });

    // -------------------------------------------------------------------------
    // Stack Properties
    // -------------------------------------------------------------------------
    describe('Stack Properties', () => {
        it.each([
            ['agentId'],
            ['agentAliasId'],
            ['agent'],
            ['agentAlias'],
            ['guardrail'],
        ] as const)('should expose %s', (prop) => {
            expect(stack[prop as keyof BedrockAgentStack]).toBeDefined();
        });
    });

    // -------------------------------------------------------------------------
    // Template assertions
    // -------------------------------------------------------------------------
    describe('Template Assertions', () => {
        it('should create Lambda functions', () => {
            const template = Template.fromStack(stack);
            // Action Group Lambda only (no more VectorKnowledgeBase custom resource Lambdas)
            template.resourceCountIs('AWS::Lambda::Function', 1);
        });

        it('should create SSM parameters for agent outputs', () => {
            const template = Template.fromStack(stack);
            // agentId, agentArn, agentAliasId (knowledgeBaseId removed)
            template.resourceCountIs('AWS::SSM::Parameter', 3);
        });
    });
});
