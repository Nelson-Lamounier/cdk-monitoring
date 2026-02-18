/**
 * @format
 * Node Exporter Task Definition Stack
 *
 * ECS Task Definition for Node Exporter daemon running on EC2 instances.
 * Collects host metrics for Prometheus scraping.
 *
 * Features:
 * - Host network mode (required for node-level metrics)
 * - Bind mounts for /proc, /sys, /rootfs
 * - Runs as nobody user (65534)
 * - Read-only root filesystem
 * - Minimal resource allocation (64 CPU, 128 MiB)
 *
 * This task definition is deployed as an ECS Daemon Service
 * to ensure one instance runs on each EC2 container instance.
 */

import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { DOCKER_VERSIONS, LOG_RETENTION, NODE_EXPORTER_PORT } from '../../../config/defaults';
import { Environment } from '../../../config/environments';

/**
 * Props for NodeExporterTaskDefinitionStack
 */
export interface NodeExporterTaskDefinitionStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;
    /**
     * Execution role ARN (from IAM roles stack)
     * Role will be imported by ARN to prevent cyclic dependencies
     */
    readonly executionRoleArn?: string;
    /** Log retention @default based on environment */
    readonly logRetentionDays?: logs.RetentionDays;
    /** Name prefix @default 'node-exporter' */
    readonly namePrefix?: string;
}

/**
 * Node Exporter Task Definition Stack
 *
 * Creates an ECS task definition for Prometheus Node Exporter.
 * Designed to run as a daemon service on each EC2 instance.
 *
 * Configuration:
 * - Network mode: host (required for node-level metrics)
 * - CPU: 64 units
 * - Memory: 128 MiB
 * - User: 65534 (nobody)
 * - Read-only root filesystem
 *
 * @example
 * ```typescript
 * const nodeExporterStack = new NodeExporterTaskDefinitionStack(app, 'NodeExporter-TaskDef-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     executionRole: iamStack.nodeExporterExecutionRole,
 * });
 * ```
 */
export class NodeExporterTaskDefinitionStack extends cdk.Stack {
    /** The ECS task definition */
    public readonly taskDefinition: ecs.Ec2TaskDefinition;
    /** The container definition */
    public readonly container: ecs.ContainerDefinition;
    /** CloudWatch log group */
    public readonly logGroup: logs.LogGroup;
    /** Target environment */
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NodeExporterTaskDefinitionStackProps) {
        super(scope, id, props);

        this.targetEnvironment = props.targetEnvironment;
        const environment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'node-exporter';
        const isProd = environment === Environment.PRODUCTION;

        // =================================================================
        // Log Group
        // =================================================================
        const logRetention = props.logRetentionDays ?? (
            environment === Environment.PRODUCTION
                ? LOG_RETENTION.prod
                : environment === Environment.STAGING
                    ? LOG_RETENTION.staging
                    : LOG_RETENTION.dev
        );

        this.logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/ecs/${namePrefix}-${environment}`,
            retention: logRetention,
            removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // =================================================================
        // Import Execution Role by ARN (prevents cyclic dependencies)
        // =================================================================
        const executionRole = props.executionRoleArn
            ? iam.Role.fromRoleArn(this, 'ImportedExecutionRole', props.executionRoleArn, {
                mutable: false,
            })
            : undefined;

        // =================================================================
        // Task Definition (EC2, host network mode)
        // =================================================================
        this.taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDefinition', {
            family: `${namePrefix}-${environment}`,
            networkMode: ecs.NetworkMode.HOST,
            executionRole,
            // No task role - Node Exporter doesn't need AWS API access
        });

        // =================================================================
        // Bind Mount Volumes (host paths for metrics collection)
        // =================================================================
        this.taskDefinition.addVolume({
            name: 'proc',
            host: { sourcePath: '/proc' },
        });

        this.taskDefinition.addVolume({
            name: 'sys',
            host: { sourcePath: '/sys' },
        });

        this.taskDefinition.addVolume({
            name: 'rootfs',
            host: { sourcePath: '/' },
        });

        // =================================================================
        // Container Definition
        // =================================================================
        this.container = this.taskDefinition.addContainer('node-exporter', {
            containerName: 'node-exporter',
            image: ecs.ContainerImage.fromRegistry(`prom/node-exporter:${DOCKER_VERSIONS.nodeExporter}`),
            essential: true,
            cpu: 64,
            memoryLimitMiB: 128,

            // Security hardening
            readonlyRootFilesystem: true,
            privileged: false,
            user: '65534', // nobody user

            // Command with metric collection paths
            command: [
                '--path.procfs=/host/proc',
                '--path.sysfs=/host/sys',
                '--path.rootfs=/host/rootfs',
                '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)',
            ],

            // Port mapping (host network mode)
            portMappings: [{
                hostPort: NODE_EXPORTER_PORT,
                containerPort: NODE_EXPORTER_PORT,
                protocol: ecs.Protocol.TCP,
            }],

            // Logging
            logging: ecs.LogDrivers.awsLogs({
                logGroup: this.logGroup,
                streamPrefix: 'node-exporter',
            }),
        });

        // =================================================================
        // Mount Points (read-only bind mounts)
        // =================================================================
        this.container.addMountPoints(
            {
                sourceVolume: 'proc',
                containerPath: '/host/proc',
                readOnly: true,
            },
            {
                sourceVolume: 'sys',
                containerPath: '/host/sys',
                readOnly: true,
            },
            {
                sourceVolume: 'rootfs',
                containerPath: '/host/rootfs',
                readOnly: true,
            },
        );

        // =================================================================
        // Tags
        // =================================================================
        cdk.Tags.of(this).add('Component', 'NodeExporter-TaskDefinition');
        cdk.Tags.of(this).add('Purpose', 'Monitoring');

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'TaskDefinitionArn', {
            value: this.taskDefinition.taskDefinitionArn,
            description: 'Node Exporter Task Definition ARN',
            exportName: `${this.stackName}-task-definition-arn`,
        });

        new cdk.CfnOutput(this, 'TaskDefinitionFamily', {
            value: this.taskDefinition.family ?? `${namePrefix}-${environment}`,
            description: 'Node Exporter Task Definition Family',
            exportName: `${this.stackName}-family`,
        });

        new cdk.CfnOutput(this, 'LogGroupName', {
            value: this.logGroup.logGroupName,
            description: 'CloudWatch Log Group for Node Exporter',
            exportName: `${this.stackName}-log-group`,
        });

        new cdk.CfnOutput(this, 'MetricsEndpoint', {
            value: `http://<instance-ip>:${NODE_EXPORTER_PORT}/metrics`,
            description: 'Node Exporter metrics endpoint pattern',
        });
    }
}
