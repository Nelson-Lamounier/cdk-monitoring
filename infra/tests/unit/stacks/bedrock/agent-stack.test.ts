/**
 * @format
 * Bedrock Agent Stack Unit Tests
 *
 * The VectorKnowledgeBase construct from @cdklabs/generative-ai-cdk-constructs
 * requires Docker to build the OpenSearch custom resource Lambda.
 *
 * Strategy:
 *  - When Docker IS available → construct the stack and run real assertions.
 *  - When Docker is NOT available → verify the error is Docker-related
 *    (not a config issue) and skip template tests.
 */

import { Template } from 'aws-cdk-lib/assertions';
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

// =============================================================================
// Tests
// =============================================================================

/* eslint-disable jest/no-conditional-in-test, jest/no-conditional-expect */
describe('BedrockAgentStack', () => {

    // Docker detection — runs once before any test in this describe
    let stack: BedrockAgentStack | undefined;
    let dockerAvailable = false;
    let dockerError: Error | undefined;

    beforeAll(() => {
        try {
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
            dockerAvailable = true;
        } catch (err) {
            dockerError = err as Error;
            dockerAvailable = false;
        }
    });

    // -------------------------------------------------------------------------
    // Constructor — always runs
    // -------------------------------------------------------------------------
    describe('Constructor', () => {
        it('should construct successfully or fail with a Docker-related error', () => {
            if (dockerAvailable) {
                expect(stack).toBeDefined();
            } else {
                expect(dockerError?.message).toMatch(/docker|Docker/);
            }
        });
    });

    // -------------------------------------------------------------------------
    // Stack Properties — only meaningful when Docker is present
    // -------------------------------------------------------------------------
    describe('Stack Properties (requires Docker)', () => {
        it.each([
            ['agentId'],
            ['agentAliasId'],
            ['agent'],
            ['agentAlias'],
            ['knowledgeBase'],
            ['guardrail'],
        ] as const)('should expose %s', (prop) => {
            if (!dockerAvailable) {
                expect(dockerAvailable).toBe(false);
                return;
            }
            expect(stack![prop as keyof BedrockAgentStack]).toBeDefined();
        });
    });

    // -------------------------------------------------------------------------
    // Template assertions — only meaningful when Docker is present
    // -------------------------------------------------------------------------
    describe('Template Assertions (requires Docker)', () => {
        it('should create Lambda functions', () => {
            if (!dockerAvailable) {
                expect(dockerAvailable).toBe(false);
                return;
            }
            const template = Template.fromStack(stack!);
            // Action Group Lambda + VectorKnowledgeBase custom resource Lambdas
            template.resourceCountIs('AWS::Lambda::Function', 4);
        });

        it('should create SSM parameters for agent outputs', () => {
            if (!dockerAvailable) {
                expect(dockerAvailable).toBe(false);
                return;
            }
            const template = Template.fromStack(stack!);
            template.resourceCountIs('AWS::SSM::Parameter', 4);
        });
    });
});
/* eslint-enable jest/no-conditional-in-test, jest/no-conditional-expect */
