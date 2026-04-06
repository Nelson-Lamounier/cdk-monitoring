/**
 * @format
 * Bedrock Agent Stack Unit Tests
 *
 * Tests for the Bedrock Agent, Guardrail, and Agent Alias.
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
        let template: Template;

        beforeAll(() => {
            template = Template.fromStack(stack);
        });

        it('should not create any Lambda functions', () => {
            // No Action Group Lambda (removed per security review)
            template.resourceCountIs('AWS::Lambda::Function', 0);
        });

        it('should create SSM parameters for agent outputs', () => {
            // agentId, agentArn, agentAliasId (knowledgeBaseId removed)
            template.resourceCountIs('AWS::SSM::Parameter', 3);
        });

        it('should create SSM parameter for agent ID', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/agent-id`,
            });
        });

        it('should create SSM parameter for agent ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/agent-arn`,
            });
        });

        it('should create SSM parameter for agent alias ID', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/agent-alias-id`,
            });
        });
    });

    // -------------------------------------------------------------------------
    // Stack Outputs
    // -------------------------------------------------------------------------
    describe('Stack Outputs', () => {
        let template: Template;

        beforeAll(() => {
            template = Template.fromStack(stack);
        });

        it('should output the Agent ID', () => {
            template.hasOutput('AgentId', {});
        });

        it('should output the Agent Alias ID', () => {
            template.hasOutput('AgentAliasId', {});
        });

        it('should output the Guardrail ID', () => {
            template.hasOutput('GuardrailId', {});
        });
    });
});
