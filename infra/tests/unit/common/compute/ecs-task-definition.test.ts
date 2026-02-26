/**
 * @format
 * ECS Task Definition Construct Unit Tests
 *
 * Tests for unified ECS Task Definition construct supporting both Fargate and EC2.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib/core';

import {
    EcsTaskDefinitionConstruct,
    EcsTaskDefinitionConstructProps,
    EcsLaunchType,
} from '../../../../lib/common/compute/constructs/ecs/ecs-task-definition';

const TEST_ENV = {
    account: '123456789012',
    region: 'eu-west-1',
};

/**
 * Helper to create test ECR repository
 */
function createTestRepository(stack: cdk.Stack): ecr.IRepository {
    return new ecr.Repository(stack, 'TestRepo', {
        repositoryName: 'test-repo',
    });
}

/**
 * Helper to create ECS Task Definition construct for testing
 */
function createEcsTaskDefinitionConstruct(
    props?: Partial<EcsTaskDefinitionConstructProps>
): { construct: EcsTaskDefinitionConstruct; template: Template; stack: cdk.Stack } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });
    const repository = createTestRepository(stack);

    const construct = new EcsTaskDefinitionConstruct(stack, 'TestTaskDef', {
        family: 'test-task',
        containerName: 'app',
        repository,
        imageTag: 'abc123',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { construct, template, stack };
}

describe('EcsTaskDefinitionConstruct', () => {
    describe('Fargate Launch Type (default)', () => {
        it('should create a Fargate task definition by default', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                RequiresCompatibilities: ['FARGATE'],
            });
        });

        it('should use awsvpc network mode', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                NetworkMode: 'awsvpc',
            });
        });

        it('should set CPU and memory at task level for Fargate', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                cpu: 512,
                memoryMiB: 1024,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                Cpu: '512',
                Memory: '1024',
            });
        });
    });

    describe('EC2 Launch Type', () => {
        it('should create an EC2 task definition when specified', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                RequiresCompatibilities: ['EC2'],
            });
        });

        it('should use awsvpc network mode for EC2', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                NetworkMode: 'awsvpc',
            });
        });

        it('should enable read-only root filesystem by default for EC2', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        ReadonlyRootFilesystem: true,
                    }),
                ]),
            });
        });

        it('should run as non-root user (1001) by default for EC2', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        User: '1001',
                    }),
                ]),
            });
        });

        it('should disable privileged mode by default for EC2', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Privileged: false,
                    }),
                ]),
            });
        });

        it('should create tmpfs via LinuxParameters when configured for EC2', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
                tmpfsVolumes: [
                    { containerPath: '/app/.next/cache', size: 128 },
                ],
            });
            // HIGH-3: tmpfs now uses LinuxParameters.addTmpfs (not host volumes)
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        LinuxParameters: Match.objectLike({
                            Tmpfs: Match.arrayWith([
                                Match.objectLike({
                                    ContainerPath: '/app/.next/cache',
                                    Size: 128,
                                }),
                            ]),
                        }),
                    }),
                ]),
            });
        });

        it('should set CPU and memory at container level for EC2', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
                cpu: 512,
                memoryMiB: 1024,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Cpu: 512,
                        Memory: 1024,
                    }),
                ]),
            });
        });

        it('should enable init process by default (HIGH-5)', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        LinuxParameters: Match.objectLike({
                            InitProcessEnabled: true,
                        }),
                    }),
                ]),
            });
        });

        it('should drop all capabilities by default (HIGH-4)', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        LinuxParameters: Match.objectLike({
                            Capabilities: Match.objectLike({
                                Drop: ['ALL'],
                            }),
                        }),
                    }),
                ]),
            });
        });

        it('should configure stop timeout (MEDIUM-1)', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                stopTimeoutSeconds: 60,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        StopTimeout: 60,
                    }),
                ]),
            });
        });

        it('should configure NOFILE ulimit (MEDIUM-4)', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                nofileLimit: 32768,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Ulimits: Match.arrayWith([
                            Match.objectLike({
                                Name: 'nofile',
                                SoftLimit: 32768,
                                HardLimit: 32768,
                            }),
                        ]),
                    }),
                ]),
            });
        });
    });

    describe('Container Configuration', () => {
        it('should create container with specified name', () => {
            const { template } = createEcsTaskDefinitionConstruct({ containerName: 'frontend' });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Name: 'frontend',
                    }),
                ]),
            });
        });

        it('should configure container port mapping', () => {
            const { template } = createEcsTaskDefinitionConstruct({ containerPort: 3000 });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        PortMappings: Match.arrayWith([
                            Match.objectLike({
                                ContainerPort: 3000,
                                Protocol: 'tcp',
                            }),
                        ]),
                    }),
                ]),
            });
        });

        it('should use default port 3000 when not specified', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        PortMappings: Match.arrayWith([
                            Match.objectLike({
                                ContainerPort: 3000,
                            }),
                        ]),
                    }),
                ]),
            });
        });
    });

    describe('Logging', () => {
        it('should configure CloudWatch logging', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        LogConfiguration: Match.objectLike({
                            LogDriver: 'awslogs',
                        }),
                    }),
                ]),
            });
        });

        it('should create CloudWatch log group', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResource('AWS::Logs::LogGroup', {});
        });

        it('should support KMS encryption for log group', () => {
            const app = new cdk.App();
            const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });
            const repository = createTestRepository(stack);
            const kmsKey = new kms.Key(stack, 'TestKey');

            new EcsTaskDefinitionConstruct(stack, 'TestTaskDef', {
                family: 'test-task',
                containerName: 'app',
                repository,
                imageTag: 'abc123',
                logGroupKmsKey: kmsKey,
            });

            const template = Template.fromStack(stack);
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                KmsKeyId: Match.anyValue(),
            });
        });
    });

    describe('Health Check', () => {
        it('should configure health check when provided', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                healthCheck: {
                    command: ['CMD-SHELL', 'curl -f http://localhost:3000/api/health || exit 1'],
                    interval: 30,
                    timeout: 5,
                    retries: 3,
                    startPeriod: 60,
                },
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        HealthCheck: Match.objectLike({
                            Command: Match.arrayWith(['CMD-SHELL']),
                            Interval: 30,
                            Timeout: 5,
                            Retries: 3,
                            StartPeriod: 60,
                        }),
                    }),
                ]),
            });
        });
    });

    describe('IAM Roles', () => {
        it('should create execution role', () => {
            const { template } = createEcsTaskDefinitionConstruct();
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

        it('should create task role', () => {
            const { construct } = createEcsTaskDefinitionConstruct();
            expect(construct.taskRole).toBeDefined();
        });
    });

    describe('Construct Properties', () => {
        it('should expose taskDefinition property', () => {
            const { construct } = createEcsTaskDefinitionConstruct();
            expect(construct.taskDefinition).toBeDefined();
        });

        it('should expose containerName property', () => {
            const { construct } = createEcsTaskDefinitionConstruct({ containerName: 'app' });
            expect(construct.containerName).toBe('app');
        });

        it('should expose containerPort property', () => {
            const { construct } = createEcsTaskDefinitionConstruct({ containerPort: 3000 });
            expect(construct.containerPort).toBe(3000);
        });

        it('should expose launchType property', () => {
            const { construct: fargateConstruct } = createEcsTaskDefinitionConstruct();
            expect(fargateConstruct.launchType).toBe(EcsLaunchType.FARGATE);

            const { construct: ec2Construct } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            expect(ec2Construct.launchType).toBe(EcsLaunchType.EC2);
        });
    });

    describe('Tags', () => {
        it('should add Component tag', () => {
            const { template } = createEcsTaskDefinitionConstruct();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'Component', Value: 'ECS-TaskDefinition' }),
                ]),
            });
        });

        it('should add LaunchType tag', () => {
            const { template } = createEcsTaskDefinitionConstruct({
                launchType: EcsLaunchType.EC2,
            });
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'LaunchType', Value: 'EC2' }),
                ]),
            });
        });
    });
});
