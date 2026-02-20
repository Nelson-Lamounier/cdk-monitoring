/**
 * @format
 * K8sComputeStack Unit Tests
 *
 * Tests for the k3s Kubernetes compute stack.
 * Verifies SecurityGroup, IAM Role, ASG, Launch Template, EBS Volume, and Elastic IP.
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getK8sConfigs } from '../../../../lib/config/k8s';
import { K8sComputeStack } from '../../../../lib/stacks/k8s';

// Set test environment
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';

/**
 * Helper to create a K8sComputeStack for testing
 */
function createK8sComputeStack(environment: Environment = Environment.DEVELOPMENT) {
    const app = new cdk.App();
    const configs = getK8sConfigs(environment);

    const stack = new K8sComputeStack(app, `K8s-Compute-${environment}`, {
        env: { account: '123456789012', region: 'eu-west-1' },
        targetEnvironment: environment,
        configs,
        namePrefix: `k8s-${environment}`,
        ssmPrefix: `/k8s/${environment}`,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

/**
 * Extract ingress ports from the first SecurityGroup in a template
 */
function getIngressPorts(template: Template): number[] {
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const sgKeys = Object.keys(sgs);
    const mainSg = sgs[sgKeys[0]];
    const ingressRules: Array<{ FromPort: number }> = mainSg.Properties?.SecurityGroupIngress ?? [];
    return ingressRules.map((r) => r.FromPort);
}

/**
 * Extract all IAM policy actions from a template
 */
function getAllPolicyActions(template: Template): string[] {
    const policies = template.findResources('AWS::IAM::Policy');
    const allActions: string[] = [];
    for (const policy of Object.values(policies)) {
        const typedPolicy = policy as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string[] }> } } };
        const statements = typedPolicy?.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of statements) {
            allActions.push(...(stmt.Action ?? []));
        }
    }
    return allActions;
}

describe('K8sComputeStack', () => {
    describe('Security Group', () => {
        it('should create a security group', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::EC2::SecurityGroup', {});
        });

        it('should allow HTTP and HTTPS ingress', () => {
            const { template } = createK8sComputeStack();

            const ingressPorts = getIngressPorts(template);

            // Verify HTTP (80) and HTTPS (443) are in the rules
            expect(ingressPorts).toContain(80);
            expect(ingressPorts).toContain(443);
        });
    });

    describe('IAM Role', () => {
        it('should create an IAM role', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::IAM::Role', {});
        });

        it('should grant ECR pull permissions', () => {
            const { template } = createK8sComputeStack();

            const allActions = getAllPolicyActions(template);

            // Verify ECR pull actions are granted
            expect(allActions).toContain('ecr:GetDownloadUrlForLayer');
            expect(allActions).toContain('ecr:BatchGetImage');
        });
    });

    describe('Auto Scaling Group', () => {
        it('should create an ASG', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::AutoScaling::AutoScalingGroup', {});
        });

        it('should set min=1 and max=1 for single-node cluster', () => {
            const { template } = createK8sComputeStack();

            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: '1',
                MaxSize: '1',
            });
        });
    });

    describe('Launch Template', () => {
        it('should create a launch template', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::EC2::LaunchTemplate', {});
        });
    });

    describe('EBS Volume', () => {
        it('should create an EBS volume', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::EC2::Volume', {});
        });

        it('should use gp3 volume type', () => {
            const { template } = createK8sComputeStack();

            template.hasResourceProperties('AWS::EC2::Volume', {
                VolumeType: 'gp3',
                Encrypted: true,
            });
        });

        it('should use correct size for dev environment', () => {
            const { template } = createK8sComputeStack(Environment.DEVELOPMENT);

            template.hasResourceProperties('AWS::EC2::Volume', {
                Size: 30,
            });
        });
    });

    describe('Elastic IP', () => {
        it('should allocate an Elastic IP', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::EC2::EIP', {});
        });
    });

    describe('SSM Parameters', () => {
        it('should create security group ID SSM parameter', () => {
            const { template } = createK8sComputeStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/security-group-id',
                Type: 'String',
            });
        });
    });

    describe('CloudWatch', () => {
        it('should create a log group', () => {
            const { template } = createK8sComputeStack();
            template.hasResource('AWS::Logs::LogGroup', {});
        });
    });

    describe('Stack Outputs', () => {
        it('should export key outputs', () => {
            const { template } = createK8sComputeStack();

            const outputs = template.findOutputs('*');
            const outputKeys = Object.keys(outputs);

            expect(outputKeys.some(k => k.includes('InstanceRoleArn'))).toBe(true);
            expect(outputKeys.some(k => k.includes('AutoScalingGroupName'))).toBe(true);
            expect(outputKeys.some(k => k.includes('ElasticIpAddress'))).toBe(true);
            expect(outputKeys.some(k => k.includes('EbsVolumeId'))).toBe(true);
        });
    });
});
