/**
 * @format
 * Self-Healing Gateway Stack Unit Tests
 *
 * Tests for the SelfHealingGatewayStack using the L2 AgentCore Gateway:
 * - AgentCore Gateway resource (AWS::BedrockAgentCore::Gateway)
 * - Auto-provisioned IAM role (Bedrock trust)
 * - Cognito User Pool for M2M auth
 * - CloudWatch log group with correct name and retention
 * - SSM parameters for gateway-url and gateway-id
 * - Stack outputs (URL, ID, ARN)
 * - Stack properties exposure
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { SelfHealingGatewayStack } from '../../../../lib/stacks/self-healing/gateway-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const NAME_PREFIX = 'self-healing-development';

const TOOL_LAMBDA_ARNS = [
    'arn:aws:lambda:eu-west-1:123456789012:function:eip-failover',
    'arn:aws:lambda:eu-west-1:123456789012:function:ebs-detach',
];

/**
 * Helper to create SelfHealingGatewayStack with sensible defaults.
 */
function createGatewayStack(
    overrides?: Partial<ConstructorParameters<typeof SelfHealingGatewayStack>[2]>,
): { stack: SelfHealingGatewayStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new SelfHealingGatewayStack(
        app,
        'TestSelfHealingGatewayStack',
        {
            namePrefix: NAME_PREFIX,
            logRetention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            toolLambdaArns: TOOL_LAMBDA_ARNS,
            throttlingRateLimit: 5,
            throttlingBurstLimit: 10,
            env: TEST_ENV_EU,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('SelfHealingGatewayStack', () => {

    // =========================================================================
    // AgentCore Gateway (L2 Construct)
    // =========================================================================
    describe('AgentCore Gateway', () => {
        const { template } = createGatewayStack();

        it('should create an AgentCore Gateway resource', () => {
            template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
        });

        it('should set the correct gateway name', () => {
            template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
                Name: `${NAME_PREFIX}-gateway`,
            });
        });

        it('should include a description', () => {
            template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
                Description: `Self-healing MCP tool gateway for ${NAME_PREFIX}`,
            });
        });
    });

    // =========================================================================
    // IAM Role (auto-created by L2)
    // =========================================================================
    describe('Gateway IAM Role', () => {
        const { template } = createGatewayStack();

        it('should create an IAM role for the Gateway', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Allow',
                            Principal: Match.objectLike({
                                Service: 'bedrock-agentcore.amazonaws.com',
                            }),
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // Cognito (default M2M auth)
    // =========================================================================
    describe('Cognito Authoriser', () => {
        const { template } = createGatewayStack();

        it('should create a Cognito User Pool for M2M auth', () => {
            template.resourceCountIs('AWS::Cognito::UserPool', 1);
        });

        it('should create a Cognito User Pool Client', () => {
            template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
        });
    });

    // =========================================================================
    // CloudWatch Log Group
    // =========================================================================
    describe('CloudWatch Logging', () => {
        const { template } = createGatewayStack();

        it('should create a log group for the Gateway', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/agentcore/${NAME_PREFIX}-gateway`,
                RetentionInDays: 7,
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createGatewayStack();

        it('should create SSM parameter for Gateway URL', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/gateway-url`,
            });
        });

        it('should create SSM parameter for Gateway ID', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/gateway-id`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createGatewayStack();

        it('should output the Gateway URL', () => {
            template.hasOutput('GatewayUrl', {});
        });

        it('should output the Gateway ID', () => {
            template.hasOutput('GatewayId', {});
        });

        it('should output the Gateway ARN', () => {
            template.hasOutput('GatewayArn', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createGatewayStack();

        it('should expose gateway L2 construct', () => {
            expect(stack.gateway).toBeDefined();
        });

        it('should expose gatewayUrl', () => {
            expect(stack.gatewayUrl).toBeDefined();
        });

        it('should expose gatewayId', () => {
            expect(stack.gatewayId).toBeDefined();
        });
    });

    // =========================================================================
    // Edge Cases
    // =========================================================================
    describe('Edge Cases', () => {
        it('should handle empty tool Lambda ARNs without error', () => {
            const { template } = createGatewayStack({ toolLambdaArns: [] });

            // Gateway should still be created without targets
            template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
        });
    });
});
