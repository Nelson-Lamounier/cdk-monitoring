/**
 * @format
 * NextJS Application Stack Unit Tests
 *
 * Tests for the consolidated NextJsApplicationStack:
 * - Task Definition creation
 * - ECS Service creation
 * - Auto-Deploy Lambda (when enabled)
 * - Log group configuration
 *
 * Note: This stack requires many dependencies (VPC, cluster, ALB, repository, etc.)
 * Uses a helper stack to provide imported resources.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../../../lib/config';
import {
    NextJsApplicationStack,
    NextJsApplicationStackProps,
} from '../../../../lib/stacks/nextjs/application/application-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper stack that provides imported resources for the application stack.
 * This avoids cyclic dependencies by using fromXxx import methods.
 */
class ImportedResourcesProvider extends cdk.Stack {
    public readonly vpc: ec2.IVpc;
    public readonly cluster: ecs.ICluster;
    public readonly targetGroup: elbv2.IApplicationTargetGroup;
    public readonly taskExecutionRole: iam.IRole;
    public readonly taskRole: iam.IRole;
    public readonly taskSecurityGroup: ec2.ISecurityGroup;

    constructor(scope: Construct, id: string) {
        super(scope, id, { env: TEST_ENV_EU });

        this.vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
            vpcId: 'vpc-12345678',
            availabilityZones: ['eu-west-1a', 'eu-west-1b'],
            publicSubnetIds: ['subnet-1', 'subnet-2'],
        });

        // NOTE: ECR repository is now imported via SSM in the Application stack
        // No repository prop needed in tests

        this.cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
            clusterName: 'test-cluster',
            clusterArn: 'arn:aws:ecs:eu-west-1:123456789012:cluster/test-cluster',
            vpc: this.vpc,
            securityGroups: [],
        });

        this.targetGroup = elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(
            this,
            'ImportedTg',
            {
                targetGroupArn:
                    'arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup/test-tg/1234567890',
            }
        );

        this.taskExecutionRole = iam.Role.fromRoleArn(
            this,
            'ImportedExecRole',
            'arn:aws:iam::123456789012:role/test-exec-role',
            { mutable: false }
        );

        this.taskRole = iam.Role.fromRoleArn(
            this,
            'ImportedTaskRole',
            'arn:aws:iam::123456789012:role/test-task-role',
            { mutable: false }
        );

        this.taskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
            this,
            'ImportedTaskSg',
            'sg-12345678'
        );
    }
}

/**
 * Helper to create NextJsApplicationStack with imported dependencies
 */
function createApplicationStack(
    props?: Partial<NextJsApplicationStackProps>,
): { stack: NextJsApplicationStack; template: Template } {
    const app = createTestApp();

    // Create helper stack that provides imported resources
    const resources = new ImportedResourcesProvider(app, 'Resources');

    const stack = new NextJsApplicationStack(app, 'TestApplicationStack', {
        env: TEST_ENV_EU,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        vpc: resources.vpc,
        // ECR is discovered via SSM: /shared/ecr/{env}/repository-arn
        imageTag: props?.imageTag ?? 'latest',
        cluster: resources.cluster,
        targetGroup: resources.targetGroup,
        taskExecutionRole: resources.taskExecutionRole,
        taskRole: resources.taskRole,
        taskSecurityGroup: resources.taskSecurityGroup,
        namePrefix: props?.namePrefix ?? 'nextjs',
        autoDeploy: props?.autoDeploy,
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

describe('NextJsApplicationStack', () => {
    describe('ECS Task Definition', () => {
        it('should create a task definition', () => {
            const { template } = createApplicationStack();
            template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
        });

        it('should use EC2 compatibility', () => {
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                RequiresCompatibilities: Match.arrayWith(['EC2']),
            });
        });

        it('should define container definition', () => {
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                ContainerDefinitions: Match.arrayWith([
                    Match.objectLike({
                        Essential: true,
                    }),
                ]),
            });
        });

        it('should use awsvpc network mode', () => {
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::ECS::TaskDefinition', {
                NetworkMode: 'awsvpc',
            });
        });
    });

    describe('ECS Service', () => {
        it('should create an ECS service', () => {
            const { template } = createApplicationStack();
            template.resourceCountIs('AWS::ECS::Service', 1);
        });

        it('should use EC2 launch type', () => {
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::ECS::Service', {
                LaunchType: 'EC2',
            });
        });

        it('should attach to target group', () => {
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::ECS::Service', {
                LoadBalancers: Match.arrayWith([
                    Match.objectLike({
                        ContainerPort: 3000,
                    }),
                ]),
            });
        });

        it('should have deployment configuration with circuit breaker matching environment config', () => {
            // Dev environment has enableCircuitBreaker: false for faster iteration
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::ECS::Service', {
                DeploymentConfiguration: Match.objectLike({
                    DeploymentCircuitBreaker: Match.objectLike({
                        Enable: false,
                        Rollback: false,
                    }),
                }),
            });
        });
    });

    describe('Log Groups', () => {
        it('should create a log group for the container', () => {
            const { template } = createApplicationStack();
            const logGroups = template.findResources('AWS::Logs::LogGroup');
            expect(Object.keys(logGroups).length).toBeGreaterThan(0);
        });
    });

    describe('Auto-Deploy', () => {
        it('should create auto-deploy Lambda when enabled', () => {
            const { template } = createApplicationStack({
                autoDeploy: { enabled: true },
            });
            const lambdas = template.findResources('AWS::Lambda::Function');
            expect(Object.keys(lambdas).length).toBeGreaterThan(0);
        });

        it('should create EventBridge rule when auto-deploy enabled', () => {
            const { template } = createApplicationStack({
                autoDeploy: { enabled: true },
            });
            const rules = template.findResources('AWS::Events::Rule');
            expect(Object.keys(rules).length).toBeGreaterThan(0);
        });

        it('should NOT create auto-deploy resources when disabled', () => {
            const { stack } = createApplicationStack({
                autoDeploy: { enabled: false },
            });
            expect(stack.autoDeployLambda).toBeUndefined();
            expect(stack.autoDeployRule).toBeUndefined();
        });
    });

    describe('Stack Properties', () => {
        it('should expose taskDefinitionConstruct property', () => {
            const { stack } = createApplicationStack();
            expect(stack.taskDefinitionConstruct).toBeDefined();
        });

        it('should expose serviceConstruct property', () => {
            const { stack } = createApplicationStack();
            expect(stack.serviceConstruct).toBeDefined();
        });

        it('should expose service getter', () => {
            const { stack } = createApplicationStack();
            expect(stack.service).toBeDefined();
        });

        it('should expose targetEnvironment property', () => {
            const { stack } = createApplicationStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });
    });

    describe('SSM Parameters', () => {
        it('should create SSM parameter for service name', () => {
            const { template } = createApplicationStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs/development/ecs/service-name',
            });
        });
    });

    describe('Stack Outputs', () => {
        it('should export service name', () => {
            const { template } = createApplicationStack();
            template.hasOutput('ServiceName', {});
        });

        it('should export task definition ARN', () => {
            const { template } = createApplicationStack();
            template.hasOutput('TaskDefinitionArn', {});
        });
    });
});
