/**
 * @format
 * NextJS Compute Stack Unit Tests
 *
 * Tests for the consolidated NextJsComputeStack:
 * - ECS Cluster creation
 * - Task Execution Role with ECR/logs permissions
 * - Task Role with app-specific permissions
 * - Container Insights configuration
 * - Security configurations
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import {
    NextJsComputeStack,
    NextJsComputeStackProps,
} from '../../../../lib/stacks/nextjs/compute/compute-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper to create NextJsComputeStack for testing
 */
function createComputeStack(
    props?: Partial<NextJsComputeStackProps>,
): { stack: NextJsComputeStack; template: Template } {
    const app = createTestApp();

    // Create VPC in separate stack
    const vpcStack = new cdk.Stack(app, 'VpcStack', { env: TEST_ENV_EU });
    const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
            {
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
            },
        ],
    });

    const stack = new NextJsComputeStack(app, 'TestComputeStack', {
        env: TEST_ENV_EU,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        vpc,
        namePrefix: props?.namePrefix ?? 'nextjs',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

describe('NextJsComputeStack', () => {
    describe('ECS Cluster', () => {
        it('should create an ECS cluster', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::ECS::Cluster', 1);
        });

        it('should enable Container Insights', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::ECS::Cluster', {
                ClusterSettings: Match.arrayWith([
                    Match.objectLike({
                        Name: 'containerInsights',
                        Value: 'enabled',
                    }),
                ]),
            });
        });

        it('should create a capacity provider', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::ECS::CapacityProvider', 1);
        });
    });

    describe('IAM Roles', () => {
        it('should create EC2 instance role', () => {
            const { stack } = createComputeStack();
            expect(stack.ec2InstanceRole).toBeDefined();
        });

        it('should create task execution role', () => {
            const { stack } = createComputeStack();
            expect(stack.taskExecutionRole).toBeDefined();
        });

        it('should create task role', () => {
            const { stack } = createComputeStack();
            expect(stack.taskRole).toBeDefined();
        });

        it('should attach AmazonEC2ContainerServiceforEC2Role to instance role', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::IAM::Role', {
                ManagedPolicyArns: Match.arrayWith([
                    Match.objectLike({
                        'Fn::Join': Match.arrayWith([
                            Match.arrayWith([
                                Match.stringLikeRegexp('AmazonEC2ContainerServiceforEC2Role'),
                            ]),
                        ]),
                    }),
                ]),
            });
        });

        it('should attach AmazonECSTaskExecutionRolePolicy to execution role', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::IAM::Role', {
                ManagedPolicyArns: Match.arrayWith([
                    Match.objectLike({
                        'Fn::Join': Match.arrayWith([
                            Match.arrayWith([
                                Match.stringLikeRegexp('AmazonECSTaskExecutionRolePolicy'),
                            ]),
                        ]),
                    }),
                ]),
            });
        });
    });

    describe('SSM Parameter Access', () => {
        it('should grant SSM parameter access when path provided', () => {
            const { template } = createComputeStack({
                ssmParameterPath: '/nextjs/development/*',
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith(['ssm:GetParameters', 'ssm:GetParameter']),
                        }),
                    ]),
                }),
            });
        });
    });

    describe('S3 and DynamoDB Access', () => {
        it('should grant S3 read access when bucket ARNs provided', () => {
            const { template } = createComputeStack({
                s3ReadBucketArns: ['arn:aws:s3:::test-bucket'],
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'S3ReadAccess',
                        }),
                    ]),
                }),
            });
        });

        it('should grant DynamoDB read access with GSI when table ARNs provided', () => {
            const { template } = createComputeStack({
                dynamoTableArns: ['arn:aws:dynamodb:eu-west-1:123456789012:table/test'],
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DynamoDbReadAccess',
                            Action: Match.arrayWith(['dynamodb:Query']),
                            Resource: Match.arrayWith([
                                'arn:aws:dynamodb:eu-west-1:123456789012:table/test',
                                'arn:aws:dynamodb:eu-west-1:123456789012:table/test/index/*',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('should NOT grant DynamoDB write actions on task role (read/write boundary)', () => {
            const { template } = createComputeStack({
                dynamoTableArns: ['arn:aws:dynamodb:eu-west-1:123456789012:table/test'],
            });

            const forbiddenActions = [
                'dynamodb:PutItem',
                'dynamodb:DeleteItem',
                'dynamodb:UpdateItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:*',
            ];

            // Use CDK assertions to verify no write actions exist
            // The DynamoDbReadAccess statement should only contain read actions
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DynamoDbReadAccess',
                            Action: Match.not(Match.arrayWith([forbiddenActions[0]])),
                        }),
                    ]),
                }),
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DynamoDbReadAccess',
                            Action: Match.not(Match.arrayWith([forbiddenActions[1]])),
                        }),
                    ]),
                }),
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DynamoDbReadAccess',
                            Action: Match.not(Match.arrayWith([forbiddenActions[2]])),
                        }),
                    ]),
                }),
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DynamoDbReadAccess',
                            Action: Match.not(Match.arrayWith([forbiddenActions[3]])),
                        }),
                    ]),
                }),
            });
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DynamoDbReadAccess',
                            Action: Match.not(Match.arrayWith([forbiddenActions[4]])),
                        }),
                    ]),
                }),
            });
        });
    });

    describe('Auto Scaling Group', () => {
        it('should create an ASG', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        it('should have correct capacity settings', () => {
            const { template } = createComputeStack({
                minCapacity: 1,
                maxCapacity: 2,
            });
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: '1',
                MaxSize: '2',
            });
        });
    });

    describe('Launch Template', () => {
        it('should create a launch template', () => {
            const { template } = createComputeStack();
            template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
        });
    });

    describe('Security Group', () => {
        it('should create a security group for ECS instances', () => {
            const { stack } = createComputeStack();
            expect(stack.securityGroupConstruct).toBeDefined();
        });

        it('should expose securityGroup getter', () => {
            const { stack } = createComputeStack();
            expect(stack.securityGroup).toBeDefined();
        });
    });

    describe('Stack Properties', () => {
        it('should expose cluster property', () => {
            const { stack } = createComputeStack();
            expect(stack.cluster).toBeDefined();
        });

        it('should expose taskExecutionRole property', () => {
            const { stack } = createComputeStack();
            expect(stack.taskExecutionRole).toBeDefined();
        });

        it('should expose taskRole property', () => {
            const { stack } = createComputeStack();
            expect(stack.taskRole).toBeDefined();
        });

        it('should expose autoScalingGroup property', () => {
            const { stack } = createComputeStack();
            expect(stack.autoScalingGroup).toBeDefined();
        });

        it('should expose capacityProvider property', () => {
            const { stack } = createComputeStack();
            expect(stack.capacityProvider).toBeDefined();
        });

        it('should expose targetEnvironment property', () => {
            const { stack } = createComputeStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });
    });

    describe('SSM Parameters', () => {
        it('should create SSM parameter for cluster name', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs/development/ecs/cluster-name',
            });
        });

        it('should create SSM parameter for cluster ARN', () => {
            const { template } = createComputeStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs/development/ecs/cluster-arn',
            });
        });
    });

    describe('Stack Outputs', () => {
        it('should export cluster name', () => {
            const { template } = createComputeStack();
            template.hasOutput('ClusterName', {});
        });

        it('should export cluster ARN', () => {
            const { template } = createComputeStack();
            template.hasOutput('ClusterArn', {});
        });

        it('should export task execution role ARN', () => {
            const { template } = createComputeStack();
            template.hasOutput('TaskExecutionRoleArn', {});
        });

        it('should export task role ARN', () => {
            const { template } = createComputeStack();
            template.hasOutput('TaskRoleArn', {});
        });
    });

    describe('Helper Methods', () => {
        it('should allow granting S3 read permissions', () => {
            const { stack } = createComputeStack();
            expect(() =>
                stack.grantS3Read({ bucketArn: 'arn:aws:s3:::another-bucket' })
            ).not.toThrow();
        });

        it('should allow granting DynamoDB read permissions', () => {
            const { stack } = createComputeStack();
            expect(() =>
                stack.grantDynamoDbRead({
                    tableArn: 'arn:aws:dynamodb:eu-west-1:123456789012:table/another',
                })
            ).not.toThrow();
        });
    });
});
