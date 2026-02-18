/**
 * @format
 * ECS Cluster Construct Unit Tests
 *
 * Tests for reusable ECS Cluster construct with Fargate and EC2 support.
 * Blueprint pattern - construct accepts ASG from stack.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as cdk from 'aws-cdk-lib/core';

import {
    EcsClusterConstruct,
    EcsClusterConstructProps,
    EcsCapacityType,
} from '../../../../lib/common/compute/constructs/ecs/ecs-cluster';

const TEST_ENV = {
    account: '123456789012',
    region: 'eu-west-1',
};

/**
 * Helper to create test VPC
 */
function createTestVpc(stack: cdk.Stack): ec2.IVpc {
    return new ec2.Vpc(stack, 'TestVpc', {
        maxAzs: 2,
        natGateways: 0,
    });
}

/**
 * Helper to create test ASG for EC2 mode
 */
function createTestAsg(stack: cdk.Stack, vpc: ec2.IVpc): autoscaling.AutoScalingGroup {
    const sg = new ec2.SecurityGroup(stack, 'TestSG', {
        vpc,
        description: 'Test security group',
    });

    return new autoscaling.AutoScalingGroup(stack, 'TestASG', {
        vpc,
        instanceType: new ec2.InstanceType('t3.small'),
        machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
        securityGroup: sg,
        minCapacity: 0,
        maxCapacity: 2,
    });
}

/**
 * Helper to create ECS Cluster construct for testing
 */
function createEcsClusterConstruct(
    props?: Partial<EcsClusterConstructProps>,
    includeAsg?: boolean
): { construct: EcsClusterConstruct; template: Template; stack: cdk.Stack } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });
    const vpc = createTestVpc(stack);

    // Create ASG if EC2 mode requires it
    let constructProps: EcsClusterConstructProps = {
        vpc,
        ...props,
    };

    if (includeAsg || props?.capacityType === EcsCapacityType.EC2 || props?.capacityType === EcsCapacityType.HYBRID) {
        const asg = createTestAsg(stack, vpc);
        constructProps = {
            ...constructProps,
            ec2Capacity: {
                autoScalingGroup: asg,
                ...props?.ec2Capacity,
            },
        };
    }

    const construct = new EcsClusterConstruct(stack, 'TestCluster', constructProps);

    const template = Template.fromStack(stack);
    return { construct, template, stack };
}

describe('EcsClusterConstruct', () => {
    describe('Cluster Creation', () => {
        it('should create an ECS cluster', () => {
            const { template } = createEcsClusterConstruct();
            template.resourceCountIs('AWS::ECS::Cluster', 1);
        });

        it('should create cluster with specified name', () => {
            const { template } = createEcsClusterConstruct({ clusterName: 'my-cluster' });
            template.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterName: 'my-cluster',
            });
        });

        it('should enable container insights by default', () => {
            const { template } = createEcsClusterConstruct();
            template.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterSettings: Match.arrayWith([
                    Match.objectLike({
                        Name: 'containerInsights',
                        Value: 'enabled',
                    }),
                ]),
            });
        });

        it('should allow disabling container insights', () => {
            const { template } = createEcsClusterConstruct({ containerInsights: ecs.ContainerInsights.DISABLED });
            template.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterSettings: Match.arrayWith([
                    Match.objectLike({
                        Name: 'containerInsights',
                        Value: 'disabled',
                    }),
                ]),
            });
        });
    });

    describe('Fargate Capacity (Default)', () => {
        it('should use FARGATE capacity provider by default', () => {
            const { template } = createEcsClusterConstruct();
            template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
                CapacityProviders: Match.arrayWith(['FARGATE']),
            });
        });

        it('should include FARGATE_SPOT when enabled', () => {
            // Note: This test verifies FARGATE_SPOT is in the list of providers
            // The actual default strategy behavior is managed by CDK
            const { template } = createEcsClusterConstruct({ 
                enableFargateSpot: true,
                capacityType: EcsCapacityType.FARGATE,
            });
            template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
                CapacityProviders: Match.arrayWith(['FARGATE_SPOT']),
            });
        });
    });

    describe('EC2 Capacity', () => {
        it('should require ASG for EC2 mode', () => {
            const app = new cdk.App();
            const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });
            const vpc = new ec2.Vpc(stack, 'TestVpc', { maxAzs: 2, natGateways: 0 });

            expect(() => {
                new EcsClusterConstruct(stack, 'TestCluster', {
                    vpc,
                    capacityType: EcsCapacityType.EC2,
                    // No ec2Capacity provided - should throw
                });
            }).toThrow('ec2Capacity with autoScalingGroup is required');
        });

        it('should create EC2 capacity provider when ASG provided', () => {
            const { template } = createEcsClusterConstruct({
                capacityType: EcsCapacityType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::CapacityProvider', {
                AutoScalingGroupProvider: Match.objectLike({
                    ManagedScaling: Match.objectLike({
                        Status: 'ENABLED',
                    }),
                }),
            });
        });

        it('should expose ec2CapacityProvider property', () => {
            const { construct } = createEcsClusterConstruct({
                capacityType: EcsCapacityType.EC2,
            });
            expect(construct.ec2CapacityProvider).toBeDefined();
        });
    });

    describe('Execute Command Configuration', () => {
        it('should create KMS key when execute command is enabled', () => {
            const { template } = createEcsClusterConstruct({
                executeCommand: { enabled: true },
            });
            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
            });
        });

        it('should create log group when execute command is enabled', () => {
            const { template } = createEcsClusterConstruct({
                executeCommand: { enabled: true },
            });
            template.hasResource('AWS::Logs::LogGroup', {});
        });

        it('should configure cluster with execute command logging', () => {
            const { template } = createEcsClusterConstruct({
                executeCommand: { enabled: true },
            });
            template.hasResourceProperties('AWS::ECS::Cluster', {
                Configuration: Match.objectLike({
                    ExecuteCommandConfiguration: Match.objectLike({
                        Logging: 'OVERRIDE',
                    }),
                }),
            });
        });

        it('should expose executeCommandKmsKey property', () => {
            const { construct } = createEcsClusterConstruct({
                executeCommand: { enabled: true },
            });
            expect(construct.executeCommandKmsKey).toBeDefined();
        });

        it('should expose executeCommandLogGroup property', () => {
            const { construct } = createEcsClusterConstruct({
                executeCommand: { enabled: true },
            });
            expect(construct.executeCommandLogGroup).toBeDefined();
        });
    });

    describe('Hybrid Capacity', () => {
        it('should support both Fargate and EC2', () => {
            const { template } = createEcsClusterConstruct({
                capacityType: EcsCapacityType.HYBRID,
            });
            template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
                CapacityProviders: Match.arrayWith(['FARGATE']),
            });
            template.hasResourceProperties('AWS::ECS::CapacityProvider', {});
        });
    });

    describe('Construct Properties', () => {
        it('should expose cluster property', () => {
            const { construct } = createEcsClusterConstruct();
            expect(construct.cluster).toBeDefined();
            expect(construct.cluster.clusterName).toBeDefined();
        });

        it('should expose clusterArn property', () => {
            const { construct } = createEcsClusterConstruct();
            expect(construct.clusterArn).toBeDefined();
        });

        it('should expose executionRole property', () => {
            const { construct } = createEcsClusterConstruct();
            expect(construct.executionRole).toBeDefined();
        });
    });

    describe('Security', () => {
        it('should create execution role for tasks', () => {
            const { template } = createEcsClusterConstruct();
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: Match.objectLike({
                                Service: 'ecs-tasks.amazonaws.com',
                            }),
                        }),
                    ]),
                }),
            });
        });
    });
});
