/**
 * @format
 * Bedrock Agent Stack Unit Tests
 *
 * The VectorKnowledgeBase construct from @cdklabs/generative-ai-cdk-constructs
 * requires Docker to build the OpenSearch custom resource Lambda. Since Docker
 * is not available in local dev or standard CI runners, template-level
 * assertions are marked as .todo. The constructor test validates that the
 * error is Docker-related (not a config issue).
 */

import * as s3 from 'aws-cdk-lib/aws-s3';
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
const TEST_BUCKET_NAME = `${NAME_PREFIX}-kb-data`;

function createAgentStack(): BedrockAgentStack {
    const app = createTestApp();

    return new BedrockAgentStack(
        app,
        'TestBedrockAgentStack',
        {
            namePrefix: NAME_PREFIX,
            foundationModel: FOUNDATION_MODEL,
            agentInstruction: 'You are a helpful AI assistant for testing.',
            agentDescription: 'Test agent',
            idleSessionTtlInSeconds: 600,
            dataBucket: s3.Bucket.fromBucketName(
                new cdk.Stack(app, 'BucketLookup', { env: TEST_ENV_EU }),
                'ImportedBucket',
                TEST_BUCKET_NAME,
            ),
            enableContentFilters: true,
            blockedInputMessaging: 'Sorry, I cannot process that request.',
            blockedOutputsMessaging: 'Sorry, I cannot provide that response.',
            actionGroupLambdaMemoryMb: 256,
            actionGroupLambdaTimeoutSeconds: 30,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            env: TEST_ENV_EU,
        },
    );
}

// =============================================================================
// Tests
// =============================================================================

describe('BedrockAgentStack', () => {

    describe('Constructor', () => {
        it('should throw Docker-related error when Docker daemon is unavailable', () => {
            expect(() => createAgentStack()).toThrow(/docker|Docker/);
        });
    });

    // Template-level tests require Docker for VectorKnowledgeBase synth.
    // Use .todo so they appear in test reports as planned work.
    describe('Action Group Lambda', () => {
        it.todo('should create an Action Group Lambda with correct name');
        it.todo('should use Node.js 22 runtime');
        it.todo('should set 256 MB memory');
    });

    describe('SSM Parameters', () => {
        it.todo('should create SSM parameter for agent ID');
        it.todo('should create SSM parameter for agent alias ID');
        it.todo('should create SSM parameter for knowledge base ID');
    });

    describe('Stack Outputs', () => {
        it.todo('should output the agent ID');
        it.todo('should output the agent alias ID');
        it.todo('should output the knowledge base ID');
        it.todo('should output the guardrail ID');
    });

    describe('Stack Properties', () => {
        it.todo('should expose agent');
        it.todo('should expose agentAlias');
        it.todo('should expose knowledgeBase');
        it.todo('should expose guardrail');
        it.todo('should expose agentId');
        it.todo('should expose agentAliasId');
    });
});
