/**
 * @format
 * Strategist Pipeline Stack Unit Tests
 *
 * Tests for the StrategistPipelineStack (Iterative Multi-Agent Step Functions):
 * - Lambda functions (Research, Strategist, AnalysisPersist, CoachLoader, Coach, Trigger)
 * - Two Step Functions state machines (Analysis + Coaching)
 * - SQS Dead Letter Queue with SSL enforcement
 * - IAM permissions (Bedrock InvokeModel, DynamoDB access)
 * - SSM parameter exports (analysis SM ARN, coaching SM ARN, trigger function ARN)
 * - X-Ray tracing enabled on all Lambdas
 * - CloudWatch log groups for all Lambdas and state machines
 * - Public properties (analysisStateMachine, coachingStateMachine, triggerFunction, pipelineDlq)
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import type { StrategistPipelineStackProps } from '../../../../lib/stacks/bedrock/strategist-pipeline-stack';
import { StrategistPipelineStack } from '../../../../lib/stacks/bedrock/strategist-pipeline-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Constants
// =============================================================================

const NAME_PREFIX = 'bedrock-development';
const TEST_BUCKET_NAME = `${NAME_PREFIX}-kb-data`;
const TABLE_NAME = `${NAME_PREFIX}-job-strategist`;
const TEST_KB_ID = 'test-kb-id-12345';
const TEST_KB_ARN = 'arn:aws:bedrock:eu-west-1:123456789012:knowledge-base/test-kb-id-12345';

/** Lambda function count: Research + Strategist + AnalysisPersist + CoachLoader + Coach + Trigger = 6 */
const EXPECTED_LAMBDA_COUNT = 6;

/** Expected Lambda function names */
const LAMBDA_NAMES = {
    research: `${NAME_PREFIX}-strategist-research`,
    strategist: `${NAME_PREFIX}-strategist-writer`,
    analysisPersist: `${NAME_PREFIX}-strategist-analysis-persist`,
    coachLoader: `${NAME_PREFIX}-strategist-coach-loader`,
    coach: `${NAME_PREFIX}-strategist-coach`,
    trigger: `${NAME_PREFIX}-strategist-trigger`,
} as const;

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Default props for StrategistPipelineStack tests.
 *
 * Uses representative model IDs and allocation values
 * from the development environment configuration.
 */
const DEFAULT_PROPS: StrategistPipelineStackProps = {
    namePrefix: NAME_PREFIX,
    assetsBucketName: TEST_BUCKET_NAME,
    tableName: TABLE_NAME,
    researchModel: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    strategistModel: 'eu.anthropic.claude-sonnet-4-6-20260313-v1:0',
    strategistMaxTokens: 16384,
    strategistThinkingBudgetTokens: 8192,
    coachModel: 'eu.anthropic.claude-haiku-4-5-20260315-v1:0',
    coachMaxTokens: 8192,
    coachThinkingBudgetTokens: 4096,
    agentLambdaMemoryMb: 512,
    agentLambdaTimeoutSeconds: 300,
    triggerLambdaMemoryMb: 256,
    logRetention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    knowledgeBaseId: TEST_KB_ID,
    knowledgeBaseArn: TEST_KB_ARN,
    environmentName: 'development',
    env: TEST_ENV_EU,
};

/**
 * Helper to create StrategistPipelineStack with sensible defaults.
 *
 * @param overrides - Partial props to override defaults
 * @returns Stack, template, and app for testing
 */
function createPipelineStack(
    overrides?: Partial<StrategistPipelineStackProps>,
): { stack: StrategistPipelineStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new StrategistPipelineStack(
        app,
        'TestStrategistPipelineStack',
        {
            ...DEFAULT_PROPS,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('StrategistPipelineStack', () => {

    // =========================================================================
    // Lambda Functions — Agent Lambdas
    // =========================================================================
    describe('Lambda Functions', () => {
        const { template } = createPipelineStack();

        it('should create exactly 6 Lambda functions', () => {
            template.resourceCountIs('AWS::Lambda::Function', EXPECTED_LAMBDA_COUNT);
        });

        it('should create the Research Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.research,
            });
        });

        it('should create the Strategist Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.strategist,
            });
        });

        it('should create the Analysis Persist Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.analysisPersist,
            });
        });

        it('should create the Coach Loader Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.coachLoader,
            });
        });

        it('should create the Coach Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.coach,
            });
        });

        it('should create the Trigger Lambda with correct name', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.trigger,
            });
        });

        it('should use NODEJS_22_X runtime for all Lambdas', () => {
            const resources = template.findResources('AWS::Lambda::Function');
            const runtimes = Object.values(resources).map(
                (r) => (r as Record<string, Record<string, string>>).Properties.Runtime,
            );

            for (const runtime of runtimes) {
                expect(runtime).toBe('nodejs22.x');
            }
        });
    });

    // =========================================================================
    // Lambda — Environment Variables
    // =========================================================================
    describe('Lambda Environment Variables', () => {
        const { template } = createPipelineStack();

        it('should pass RESEARCH_MODEL to the Research Lambda', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.research,
                Environment: {
                    Variables: Match.objectLike({
                        RESEARCH_MODEL: DEFAULT_PROPS.researchModel,
                    }),
                },
            });
        });

        it('should pass KNOWLEDGE_BASE_ID to the Research Lambda when provided', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.research,
                Environment: {
                    Variables: Match.objectLike({
                        KNOWLEDGE_BASE_ID: TEST_KB_ID,
                    }),
                },
            });
        });

        it('should pass FOUNDATION_MODEL to the Strategist Lambda', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.strategist,
                Environment: {
                    Variables: Match.objectLike({
                        FOUNDATION_MODEL: DEFAULT_PROPS.strategistModel,
                    }),
                },
            });
        });

        it('should pass MAX_TOKENS and THINKING_BUDGET_TOKENS to the Strategist Lambda', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.strategist,
                Environment: {
                    Variables: Match.objectLike({
                        MAX_TOKENS: String(DEFAULT_PROPS.strategistMaxTokens),
                        THINKING_BUDGET_TOKENS: String(DEFAULT_PROPS.strategistThinkingBudgetTokens),
                    }),
                },
            });
        });

        it('should pass COACH_MODEL to the Coach Lambda', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.coach,
                Environment: {
                    Variables: Match.objectLike({
                        COACH_MODEL: DEFAULT_PROPS.coachModel,
                    }),
                },
            });
        });

        it('should pass ENVIRONMENT to all agent Lambdas', () => {
            for (const lambdaName of [LAMBDA_NAMES.research, LAMBDA_NAMES.strategist, LAMBDA_NAMES.coach]) {
                template.hasResourceProperties('AWS::Lambda::Function', {
                    FunctionName: lambdaName,
                    Environment: {
                        Variables: Match.objectLike({
                            ENVIRONMENT: 'development',
                        }),
                    },
                });
            }
        });
    });

    // =========================================================================
    // Lambda — X-Ray Tracing
    // =========================================================================
    describe('Lambda X-Ray Tracing', () => {
        const { template } = createPipelineStack();

        it('should enable X-Ray active tracing on all agent Lambdas', () => {
            for (const lambdaName of Object.values(LAMBDA_NAMES)) {
                template.hasResourceProperties('AWS::Lambda::Function', {
                    FunctionName: lambdaName,
                    TracingConfig: {
                        Mode: 'Active',
                    },
                });
            }
        });
    });

    // =========================================================================
    // Lambda — Memory Configuration
    // =========================================================================
    describe('Lambda Memory Configuration', () => {
        const { template } = createPipelineStack();

        it('should set correct memory for agent Lambdas', () => {
            for (const lambdaName of [LAMBDA_NAMES.research, LAMBDA_NAMES.strategist, LAMBDA_NAMES.coach]) {
                template.hasResourceProperties('AWS::Lambda::Function', {
                    FunctionName: lambdaName,
                    MemorySize: DEFAULT_PROPS.agentLambdaMemoryMb,
                });
            }
        });

        it('should set correct memory for the Trigger Lambda', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: LAMBDA_NAMES.trigger,
                MemorySize: DEFAULT_PROPS.triggerLambdaMemoryMb,
            });
        });
    });

    // =========================================================================
    // Step Functions — State Machine
    // =========================================================================
    describe('Step Functions State Machines', () => {
        const { template } = createPipelineStack();

        it('should create exactly 2 state machines', () => {
            template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
        });

        it('should set the correct analysis state machine name', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineName: `${NAME_PREFIX}-strategist-analysis`,
            });
        });

        it('should set the correct coaching state machine name', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineName: `${NAME_PREFIX}-strategist-coaching`,
            });
        });

        it('should use STANDARD state machine type', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineType: 'STANDARD',
            });
        });

        it('should enable tracing on the state machine', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                TracingConfiguration: {
                    Enabled: true,
                },
            });
        });

        it('should configure logging on the state machine', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                LoggingConfiguration: Match.objectLike({
                    Level: 'ALL',
                }),
            });
        });
    });

    // =========================================================================
    // SQS — Dead Letter Queue
    // =========================================================================
    describe('SQS Dead Letter Queue', () => {
        const { template } = createPipelineStack();

        it('should create exactly 1 SQS queue (DLQ)', () => {
            template.resourceCountIs('AWS::SQS::Queue', 1);
        });

        it('should set the correct DLQ name', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: `${NAME_PREFIX}-strategist-dlq`,
            });
        });

        it('should set 14-day message retention on DLQ', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                MessageRetentionPeriod: 1209600, // 14 days in seconds
            });
        });

        it('should use SQS managed encryption', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                SqsManagedSseEnabled: true,
            });
        });
    });

    // =========================================================================
    // IAM — Bedrock Permissions
    // =========================================================================
    describe('IAM Permissions', () => {
        const { template } = createPipelineStack();

        it('should grant bedrock:InvokeModel to agent Lambdas', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'bedrock:InvokeModel',
                            Effect: 'Allow',
                        }),
                    ]),
                },
            });
        });

        it('should grant bedrock:Retrieve when KB ARN is provided', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: {
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'bedrock:Retrieve',
                            Effect: 'Allow',
                            Resource: TEST_KB_ARN,
                        }),
                    ]),
                },
            });
        });
    });

    // =========================================================================
    // IAM — KB Permissions Without KB
    // =========================================================================
    describe('IAM Permissions without KB', () => {
        it('should not grant bedrock:Retrieve when no KB ARN is provided', () => {
            const { template } = createPipelineStack({
                knowledgeBaseId: undefined,
                knowledgeBaseArn: undefined,
            });

            const policies = template.findResources('AWS::IAM::Policy');
            const allStatements = Object.values(policies).flatMap(
                (p) => {
                    const props = (p as Record<string, Record<string, Record<string, unknown[]>>>).Properties;
                    const doc = props['PolicyDocument'] as Record<string, unknown[]>;
                    return doc['Statement'] as Record<string, unknown>[];
                },
            );

            const retrieveActions = allStatements.filter(
                (s) => (s as Record<string, string>).Action === 'bedrock:Retrieve',
            );

            expect(retrieveActions).toHaveLength(0);
        });
    });

    // =========================================================================
    // CloudWatch — Log Groups
    // =========================================================================
    describe('CloudWatch Log Groups', () => {
        const { template } = createPipelineStack();

        it('should create log groups for all Lambda functions', () => {
            for (const lambdaName of Object.values(LAMBDA_NAMES)) {
                template.hasResourceProperties('AWS::Logs::LogGroup', {
                    LogGroupName: `/aws/lambda/${lambdaName}`,
                });
            }
        });

        it('should create a log group for the analysis state machine', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/vendedlogs/states/${NAME_PREFIX}-strategist-analysis`,
            });
        });

        it('should create a log group for the coaching state machine', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: `/aws/vendedlogs/states/${NAME_PREFIX}-strategist-coaching`,
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createPipelineStack();

        it('should export analysis state machine ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/strategist-analysis-state-machine-arn`,
            });
        });

        it('should export coaching state machine ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/strategist-coaching-state-machine-arn`,
            });
        });

        it('should export trigger function ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `/${NAME_PREFIX}/strategist-trigger-function-arn`,
            });
        });

        it('should create exactly 3 SSM parameters', () => {
            template.resourceCountIs('AWS::SSM::Parameter', 3);
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createPipelineStack();

        it('should expose analysisStateMachine', () => {
            expect(stack.analysisStateMachine).toBeDefined();
        });

        it('should expose coachingStateMachine', () => {
            expect(stack.coachingStateMachine).toBeDefined();
        });

        it('should expose triggerFunction', () => {
            expect(stack.triggerFunction).toBeDefined();
        });

        it('should expose pipelineDlq', () => {
            expect(stack.pipelineDlq).toBeDefined();
        });
    });

    // =========================================================================
    // Step Functions — Pipeline Definition
    // =========================================================================
    describe('Step Functions Pipeline Definitions', () => {
        const { template } = createPipelineStack();

        it('should create exactly 2 state machines', () => {
            template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
        });

        it('should reference analysis pipeline tasks in the definitions', () => {
            const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
            const definitionStr = JSON.stringify(Object.values(stateMachines));

            // Analysis pipeline tasks
            expect(definitionStr).toContain('ResearchTask');
            expect(definitionStr).toContain('StrategistTask');
            expect(definitionStr).toContain('AnalysisPersistTask');
            expect(definitionStr).toContain('AnalysisPipelineFailed');
        });

        it('should reference coaching pipeline tasks in the definitions', () => {
            const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
            const definitionStr = JSON.stringify(Object.values(stateMachines));

            // Coaching pipeline tasks
            expect(definitionStr).toContain('CoachLoaderTask');
            expect(definitionStr).toContain('CoachTask');
            expect(definitionStr).toContain('CoachingPipelineFailed');
        });
    });

    // =========================================================================
    // No API Gateway (trigger via SSM-resolved Lambda invocation)
    // =========================================================================
    describe('API Gateway absence', () => {
        const { template } = createPipelineStack();

        it('should not create any API Gateway resources (trigger is invoked directly)', () => {
            template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
        });
    });
});
