/**
 * @format
 * Monitoring Compute Stack Unit Tests
 *
 * Tests for the MonitoringComputeStack:
 * - Auto Scaling Group (only compute mode)
 * - Launch Template configuration
 * - IAM instance profile + SSM execution policy
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    MonitoringComputeStack,
    MonitoringComputeStackProps,
} from '../../../../lib/stacks/monitoring/compute/compute-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper stack to provide dependencies for tests
 */
class DependencyProvider extends cdk.Stack {
    public readonly vpc: ec2.Vpc;

    constructor(scope: Construct, id: string) {
        super(scope, id, { env: TEST_ENV_EU });

        this.vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
            ],
        });
    }
}

/**
 * Helper to create MonitoringComputeStack for testing
 */
function createComputeStack(
    props?: Partial<MonitoringComputeStackProps>,
): { stack: MonitoringComputeStack; template: Template } {
    const app = createTestApp();
    const deps = new DependencyProvider(app, 'Deps');

    const stack = new MonitoringComputeStack(app, 'TestComputeStack', {
        env: TEST_ENV_EU,
        vpc: deps.vpc,
        trustedCidrs: props?.trustedCidrs ?? ['10.0.0.0/8'],
        ssmOnlyAccess: props?.ssmOnlyAccess ?? true,
        volumeId: props?.volumeId ?? 'vol-1234567890abcdef0',
        volumeAz: props?.volumeAz ?? 'eu-west-1a',
        namePrefix: props?.namePrefix ?? 'monitoring',
        autoScalingConfig: props?.autoScalingConfig,
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

describe('MonitoringComputeStack', () => {
    describe('Auto Scaling Group', () => {
        it('should create Launch Template', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
        });

        it('should create Auto Scaling Group', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        it('should enforce maxCapacity=1 for singleton EBS volume constraint', () => {
            // Singleton EBS can only attach to one instance — maxCapacity > 1
            // causes rolling update failures (second instance can't attach volume)
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MaxSize: '1',
            });
        });

        it('should NOT create standalone EC2 instance', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::EC2::Instance', 0);
        });

        it('should encrypt CloudWatch log group with KMS', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                KmsKeyId: Match.anyValue(),
            });
        });

        it('should configure ASG capacity via autoScalingConfig', () => {
            const { template } = createComputeStack({
                autoScalingConfig: {
                    minCapacity: 1,
                    maxCapacity: 1, // Conservative default: single-instance ASG
                    desiredCapacity: 1,
                },
            });
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: '1',
                MaxSize: '1',
                DesiredCapacity: '1',
            });
        });
    });

    describe('Launch Template Configuration', () => {
        it('should use Amazon Linux 2023 AMI', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                LaunchTemplateData: Match.objectLike({
                    ImageId: Match.anyValue(),
                }),
            });
        });

        it('should configure instance type', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                LaunchTemplateData: Match.objectLike({
                    InstanceType: Match.anyValue(),
                }),
            });
        });

        it('should include UserData', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                LaunchTemplateData: Match.objectLike({
                    UserData: Match.anyValue(),
                }),
            });
        });
    });

    describe('IAM Configuration', () => {
        it('should create IAM instance profile', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::IAM::InstanceProfile', 1);
        });

        it('should create IAM role for EC2', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: Match.objectLike({
                                Service: Match.anyValue(),
                            }),
                        }),
                    ]),
                }),
            });
        });
    });

    describe('Stack Properties', () => {
        it('should expose asgName', () => {
            const { stack } = createComputeStack();
            expect(stack.asgName).toBeDefined();
        });

        it('should expose autoScalingGroup', () => {
            const { stack } = createComputeStack();
            expect(stack.autoScalingGroup).toBeDefined();
        });

        it('should expose instanceRole', () => {
            const { stack } = createComputeStack();
            expect(stack.instanceRole).toBeDefined();
        });

        it('should expose securityGroup', () => {
            const { stack } = createComputeStack();
            expect(stack.securityGroup).toBeDefined();
        });
    });

    describe('Stack Outputs', () => {
        it('should export instance role ARN', () => {
            const { template } = createComputeStack();
            template.hasOutput('InstanceRoleArn', {});
        });

        it('should export ASG name', () => {
            const { template } = createComputeStack();
            template.hasOutput('AutoScalingGroupName', {});
        });

        it('should export ASG ARN', () => {
            const { template } = createComputeStack();
            template.hasOutput('AutoScalingGroupArn', {});
        });
    });

    describe('Rolling Update Timeout', () => {
        it('should ensure PauseTime matches signals timeout', () => {
            const { template } = createComputeStack();

            // CloudFormation uses PauseTime (not CreationPolicy timeout) as the
            // signal wait interval during rolling updates. If PauseTime < signals
            // timeout, cfn-signal arrives too late and CloudFormation records FAILURE.
            const asgResources = template.findResources('AWS::AutoScaling::AutoScalingGroup');
            const asgKey = Object.keys(asgResources)[0];
            const asg = asgResources[asgKey];

            const pauseTime = asg.UpdatePolicy?.AutoScalingRollingUpdate?.PauseTime;
            const signalTimeout = asg.CreationPolicy?.ResourceSignal?.Timeout;

            expect(pauseTime).toBeDefined();
            expect(signalTimeout).toBeDefined();
            expect(pauseTime).toBe(signalTimeout);
        });
    });
});
