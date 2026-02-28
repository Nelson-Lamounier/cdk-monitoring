/**
 * @format
 * SSM Automation Stack Unit Tests
 *
 * Tests for K8sSsmAutomationStack:
 * - SSM Automation Documents (control plane + worker)
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

        it('should create 2 SSM Automation documents', () => {
            template.resourceCountIs('AWS::SSM::Document', 2);
        });

        it('should create a control plane automation document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                DocumentType: 'Automation',
                Name: 'k8s-dev-bootstrap-control-plane',
                DocumentFormat: 'JSON',
                UpdateMethod: 'NewVersion',
            });
        });

        it('should create a worker automation document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                DocumentType: 'Automation',
                Name: 'k8s-dev-bootstrap-worker',
                DocumentFormat: 'JSON',
                UpdateMethod: 'NewVersion',
            });
        });

        it('should have 7 steps in the control plane document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-control-plane',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({ name: 'validateGoldenAMI' }),
                        Match.objectLike({ name: 'initKubeadm' }),
                        Match.objectLike({ name: 'installCalicoCNI' }),
                        Match.objectLike({ name: 'configureKubectl' }),
                        Match.objectLike({ name: 'syncManifests' }),
                        Match.objectLike({ name: 'bootstrapArgoCD' }),
                        Match.objectLike({ name: 'verifyCluster' }),
                    ]),
                }),
            });
        });

        it('should have 2 steps in the worker document', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-worker',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({ name: 'validateGoldenAMI' }),
                        Match.objectLike({ name: 'joinCluster' }),
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

        it('should configure timeouts for each step', () => {
            template.hasResourceProperties('AWS::SSM::Document', {
                Name: 'k8s-dev-bootstrap-control-plane',
                Content: Match.objectLike({
                    mainSteps: Match.arrayWith([
                        Match.objectLike({
                            name: 'validateGoldenAMI',
                            timeoutSeconds: 60,
                        }),
                        Match.objectLike({
                            name: 'initKubeadm',
                            timeoutSeconds: 300,
                        }),
                        Match.objectLike({
                            name: 'bootstrapArgoCD',
                            timeoutSeconds: 900,
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
    });
});
