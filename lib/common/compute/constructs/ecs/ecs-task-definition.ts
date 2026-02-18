/**
 * @format
 * ECS Task Definition Construct
 *
 * Unified ECS Task Definition construct supporting both Fargate and EC2 launch types.
 * Includes security hardening options for EC2 launch type.
 */

import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { EcsLaunchType } from '../../../../config/defaults';
import { Environment } from '../../../../config/environments';

// Re-export for convenience
export { EcsLaunchType } from '../../../../config/defaults';

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
    /** Health check command */
    readonly command: string[];
    /** Interval in seconds @default 30 */
    readonly interval?: number;
    /** Timeout in seconds @default 5 */
    readonly timeout?: number;
    /** Number of retries @default 3 */
    readonly retries?: number;
    /** Start period in seconds @default 60 */
    readonly startPeriod?: number;
}

/**
 * Tmpfs volume configuration (EC2 only)
 */
export interface TmpfsVolumeConfig {
    /** Container path for tmpfs mount */
    readonly containerPath: string;
    /** Size in MiB @default 128 */
    readonly size?: number;
}

/**
 * Props for EcsTaskDefinitionConstruct
 */
export interface EcsTaskDefinitionConstructProps {
    /** Task definition family name */
    readonly family: string;
    /** Container name */
    readonly containerName: string;
    /** ECR repository for container image */
    readonly repository: ecr.IRepository;
    /** Image tag @default 'latest' */
    readonly imageTag: string;
    /** Launch type @default FARGATE */
    readonly launchType?: EcsLaunchType;
    /** Container port @default 3000 */
    readonly containerPort?: number;
    /** CPU units @default 256 */
    readonly cpu?: number;
    /** Memory in MiB @default 512 */
    readonly memoryMiB?: number;
    /** Container environment variables */
    readonly containerEnvironment?: Record<string, string>;
    /** Health check configuration */
    readonly healthCheck?: HealthCheckConfig;
    /** Target environment @default DEV */
    readonly environment?: Environment;
    /** Resource name prefix */
    readonly namePrefix?: string;
    /** Log retention days @default 30 */
    readonly logRetentionDays?: number;
    /** Existing execution role */
    readonly executionRole?: iam.IRole;
    /** Existing task role (blueprint pattern: create in stack, pass here) */
    readonly taskRole?: iam.IRole;
    /** KMS key for log group encryption */
    readonly logGroupKmsKey?: kms.IKey;
    /** Log stream prefix @default containerName */
    readonly logStreamPrefix?: string;
    /** Removal policy for log group */
    readonly logGroupRemovalPolicy?: cdk.RemovalPolicy;

    // EC2-only security hardening options (ignored for Fargate)
    /** Enable read-only root filesystem (EC2 only) @default true for EC2 */
    readonly readonlyRootFilesystem?: boolean;
    /** Container user UID (EC2 only) @default '1001' for EC2 */
    readonly user?: string;
    /** Explicitly disable privileged mode (EC2 only) @default false */
    readonly privileged?: boolean;
    /** Tmpfs volume configuration (EC2 only) */
    readonly tmpfsVolumes?: TmpfsVolumeConfig[];

    // Security hardening (HIGH-4, HIGH-5)
    /** Enable init process for zombie reaping @default true */
    readonly initProcessEnabled?: boolean;
    /** Drop all Linux capabilities @default true */
    readonly dropAllCapabilities?: boolean;

    // Graceful shutdown (MEDIUM-1)
    /** Stop timeout in seconds @default 30 */
    readonly stopTimeoutSeconds?: number;

    // Resource limits (MEDIUM-4)
    /** NOFILE ulimit (open file descriptors) @default 65536 */
    readonly nofileLimit?: number;

    /**
     * Secrets from SSM Parameter Store (String type only, not SecureString)
     * Map of environment variable name to SSM parameter path
     * @example { DATABASE_URL: '/nextjs/prod/database-url' }
     */
    readonly secrets?: Record<string, string>;

    /**
     * Secrets from AWS Secrets Manager (recommended for sensitive data)
     * Map of environment variable name to Secrets Manager secret name/ARN
     * @example { NEXTAUTH_SECRET: 'nextjs/development/auth-secret' }
     */
    readonly secretsFromSecretsManager?: Record<string, string>;
}

/**
 * Unified ECS Task Definition construct.
 *
 * Supports both Fargate and EC2 launch types with:
 * - CloudWatch logging with optional KMS encryption
 * - Health check support
 * - Environment-based resource sizing
 * - Security hardening for EC2 (read-only root fs, non-root user, tmpfs)
 *
 * @example
 * ```typescript
 * // Fargate task (default)
 * const fargateTask = new EcsTaskDefinitionConstruct(this, 'FargateTask', {
 *     family: 'my-app',
 *     containerName: 'app',
 *     repository: ecrRepo,
 *     imageTag: 'abc123',
 * });
 *
 * // EC2 task with security hardening
 * const ec2Task = new EcsTaskDefinitionConstruct(this, 'Ec2Task', {
 *     family: 'my-app',
 *     containerName: 'app',
 *     repository: ecrRepo,
 *     imageTag: 'abc123',
 *     launchType: EcsLaunchType.EC2,
 *     tmpfsVolumes: [{ containerPath: '/app/.next/cache' }],
 * });
 * ```
 */
export class EcsTaskDefinitionConstruct extends Construct {
    /** The task definition (Fargate or EC2) */
    public readonly taskDefinition: ecs.TaskDefinition;
    /** The container definition */
    public readonly container: ecs.ContainerDefinition;
    /** The task role */
    public readonly taskRole: iam.Role;
    /** The execution role */
    public readonly executionRole: iam.IRole;
    /** CloudWatch log group */
    public readonly logGroup: logs.LogGroup;
    /** Container name */
    public readonly containerName: string;
    /** Container port */
    public readonly containerPort: number;
    /** Launch type */
    public readonly launchType: EcsLaunchType;

    constructor(scope: Construct, id: string, props: EcsTaskDefinitionConstructProps) {
        super(scope, id);

        const environment = props.environment ?? Environment.DEVELOPMENT;
        const namePrefix = props.namePrefix ?? 'app';
        this.launchType = props.launchType ?? EcsLaunchType.FARGATE;
        this.containerPort = props.containerPort ?? 3000;
        this.containerName = props.containerName;

        const cpu = props.cpu ?? 256;
        const memoryMiB = props.memoryMiB ?? 512;
        const isEc2 = this.launchType === EcsLaunchType.EC2;

        // =================================================================
        // CloudWatch Log Group
        // =================================================================
        const logRemovalPolicy = props.logGroupRemovalPolicy ?? (
            environment === Environment.DEVELOPMENT
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN
        );

        this.logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/ecs/${namePrefix}/${props.family}`,
            retention: props.logRetentionDays ?? logs.RetentionDays.ONE_MONTH,
            encryptionKey: props.logGroupKmsKey,
            removalPolicy: logRemovalPolicy,
        });

        // =================================================================
        // Task Role (application runtime permissions)
        // =================================================================
        if (props.taskRole) {
            this.taskRole = props.taskRole as iam.Role;
        } else {
            this.taskRole = new iam.Role(this, 'TaskRole', {
                roleName: `${namePrefix}-task-${props.family}-${environment}`,
                assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
                description: `Task role for ${props.family}`,
            });
        }

        // =================================================================
        // Execution Role (ECS agent: pulls, secrets, logging)
        // =================================================================
        if (props.executionRole) {
            this.executionRole = props.executionRole;
        } else {
            this.executionRole = new iam.Role(this, 'ExecutionRole', {
                roleName: `${namePrefix}-exec-${props.family}-${environment}`,
                assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
                ],
            });
        }

        // =================================================================
        // Task Definition (Fargate or EC2)
        // =================================================================
        if (isEc2) {
            this.taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDefinition', {
                family: props.family,
                networkMode: ecs.NetworkMode.AWS_VPC,
                taskRole: this.taskRole,
                executionRole: this.executionRole,
            });
        } else {
            this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
                family: props.family,
                cpu,
                memoryLimitMiB: memoryMiB,
                taskRole: this.taskRole,
                executionRole: this.executionRole,
            });
        }

        // =================================================================
        // Linux Parameters (HIGH-4, HIGH-5) — Security Hardening
        // =================================================================
        const linuxParams = new ecs.LinuxParameters(this, 'LinuxParams', {
            initProcessEnabled: props.initProcessEnabled ?? true,  // HIGH-5: zombie reaping
        });

        // HIGH-4: Drop all Linux capabilities — NextJS needs none
        if (props.dropAllCapabilities ?? true) {
            linuxParams.dropCapabilities(ecs.Capability.ALL);
        }

        // HIGH-3: Proper tmpfs via LinuxParameters (not host volume)
        if (isEc2 && props.tmpfsVolumes) {
            props.tmpfsVolumes.forEach(tmpfs => {
                linuxParams.addTmpfs({
                    containerPath: tmpfs.containerPath,
                    size: tmpfs.size ?? 128,
                    mountOptions: [ecs.TmpfsMountOption.RW],
                });
            });
        }

        // =================================================================
        // Container Environment
        // =================================================================
        const containerEnv: Record<string, string> = {
            NODE_ENV: environment === Environment.PRODUCTION ? 'production' : 'development',
            ...props.containerEnvironment,
        };

        // =================================================================
        // Health Check
        // =================================================================
        let healthCheck: ecs.HealthCheck | undefined;
        if (props.healthCheck) {
            healthCheck = {
                command: props.healthCheck.command,
                interval: cdk.Duration.seconds(props.healthCheck.interval ?? 30),
                timeout: cdk.Duration.seconds(props.healthCheck.timeout ?? 5),
                retries: props.healthCheck.retries ?? 3,
                startPeriod: cdk.Duration.seconds(props.healthCheck.startPeriod ?? 60),
            };
        }

        // =================================================================
        // Secrets from SSM Parameter Store (String type only)
        // =================================================================
        const containerSecrets: Record<string, ecs.Secret> = {};
        if (props.secrets) {
            Object.entries(props.secrets).forEach(([envVarName, ssmPath]) => {
                containerSecrets[envVarName] = ecs.Secret.fromSsmParameter(
                    ssm.StringParameter.fromStringParameterName(
                        this,
                        `Secret-${envVarName}`,
                        ssmPath,
                    ),
                );
            });
        }

        // =================================================================
        // Secrets from AWS Secrets Manager (recommended for sensitive data)
        // Uses fromSecretPartialArn to construct a resolvable ARN for ECS
        // =================================================================
        if (props.secretsFromSecretsManager) {
            Object.entries(props.secretsFromSecretsManager).forEach(([envVarName, secretNameOrArn]) => {
                // Construct partial ARN - ECS will resolve with the random suffix
                const partialArn = secretNameOrArn.startsWith('arn:')
                    ? secretNameOrArn
                    : `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:${secretNameOrArn}`;
                
                const secret = secretsmanager.Secret.fromSecretPartialArn(
                    this,
                    `SmSecret-${envVarName}`,
                    partialArn,
                );
                containerSecrets[envVarName] = ecs.Secret.fromSecretsManager(secret);
            });
        }

        // =================================================================
        // Container Definition
        // =================================================================
        // Always use ECR - frontend must push image before CDK deploy
        const containerImage = ecs.ContainerImage.fromEcrRepository(props.repository, props.imageTag);

        const containerOptions: ecs.ContainerDefinitionOptions = {
            image: containerImage,
            containerName: props.containerName,
            portMappings: [
                {
                    containerPort: this.containerPort,
                    protocol: ecs.Protocol.TCP,
                },
            ],
            environment: containerEnv,
            secrets: Object.keys(containerSecrets).length > 0 ? containerSecrets : undefined,
            healthCheck,
            logging: ecs.LogDrivers.awsLogs({
                logGroup: this.logGroup,
                streamPrefix: props.logStreamPrefix ?? props.containerName,
            }),
            essential: true,
            linuxParameters: linuxParams,  // HIGH-4, HIGH-5: Security hardening
            stopTimeout: cdk.Duration.seconds(props.stopTimeoutSeconds ?? 30),  // MEDIUM-1
        };

        // Add EC2-specific options
        if (isEc2) {
            Object.assign(containerOptions, {
                cpu,
                memoryLimitMiB: memoryMiB,
                readonlyRootFilesystem: props.readonlyRootFilesystem ?? true,
                user: props.user ?? '1001',
                privileged: props.privileged ?? false,
            });
        }

        this.container = this.taskDefinition.addContainer(props.containerName, containerOptions);

        // =================================================================
        // MEDIUM-4: NOFILE ulimit for file descriptor limits
        // =================================================================
        const nofileLimit = props.nofileLimit ?? 65536;
        this.container.addUlimits({
            name: ecs.UlimitName.NOFILE,
            softLimit: nofileLimit,
            hardLimit: nofileLimit,
        });

        // =================================================================
        // ECR Pull Permissions
        // Only grant if we created the execution role ourselves.
        // If an external role was provided, assume permissions are pre-granted
        // to avoid cyclic cross-stack dependencies.
        // =================================================================
        if (!props.executionRole) {
            props.repository.grantPull(this.executionRole);
        }

        // =================================================================
        // Component-specific Tags (Environment/Project/ManagedBy via TaggingAspect)
        // =================================================================
        cdk.Tags.of(this.taskDefinition).add('Component', 'ECS-TaskDefinition');
        cdk.Tags.of(this.taskDefinition).add('LaunchType', this.launchType);
    }
}
