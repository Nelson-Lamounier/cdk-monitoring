/**
 * @format
 * ECS Service Construct
 *
 * Reusable ECS service construct for EC2 and Fargate launch types.
 * Handles service configuration, load balancer attachment, auto-scaling, and alarms.
 *
 * Blueprint Pattern:
 * - Accepts cluster, task definition, and security group from stack
 * - Optionally attaches to ALB target groups
 * - Creates CloudWatch alarms for monitoring
 */

import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../../../config/environments';

// =============================================================================
// Types
// =============================================================================

/**
 * Load balancer target configuration
 */
export interface LoadBalancerTargetConfig {
    /** ALB target group */
    readonly targetGroup: elbv2.IApplicationTargetGroup;
    /** Container name to register */
    readonly containerName: string;
    /** Container port to register */
    readonly containerPort: number;
}

/**
 * Auto-scaling configuration
 */
export interface ServiceScalingConfig {
    /** Minimum task count @default 1 */
    readonly minCapacity?: number;
    /** Maximum task count @default 4 */
    readonly maxCapacity?: number;
    /** Target CPU utilization @default 70 */
    readonly cpuTargetUtilizationPercent?: number;
    /** Target memory utilization @default 80 */
    readonly memoryTargetUtilizationPercent?: number;
    /** Cooldown after scale-in @default 60s */
    readonly scaleInCooldown?: cdk.Duration;
    /** Cooldown after scale-out @default 60s */
    readonly scaleOutCooldown?: cdk.Duration;
}

/**
 * CloudWatch alarm configuration
 */
export interface ServiceAlarmConfig {
    /** Enable alarms @default true */
    readonly enabled?: boolean;
    /** CPU threshold percentage @default 80 */
    readonly cpuThreshold?: number;
    /** Memory threshold percentage @default 80 */
    readonly memoryThreshold?: number;
    /** Alarm behavior for deployments @default ROLLBACK_ON_ALARM */
    readonly alarmBehavior?: ecs.AlarmBehavior;
}

/**
 * Props for EcsServiceConstruct
 */
export interface EcsServiceConstructProps {
    /** ECS cluster */
    readonly cluster: ecs.ICluster;
    /** Task definition */
    readonly taskDefinition: ecs.TaskDefinition;
    /** Target environment */
    readonly environment: Environment;
    /** Service name @default '{namePrefix}-service-{env}' */
    readonly serviceName?: string;
    /** Resource name prefix @default 'nextjs' */
    readonly namePrefix?: string;

    // Deployment configuration
    /** Desired task count @default 1 */
    readonly desiredCount?: number;
    /** Minimum healthy percent during deployment @default 100 */
    readonly minHealthyPercent?: number;
    /** Maximum healthy percent during deployment @default 200 */
    readonly maxHealthyPercent?: number;
    /** Health check grace period @default 60s */
    readonly healthCheckGracePeriod?: cdk.Duration;
    /** Enable circuit breaker @default true */
    readonly enableCircuitBreaker?: boolean;
    /** Enable ECS Exec @default false */
    readonly enableExecuteCommand?: boolean;

    // Networking (for awsvpc mode)
    /** Security groups for tasks */
    readonly securityGroups?: ec2.ISecurityGroup[];
    /** VPC subnets for tasks */
    readonly vpcSubnets?: ec2.SubnetSelection;
    /** Assign public IP (Fargate only) @default false */
    readonly assignPublicIp?: boolean;

    // Capacity provider (EC2 only)
    /** EC2 capacity provider strategies */
    readonly capacityProviderStrategies?: ecs.CapacityProviderStrategy[];

    // Load balancer integration
    /** Load balancer target configurations */
    readonly loadBalancerTargets?: LoadBalancerTargetConfig[];

    // Auto-scaling configuration
    /** Auto-scaling configuration */
    readonly scalingConfig?: ServiceScalingConfig;

    // Alarms
    /** Alarm configuration */
    readonly alarmConfig?: ServiceAlarmConfig;

    // Service Discovery (Cloud Map)
    /** Cloud Map service discovery options */
    readonly cloudMapOptions?: ecs.CloudMapOptions;
}

/**
 * Reusable ECS Service construct
 *
 * Creates an ECS service (EC2 or Fargate) with:
 * - Circuit breaker for automatic rollbacks
 * - Optional ALB integration
 * - Auto-scaling based on CPU/Memory
 * - CloudWatch alarms for monitoring
 *
 * @example
 * ```typescript
 * // Create service with ALB target
 * const service = new EcsServiceConstruct(this, 'Service', {
 *     cluster,
 *     taskDefinition,
 *     environment: Environment.PRODUCTION,
 *     desiredCount: 2,
 *     loadBalancerTargets: [{
 *         targetGroup: albTargetGroup,
 *         containerName: 'nextjs-app',
 *         containerPort: 3000,
 *     }],
 *     scalingConfig: {
 *         minCapacity: 2,
 *         maxCapacity: 10,
 *         cpuTargetUtilizationPercent: 70,
 *     },
 * });
 * ```
 */
export class EcsServiceConstruct extends Construct {
    /** The ECS service */
    public readonly service: ecs.BaseService;
    /** CPU utilization alarm (if created) */
    public readonly cpuAlarm?: cw.Alarm;
    /** Memory utilization alarm (if created) */
    public readonly memoryAlarm?: cw.Alarm;
    /** Scalable target (if auto-scaling enabled) */
    public readonly scalableTarget?: ecs.ScalableTaskCount;

    constructor(scope: Construct, id: string, props: EcsServiceConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'nextjs';
        const environment = props.environment;
        const serviceName = props.serviceName ?? `${namePrefix}-service-${environment}`;

        const desiredCount = props.desiredCount ?? 1;
        const minHealthyPercent = props.minHealthyPercent ?? 100;
        const maxHealthyPercent = props.maxHealthyPercent ?? 200;
        const healthCheckGracePeriod = props.healthCheckGracePeriod
            ?? cdk.Duration.seconds(60);

        // =================================================================
        // Validation
        // =================================================================
        if (desiredCount < 0) {
            throw new Error('desiredCount must be >= 0');
        }
        if (minHealthyPercent < 0 || minHealthyPercent > 100) {
            throw new Error('minHealthyPercent must be between 0 and 100');
        }
        if (maxHealthyPercent < minHealthyPercent) {
            throw new Error('maxHealthyPercent must be >= minHealthyPercent');
        }

        // =================================================================
        // Determine Launch Type
        // =================================================================
        const isFargate = props.taskDefinition.compatibility === ecs.Compatibility.FARGATE
            || props.taskDefinition.compatibility === ecs.Compatibility.EC2_AND_FARGATE;

        // =================================================================
        // Create Service
        // =================================================================
        if (isFargate && !props.capacityProviderStrategies?.length) {
            this.service = new ecs.FargateService(this, 'Service', {
                cluster: props.cluster,
                taskDefinition: props.taskDefinition,
                serviceName,
                desiredCount,
                minHealthyPercent,
                maxHealthyPercent,
                healthCheckGracePeriod,
                circuitBreaker: {
                    enable: props.enableCircuitBreaker ?? true,
                    rollback: props.enableCircuitBreaker ?? true,
                },
                enableExecuteCommand: props.enableExecuteCommand ?? false,
                securityGroups: props.securityGroups,
                vpcSubnets: props.vpcSubnets,
                assignPublicIp: props.assignPublicIp ?? false,
                cloudMapOptions: props.cloudMapOptions,
            });
        } else {
            this.service = new ecs.Ec2Service(this, 'Service', {
                cluster: props.cluster,
                taskDefinition: props.taskDefinition,
                serviceName,
                desiredCount,
                minHealthyPercent,
                maxHealthyPercent,
                healthCheckGracePeriod,
                circuitBreaker: {
                    enable: props.enableCircuitBreaker ?? true,
                    rollback: props.enableCircuitBreaker ?? true,
                },
                enableExecuteCommand: props.enableExecuteCommand ?? false,
                capacityProviderStrategies: props.capacityProviderStrategies,
                cloudMapOptions: props.cloudMapOptions,
            });
        }

        // =================================================================
        // Load Balancer Integration
        // =================================================================
        if (props.loadBalancerTargets) {
            props.loadBalancerTargets.forEach((target) => {
                this.attachToLoadBalancer(target);
            });
        }

        // =================================================================
        // Auto-scaling
        // =================================================================
        if (props.scalingConfig) {
            this.configureAutoScaling(props.scalingConfig, environment);
        }

        // =================================================================
        // CloudWatch Alarms
        // =================================================================
        const alarmConfig = props.alarmConfig ?? { enabled: true };
        if (alarmConfig.enabled !== false) {
            this.createAlarms(alarmConfig, serviceName, environment);
        }

        // =================================================================
        // Production Warnings
        // =================================================================
        if (environment === Environment.PRODUCTION && desiredCount < 2) {
            cdk.Annotations.of(this).addWarning(
                'Production service has desiredCount < 2. Consider 2+ tasks for high availability.',
            );
        }

        if (minHealthyPercent < 50) {
            cdk.Annotations.of(this).addWarning(
                'minHealthyPercent < 50 may cause downtime during deployments.',
            );
        }

        // =================================================================
        // Tags
        // =================================================================
        cdk.Tags.of(this.service).add('Component', 'ECS-Service');
        cdk.Tags.of(this.service).add('Environment', environment);
    }

    /**
     * Attach service to ALB target group
     */
    private attachToLoadBalancer(config: LoadBalancerTargetConfig): void {
        config.targetGroup.addTarget(
            this.service.loadBalancerTarget({
                containerName: config.containerName,
                containerPort: config.containerPort,
            }),
        );
    }

    /**
     * Configure auto-scaling for the service
     */
    private configureAutoScaling(config: ServiceScalingConfig, _environment: Environment): void {
        const minCapacity = config.minCapacity ?? 1;
        const maxCapacity = config.maxCapacity ?? 2;

        if (minCapacity > maxCapacity) {
            throw new Error('minCapacity must be <= maxCapacity');
        }

        const scaling = this.service.autoScaleTaskCount({
            minCapacity,
            maxCapacity,
        });

        // CPU-based scaling
        if (config.cpuTargetUtilizationPercent !== undefined) {
            scaling.scaleOnCpuUtilization('CpuScaling', {
                targetUtilizationPercent: config.cpuTargetUtilizationPercent,
                scaleInCooldown: config.scaleInCooldown ?? cdk.Duration.seconds(60),
                scaleOutCooldown: config.scaleOutCooldown ?? cdk.Duration.seconds(60),
            });
        }

        // Memory-based scaling
        if (config.memoryTargetUtilizationPercent !== undefined) {
            scaling.scaleOnMemoryUtilization('MemoryScaling', {
                targetUtilizationPercent: config.memoryTargetUtilizationPercent,
                scaleInCooldown: config.scaleInCooldown ?? cdk.Duration.seconds(60),
                scaleOutCooldown: config.scaleOutCooldown ?? cdk.Duration.seconds(60),
            });
        }

        // Store for external access
        (this as { scalableTarget: ecs.ScalableTaskCount }).scalableTarget = scaling;
    }

    /**
     * Create CloudWatch alarms for the service
     */
    private createAlarms(
        config: ServiceAlarmConfig,
        serviceName: string,
        environment: Environment,
    ): void {
        const alarmNames: string[] = [];

        // CPU Alarm
        const cpuThreshold = config.cpuThreshold ?? 80;
        const cpuAlarmName = `${serviceName}-CPU-High`;
        (this as { cpuAlarm: cw.Alarm }).cpuAlarm = new cw.Alarm(this, 'CpuAlarm', {
            alarmName: cpuAlarmName,
            alarmDescription: `CPU utilization > ${cpuThreshold}% for ${serviceName}`,
            metric: this.service.metricCpuUtilization(),
            threshold: cpuThreshold,
            evaluationPeriods: 2,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        alarmNames.push(cpuAlarmName);

        // Memory Alarm
        const memoryThreshold = config.memoryThreshold ?? 80;
        const memoryAlarmName = `${serviceName}-Memory-High`;
        (this as { memoryAlarm: cw.Alarm }).memoryAlarm = new cw.Alarm(this, 'MemoryAlarm', {
            alarmName: memoryAlarmName,
            alarmDescription: `Memory utilization > ${memoryThreshold}% for ${serviceName}`,
            metric: this.service.metricMemoryUtilization(),
            threshold: memoryThreshold,
            evaluationPeriods: 2,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
        alarmNames.push(memoryAlarmName);

        // Enable deployment alarms (rollback on alarm)
        if (environment === Environment.PRODUCTION) {
            this.service.enableDeploymentAlarms(alarmNames, {
                behavior: config.alarmBehavior ?? ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
            });
        }
    }
}
