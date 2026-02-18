/**
 * @format
 * Monitoring Storage Stack (Consolidated)
 *
 * Creates persistent storage infrastructure for monitoring services:
 * - Encrypted EBS volume with SSM-based reuse
 * - DLM snapshot policy for backup
 * - EBS Lifecycle Lambda for ASG termination handling (optional)
 *
 * This is the foundation stack - deployed first, rarely changed.
 * Uses RETAIN to preserve data across stack updates.
 */

import { NagSuppressions } from 'cdk-nag';

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { LambdaFunctionConstruct,
    EventBridgeRuleConstruct,
    EncryptedEbsVolumeConstruct } from '../../../common/index';
import { EBS_DEFAULTS, MONITORING_APP_TAG } from '../../../config/defaults';

/**
 * Props for MonitoringStorageStack
 */
export interface MonitoringStorageStackProps extends cdk.StackProps {
    /**
     * The VPC (used to determine availability zone).
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

    /** Data volume size in GB @default 30 */
    readonly volumeSizeGb?: number;

    /** Create customer-managed KMS key for EBS encryption @default false */
    readonly createEncryptionKey?: boolean;

    /** Enable DLM snapshot policy for automated nightly backups @default true */
    readonly enableBackup?: boolean;

    /** Number of daily snapshots to retain @default 7 */
    readonly snapshotRetentionDays?: number;

    /** Removal policy for the EBS volume @default RETAIN */
    readonly removalPolicy?: cdk.RemovalPolicy;

    /** SSM parameter prefix for volume discovery @default '/monitoring/ebs' */
    readonly ssmPrefix?: string;

    /** Name prefix for resources @default 'monitoring' */
    readonly namePrefix?: string;

    // =================================================================
    // EBS Lifecycle (ASG Mode Only)
    // =================================================================

    /**
     * Auto Scaling Group name for lifecycle management.
     * When provided, creates Lambda + EventBridge for automatic EBS detachment.
     * @default undefined (no lifecycle management)
     */
    readonly asgName?: string;

    /** Tag key used to identify volumes to detach @default 'ManagedBy' */
    readonly volumeTagKey?: string;

    /** Tag value used to identify volumes to detach @default 'MonitoringStack' */
    readonly volumeTagValue?: string;

    // =================================================================
    // Alarm Configuration
    // =================================================================

    /**
     * SNS topic for alarm notifications.
     * When provided, lifecycle error alarms will send notifications here.
     * Without this, alarms are silent (metrics-only).
     */
    readonly alarmSnsTopic?: sns.ITopic;
}

/**
 * Consolidated Storage Stack for Monitoring services.
 *
 * Combines EBS volume management and lifecycle handling:
 * - EBS volume with encryption and SSM-based reuse
 * - DLM backup policy
 * - ASG lifecycle Lambda (when asgName provided)
 *
 * @example
 * ```typescript
 * const storageStack = new MonitoringStorageStack(app, 'Monitoring-Storage-dev', {
 *     vpc,
 *     volumeSizeGb: 50,
 *     enableBackup: true,
 *     asgName: computeStack.asgName, // Optional: enables lifecycle
 * });
 * ```
 */
export class MonitoringStorageStack extends cdk.Stack {
    /** The encrypted EBS volume (may be created or imported) */
    public readonly volume: ec2.IVolume;

    /** The volume ID for cross-stack reference */
    public readonly volumeId: string;

    /** The availability zone where the volume is created */
    public readonly availabilityZone: string;

    /** The KMS key used for encryption (if customer-managed) */
    public readonly encryptionKey?: kms.IKey;

    /** Whether this stack imported an existing volume */
    public readonly isImportedVolume: boolean;

    /** EBS Lifecycle Lambda (only when asgName provided) */
    public readonly lifecycleLambda?: LambdaFunctionConstruct;

    /** EBS Lifecycle CloudWatch alarm (only when asgName provided) */
    public readonly lifecycleErrorAlarm?: cloudwatch.Alarm;

    /** The EBS construct (for granting permissions) */
    private readonly ebsConstruct: EncryptedEbsVolumeConstruct;

    constructor(scope: Construct, id: string, props: MonitoringStorageStackProps) {
        super(scope, id, props);

        // =================================================================
        // Input Validation
        // =================================================================
        if (props.volumeSizeGb !== undefined && props.volumeSizeGb <= 0) {
            throw new Error(`volumeSizeGb must be positive, got: ${props.volumeSizeGb}`);
        }
        if (props.enableBackup !== false && props.snapshotRetentionDays !== undefined && props.snapshotRetentionDays <= 0) {
            throw new Error(
                `snapshotRetentionDays must be positive when backups are enabled, got: ${props.snapshotRetentionDays}. ` +
                `Set enableBackup: false to disable backups entirely.`,
            );
        }

        // Resolve VPC: prefer vpcName (synth-time lookup) over direct vpc reference
        const resolvedVpc = props.vpcName
            ? ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName: props.vpcName })
            : props.vpc;

        if (!resolvedVpc) {
            throw new Error('MonitoringStorageStack requires either vpc or vpcName prop');
        }
        const vpc = resolvedVpc;

        const namePrefix = props.namePrefix ?? 'monitoring';
        const volumeSizeGb = props.volumeSizeGb ?? EBS_DEFAULTS.sizeGb;
        const ssmPrefix = props.ssmPrefix ?? '/monitoring/ebs';
        const ssmVolumeIdParam = `${ssmPrefix}/volume-id`;
        const ssmAzParam = `${ssmPrefix}/availability-zone`;

        // =================================================================
        // Volume Discovery Strategy:
        // 1. First deployment: No existing volume, create new one
        // 2. Subsequent: Use context from cdk.context.json (populated by synth)
        // 
        // We avoid valueFromLookup because it fails when param doesn't exist.
        // Instead, the volume ID can be passed via:
        //   - CDK context: -c existingVolumeId=vol-xxx
        //   - Or will be auto-discovered from SSM after first deployment
        // =================================================================
        
        // Check for existing volume via context (set by previous deployment or manual override)
        const existingVolumeIdContext = this.node.tryGetContext('existingVolumeId') as string | undefined;
        const existingAzContext = this.node.tryGetContext('existingVolumeAz') as string | undefined;
        
        // Determine if we have an existing volume
        const hasExistingVolume = existingVolumeIdContext && 
            existingVolumeIdContext.startsWith('vol-');

        // Determine availability zone
        if (hasExistingVolume && existingAzContext) {
            this.availabilityZone = existingAzContext;
        } else {
            this.availabilityZone = vpc.publicSubnets[0].availabilityZone;
        }

        // =================================================================
        // Create or Import EBS Volume
        // =================================================================
        if (hasExistingVolume && existingVolumeIdContext) {
            this.ebsConstruct = new EncryptedEbsVolumeConstruct(this, 'DataVolume', {
                availabilityZone: this.availabilityZone,
                existingVolumeId: existingVolumeIdContext,
                importExisting: true,
                namePrefix,
            });
            this.isImportedVolume = true;
        } else {
            this.ebsConstruct = new EncryptedEbsVolumeConstruct(this, 'DataVolume', {
                availabilityZone: this.availabilityZone,
                sizeGb: volumeSizeGb,
                createEncryptionKey: props.createEncryptionKey,
                removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
                namePrefix,
            });
            this.isImportedVolume = false;

            // Store volume ID in SSM for future reuse
            new ssm.StringParameter(this, 'VolumeIdParam', {
                parameterName: ssmVolumeIdParam,
                stringValue: this.ebsConstruct.volume.volumeId,
                description: `EBS Volume ID for ${namePrefix} monitoring data`,
            });

            new ssm.StringParameter(this, 'AvailabilityZoneParam', {
                parameterName: ssmAzParam,
                stringValue: this.availabilityZone,
                description: `Availability Zone for ${namePrefix} EBS volume`,
            });
        }

        this.volume = this.ebsConstruct.volume;
        this.volumeId = this.volume.volumeId;
        this.encryptionKey = this.ebsConstruct.encryptionKey;

        // When lifecycle management is enabled, tag the volume so the Lambda's
        // IAM condition (ec2:ResourceTag/ManagedBy = MonitoringStack) matches.
        // This is separate from the CDK-level 'ManagedBy: CDK' tag set by TaggingAspect.
        if (props.asgName) {
            const volumeTagKey = props.volumeTagKey ?? 'ManagedBy';
            const volumeTagValue = props.volumeTagValue ?? 'MonitoringStack';
            cdk.Tags.of(this.ebsConstruct).add(volumeTagKey, volumeTagValue);
        }

        // =================================================================
        // DLM Snapshot Policy (Automated Backups)
        // =================================================================
        const enableBackup = props.enableBackup ?? true;
        const snapshotRetentionDays = props.snapshotRetentionDays ?? 7;

        if (enableBackup && !this.isImportedVolume) {
            this.createDlmPolicy(namePrefix, snapshotRetentionDays);
        }

        // =================================================================
        // EBS Lifecycle Management (ASG Mode Only)
        // =================================================================
        if (props.asgName) {
            const lifecycle = this.createLifecycleResources(props.asgName, namePrefix, props);
            // TypeScript workaround: assign readonly optionals from method return
            (this as { lifecycleLambda?: LambdaFunctionConstruct }).lifecycleLambda = lifecycle.lambda;
            (this as { lifecycleErrorAlarm?: cloudwatch.Alarm }).lifecycleErrorAlarm = lifecycle.alarm;

            // Wire alarm action to SNS topic (when provided)
            if (props.alarmSnsTopic) {
                lifecycle.alarm.addAlarmAction(
                    new cloudwatch_actions.SnsAction(props.alarmSnsTopic),
                );
            }
        }

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'VolumeId', {
            value: this.volumeId,
            description: 'EBS Volume ID',
            exportName: `${this.stackName}-volume-id`,
        });

        new cdk.CfnOutput(this, 'AvailabilityZone', {
            value: this.availabilityZone,
            description: 'Volume Availability Zone',
        });

        new cdk.CfnOutput(this, 'IsImportedVolume', {
            value: this.isImportedVolume.toString(),
            description: 'Whether volume was imported from existing',
        });
    }

    /**
     * Create EBS lifecycle Lambda and EventBridge resources for ASG mode.
     * Returns the created resources for readonly field assignment in constructor.
     */
    private createLifecycleResources(
        asgName: string,
        namePrefix: string,
        props: MonitoringStorageStackProps
    ): { lambda: LambdaFunctionConstruct; alarm: cloudwatch.Alarm } {
        const volumeTagKey = props.volumeTagKey ?? 'ManagedBy';
        const volumeTagValue = props.volumeTagValue ?? 'MonitoringStack';

        // KMS Key for Lambda encryption (CKV_AWS_158 + CKV_AWS_173)
        const lambdaEncryptionKey = new kms.Key(this, 'LambdaEncryptionKey', {
            alias: `${namePrefix}-lambda-encryption`,
            description: `Encryption key for ${namePrefix} Lambda log groups and environment variables`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // CloudWatch Logs requires explicit KMS key policy to use customer-managed keys.
        // Without this, log group creation fails: "KMS key does not exist or is not allowed"
        lambdaEncryptionKey.addToResourcePolicy(new iam.PolicyStatement({
            sid: 'AllowCloudWatchLogsEncryption',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
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
                    'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
                },
            },
        }));

        // Dead Letter Queues (CKV_AWS_27 — SQS encryption)
        const lambdaDlq = new sqs.Queue(this, 'LambdaDlq', {
            queueName: `${namePrefix}-ebs-detach-lambda-dlq`,
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
        });

        const eventBridgeDlq = new sqs.Queue(this, 'EventBridgeDlq', {
            queueName: `${namePrefix}-ebs-detach-eventbridge-dlq`,
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
        });

        NagSuppressions.addResourceSuppressions(
            [lambdaDlq, eventBridgeDlq],
            [{
                id: 'AwsSolutions-SQS3',
                reason: 'These queues ARE dead letter queues - DLQs do not require their own DLQ',
            }]
        );

        // Lambda Function
        const lifecycleLambda = new LambdaFunctionConstruct(this, 'EbsDetachLambda', {
            functionName: `${namePrefix}-ebs-detach`,
            description: 'Detaches EBS volumes and completes lifecycle action on ASG termination',
            entry: 'lambda/ebs-detach/index.ts',
            timeout: cdk.Duration.seconds(60),
            memorySize: 256,
            reservedConcurrentExecutions: 1,
            deadLetterQueue: lambdaDlq,
            encryptionKey: lambdaEncryptionKey,
            environment: {
                VOLUME_TAG_KEY: volumeTagKey,
                VOLUME_TAG_VALUE: volumeTagValue,
            },
            additionalPolicyStatements: [
                new iam.PolicyStatement({
                    sid: 'DescribeEC2Resources',
                    effect: iam.Effect.ALLOW,
                    actions: ['ec2:DescribeVolumes', 'ec2:DescribeInstances'],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    sid: 'DetachTaggedVolumes',
                    effect: iam.Effect.ALLOW,
                    actions: ['ec2:DetachVolume'],
                    resources: [
                        `arn:aws:ec2:${this.region}:${this.account}:volume/*`,
                    ],
                    conditions: {
                        StringEquals: {
                            [`ec2:ResourceTag/${volumeTagKey}`]: volumeTagValue,
                        },
                    },
                }),
                new iam.PolicyStatement({
                    sid: 'DetachVolumeFromInstance',
                    effect: iam.Effect.ALLOW,
                    actions: ['ec2:DetachVolume'],
                    resources: [
                        `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
                    ],
                }),
                new iam.PolicyStatement({
                    sid: 'CompleteLifecycleAction',
                    effect: iam.Effect.ALLOW,
                    actions: ['autoscaling:CompleteLifecycleAction'],
                    resources: [
                        `arn:aws:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${asgName}`,
                    ],
                }),
                new iam.PolicyStatement({
                    sid: 'SendToDLQ',
                    effect: iam.Effect.ALLOW,
                    actions: ['sqs:SendMessage'],
                    resources: [lambdaDlq.queueArn],
                }),
            ],
            namePrefix,
        });

        NagSuppressions.addResourceSuppressions(
            lifecycleLambda.function,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:Describe* requires Resource:*. DetachVolume is tag-conditioned.',
            }],
            true
        );

        NagSuppressions.addStackSuppressions(this, [{
            id: 'AwsSolutions-VPC3',
            reason: 'Lambda calls public AWS APIs only, VPC adds cost with no security benefit',
        }]);

        // CloudWatch Alarm
        const lifecycleErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorsAlarm', {
            alarmName: `${namePrefix}-ebs-detach-errors`,
            alarmDescription: 'Triggers when EBS detach Lambda fails',
            metric: lifecycleLambda.function.metricErrors({
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        // EventBridge Rule
        new EventBridgeRuleConstruct(this, 'EbsDetachRule', {
            ruleName: `${namePrefix}-asg-lifecycle-terminate`,
            description: `Triggers EBS detach when ${asgName} lifecycle hook fires`,
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: ['EC2 Instance-terminate Lifecycle Action'],
                detail: {
                    AutoScalingGroupName: [asgName],
                },
            },
            lambdaTargets: [{
                function: lifecycleLambda.function,
                deadLetterQueue: eventBridgeDlq,
                retryAttempts: 2,
                maxEventAge: cdk.Duration.hours(1),
            }],
            namePrefix,
        });

        // Lifecycle outputs
        new cdk.CfnOutput(this, 'LifecycleLambdaArn', {
            value: lifecycleLambda.function.functionArn,
            description: 'EBS Detach Lambda ARN',
        });

        return { lambda: lifecycleLambda, alarm: lifecycleErrorAlarm };
    }

    /**
     * Create DLM snapshot policy for automated nightly backups.
     * Extracted to a private method to keep the constructor as a pure orchestrator.
     */
    private createDlmPolicy(namePrefix: string, snapshotRetentionDays: number): void {
        const dlmRole = new iam.Role(this, 'DlmRole', {
            assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
            description: `DLM role for ${namePrefix} EBS snapshot management`,
        });

        // Describe actions require resource: '*' (API limitation)
        dlmRole.addToPolicy(new iam.PolicyStatement({
            sid: 'DescribeEC2Resources',
            actions: [
                'ec2:DescribeSnapshots',
                'ec2:DescribeVolumes',
                'ec2:DescribeInstances',
            ],
            resources: ['*'],
        }));

        // Create/Delete scoped to specific volume and snapshots
        dlmRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ManageSnapshots',
            actions: [
                'ec2:CreateSnapshot',
                'ec2:CreateSnapshots',
                'ec2:DeleteSnapshot',
            ],
            resources: [
                `arn:aws:ec2:${this.region}:${this.account}:volume/${this.volumeId}`,
                `arn:aws:ec2:${this.region}::snapshot/*`,
            ],
        }));

        dlmRole.addToPolicy(new iam.PolicyStatement({
            sid: 'TagSnapshots',
            actions: ['ec2:CreateTags'],
            resources: [`arn:aws:ec2:${this.region}::snapshot/*`],
        }));

        new dlm.CfnLifecyclePolicy(this, 'SnapshotPolicy', {
            description: `Nightly snapshots for ${namePrefix} data volume`,
            state: 'ENABLED',
            executionRoleArn: dlmRole.roleArn,
            policyDetails: {
                resourceTypes: ['VOLUME'],
                targetTags: [{
                    key: MONITORING_APP_TAG.key,
                    value: MONITORING_APP_TAG.value,
                }],
                schedules: [{
                    name: 'Daily Snapshots',
                    createRule: {
                        interval: 24,
                        intervalUnit: 'HOURS',
                        times: ['03:00'],
                    },
                    retainRule: {
                        count: snapshotRetentionDays,
                    },
                    copyTags: true,
                }],
            },
        });
    }

    /**
     * Grant attach volume permissions to an EC2 instance.
     */
    grantAttachVolume(instance: ec2.Instance): void {
        this.ebsConstruct.grantAttachVolume(instance);
    }

    /**
     * Grant detach volume permissions to an EC2 instance.
     */
    grantDetachVolume(instance: ec2.Instance): void {
        this.ebsConstruct.grantDetachVolume(instance);
    }

    /**
     * Grant attach volume permissions by resource tag.
     */
    grantAttachVolumeByResourceTag(
        grantee: iam.IRole,
        resourceTagScope: Construct[]
    ): void {
        this.ebsConstruct.grantAttachVolumeByResourceTag(grantee, resourceTagScope);
    }

    /**
     * Grant detach volume permissions by resource tag.
     * Useful for lifecycle Lambdas that need to detach tagged volumes.
     */
    grantDetachVolumeByResourceTag(
        grantee: iam.IRole,
        resourceTagScope: Construct[]
    ): void {
        this.ebsConstruct.grantDetachVolumeByResourceTag(grantee, resourceTagScope);
    }
}
