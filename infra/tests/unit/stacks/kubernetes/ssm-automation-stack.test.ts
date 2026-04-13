/**
 * @format
 * SSM Automation Stack Unit Tests
 *
 * Tests for K8sSsmAutomationStack:
 * - SSM Automation Documents (control plane, worker, deploy-secrets)
 * - SSM Command Document (node drift enforcement)
 * - IAM Role for automation execution
 * - SSM Parameters for document discovery
 * - Step configuration and ordering
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getK8sConfigs } from '../../../../lib/config/kubernetes';
import {
    K8sSsmAutomationStack,
    K8sSsmAutomationStackProps,
} from '../../../../lib/stacks/kubernetes/ssm-automation-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_CONFIGS = getK8sConfigs(Environment.DEVELOPMENT);

function createSsmAutomationStack(
    overrides?: Partial<K8sSsmAutomationStackProps>,
): { stack: K8sSsmAutomationStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new K8sSsmAutomationStack(app, 'TestSsmAutomationStack', {
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        configs: TEST_CONFIGS,
        namePrefix: 'k8s-dev',
        ssmPrefix: '/k8s/development',
        scriptsBucketName: 'test-scripts-bucket',
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('K8sSsmAutomationStack', () => {

    // =========================================================================
    // SSM Automation Documents
    // =========================================================================
    describe('SSM Automation Documents', () => {
        const { template } = createSsmAutomationStack();

        it('should create 5 SSM documents (2 Automation + 3 Command)', () => {
            template.resourceCountIs('AWS::SSM::Document', 5);
        });

        it('should create a control plane automation document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                DocumentType: 'Automation',
                Name: 'k8s-dev-bootstrap-control-plane',
                DocumentFormat: 'JSON',
                UpdateMethod: 'NewVersion',
            });
        });

        it('should create a unified worker automation document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                DocumentType: 'Automation',
                Name: 'k8s-dev-bootstrap-worker',
                DocumentFormat: 'JSON',
                UpdateMethod: 'NewVersion',
            });
        });

        it('should have 1 consolidated step in the worker document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-worker',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({ name: 'bootstrapWorker' }),
                    ]),
                }),
            });
        });

        it('should use aws:runCommand action for each step', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-control-plane',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({
                            action: 'aws:runCommand',
                        }),
                    ]),
                }),
            });
        });

        it('should configure onFailure: Abort for each step', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-control-plane',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({
                            onFailure: 'Abort',
                        }),
                    ]),
                }),
            });
        });

        it('should configure timeouts for consolidated steps', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-control-plane',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({
                            name: 'bootstrapControlPlane',
                            timeoutSeconds: 1800,
                        }),
                    ]),
                }),
            });
        });

        it('should define InstanceId, SsmPrefix, S3Bucket, Region parameters', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-control-plane',
                Content: Match.objectLike({
                    parameters: Match.objectLike({
                        InstanceId: Match.objectLike({ type: 'String' }),
                        SsmPrefix: Match.objectLike({ type: 'String' }),
                        S3Bucket: Match.objectLike({ type: 'String' }),
                        Region: Match.objectLike({ type: 'String' }),
                    }),
                }),
            });
        });

        it('should create a deploy-runner command document (SM-B runner)', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                DocumentType: 'Command',
                Name: 'k8s-dev-deploy-runner',
                DocumentFormat: 'JSON',
                UpdateMethod: 'NewVersion',
            });
        });

        it('should have a single runScript step in the deploy-runner document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-deploy-runner',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({ name: 'runScript' }),
                    ]),
                }),
            });
        });

        it('should accept ScriptPath and S3Bucket parameters and execute via python3', () => {
            // deploy-runner receives ScriptPath at runtime from SM-B (ConfigOrchestrator).
            // Script paths are no longer hardcoded in the document — they are passed as
            // parameters, keeping the document generic for any app-deploy/<app>/deploy.py.
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-deploy-runner',
                Content: Match.objectLike({
                    parameters: Match.objectLike({
                        ScriptPath: Match.objectLike({ type: 'String' }),
                        S3Bucket: Match.objectLike({ type: 'String' }),
                    }),
                    mainSteps: Match.arrayWith([
                        Match.objectLike({
                            inputs: Match.objectLike({
                                runCommand: Match.arrayWith([
                                    Match.stringLikeRegexp('python3'),
                                ]),
                            }),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // IAM Role
    // =========================================================================
    describe('IAM Role', () => {
        const { template } = createSsmAutomationStack();

        it('should create an automation execution role', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: 'k8s-dev-ssm-automation-role',
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: Match.objectLike({
                                Service: 'ssm.amazonaws.com',
                            }),
                        }),
                    ]),
                }),
            });
        });

        it('should grant ssm:SendCommand permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'ssm:SendCommand',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('should grant S3 read permissions scoped to scripts bucket', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                's3:GetObject',
                            ]),
                            Resource: Match.arrayWith([
                                Match.stringLikeRegexp('test-scripts-bucket'),
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('should grant SSM parameter access scoped to ssmPrefix', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'ssm:GetParameter',
                                'ssm:PutParameter',
                            ]),
                            Resource: Match.stringLikeRegexp('/k8s/development'),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // SSM Parameters (Document Discovery)
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createSsmAutomationStack();

        it('should create SSM parameter for control plane document name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/bootstrap/control-plane-doc-name',
                Value: 'k8s-dev-bootstrap-control-plane',
            });
        });

        it('should create SSM parameter for worker document name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/bootstrap/worker-doc-name',
                Value: 'k8s-dev-bootstrap-worker',
            });
        });

        it('should create SSM parameter for automation role ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/bootstrap/automation-role-arn',
            });
        });

        it('should create SSM parameter for consolidated deploy secrets document name', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/deploy/secrets-doc-name',
                Value: 'k8s-dev-deploy-secrets',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        const { stack } = createSsmAutomationStack();

        it('should expose controlPlaneDocName', () => {
            expect(stack.controlPlaneDocName).toBe('k8s-dev-bootstrap-control-plane');
        });

        it('should expose workerDocName', () => {
            expect(stack.workerDocName).toBe('k8s-dev-bootstrap-worker');
        });

        it('should expose automationRoleArn', () => {
            expect(stack.automationRoleArn).toBeTruthy();
        });

        it('should expose deploySecretsDocName', () => {
            expect(stack.deploySecretsDocName).toBe('k8s-dev-deploy-secrets');
        });
    });

    // =========================================================================
    // Resource Cleanup Provider — pre-emptive orphan deletion
    // =========================================================================
    describe('Resource Cleanup Provider', () => {
        const { template } = createSsmAutomationStack();

        it('should create the cleanup Lambda function', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                Runtime: 'python3.13',
                Description: Match.stringLikeRegexp('cleanup.*orphaned'),
            });
        });

        it('should create custom resources for SSM parameter cleanup', () => {
            // Cleanup targets:
            //   SSM params (8): control-plane-doc-name, worker-doc-name, secrets-doc-name,
            //     automation-role-arn, ssm-bootstrap-log-group, ssm-deploy-log-group,
            //     state-machine-arn, config-state-machine-arn
            //   Log groups (5): bootstrap, deploy, bootstrap-orchestrator, bootstrap-router,
            //     config-orchestrator
            //   SNS topics (1): bootstrap-alarm
            // Total cleanup registrations = 14
            template.resourceCountIs('AWS::CloudFormation::CustomResource', 14);
        });

        it('should grant the cleanup Lambda logs:DeleteLogGroup permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'logs:DeleteLogGroup',
                            Sid: 'CleanupLogGroups',
                        }),
                    ]),
                }),
            });
        });

        it('should grant the cleanup Lambda ssm:DeleteParameter permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'ssm:DeleteParameter',
                            Sid: 'CleanupSsmParameters',
                        }),
                    ]),
                }),
            });
        });

        it('should grant the cleanup Lambda sns:DeleteTopic permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sns:DeleteTopic',
                            Sid: 'CleanupSnsTopics',
                        }),
                    ]),
                }),
            });
        });
    });
});
