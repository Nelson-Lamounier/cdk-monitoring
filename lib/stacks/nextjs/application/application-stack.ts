/**
 * @format
 * NextJS Application Stack
 *
 * Consolidated application resources for the Next.js deployment.
 * This stack combines Task Definition, ECS Service, and Auto-Deploy.
 *
 * Domain: Application Layer (changes frequently)
 *
 * Resources:
 * 1. ECS Task Definition - Container configuration with security hardening
 * 2. ECS Service - Runs tasks with ALB integration
 * 3. Auto-Deploy - Lambda + EventBridge for automated deployments
 *
 * @example
 * ```typescript
 * const appStack = new NextJsApplicationStack(app, 'NextJS-AppStack-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     vpc: vpcStack.vpc,
 *     repository: dataStack.repository,
 *     imageTag: 'abc123def',
 *     cluster: computeStack.cluster,
 *     taskExecutionRole: computeStack.taskExecutionRole,
 *     taskRole: computeStack.taskRole,
 *     targetGroup: networkingStack.targetGroup,
 *     taskSecurityGroup: networkingStack.taskSecurityGroup,
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudmap from 'aws-cdk-lib/aws-servicediscovery';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { EcsTaskDefinitionConstruct, EcsLaunchType, EcsServiceConstruct, LambdaFunctionConstruct } from '../../../common/compute';
import { EncryptionKeyConstruct } from '../../../common/security/kms-key';
import { DOCKER_VERSIONS, NODE_EXPORTER_PORT, LOG_RETENTION, PORTFOLIO_GSI1_NAME, PORTFOLIO_GSI2_NAME } from '../../../config/defaults';
import { Environment } from '../../../config/environments';
import { getNextJsAllocations } from '../../../config/nextjs/allocations';
import { getNextJsConfigs } from '../../../config/nextjs/configurations';
import { nextjsSsmPaths, sharedEcrPaths } from '../../../config/ssm-paths';

/**
 * Monitoring and observability options for the application stack.
 * Groups all sidecar, service-discovery, and metrics-related configuration.
 */
export interface MonitoringOptions {
    /** Enable node-exporter daemon service for Prometheus host metrics @default false */
    readonly enableNodeExporter?: boolean;

    /** Enable Promtail sidecar for Loki log forwarding @default false */
    readonly enablePromtail?: boolean;

    /**
     * SSM parameter path for Loki endpoint.
     * Resolves the endpoint internally via SSM, avoiding cross-stack exports.
     * Takes precedence over lokiEndpoint.
     * @example '/monitoring/loki/endpoint'
     */
    readonly lokiSsmPath?: string;

    /**
     * Loki endpoint URL for Promtail log forwarding
     * @example 'http://10.0.0.197:3100/loki/api/v1/push'
     */
    readonly lokiEndpoint?: string;

    /** Enable Grafana Alloy sidecar for OTLP trace collection @default false */
    readonly enableAlloy?: boolean;

    /**
     * Tempo OTLP endpoint URL (monitoring EC2 private IP + port 4317)
     * @example 'http://10.0.0.197:4317'
     */
    readonly tempoEndpoint?: string;

    /**
     * SSM parameter path for Tempo endpoint.
     * Resolves endpoint internally via SSM. Takes precedence over tempoEndpoint.
     * @example '/monitoring/tempo/endpoint'
     */
    readonly tempoSsmPath?: string;

    /** Cloud Map namespace for Prometheus service discovery (from ComputeStack) */
    readonly cloudMapNamespace?: cloudmap.IPrivateDnsNamespace;
}

/**
 * Auto-deploy options for ECR push-triggered deployments.
 */
export interface AutoDeployOptions {
    /** Enable auto-deploy on ECR image push @default true */
    readonly enabled?: boolean;

    /** Image tags to trigger auto-deploy @default ['latest'] */
    readonly triggerTags?: string[];
}

/**
 * Props for NextJsApplicationStack
 */
export interface NextJsApplicationStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /**
     * VPC for networking.
     * Provide either `vpc` (direct reference) or `vpcName` (synth-time lookup).
     * Using `vpcName` avoids cross-stack CloudFormation exports.
     */
    readonly vpc?: ec2.IVpc;

    /**
     * VPC Name tag for synth-time lookup via Vpc.fromLookup().
     * When provided, the stack resolves the VPC internally — no cross-stack exports.
     * Mutually exclusive with `vpc` (vpcName takes precedence).
     * @example 'shared-vpc-development'
     */
    readonly vpcName?: string;

    // ===========================================
    // ECR Configuration (via SSM from SharedVpcStack)
    // ===========================================
    /**
     * SSM parameter prefix for ECR discovery
     * @default '/shared/ecr/{targetEnvironment}'
     */
    readonly ecrSsmPrefix?: string;

    /** Image tag @default 'latest' */
    readonly imageTag?: string;

    // ===========================================
    // From ComputeStack
    // ===========================================
    /** ECS cluster */
    readonly cluster: ecs.ICluster;

    /** Task execution role (ARN or Role) */
    readonly taskExecutionRole?: iam.IRole;
    readonly taskExecutionRoleArn?: string;

    /** Task role (ARN or Role) */
    readonly taskRole?: iam.IRole;
    readonly taskRoleArn?: string;

    // ===========================================
    // From NetworkingStack
    // ===========================================
    /** ALB target group */
    readonly targetGroup: elbv2.IApplicationTargetGroup;

    /** Security group for tasks */
    readonly taskSecurityGroup: ec2.ISecurityGroup;

    // ===========================================
    // Service Configuration
    // ===========================================
    /** Container port @default 3000 */
    readonly containerPort?: number;

    /** Desired task count @default 1 */
    readonly desiredCount?: number;

    /** Enable auto-scaling @default false */
    readonly enableAutoScaling?: boolean;

    /** Health check grace period in seconds @default 120 */
    readonly healthCheckGracePeriodSeconds?: number;

    // ===========================================
    // Task Definition Configuration
    // ===========================================
    /** CPU units @default based on environment */
    readonly cpu?: number;

    /** Memory in MiB @default based on environment */
    readonly memoryMiB?: number;

    /** Existing KMS key for log encryption */
    readonly logGroupKmsKey?: kms.IKey;

    /** Create KMS key for log encryption @default true for prod */
    readonly createLogGroupKmsKey?: boolean;

    /** SSM parameter path prefix @default '/{namePrefix}/{environment}' */
    readonly ssmParameterPathPrefix?: string;

    /** Name prefix @default 'nextjs' */
    readonly namePrefix?: string;

    // ===========================================
    // Grouped Options
    // ===========================================
    /** Monitoring and observability configuration */
    readonly monitoring?: MonitoringOptions;

    /** Auto-deploy on ECR push configuration */
    readonly autoDeploy?: AutoDeployOptions;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * NextJsApplicationStack - Consolidated application layer for Next.js
 *
 * This stack consolidates the "frequently changing" application resources:
 *
 * Task Definition:
 * - EC2 compatible with security hardening
 * - Read-only filesystem with tmpfs for cache
 * - Non-root user, init process, dropped capabilities
 * - KMS-encrypted CloudWatch logging
 * - SSM secrets for configuration
 *
 * ECS Service:
 * - EC2 launch type with awsvpc networking
 * - ALB target group integration
 * - Deployment circuit breaker with rollback
 * - Execute command enabled for debugging
 *
 * Auto-Deploy:
 * - EventBridge rule for ECR push events
 * - Lambda function to trigger ECS service update
 * - Dead letter queue for failed invocations
 */
export class NextJsApplicationStack extends cdk.Stack {
    // Task Definition
    public readonly taskDefinitionConstruct: EcsTaskDefinitionConstruct;
    public readonly logGroupKmsKey?: kms.IKey;

    // Service
    public readonly serviceConstruct: EcsServiceConstruct;

    // Auto-Deploy
    public autoDeployRule?: events.Rule;
    public autoDeployLambda?: LambdaFunctionConstruct;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NextJsApplicationStackProps) {
        super(scope, id, props);

        // Validate VPC input (the resolved VPC is accessed through the
        // cluster, target group, and security group — no direct reference needed)
        if (!props.vpc && !props.vpcName) {
            throw new Error('NextJsApplicationStack requires either vpc or vpcName prop');
        }

        this.targetEnvironment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'nextjs';
        const environment = props.targetEnvironment;
        const containerPort = props.containerPort ?? 3000;
        const containerName = `${namePrefix}-app`;

        // =================================================================
        // CONFIGURATION
        // =================================================================
        const allocations = getNextJsAllocations(environment);
        const configs = getNextJsConfigs(environment);
        const ecsTaskConfig = configs.ecsTask;
        const ecsTaskAlloc = allocations.ecsTask;
        const isProd = environment === Environment.PRODUCTION;

        // =================================================================
        // SIDECAR PROP VALIDATION
        // Fail fast if the user opts into a sidecar but forgets the endpoint.
        // =================================================================
        const mon = props.monitoring ?? {};

        if (mon.enablePromtail && !mon.lokiEndpoint && !mon.lokiSsmPath) {
            throw new Error(
                'monitoring.enablePromtail is true but neither lokiEndpoint nor lokiSsmPath was provided. ' +
                'Provide at least one so the Promtail sidecar can forward logs to Loki.'
            );
        }
        if (mon.enableAlloy && !mon.tempoEndpoint && !mon.tempoSsmPath) {
            throw new Error(
                'monitoring.enableAlloy is true but neither tempoEndpoint nor tempoSsmPath was provided. ' +
                'Provide at least one so the Alloy sidecar can forward traces to Tempo.'
            );
        }

        // =================================================================
        // KMS KEY FOR LOG ENCRYPTION
        // =================================================================
        const createKmsKey = props.createLogGroupKmsKey ?? ecsTaskConfig.enableLogEncryption;

        if (props.logGroupKmsKey) {
            this.logGroupKmsKey = props.logGroupKmsKey;
        } else if (createKmsKey) {
            const kmsConstruct = new EncryptionKeyConstruct(this, 'LogGroupKey', {
                alias: `${namePrefix}-app-logs-${environment}`,
                description: `KMS key for ${namePrefix} application logs`,
                allowCloudWatchLogs: true,
                removalPolicy: ecsTaskConfig.retainLogs
                    ? cdk.RemovalPolicy.RETAIN
                    : cdk.RemovalPolicy.DESTROY,
            });
            this.logGroupKmsKey = kmsConstruct.key;
        }

        // =================================================================
        // SECRETS CONFIGURATION
        // SSM for non-sensitive config, Secrets Manager for sensitive data
        // =================================================================
        const ssmPaths = nextjsSsmPaths(environment, namePrefix);
        const _ssmPrefix = props.ssmParameterPathPrefix ?? ssmPaths.prefix;
        
        // Non-sensitive configuration from SSM (String type parameters)
        const ssmSecrets: Record<string, string> = {
            DYNAMODB_TABLE_NAME: ssmPaths.dynamodbTableName,
            ASSETS_BUCKET_NAME: ssmPaths.assetsBucketName,
            NEXT_PUBLIC_API_URL: ssmPaths.apiGatewayUrl,
        };
        
        // Note: No authentication secrets needed for public portfolio site
        // If authentication is added later, use secretsFromSecretsManager

        // =================================================================
        // IMPORT ROLES
        // =================================================================
        const executionRole = props.taskExecutionRole
            ?? (props.taskExecutionRoleArn
                ? iam.Role.fromRoleArn(this, 'ImportedExecutionRole', props.taskExecutionRoleArn, {
                      mutable: false,
                  })
                : undefined);

        const taskRole = props.taskRole
            ?? (props.taskRoleArn
                ? iam.Role.fromRoleArn(this, 'ImportedTaskRole', props.taskRoleArn, {
                      mutable: false,
                  })
                : undefined);

        // =================================================================
        // IMPORT ECR REPOSITORY (from SharedVpcStack via SSM)
        // Uses fromRepositoryAttributes because SSM values are late-bound tokens
        // =================================================================
        const ecrPaths = sharedEcrPaths(environment);
        const ecrSsmPrefix = props.ecrSsmPrefix ?? ecrPaths.prefix;
        const ecrRepositoryArn = ssm.StringParameter.valueForStringParameter(
            this,
            `${ecrSsmPrefix}/repository-arn`
        );
        const ecrRepositoryName = ssm.StringParameter.valueForStringParameter(
            this,
            `${ecrSsmPrefix}/repository-name`
        );
        const repository = ecr.Repository.fromRepositoryAttributes(this, 'ImportedEcrRepository', {
            repositoryArn: ecrRepositoryArn,
            repositoryName: ecrRepositoryName,
        });
        const imageTag = props.imageTag ?? 'latest';

        // =================================================================
        // TASK DEFINITION
        // =================================================================
        this.taskDefinitionConstruct = new EcsTaskDefinitionConstruct(this, 'TaskDefinition', {
            family: `${namePrefix}-app-${environment}`,
            containerName,
            repository,
            imageTag,
            launchType: EcsLaunchType.EC2,
            containerPort,
            cpu: props.cpu ?? ecsTaskAlloc.cpu,
            memoryMiB: props.memoryMiB ?? ecsTaskAlloc.memoryMiB,
            environment,
            namePrefix,
            logRetentionDays: ecsTaskConfig.logRetention,
            logGroupKmsKey: this.logGroupKmsKey,
            logStreamPrefix: namePrefix,
            logGroupRemovalPolicy: ecsTaskConfig.retainLogs
                ? cdk.RemovalPolicy.RETAIN
                : cdk.RemovalPolicy.DESTROY,
            executionRole,
            taskRole,
            containerEnvironment: {
                NODE_ENV: 'production',
                PORT: containerPort.toString(),
                NEXT_TELEMETRY_DISABLED: '1',
                HOSTNAME: '0.0.0.0',
                // DynamoDB GSI names for server-side direct queries (bypass API Gateway)
                DYNAMODB_GSI1_NAME: PORTFOLIO_GSI1_NAME,
                DYNAMODB_GSI2_NAME: PORTFOLIO_GSI2_NAME,
                // OpenTelemetry: enable SDK when Alloy sidecar is present
                ...(mon.enableAlloy ? {
                    OTEL_SDK_DISABLED: 'false',
                    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
                    OTEL_SERVICE_NAME: `${namePrefix}-app`,
                    OTEL_RESOURCE_ATTRIBUTES: `environment=${environment},service.namespace=${namePrefix}`,
                } : {
                    OTEL_SDK_DISABLED: 'true',
                }),
            },
            secrets: ssmSecrets,
            // No auth secrets needed for public portfolio
            // ISR writes updated pages to /app/.next/server/ at runtime.
            // tmpfs would wipe Docker-built prerendered pages on container start.
            // Security maintained: non-root user (1001), awsvpc isolation, SG-restricted ingress.
            readonlyRootFilesystem: false,
            user: '1001',
            privileged: false,
            tmpfsVolumes: [
                { containerPath: '/app/.next/cache', size: ecsTaskAlloc.tmpfsSizeMiB },
            ],
            initProcessEnabled: ecsTaskConfig.initProcessEnabled,
            dropAllCapabilities: ecsTaskConfig.dropAllCapabilities,
            stopTimeoutSeconds: ecsTaskAlloc.stopTimeoutSeconds,
            nofileLimit: ecsTaskAlloc.nofileLimit,
            healthCheck: {
                command: [
                    'CMD',
                    'node',
                    '-e',
                    "require('http').get('http://localhost:3000/api/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))",
                ],
                interval: ecsTaskConfig.healthCheck.intervalSeconds,
                timeout: ecsTaskConfig.healthCheck.timeoutSeconds,
                retries: ecsTaskConfig.healthCheck.retries,
                startPeriod: ecsTaskConfig.healthCheck.startPeriodSeconds,
            },
        });

        // Promtail sidecar: forwards container logs to Loki
        if (mon.enablePromtail) {
            this.addPromtailSidecar({ monitoring: mon, environment, isProd, namePrefix });
        }

        // Alloy sidecar: collects OTLP traces and forwards to Tempo
        if (mon.enableAlloy) {
            this.addAlloySidecar({ monitoring: mon, environment, isProd, namePrefix });
        }

        // =================================================================
        // ECS SERVICE
        // =================================================================
        const { minHealthyPercent, maxHealthyPercent } = ecsTaskConfig.deployment;
        const desiredCount = props.desiredCount ?? 1;

        this.serviceConstruct = new EcsServiceConstruct(this, 'Service', {
            cluster: props.cluster,
            taskDefinition: this.taskDefinitionConstruct.taskDefinition,
            environment,
            serviceName: `${namePrefix}-service-${environment}`,
            namePrefix,
            desiredCount,
            minHealthyPercent,
            maxHealthyPercent,
            healthCheckGracePeriod: cdk.Duration.seconds(
                props.healthCheckGracePeriodSeconds ?? 120
            ),
            enableCircuitBreaker: ecsTaskConfig.enableCircuitBreaker,
            enableExecuteCommand: true,
            securityGroups: [props.taskSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
            // Cloud Map service discovery: auto-registers task IPs
            cloudMapOptions: mon.cloudMapNamespace ? {
                cloudMapNamespace: mon.cloudMapNamespace,
                name: `${namePrefix}-app`,
                dnsRecordType: cloudmap.DnsRecordType.A,
                dnsTtl: cdk.Duration.seconds(10),
            } : undefined,
            loadBalancerTargets: [
                {
                    targetGroup: props.targetGroup,
                    containerName,
                    containerPort,
                },
            ],
            scalingConfig: props.enableAutoScaling
                ? {
                      minCapacity: allocations.serviceScaling.minCapacity,
                      maxCapacity: allocations.serviceScaling.maxCapacity,
                      cpuTargetUtilizationPercent: allocations.serviceScaling.cpuTargetUtilizationPercent,
                      memoryTargetUtilizationPercent: allocations.serviceScaling.memoryTargetUtilizationPercent,
                  }
                : undefined,
            alarmConfig: {
                enabled: ecsTaskConfig.alarms.enabled,
                cpuThreshold: ecsTaskConfig.alarms.cpuThreshold,
                memoryThreshold: ecsTaskConfig.alarms.memoryThreshold,
            },
        });


        // Node Exporter daemon: host metrics for Prometheus
        if (mon.enableNodeExporter) {
            this.addNodeExporterDaemon({
                cluster: props.cluster,
                environment,
                isProd,
                namePrefix,
            });
        }

        // Auto-deploy: ECR push triggers ECS service update
        const enableAutoDeploy = props.autoDeploy?.enabled ?? true;
        if (enableAutoDeploy) {
            this.addAutoDeployPipeline({
                props,
                repository,
                environment,
                isProd,
                namePrefix,
            });
        }

        // =================================================================
        // CDK-NAG SUPPRESSIONS FOR TASK DEFINITION
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.taskDefinitionConstruct.taskDefinition,
            [
                {
                    id: 'AwsSolutions-ECS2',
                    reason: 'Non-sensitive environment variables (NODE_ENV, PORT, NEXT_TELEMETRY_DISABLED, HOSTNAME) are acceptable. Secrets use SSM.',
                },
            ],
            true
        );

        // =================================================================
        // TAGS
        // =================================================================
        cdk.Tags.of(this).add('Stack', 'NextJsApplication');
        cdk.Tags.of(this).add('Layer', 'Application');

        // =================================================================
        // SSM PARAMETERS FOR CI/CD
        // =================================================================
        new ssm.StringParameter(this, 'SsmServiceName', {
            parameterName: ssmPaths.ecs.serviceName,
            stringValue: this.serviceConstruct.service.serviceName,
            description: 'ECS Service Name for NextJS deployments',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmServiceArn', {
            parameterName: ssmPaths.ecs.serviceArn,
            stringValue: this.serviceConstruct.service.serviceArn,
            description: 'ECS Service ARN for NextJS deployments',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // STACK OUTPUTS
        // =================================================================

        // Task Definition Outputs
        new cdk.CfnOutput(this, 'TaskDefinitionArn', {
            value: this.taskDefinitionConstruct.taskDefinition.taskDefinitionArn,
            description: 'ECS Task Definition ARN',
            exportName: `${this.stackName}-taskdef-arn`,
        });

        new cdk.CfnOutput(this, 'TaskDefinitionFamily', {
            value: this.taskDefinitionConstruct.taskDefinition.family!,
            description: 'ECS Task Definition Family',
        });

        new cdk.CfnOutput(this, 'LogGroupName', {
            value: this.taskDefinitionConstruct.logGroup.logGroupName,
            description: 'CloudWatch Log Group Name',
        });

        // Service Outputs
        new cdk.CfnOutput(this, 'ServiceName', {
            value: this.serviceConstruct.service.serviceName,
            description: 'ECS Service Name',
            exportName: `${this.stackName}-service-name`,
        });

        new cdk.CfnOutput(this, 'ServiceArn', {
            value: this.serviceConstruct.service.serviceArn,
            description: 'ECS Service ARN',
            exportName: `${this.stackName}-service-arn`,
        });

        new cdk.CfnOutput(this, 'DeploymentConfig', {
            value: `min=${minHealthyPercent}%, max=${maxHealthyPercent}%`,
            description: 'Deployment healthy percent configuration',
        });

        // Auto-Deploy Outputs
        if (enableAutoDeploy && this.autoDeployRule) {
            new cdk.CfnOutput(this, 'AutoDeployRuleName', {
                value: this.autoDeployRule.ruleName,
                description: 'EventBridge rule name for ECR push events',
            });

            new cdk.CfnOutput(this, 'AutoDeployLambdaName', {
                value: this.autoDeployLambda!.function.functionName,
                description: 'Auto-deploy Lambda function name',
            });
        }

        // Production warning
        if (!isProd && minHealthyPercent === 0) {
            cdk.Annotations.of(this).addInfo(
                `Using minHealthy=0% for t3.small ENI constraints (configured in ecsTask.deployment). Brief downtime during deployments.`
            );
        }
    }

    // =========================================================================
    // PRIVATE METHODS — Optional resource blocks extracted from the constructor
    // =========================================================================

    /**
     * Add Promtail sidecar to the task definition.
     * Forwards container logs to Loki for centralized log aggregation.
     *
     * Config is injected as an env var and piped to stdin at runtime —
     * the standard ECS pattern since containers can't mount ad-hoc files.
     */
    private addPromtailSidecar(params: {
        monitoring: MonitoringOptions;
        environment: string;
        isProd: boolean;
        namePrefix: string;
    }): void {
        const { monitoring, environment, isProd, namePrefix } = params;

        const lokiEndpoint = monitoring.lokiSsmPath
            ? ssm.StringParameter.valueForStringParameter(this, monitoring.lokiSsmPath)
            : monitoring.lokiEndpoint!;

        // Shared logs volume for Next.js → Promtail
        this.taskDefinitionConstruct.taskDefinition.addVolume({
            name: 'logs',
            host: {},
        });
        this.taskDefinitionConstruct.container.addMountPoints({
            sourceVolume: 'logs',
            containerPath: '/var/log/app',
            readOnly: false,
        });

        // Promtail log group
        // No hardcoded logGroupName — CloudFormation generates a unique name
        // from the logical ID, preventing 'already exists' collisions on
        // stack rollback/re-creation (especially with RemovalPolicy.RETAIN).
        const promtailLogGroup = new logs.LogGroup(this, 'PromtailLogGroup', {
            retention: isProd ? LOG_RETENTION.prod : LOG_RETENTION.dev,
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Config injected via PROMTAIL_CONFIG env var and piped to stdin.
        // -config.expand-env resolves ${LOKI_ENDPOINT} from the environment.
        const promtailContainer = this.taskDefinitionConstruct.taskDefinition.addContainer('promtail', {
            containerName: 'promtail',
            image: ecs.ContainerImage.fromRegistry(`grafana/promtail:${DOCKER_VERSIONS.promtail}`),
            memoryLimitMiB: 128,
            cpu: 64,
            essential: false,
            entryPoint: ['/bin/sh', '-c'],
            command: ['echo "$PROMTAIL_CONFIG" | /usr/bin/promtail -config.expand-env=true -config.file=/dev/stdin'],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'promtail',
                logGroup: promtailLogGroup,
            }),
            environment: {
                LOKI_ENDPOINT: lokiEndpoint,
            },
            readonlyRootFilesystem: true,
        });

        // Mount shared logs volume (read-only)
        promtailContainer.addMountPoints({
            sourceVolume: 'logs',
            containerPath: '/var/log/app',
            readOnly: true,
        });

        // tmpfs for Promtail positions file
        this.taskDefinitionConstruct.taskDefinition.addVolume({
            name: 'promtail-positions',
            host: {},
        });
        promtailContainer.addMountPoints({
            sourceVolume: 'promtail-positions',
            containerPath: '/tmp',
            readOnly: false,
        });

        // Inline Promtail config
        const promtailConfig = [
            'server:',
            '  http_listen_port: 9080',
            '  grpc_listen_port: 0',
            'positions:',
            '  filename: /tmp/positions.yaml',
            'clients:',
            '  - url: ${LOKI_ENDPOINT}',
            'scrape_configs:',
            '  - job_name: nextjs-app',
            '    static_configs:',
            '      - targets:',
            '          - localhost',
            '        labels:',
            '          job: nextjs',
            `          environment: ${environment}`,
            '          __path__: /var/log/app/*.log',
        ].join('\n');

        promtailContainer.addEnvironment('PROMTAIL_CONFIG', promtailConfig);
    }

    /**
     * Add Grafana Alloy sidecar to the task definition.
     * Collects OTLP traces from the Next.js app and forwards to Tempo.
     * Alloy runs with OTLP gRPC receiver on localhost:4317.
     */
    private addAlloySidecar(params: {
        monitoring: MonitoringOptions;
        environment: string;
        isProd: boolean;
        namePrefix: string;
    }): void {
        const { monitoring, environment, isProd, namePrefix } = params;

        const tempoEndpoint = monitoring.tempoSsmPath
            ? ssm.StringParameter.valueForStringParameter(this, monitoring.tempoSsmPath)
            : monitoring.tempoEndpoint!;

        // No hardcoded logGroupName — same pattern as PromtailLogGroup above.
        const alloyLogGroup = new logs.LogGroup(this, 'AlloyLogGroup', {
            retention: isProd ? LOG_RETENTION.prod : LOG_RETENTION.dev,
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Alloy config file (config.alloy) provisioned to S3
        // and downloaded during user-data setup.
        this.taskDefinitionConstruct.taskDefinition.addContainer('alloy', {
            containerName: 'alloy',
            image: ecs.ContainerImage.fromRegistry(`grafana/alloy:${DOCKER_VERSIONS.alloy}`),
            memoryLimitMiB: 128,
            cpu: 64,
            essential: false,
            command: ['run', '--stability.level=generally-available', '/etc/alloy/config.alloy'],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'alloy',
                logGroup: alloyLogGroup,
            }),
            environment: {
                TEMPO_ENDPOINT: tempoEndpoint,
            },
            portMappings: [{
                containerPort: 4317,
                protocol: ecs.Protocol.TCP,
            }],
        });
    }

    /**
     * Add Node Exporter daemon service for Prometheus host metrics.
     *
     * Uses a raw Ec2TaskDefinition (not EcsTaskDefinitionConstruct) because
     * Node Exporter requires HOST networking to access /proc, /sys, rootfs.
     * HOST networking inherits the EC2 instance's security group.
     */
    private addNodeExporterDaemon(params: {
        cluster: ecs.ICluster;
        environment: string;
        isProd: boolean;
        namePrefix: string;
    }): void {
        const { cluster, environment, isProd, namePrefix } = params;

        const nodeExporterTaskDef = new ecs.Ec2TaskDefinition(this, 'NodeExporterTaskDef', {
            family: `${namePrefix}-node-exporter-${environment}`,
            networkMode: ecs.NetworkMode.HOST,
        });

        // Bind mounts for host filesystem access
        nodeExporterTaskDef.addVolume({ name: 'proc', host: { sourcePath: '/proc' } });
        nodeExporterTaskDef.addVolume({ name: 'sys', host: { sourcePath: '/sys' } });
        nodeExporterTaskDef.addVolume({ name: 'rootfs', host: { sourcePath: '/' } });

        // No hardcoded logGroupName — same pattern as PromtailLogGroup above.
        const nodeExporterLogGroup = new logs.LogGroup(this, 'NodeExporterLogGroup', {
            retention: isProd ? LOG_RETENTION.prod : LOG_RETENTION.dev,
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Security hardening (HIGH-4/HIGH-5)
        const nodeExporterLinuxParams = new ecs.LinuxParameters(this, 'NodeExporterLinuxParams', {
            initProcessEnabled: true,
        });
        nodeExporterLinuxParams.dropCapabilities(ecs.Capability.ALL);

        const nodeExporterContainer = nodeExporterTaskDef.addContainer('node-exporter', {
            containerName: 'node-exporter',
            image: ecs.ContainerImage.fromRegistry(`prom/node-exporter:${DOCKER_VERSIONS.nodeExporter}`),
            memoryLimitMiB: 128,
            cpu: 64,
            essential: true,
            command: [
                '--path.procfs=/host/proc',
                '--path.sysfs=/host/sys',
                '--path.rootfs=/host/rootfs',
                '--collector.filesystem.ignored-mount-points=^/(sys|proc|dev|host|etc)($$|/)',
            ],
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'node-exporter',
                logGroup: nodeExporterLogGroup,
            }),
            portMappings: [{
                containerPort: NODE_EXPORTER_PORT,
                hostPort: NODE_EXPORTER_PORT,
                protocol: ecs.Protocol.TCP,
            }],
            readonlyRootFilesystem: true,
            linuxParameters: nodeExporterLinuxParams,
        });

        nodeExporterContainer.addUlimits({
            name: ecs.UlimitName.NOFILE,
            softLimit: 65536,
            hardLimit: 65536,
        });

        nodeExporterContainer.addMountPoints(
            { sourceVolume: 'proc', containerPath: '/host/proc', readOnly: true },
            { sourceVolume: 'sys', containerPath: '/host/sys', readOnly: true },
            { sourceVolume: 'rootfs', containerPath: '/host/rootfs', readOnly: true },
        );

        cdk.Tags.of(nodeExporterTaskDef).add('Component', 'ECS-TaskDefinition');
        cdk.Tags.of(nodeExporterTaskDef).add('LaunchType', 'EC2');
        cdk.Tags.of(nodeExporterTaskDef).add('Purpose', 'NodeExporter-HostMetrics');

        // Daemon Service (no securityGroups — HOST networking uses EC2 instance SG)
        new ecs.Ec2Service(this, 'NodeExporterService', {
            serviceName: `${namePrefix}-node-exporter-${environment}`,
            cluster,
            taskDefinition: nodeExporterTaskDef,
            daemon: true,
            minHealthyPercent: 0,
            maxHealthyPercent: 100,
        });

        new cdk.CfnOutput(this, 'NodeExporterPort', {
            value: String(NODE_EXPORTER_PORT),
            description: 'Node Exporter metrics port for Prometheus scraping',
        });
    }

    /**
     * Add auto-deploy pipeline: EventBridge → Lambda → ECS UpdateService.
     * Triggers on ECR image push events matching the configured tags.
     */
    private addAutoDeployPipeline(params: {
        props: NextJsApplicationStackProps;
        repository: ecr.IRepository;
        environment: string;
        isProd: boolean;
        namePrefix: string;
    }): void {
        const { props, repository, environment, isProd, namePrefix } = params;
        const triggerTags = props.autoDeploy?.triggerTags ?? ['latest'];

        const dlq = new sqs.Queue(this, 'AutoDeployDLQ', {
            queueName: `${namePrefix}-ecr-deploy-dlq-${environment}`,
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
        });

        this.autoDeployLambda = new LambdaFunctionConstruct(this, 'AutoDeployLambda', {
            functionName: `${namePrefix}-ecr-auto-deploy-${environment}`,
            description: 'Triggers ECS deployment on ECR image push',
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lambda/ecr-deploy/index.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            reservedConcurrentExecutions: 5,
            environment: {
                CLUSTER_NAME: props.cluster.clusterName,
                SERVICE_NAME: this.serviceConstruct.service.serviceName,
                NODE_OPTIONS: '--enable-source-maps',
            },
            logRetention: isProd
                ? logs.RetentionDays.THREE_MONTHS
                : logs.RetentionDays.ONE_MONTH,
            deadLetterQueue: dlq,
            namePrefix,
        });

        this.autoDeployLambda.function.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'EcsUpdateService',
                effect: iam.Effect.ALLOW,
                actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
                resources: [this.serviceConstruct.service.serviceArn],
            })
        );

        dlq.grantSendMessages(this.autoDeployLambda.function);

        this.autoDeployRule = new events.Rule(this, 'EcrPushRule', {
            ruleName: `${namePrefix}-ecr-push-deploy-${environment}`,
            description: `Trigger ECS deployment on ECR push to ${repository.repositoryName}`,
            eventPattern: {
                source: ['aws.ecr'],
                detailType: ['ECR Image Action'],
                detail: {
                    'action-type': ['PUSH'],
                    'result': ['SUCCESS'],
                    'repository-name': [repository.repositoryName],
                    ...(triggerTags.length > 0 && triggerTags[0] !== '*'
                        ? { 'image-tag': triggerTags }
                        : {}),
                },
            },
        });

        this.autoDeployRule.addTarget(
            new targets.LambdaFunction(this.autoDeployLambda.function, {
                deadLetterQueue: dlq,
                maxEventAge: cdk.Duration.hours(1),
                retryAttempts: 2,
            })
        );

        NagSuppressions.addResourceSuppressions(
            this.autoDeployLambda.function.role!,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Lambda needs CloudWatch Logs permissions with wildcard for log streams',
                },
            ],
            true
        );
    }

    /**
     * Get the ECS service
     */
    get service(): ecs.BaseService {
        return this.serviceConstruct.service;
    }
}
