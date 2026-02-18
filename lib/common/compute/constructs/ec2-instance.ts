/**
 * @format
 * EC2 Instance Construct
 *
 * Reusable EC2 instance construct with built-in IAM role,
 * CloudWatch logs, and security best practices.
 *
 * Can be used by any project (Monitoring, NextJS, etc.).
 *
 * Design decisions:
 * - Default subnet: PRIVATE_WITH_EGRESS (secure default; consumers opt into PUBLIC)
 * - No explicit roleName: CDK auto-generates unique names (avoids global IAM collisions)
 * - namePrefix should include the environment suffix (e.g. 'monitoring-development')
 *   to prevent log group / resource name collisions in single-account multi-env setups
 * - Device name '/dev/xvda' targets Amazon Linux 2023 on Nitro instances (t3, m5, c5, etc.)
 *   If using a custom AMI or non-Nitro instance family, override blockDevices directly
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for Ec2InstanceConstruct
 */
export interface Ec2InstanceConstructProps {
    /**
     * The VPC where the EC2 instance will be launched
     */
    readonly vpc: ec2.IVpc;

    /**
     * Security group for the instance
     */
    readonly securityGroup: ec2.ISecurityGroup;

    /**
     * EC2 instance type
     * @default t3.small
     */
    readonly instanceType?: ec2.InstanceType;

    /**
     * SSH key pair name for instance access
     * @default undefined (no SSH key)
     */
    readonly keyPairName?: string;

    /**
     * EBS root volume size in GB
     * @default 30
     */
    readonly volumeSizeGb?: number;

    /**
     * Enable detailed CloudWatch monitoring
     * @default true
     */
    readonly detailedMonitoring?: boolean;

    /**
     * User data script to run on instance startup
     * @default undefined
     */
    readonly userData?: ec2.UserData;

    /**
     * Name prefix for resources (should include environment, e.g. 'monitoring-development').
     * Used for log group names, instance names, and tags.
     * @default 'ec2'
     */
    readonly namePrefix?: string;

    /**
     * Subnet selection for instance placement.
     * @default PRIVATE_WITH_EGRESS subnets (secure default)
     */
    readonly subnetSelection?: ec2.SubnetSelection;

    /**
     * Application tag value. Applied as `Application: {value}` tag
     * to the instance and all child resources.
     * @default namePrefix value
     */
    readonly applicationTag?: string;

    /**
     * Purpose tag value. Applied as `Purpose: {value}` tag
     * to the instance and all child resources.
     * @default 'Compute'
     */
    readonly purposeTag?: string;

    /**
     * CloudWatch log retention period.
     * @default ONE_MONTH
     */
    readonly logRetentionDays?: logs.RetentionDays;

    /**
     * KMS key for CloudWatch log group encryption.
     * @default undefined (AWS-managed encryption)
     */
    readonly logGroupEncryptionKey?: kms.IKey;

    /**
     * Removal policy for log group and other resources.
     * @default DESTROY
     */
    readonly removalPolicy?: cdk.RemovalPolicy;

    /**
     * Whether to associate a public IP address with the instance.
     * Only effective when placed in a public subnet.
     * @default undefined (VPC subnet default applies)
     */
    readonly associatePublicIpAddress?: boolean;
}

/**
 * Reusable EC2 instance construct for any workload.
 *
 * Features:
 * - IAM role with SSM and CloudWatch access (auto-generated name)
 * - CloudWatch log group with configurable retention
 * - Encrypted GP3 EBS root volume with explicit IOPS/throughput
 * - IMDSv2 required (security best practice)
 * - Detailed monitoring enabled by default
 * - Resource tagging via applicationTag and purposeTag props
 * - Default placement in private subnets (secure default)
 *
 * @example
 * ```typescript
 * const instance = new Ec2InstanceConstruct(this, 'WebServer', {
 *     vpc,
 *     securityGroup,
 *     namePrefix: 'webapp-development',
 *     applicationTag: 'MyApp',
 *     purposeTag: 'WebServer',
 *     userData: myUserData,
 * });
 *
 * // Grant additional permissions
 * instance.grantSsmParameterRead('/my-app/*');
 * instance.addToRolePolicy(new iam.PolicyStatement({ ... }));
 * ```
 */
export class Ec2InstanceConstruct extends Construct {
    /**
     * The EC2 instance
     */
    public readonly instance: ec2.Instance;

    /**
     * IAM role attached to the instance
     */
    public readonly instanceRole: iam.Role;

    /**
     * CloudWatch log group for instance logs
     */
    public readonly logGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: Ec2InstanceConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'ec2';
        const volumeSize = props.volumeSizeGb ?? 30;
        const applicationTag = props.applicationTag ?? namePrefix;
        const purposeTag = props.purposeTag ?? 'Compute';

        // =================================================================
        // CloudWatch Log Group
        // =================================================================
        this.logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/ec2/${namePrefix}/instance`,
            retention: props.logRetentionDays ?? logs.RetentionDays.ONE_MONTH,
            removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
            encryptionKey: props.logGroupEncryptionKey,
        });

        // =================================================================
        // IAM Role (auto-generated name avoids global collisions)
        // =================================================================
        this.instanceRole = new iam.Role(this, 'InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            description: `IAM role for ${namePrefix} EC2 instance`,
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
            ],
        });

        // Grant write access to the log group
        this.logGroup.grantWrite(this.instanceRole);

        // =================================================================
        // EC2 Instance
        //
        // Device name '/dev/xvda' is the root device for Amazon Linux 2023
        // on Nitro-based instances (t3, m5, c5, r5, etc.). If using a
        // custom AMI or non-Nitro instance family, override blockDevices.
        // =================================================================
        this.instance = new ec2.Instance(this, 'Instance', {
            vpc: props.vpc,
            instanceType: props.instanceType ?? ec2.InstanceType.of(
                ec2.InstanceClass.T3,
                ec2.InstanceSize.SMALL
            ),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: props.securityGroup,
            role: this.instanceRole,
            vpcSubnets: props.subnetSelection ?? {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            associatePublicIpAddress: props.associatePublicIpAddress,
            keyPair: props.keyPairName
                ? ec2.KeyPair.fromKeyPairName(this, 'KeyPair', props.keyPairName)
                : undefined,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(volumeSize, {
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                        encrypted: true,
                        deleteOnTermination: true,
                        iops: 3000,
                        throughput: 125,
                    }),
                },
            ],
            detailedMonitoring: props.detailedMonitoring ?? true,
            requireImdsv2: true,
            instanceName: `${namePrefix}-instance`,
            userData: props.userData,
        });

        // =================================================================
        // Resource Tagging
        // =================================================================
        cdk.Tags.of(this).add('Application', applicationTag);
        cdk.Tags.of(this).add('Purpose', purposeTag);
    }

    // =====================================================================
    // Grant Helpers
    // =====================================================================

    /**
     * Add an IAM policy statement to the instance role.
     * Convenience wrapper matching LambdaFunctionConstruct patterns.
     */
    addToRolePolicy(statement: iam.PolicyStatement): void {
        this.instanceRole.addToPrincipalPolicy(statement);
    }

    /**
     * Grant the instance read access to SSM parameters under the given path.
     * Common pattern for the SSM-based service discovery used across stacks.
     *
     * @param parameterPath - SSM path prefix (e.g. '/monitoring/*')
     */
    grantSsmParameterRead(parameterPath: string): void {
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmParameterRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParametersByPath',
            ],
            resources: [
                cdk.Arn.format(
                    {
                        service: 'ssm',
                        resource: 'parameter',
                        resourceName: parameterPath.replace(/^\//, ''),
                    },
                    cdk.Stack.of(this),
                ),
            ],
        }));
    }
}
