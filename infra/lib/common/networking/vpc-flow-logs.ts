/**
 * @format
 * VPC Construct
 *
 * Reusable VPC construct with optional flow logs and cost optimization.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Flow log configuration
 */
export interface FlowLogConfiguration {
    /** Log group name @default '/vpc/flow-logs' */
    readonly logGroupName?: string;
    /** Retention period @default ONE_MONTH */
    readonly retention?: logs.RetentionDays;
    /** KMS key for encryption (if not provided, creates new one) */
    readonly encryptionKey?: kms.IKey;
    /** Create new KMS key @default true */
    readonly createEncryptionKey?: boolean;
}

/**
 * Props for StandardVpcConstruct
 */
export interface StandardVpcConstructProps {
    /** CIDR block for the VPC @default '10.0.0.0/16' */
    readonly cidr?: string;
    /** Maximum AZs to use @default 2 */
    readonly maxAzs?: number;
    /** VPC name @default 'MainVpc' */
    readonly vpcName?: string;
    /** Create NAT Gateway @default false (cost optimization) */
    readonly natGateways?: number;
    /** Flow log configuration */
    readonly flowLogConfig?: FlowLogConfiguration;
    /** Additional subnet configuration */
    readonly subnetConfiguration?: ec2.SubnetConfiguration[];
}

/**
 * Reusable VPC construct with cost optimization and security features
 *
 * Features:
 * - No NAT Gateway by default (cost optimization)
 * - Optional VPC flow logs with encryption
 * - Public subnet only by default
 */
export class StandardVpcConstruct extends Construct {
    /** The VPC */
    public readonly vpc: ec2.Vpc;
    /** KMS key for flow log encryption */
    public readonly flowLogEncryptionKey?: kms.IKey;
    /** Flow log CloudWatch log group */
    public readonly flowLogGroup?: logs.ILogGroup;

    constructor(scope: Construct, id: string, props?: StandardVpcConstructProps) {
        super(scope, id);

        const defaultSubnets: ec2.SubnetConfiguration[] = [
            {
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
                cidrMask: 24,
            },
        ];

        // Create VPC
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: props?.vpcName ?? 'MainVpc',
            ipAddresses: ec2.IpAddresses.cidr(props?.cidr ?? '10.0.0.0/16'),
            maxAzs: props?.maxAzs ?? 2,
            natGateways: props?.natGateways ?? 0,
            subnetConfiguration: props?.subnetConfiguration ?? defaultSubnets,
        });

        // Configure flow logs if enabled
        if (props?.flowLogConfig) {
            this.configureFlowLogs(props.flowLogConfig);
        }
    }

    private configureFlowLogs(config: FlowLogConfiguration): void {
        const stack = cdk.Stack.of(this);

        // Determine encryption key
        if (config.encryptionKey) {
            (this as { flowLogEncryptionKey?: kms.IKey }).flowLogEncryptionKey = config.encryptionKey;
        } else if (config.createEncryptionKey !== false) {
            (this as { flowLogEncryptionKey?: kms.IKey }).flowLogEncryptionKey = new kms.Key(this, 'FlowLogKey', {
                alias: 'vpc-flow-logs',
                description: 'KMS key for VPC Flow Logs encryption',
                enableKeyRotation: true,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });

            // Grant CloudWatch Logs permission
            this.flowLogEncryptionKey!.addToResourcePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
                actions: [
                    'kms:Encrypt*',
                    'kms:Decrypt*',
                    'kms:ReEncrypt*',
                    'kms:GenerateDataKey*',
                    'kms:Describe*',
                ],
                resources: ['*'],
                conditions: {
                    ArnLike: {
                        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${stack.region}:${stack.account}:*`,
                    },
                },
            }));
        }

        // Create log group
        const logGroup = new logs.LogGroup(this, 'FlowLogGroup', {
            logGroupName: config.logGroupName ?? '/vpc/flow-logs',
            retention: config.retention ?? logs.RetentionDays.ONE_MONTH,
            encryptionKey: this.flowLogEncryptionKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        (this as { flowLogGroup?: logs.ILogGroup }).flowLogGroup = logGroup;

        // Add flow log
        this.vpc.addFlowLog('FlowLog', {
            trafficType: ec2.FlowLogTrafficType.ALL,
            destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup),
        });
    }
}
