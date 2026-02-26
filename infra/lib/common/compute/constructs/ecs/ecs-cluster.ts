/**
 * @format
 * ECS Cluster Construct
 *
 * Reusable ECS Cluster construct supporting both Fargate and EC2 launch types.
 * Follows blueprint pattern - accepts ASG from stack, does not create internally.
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { EcsCapacityType } from '../../../../config/defaults';
import { Environment } from '../../../../config/environments';

// Re-export for convenience
export { EcsCapacityType } from '../../../../config/defaults';

/**
 * Execute command configuration
 */
export interface ExecuteCommandConfig {
    /** Enable execute command with logging @default false */
    readonly enabled?: boolean;
    /** Use KMS encryption for logging @default true when enabled */
    readonly useKmsEncryption?: boolean;
    /** Existing KMS key to use (creates new if not provided) */
    readonly kmsKey?: kms.IKey;
    /** Existing log group to use (creates new if not provided) */
    readonly logGroup?: logs.ILogGroup;
    /** Log retention days @default ONE_MONTH */
    readonly logRetentionDays?: logs.RetentionDays;
}

/**
 * EC2 capacity configuration
 */
export interface Ec2CapacityConfig {
    /** Auto Scaling Group to use for EC2 capacity (required for EC2/HYBRID mode) */
    readonly autoScalingGroup: autoscaling.IAutoScalingGroup;
    /** Capacity provider name @default auto-generated */
    readonly capacityProviderName?: string;
    /** Enable managed scaling @default true */
    readonly enableManagedScaling?: boolean;
    /** Target capacity percent @default 100 */
    readonly targetCapacityPercent?: number;
}

/**
 * Props for EcsClusterConstruct
 */
export interface EcsClusterConstructProps {
    /** VPC for the cluster */
    readonly vpc: ec2.IVpc;
    /** Cluster name @default auto-generated */
    readonly clusterName?: string;
    /** Capacity type @default FARGATE */
    readonly capacityType?: EcsCapacityType;
    /** Enable Container Insights @default ENABLED */
    readonly containerInsights?: ecs.ContainerInsights;
    /** Enable FARGATE_SPOT capacity provider @default false */
    readonly enableFargateSpot?: boolean;
    /** EC2 capacity configuration (required for EC2 or HYBRID mode) */
    readonly ec2Capacity?: Ec2CapacityConfig;
    /** Execute command configuration */
    readonly executeCommand?: ExecuteCommandConfig;
    /** Target environment @default DEV */
    readonly environment?: Environment;
    /** Resource name prefix @default 'nextjs' */
    readonly namePrefix?: string;
}

/**
 * Reusable ECS Cluster construct supporting both Fargate and EC2.
 *
 * Follows blueprint pattern:
 * - Stack creates LaunchTemplate and ASG
 * - Stack passes ASG to this construct
 * - Construct handles ECS-specific configuration
 *
 * Features:
 * - Fargate, EC2, or Hybrid capacity modes
 * - Fargate Spot and EC2 Spot support
 * - Container Insights enabled by default
 * - Execute command with optional KMS encryption
 * - Execution role for tasks
 *
 * @example
 * ```typescript
 * // Stack creates ASG first
 * const launchTemplate = new LaunchTemplateConstruct(this, 'LT', {
 *     securityGroup,
 *     machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
 *     additionalManagedPolicies: [
 *         iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
 *     ],
 * });
 *
 * const asg = new AutoScalingGroupConstruct(this, 'ASG', {
 *     vpc,
 *     launchTemplate: launchTemplate.launchTemplate,
 * });
 *
 * // Then passes ASG to ECS Cluster
 * const cluster = new EcsClusterConstruct(this, 'Cluster', {
 *     vpc,
 *     capacityType: EcsCapacityType.EC2,
 *     ec2Capacity: { autoScalingGroup: asg.autoScalingGroup },
 *     executeCommand: { enabled: true },
 * });
 * ```
 */
export class EcsClusterConstruct extends Construct {
    /** The ECS cluster */
    public readonly cluster: ecs.Cluster;
    /** Default execution role for tasks */
    public readonly executionRole: iam.Role;
    /** EC2 capacity provider (if EC2 capacity enabled) */
    public readonly ec2CapacityProvider?: ecs.AsgCapacityProvider;
    /** KMS key for execute command (if enabled) */
    public readonly executeCommandKmsKey?: kms.IKey;
    /** Log group for execute command (if enabled) */
    public readonly executeCommandLogGroup?: logs.ILogGroup;

    constructor(scope: Construct, id: string, props: EcsClusterConstructProps) {
        super(scope, id);

        const environment = props.environment ?? Environment.DEVELOPMENT;
        const namePrefix = props.namePrefix ?? 'nextjs';
        const containerInsights = props.containerInsights ?? ecs.ContainerInsights.ENABLED;
        const capacityType = props.capacityType ?? EcsCapacityType.FARGATE;
        const enableFargateSpot = props.enableFargateSpot ?? false;

        // Validate EC2 config is provided when needed
        if ((capacityType === EcsCapacityType.EC2 || capacityType === EcsCapacityType.HYBRID) && !props.ec2Capacity) {
            throw new Error('ec2Capacity with autoScalingGroup is required for EC2 or HYBRID capacity types');
        }

        // Generate cluster name if not provided
        const clusterName = props.clusterName ?? `${namePrefix}-cluster-${environment}`;

        // Determine if Fargate capacity providers should be enabled
        const enableFargate = capacityType === EcsCapacityType.FARGATE || capacityType === EcsCapacityType.HYBRID;

        // Build execute command configuration
        let executeCommandConfig: ecs.ExecuteCommandConfiguration | undefined;
        if (props.executeCommand?.enabled) {
            const useKms = props.executeCommand.useKmsEncryption ?? true;

            // KMS key with least-privilege policy (no kms:*)
            if (useKms) {
                this.executeCommandKmsKey = props.executeCommand.kmsKey ?? new kms.Key(this, 'ExecuteCommandKey', {
                    alias: `${namePrefix}-ecs-exec-${environment}`,
                    description: `KMS key for ECS execute command (${namePrefix})`,
                    enableKeyRotation: true,
                    removalPolicy: environment === Environment.DEVELOPMENT
                        ? cdk.RemovalPolicy.DESTROY
                        : cdk.RemovalPolicy.RETAIN,
                    // Least-privilege key policy (replaces CDK default kms:*)
                    policy: new iam.PolicyDocument({
                        statements: [
                            // Allow key administration to account root
                            new iam.PolicyStatement({
                                sid: 'AllowKeyAdministration',
                                actions: [
                                    'kms:Create*', 'kms:Describe*', 'kms:Enable*',
                                    'kms:List*', 'kms:Put*', 'kms:Update*',
                                    'kms:Revoke*', 'kms:Disable*', 'kms:Get*',
                                    'kms:Delete*', 'kms:TagResource', 'kms:UntagResource',
                                    'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
                                ],
                                principals: [new iam.AccountRootPrincipal()],
                                resources: ['*'],
                            }),
                            // Allow key usage for ECS and CloudWatch Logs
                            new iam.PolicyStatement({
                                sid: 'AllowKeyUsage',
                                actions: [
                                    'kms:Decrypt', 'kms:DescribeKey',
                                    'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*',
                                ],
                                principals: [
                                    new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
                                    new iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.amazonaws.com`),
                                ],
                                resources: ['*'],
                            }),
                        ],
                    }),
                });
            }

            // Log group
            this.executeCommandLogGroup = props.executeCommand.logGroup ?? new logs.LogGroup(this, 'ExecuteCommandLogs', {
                logGroupName: `/ecs/${namePrefix}/execute-command`,
                retention: props.executeCommand.logRetentionDays ?? logs.RetentionDays.ONE_MONTH,
                encryptionKey: this.executeCommandKmsKey as kms.Key,
                removalPolicy: environment === Environment.DEVELOPMENT
                    ? cdk.RemovalPolicy.DESTROY
                    : cdk.RemovalPolicy.RETAIN,
            });

            executeCommandConfig = {
                kmsKey: this.executeCommandKmsKey as kms.Key,
                logConfiguration: {
                    cloudWatchLogGroup: this.executeCommandLogGroup as logs.LogGroup,
                    cloudWatchEncryptionEnabled: useKms,
                },
                logging: ecs.ExecuteCommandLogging.OVERRIDE,
            };
        }

        // Create cluster with Container Insights
        this.cluster = new ecs.Cluster(this, 'Cluster', {
            vpc: props.vpc,
            clusterName,
            containerInsightsV2: containerInsights,
            enableFargateCapacityProviders: enableFargate,
            executeCommandConfiguration: executeCommandConfig,
        });

        // Setup Fargate capacity provider strategy
        if (enableFargate) {
            const fargateStrategy: ecs.CapacityProviderStrategy[] = enableFargateSpot
                ? [
                    { capacityProvider: 'FARGATE_SPOT', weight: 2 },
                    { capacityProvider: 'FARGATE', weight: 1 },
                ]
                : [{ capacityProvider: 'FARGATE', weight: 1 }];

            // Must pass entire strategy array at once - CDK only allows one call
            this.cluster.addDefaultCapacityProviderStrategy(fargateStrategy);
        }

        // Setup EC2 capacity if provided
        if (props.ec2Capacity) {
            const ec2Config = props.ec2Capacity;
            const capacityProviderName = ec2Config.capacityProviderName ?? `${namePrefix}-ec2-provider-${environment}`;

            // Create EC2 capacity provider from the provided ASG
            this.ec2CapacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
                autoScalingGroup: ec2Config.autoScalingGroup as autoscaling.AutoScalingGroup,
                capacityProviderName,
                enableManagedScaling: ec2Config.enableManagedScaling ?? true,
                enableManagedTerminationProtection: false,
                targetCapacityPercent: ec2Config.targetCapacityPercent ?? 100,
            });

            // Add capacity provider to cluster
            this.cluster.addAsgCapacityProvider(this.ec2CapacityProvider);

            // Add to default strategy if EC2-only
            if (capacityType === EcsCapacityType.EC2) {
                this.cluster.addDefaultCapacityProviderStrategy([{
                    capacityProvider: this.ec2CapacityProvider.capacityProviderName,
                    weight: 1,
                }]);
            }
        }

        // Create execution role for tasks
        this.executionRole = new iam.Role(this, 'ExecutionRole', {
            roleName: `${namePrefix}-ecs-execution-${environment}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
            description: `ECS task execution role for ${namePrefix} cluster`,
        });

        // Apply tags
        cdk.Tags.of(this.cluster).add('Environment', environment);
        cdk.Tags.of(this.cluster).add('Application', 'NextJS');
        cdk.Tags.of(this.cluster).add('ManagedBy', 'CDK');
        cdk.Tags.of(this.cluster).add('CapacityType', capacityType);
    }

    /**
     * Get the cluster ARN
     */
    get clusterArn(): string {
        return this.cluster.clusterArn;
    }

    /**
     * Get the cluster name
     */
    get clusterName(): string {
        return this.cluster.clusterName;
    }

    /**
     * Grant KMS decrypt permissions to a role (for execute command)
     */
    grantExecuteCommandKmsDecrypt(grantee: iam.IGrantable): void {
        if (this.executeCommandKmsKey) {
            this.executeCommandKmsKey.grantDecrypt(grantee);
        }
    }
}
