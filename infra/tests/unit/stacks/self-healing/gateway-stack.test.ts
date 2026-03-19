/**
 * @format
 * Self-Healing Gateway Stack Unit Tests
 *
 * Tests for the SelfHealingGatewayStack:
 * - IAM role with correct name and trust policy
 * - Lambda invoke permissions for registered tools
 * - CloudWatch log group with correct name and retention
 * - SSM parameters for gateway-url and gateway-id
 * - Stack outputs
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
    // IAM Role
    // =========================================================================
    describe('IAM Role', () => {
        const { template } = createGatewayStack();

        it('should create a Gateway role with correct name', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: `${NAME_PREFIX}-gateway-role`,
            });
        });

        it('should trust the Bedrock service principal', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: {
                    Statement: [
                        {
                            Effect: 'Allow',
                            Principal: {
                                Service: 'bedrock.amazonaws.com',
                            },
                            Action: 'sts:AssumeRole',
                        },
                    ],
                },
            });
        });

        it('should grant lambda:InvokeFunction on registered tool ARNs', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'InvokeRegisteredTools',
                            Effect: 'Allow',
                            Action: 'lambda:InvokeFunction',
                            Resource: TOOL_LAMBDA_ARNS,
                        }),
                    ]),
                },
            });
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

        it('should output the Gateway Role ARN', () => {
            template.hasOutput('GatewayRoleArn', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createGatewayStack();

        it('should expose gatewayRole', () => {
            expect(stack.gatewayRole).toBeDefined();
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

            // Should still create the role but without the invoke policy
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: `${NAME_PREFIX}-gateway-role`,
            });
        });
    });
});
