/**
 * @format
 * Self-Healing Gateway Stack Unit Tests
 *
 * Tests for the SelfHealingGatewayStack using the L2 AgentCore Gateway:
 * - AgentCore Gateway resource (AWS::BedrockAgentCore::Gateway)
 * - Auto-provisioned IAM role (Bedrock trust)
 * - Cognito User Pool for M2M auth
 * - Tool Lambda functions (diagnose-alarm, ebs-detach, check-node-health, analyse-cluster-health, get-node-diagnostic-json, remediate-node-bootstrap)
 * - GatewayTarget registrations
 * - CloudWatch log groups with correct names and retention
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
            throttlingRateLimit: 5,
            throttlingBurstLimit: 10,
            sonnetProfileSourceArn: 'arn:aws:bedrock:eu-west-1::inference-profile/eu.anthropic.claude-sonnet-4-6',
            environmentName: 'development',
            // Resolved at deploy time via {{resolve:ssm:...}} — stub path for tests
            stateMachineArnSsmPath: '/k8s/development/bootstrap/state-machine-arn',
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
    // Tool Lambda Functions
    // =========================================================================
    describe('Tool Lambda Functions', () => {
        const { template } = createGatewayStack();

        it('should create the diagnose-alarm Lambda function', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-tool-diagnose-alarm`,
                Runtime: 'nodejs22.x',
            });
        });

        it('should enable X-Ray tracing on tool Lambdas', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-tool-diagnose-alarm`,
                TracingConfig: { Mode: 'Active' },
            });
        });
    });

    // =========================================================================
    // Gateway Targets (tool registrations)
    // =========================================================================
    describe('Gateway Targets', () => {
        const { template } = createGatewayStack();

        it('should register 5 Gateway targets', () => {
            template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 5);
        });

        it('should register the diagnose-alarm target', () => {
            template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
                Name: 'diagnose-alarm',
            });
        });

        it('should register the check-node-health target', () => {
            template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
                Name: 'check-node-health',
            });
        });

        it('should register the analyse-cluster-health target', () => {
            template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
                Name: 'analyse-cluster-health',
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
    // IAM Policies for Tool Lambdas
    // =========================================================================
    describe('Tool Lambda IAM Policies', () => {
        const { template } = createGatewayStack();

        it('should grant CloudWatch read access to diagnose-alarm', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'cloudwatch:DescribeAlarms',
                                'cloudwatch:GetMetricData',
                            ]),
                            Effect: 'Allow',
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
    // CloudWatch Log Groups
    // =========================================================================
    describe('CloudWatch Logging', () => {
        const { template } = createGatewayStack();

        it('should create a log group for the Gateway', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/agentcore/${NAME_PREFIX}-gateway`,
                RetentionInDays: 7,
            });
        });

        it('should create log groups for tool Lambdas', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/lambda/${NAME_PREFIX}-tool-diagnose-alarm`,
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
});
