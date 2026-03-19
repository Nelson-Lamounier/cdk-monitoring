/**
 * @format
 * Self-Healing Agent Stack Unit Tests
 *
 * Tests for the SelfHealingAgentStack:
 * - NodejsFunction with correct runtime (NODEJS_22_X), memory, timeout
 * - X-Ray active tracing
 * - SQS Dead Letter Queue (encrypted, retention)
 * - Environment variables (GATEWAY_URL, FOUNDATION_MODEL, DRY_RUN)
 * - IAM policy for bedrock:InvokeModel (cross-region inference profile)
 * - EventBridge rule with scoped alarm name prefix
 * - CloudWatch log group
 * - SSM parameters for agent Lambda ARN/name + DLQ URL
 * - Stack outputs
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { SelfHealingAgentStack } from '../../../../lib/stacks/self-healing/agent-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Constants
// =============================================================================

const NAME_PREFIX = 'self-healing-development';
const GATEWAY_URL = 'https://self-healing-dev-gateway.bedrock.eu-west-1.amazonaws.com';
const FOUNDATION_MODEL = 'eu.anthropic.claude-sonnet-4-6';
const SYSTEM_PROMPT = 'You are a test agent.';
const DLQ_RETENTION_DAYS = 7;

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Helper to create SelfHealingAgentStack with sensible defaults.
 */
function createAgentStack(
    overrides?: Partial<ConstructorParameters<typeof SelfHealingAgentStack>[2]>,
): { stack: SelfHealingAgentStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new SelfHealingAgentStack(
        app,
        'TestSelfHealingAgentStack',
        {
            namePrefix: NAME_PREFIX,
            lambdaMemoryMb: 512,
            lambdaTimeoutSeconds: 120,
            logRetention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            foundationModel: FOUNDATION_MODEL,
            enableDryRun: true,
            systemPrompt: SYSTEM_PROMPT,
            gatewayUrl: GATEWAY_URL,
            dlqRetentionDays: DLQ_RETENTION_DAYS,
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

describe('SelfHealingAgentStack', () => {

    // =========================================================================
    // Lambda — Agent Function (NodejsFunction)
    // =========================================================================
    describe('Lambda Agent Function', () => {
        const { template } = createAgentStack();

        it('should create a Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: `${NAME_PREFIX}-agent`,
            });
        });

        it('should use Node.js 22.x runtime', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'nodejs22.x',
            });
        });

        it('should set 512 MB memory', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                MemorySize: 512,
            });
        });

        it('should set 120 second timeout', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Timeout: 120,
            });
        });

        it('should enable X-Ray active tracing', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                TracingConfig: {
                    Mode: 'Active',
                },
            });
        });

        it('should configure environment variables', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        GATEWAY_URL: GATEWAY_URL,
                        FOUNDATION_MODEL: FOUNDATION_MODEL,
                        DRY_RUN: 'true',
                        SYSTEM_PROMPT: SYSTEM_PROMPT,
                    }),
                },
            });
        });

        it('should set DRY_RUN to false when enableDryRun is false', () => {
            const { template: t } = createAgentStack({ enableDryRun: false });
            t.hasResourceProperties('AWS::Lambda::Function', {
                Environment: {
                    Variables: Match.objectLike({
                        DRY_RUN: 'false',
                    }),
                },
            });
        });
    });

    // =========================================================================
    // SQS — Dead Letter Queue
    // =========================================================================
    describe('Dead Letter Queue', () => {
        const { template } = createAgentStack();

        it('should create an SQS DLQ', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: `${NAME_PREFIX}-agent-dlq`,
            });
        });

        it('should set DLQ retention period', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                MessageRetentionPeriod: DLQ_RETENTION_DAYS * 86400,
            });
        });

        it('should use SQS managed encryption', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                SqsManagedSseEnabled: true,
            });
        });

        it('should wire DLQ to the Lambda', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                DeadLetterConfig: {
                    TargetArn: Match.anyValue(),
                },
            });
        });
    });

    // =========================================================================
    // IAM — Bedrock Model Invocation (Cross-Region)
    // =========================================================================
    describe('IAM Policies', () => {
        const { template } = createAgentStack();

        it('should grant Bedrock InvokeModel permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'InvokeBedrockModel',
                            Effect: 'Allow',
                            Action: [
                                'bedrock:InvokeModel',
                                'bedrock:InvokeModelWithResponseStream',
                            ],
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // EventBridge Rule — Alarm Trigger
    // =========================================================================
    describe('EventBridge Rule', () => {
        const { template } = createAgentStack();

        it('should create an alarm trigger rule', () => {
            template.hasResourceProperties('AWS::Events::Rule', {
                Name: `${NAME_PREFIX}-alarm-trigger`,
                EventPattern: Match.objectLike({
                    source: ['aws.cloudwatch'],
                    'detail-type': ['CloudWatch Alarm State Change'],
                }),
            });
        });

        it('should filter by ALARM state only', () => {
            template.hasResourceProperties('AWS::Events::Rule', {
                EventPattern: Match.objectLike({
                    detail: Match.objectLike({
                        state: { value: ['ALARM'] },
                    }),
                }),
            });
        });
    });

    // =========================================================================
    // CloudWatch Log Group
    // =========================================================================
    describe('CloudWatch Logging', () => {
        const { template } = createAgentStack();

        it('should create a log group for the agent Lambda', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/lambda/${NAME_PREFIX}-agent`,
                RetentionInDays: 7,
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createAgentStack();

        it('should create SSM parameter for agent Lambda ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/agent-lambda-arn`,
            });
        });

        it('should create SSM parameter for agent Lambda name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/agent-lambda-name`,
            });
        });

        it('should create SSM parameter for agent DLQ URL', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/agent-dlq-url`,
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createAgentStack();

        it('should output the agent function ARN', () => {
            template.hasOutput('AgentFunctionArn', {});
        });

        it('should output the agent function name', () => {
            template.hasOutput('AgentFunctionName', {});
        });

        it('should output the DLQ URL', () => {
            template.hasOutput('AgentDlqUrl', {});
        });

        it('should output the dry-run mode status', () => {
            template.hasOutput('DryRunEnabled', {});
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createAgentStack();

        it('should expose agentFunction', () => {
            expect(stack.agentFunction).toBeDefined();
        });

        it('should expose agentDlq', () => {
            expect(stack.agentDlq).toBeDefined();
        });
    });
});
