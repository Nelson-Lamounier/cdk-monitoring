/**
 * @format
 * Bedrock Knowledge Base Stack Unit Tests
 *
 * Tests for the Bedrock Knowledge Base backed by Pinecone.
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';

import { BedrockKbStack } from '../../../../lib/stacks/bedrock/kb-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'bedrock-development';
const PINECONE_CONNECTION_STRING = 'https://portfolio-kb-test.svc.aped-test.pinecone.io';
const PINECONE_SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:bedrock-dev/pinecone-api-key-AbCdEf';
const PINECONE_NAMESPACE = 'portfolio-dev';
const EMBEDDINGS_MODEL = 'amazon.titan-embed-text-v2:0';
const KB_DESCRIPTION = 'Test knowledge base';
const KB_INSTRUCTION = 'Use this knowledge base for testing.';

// =============================================================================
// Tests
// =============================================================================

describe('BedrockKbStack', () => {
    let stack: BedrockKbStack;

    beforeAll(() => {
        const app = createTestApp();

        // Create a stub data bucket in a separate stack
        const dataStack = new cdk.Stack(app, 'TestDataStack', { env: TEST_ENV_EU });
        const dataBucket = new s3.Bucket(dataStack, 'DataBucket', {
            bucketName: `${NAME_PREFIX}-kb-data`,
        });

        stack = new BedrockKbStack(
            app,
            'TestBedrockKbStack',
            {
                namePrefix: NAME_PREFIX,
                embeddingsModel: EMBEDDINGS_MODEL,
                dataBucketArn: dataBucket.bucketArn,
                pineconeConnectionString: PINECONE_CONNECTION_STRING,
                pineconeCredentialsSecretArn: PINECONE_SECRET_ARN,
                pineconeNamespace: PINECONE_NAMESPACE,
                kbDescription: KB_DESCRIPTION,
                kbInstruction: KB_INSTRUCTION,
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
            ['knowledgeBaseId'],
            ['knowledgeBaseArn'],
            ['knowledgeBase'],
            ['dataSource'],
        ] as const)('should expose %s', (prop) => {
            expect(stack[prop as keyof BedrockKbStack]).toBeDefined();
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

        it('should create a Bedrock Knowledge Base', () => {
            template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
        });

        it('should create a Bedrock Data Source', () => {
            template.resourceCountIs('AWS::Bedrock::DataSource', 1);
        });

        it('should create SSM parameters for KB outputs', () => {
            // knowledgeBaseId, knowledgeBaseArn
            template.resourceCountIs('AWS::SSM::Parameter', 2);
        });

        it('should create SSM parameter for KB ID', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/knowledge-base-id`,
            });
        });

        it('should create SSM parameter for KB ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/knowledge-base-arn`,
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

        it('should output the Knowledge Base ID', () => {
            template.hasOutput('KnowledgeBaseId', {});
        });

        it('should output the Knowledge Base ARN', () => {
            template.hasOutput('KnowledgeBaseArn', {});
        });
    });
});
