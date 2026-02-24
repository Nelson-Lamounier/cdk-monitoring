/**
 * @format
 * Monitoring Compute Stack (Consolidated)
 *
 * Creates compute and networking resources for monitoring services.
 * Includes security group creation + ASG compute.
 *
 * This consolidation reduces the monitoring project from 4 to 2 stacks:
 * - StorageStack: EBS + Lifecycle
 * - ComputeStack: SecurityGroup + Compute (this stack)
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    ScalingPolicyConfiguration,
    LaunchTemplateConstruct,
    UserDataBuilder,
} from '../../../common/index';
import {
    SecurityGroupConstruct,
    DEFAULT_MONITORING_PORTS,
} from '../../../common/security/security-group';
import { Environment } from '../../../config/environments';
import { nextjsSsmPaths } from '../../../config/ssm-paths';


/**
 * Props for MonitoringComputeStack
 */
export interface MonitoringComputeStackProps extends cdk.StackProps {
    /**
     * The VPC where compute resources will be created.
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

    // =================================================================
    // Security Group Configuration (integrated)
    // =================================================================

    /** Trusted CIDR blocks for security group access (ignored when ssmOnlyAccess is true) */
    readonly trustedCidrs: string[];

    /**
     * Enable SSM-only access mode (recommended for production)
     * When true: all CIDR-based ingress rules are skipped, access via SSM only
     * @default true
     */
    readonly ssmOnlyAccess?: boolean;

    // =================================================================
    // EBS Volume Configuration
    // =================================================================

    /** EBS volume ID for data persistence (from StorageStack) */
    readonly volumeId: string;

    /** Availability zone where EBS volume is located (ASG/EC2 will be constrained to this AZ) */
    readonly volumeAz: string;

    /**
     * KMS encryption key for the EBS volume (from StorageStack).
     * Required when volume uses a customer-managed KMS key.
     * The instance role needs kms:CreateGrant to attach encrypted volumes.
     */
    readonly ebsEncryptionKey?: kms.IKey;

    // =================================================================
    // Compute Configuration
    // =================================================================

    /** EC2 instance type @default t3.small */
    readonly instanceType?: ec2.InstanceType;

    /** SSH key pair name @default undefined */
    readonly keyPairName?: string;

    /** Root volume size in GB @default 30 */
    readonly volumeSizeGb?: number;

    /** Enable detailed CloudWatch monitoring @default true */
    readonly detailedMonitoring?: boolean;

    /** Auto Scaling configuration */
    readonly autoScalingConfig?: {
        readonly minCapacity?: number;
        readonly maxCapacity?: number;
        readonly desiredCapacity?: number;
        readonly scalingPolicy?: ScalingPolicyConfiguration;
    };

    /** Name prefix for resources @default 'monitoring' */
    readonly namePrefix?: string;

    /**
     * Loki endpoint URL for log forwarding (exported to SSM)
     * If provided, creates SSM parameter at /monitoring/{env}/loki/endpoint
     * @example 'http://10.0.0.197:3100/loki/api/v1/push'
     */
    readonly lokiEndpoint?: string;
}

/**
 * Compute Stack for Monitoring services.
 *
 * Creates a Launch Template + Auto Scaling Group for monitoring infrastructure.
 * UserData is built at the stack level for full control over instance setup.
 *
 * @example
 * ```typescript
 * const computeStack = new MonitoringComputeStack(app, 'Monitoring-ComputeStack-dev', {
 *     vpc,
 *     securityGroup: sgStack.securityGroup,
 *     volumeId: ebsStack.volumeId,
 *     namePrefix: 'monitoring-dev',
 * });
 * ```
 */
export class MonitoringComputeStack extends cdk.Stack {
    /** The security group for monitoring services */
    public readonly securityGroup: ec2.SecurityGroup;

    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for compute resources */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    /** ASG name (for EBS Lifecycle stack reference) */
    public readonly asgName: string;

    /** S3 bucket for monitoring scripts (imported from SSM stack) */
    public readonly scriptsBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: MonitoringComputeStackProps) {
        super(scope, id, props);

        // =================================================================
        // Input Validation
        // =================================================================
        if (props.volumeSizeGb !== undefined && props.volumeSizeGb <= 0) {
            throw new Error(`volumeSizeGb must be positive, got: ${props.volumeSizeGb}`);
        }

        // Resolve VPC: prefer vpcName (synth-time lookup) over direct vpc reference
        const resolvedVpc = props.vpcName
            ? ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName: props.vpcName })
            : props.vpc;

        if (!resolvedVpc) {
            throw new Error('MonitoringComputeStack requires either vpc or vpcName prop');
        }
        const vpc = resolvedVpc;

        const namePrefix = props.namePrefix ?? 'monitoring';
        const ssmOnlyAccess = props.ssmOnlyAccess ?? true;

        // =================================================================
        // Security Group (integrated into compute stack)
        // =================================================================
        const sgConstruct = new SecurityGroupConstruct(this, 'SecurityGroup', {
            vpc,
            trustedCidrs: props.trustedCidrs,
            ssmOnlyAccess,
            allowSsh: false,  // Use SSM Session Manager
            ports: DEFAULT_MONITORING_PORTS,
            namePrefix,
            description: 'Security group for monitoring services (Grafana, Prometheus)',
            purpose: 'Monitoring',
        });
        this.securityGroup = sgConstruct.securityGroup;

        // =================================================================
        // Cross-stack ingress: allow Prometheus to scrape ECS tasks
        //
        // The Next.js ECS task SG only allows port 3000 from the ALB.
        // Prometheus needs direct access to scrape /api/metrics.
        // We look up the task SG via SSM and add an ingress rule.
        // =================================================================
        const nextjsPaths = nextjsSsmPaths(Environment.PRODUCTION);
        const taskSgId = ssm.StringParameter.valueForStringParameter(
            this, nextjsPaths.taskSecurityGroupId,
        );
        const ecsTaskSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'EcsTaskSg', taskSgId,
        );
        ecsTaskSg.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(3000),
            'Allow Prometheus metrics scraping from monitoring instance',
        );

        // =================================================================
        // SSM Parameter Discovery
        //
        // Read the SSM document name, scripts bucket, and execution policy
        // from SSM parameters written by the MonitoringSsmStack.
        // No cross-stack CloudFormation dependency.
        // =================================================================
        const ssmDocumentName = ssm.StringParameter.valueForStringParameter(
            this, `/${namePrefix}/ssm/document-name`,
        );
        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `/${namePrefix}/ssm/scripts-bucket-name`,
        );
        this.scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);

        const ssmExecutionPolicyArn = ssm.StringParameter.valueForStringParameter(
            this, `/${namePrefix}/ssm/execution-policy-arn`,
        );

        // =================================================================
        // KMS Key for CloudWatch Log Group Encryption (CKV_AWS_158)
        // =================================================================
        const logGroupKmsKey = new kms.Key(this, 'LogGroupKey', {
            alias: `${namePrefix}-log-group`,
            description: `KMS key for ${namePrefix} CloudWatch log group encryption`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // CloudWatch Logs requires an explicit key policy to use a CMK
        logGroupKmsKey.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                'kms:Encrypt*',
                'kms:Decrypt*',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
                'kms:Describe*',
            ],
            principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
            resources: ['*'],
            conditions: {
                ArnLike: {
                    'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:/ec2/${namePrefix}/*`,
                },
            },
        }));

        // =================================================================
        // Compute Resources: LaunchTemplate + AutoScalingGroup
        //
        // For proper cfn-signal support, we need to:
        // 1. Create the base user data without cfn-signal
        // 2. Create the ASG to get its logical ID
        // 3. Add cfn-signal commands referencing the ASG
        // =================================================================

        // Step 1: Create LaunchTemplate to establish the ASG context
        // We need the ASG logical ID for cfn-signal, which requires circular setup
        const userData = ec2.UserData.forLinux();

        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup: this.securityGroup,
            instanceType: props.instanceType,
            volumeSizeGb: props.volumeSizeGb,
            keyPairName: props.keyPairName,
            detailedMonitoring: props.detailedMonitoring,
            userData,
            namePrefix,
            logGroupKmsKey,
        });

        // maxCapacity MUST be 1 for singleton EBS volumes.
        // The dedicated EBS volume can only attach to one instance at a time.
        // With maxCapacity > 1, rolling updates launch a second instance that
        // cannot attach the volume → user-data fails → cfn-signal FAILURE → rollback.
        // CloudFormation will terminate the old instance first (minInstancesInService=0),
        // the lifecycle hook detaches the volume, then the replacement instance attaches it.
        // This causes a brief monitoring gap during replacement.
        const maxCapacity = 1;

        const asgConstruct = new AutoScalingGroupConstruct(this, 'Compute', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: props.autoScalingConfig?.minCapacity ?? 1,
            maxCapacity,
            desiredCapacity: props.autoScalingConfig?.desiredCapacity ?? 1,
            scalingPolicy: props.autoScalingConfig?.scalingPolicy,
            // Rolling update: minInstancesInService MUST be 0 for EBS-backed instances.
            // The dedicated EBS volume can only be attached to one instance at a time.
            // With minInstancesInService=1, CloudFormation keeps the old instance alive
            // (volume still attached) while the new instance tries to attach it → fails.
            // Setting 0 allows CloudFormation to terminate the old instance first,
            // the lifecycle hook detaches the volume, then the new instance attaches it.
            // This causes a brief monitoring gap during replacement.
            rollingUpdate: {
                minInstancesInService: 0,
                // Must match signalsTimeoutMinutes — CloudFormation uses PauseTime
                // (not CreationPolicy timeout) as the signal wait during rolling updates.
                pauseTimeMinutes: 15,
            },
            namePrefix,
            enableTerminationLifecycleHook: true,
            useSignals: true,
            signalsTimeoutMinutes: 15,
            // Constrain to same AZ as EBS volume - volumes cannot cross AZs
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [props.volumeAz],
            },
        });

        // Step 2: Get ASG logical resource ID for cfn-signal
        const asgCfnResource = asgConstruct.autoScalingGroup.node.defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // Step 3: User data (single pipeline via UserDataBuilder)
        //
        // UserDataBuilder operates directly on the CDK UserData object,
        // so CDK Tokens (props.volumeId, this.stackName, ssmDocumentName)
        // resolve correctly via Fn::Join at synth time.
        //
        // ORDERING: cfn-signal is sent after critical infrastructure
        // (system update, AWS CLI, EBS attach) but BEFORE Docker install.
        // This prevents Docker/dnf failures from blocking the cfn-signal,
        // which would cause CREATE_FAILED with 0 SUCCESS signals.
        // Docker install happens after signaling — the SSM Association
        // has a Docker readiness wait loop to handle this timing.
        //
        // skipPreamble: true because CDK's UserData.forLinux() already adds
        // the shebang line. We add the logging preamble here.
        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            'echo "=== User data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .updateSystem()
            .installAwsCli()
            .attachEbsVolume({
                volumeId: props.volumeId,
                mountPoint: '/data',
            })
            .sendCfnSignal({
                stackName: this.stackName,
                asgLogicalId,
                region: this.region,
            })
            .installDocker()
            .addCompletionMarker();

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.asgName = this.autoScalingGroup.autoScalingGroupName;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // =================================================================
        // IAM Grants
        // =================================================================

        // Grant EBS attach/detach permissions
        // Note: Describe* actions require resource: '*'
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'EbsVolumeManagement',
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:AttachVolume',
                'ec2:DetachVolume',
                'ec2:DescribeVolumes',
                'ec2:DescribeInstances',
            ],
            resources: ['*'],
        }));

        // Grant KMS permissions for encrypted EBS volume attachment.
        // Without these, AttachVolume fails with CustomerKeyHasBeenRevoked
        // when the volume uses a customer-managed KMS key.
        if (props.ebsEncryptionKey) {
            props.ebsEncryptionKey.grant(
                this.instanceRole,
                'kms:CreateGrant',
                'kms:Decrypt',
                'kms:DescribeKey',
                'kms:GenerateDataKeyWithoutPlaintext',
                'kms:ReEncryptFrom',
                'kms:ReEncryptTo',
            );
        }

        // =================================================================
        // SSM Execution Policy (from SSM Stack)
        //
        // The SSM stack creates a managed policy with ALL permissions needed
        // for SSM document execution (S3 read, SSM write endpoints, SSM read
        // GitHub token, SSM run command). We import and attach it here to
        // keep the SSM stack fully independent.
        // =================================================================
        const ssmPolicy = iam.ManagedPolicy.fromManagedPolicyArn(
            this, 'SsmExecutionPolicy', ssmExecutionPolicyArn,
        );
        (this.instanceRole as iam.Role).addManagedPolicy(ssmPolicy);

        // =================================================================
        // CloudWatch Read Permissions (for Grafana CloudWatch datasource)
        // =================================================================
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'CloudWatchMetricsRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:GetMetricData',
                'cloudwatch:GetMetricStatistics',
                'cloudwatch:ListMetrics',
                'cloudwatch:DescribeAlarmsForMetric',
                'cloudwatch:DescribeAlarmHistory',
                'cloudwatch:DescribeAlarms',
                'cloudwatch:ListDashboards',
                'cloudwatch:GetDashboard',
            ],
            resources: ['*'],
        }));

        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'CloudWatchLogsRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:DescribeLogGroups',
                'logs:GetLogGroupFields',
                'logs:StartQuery',
                'logs:StopQuery',
                'logs:GetQueryResults',
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
            ],
            resources: ['*'],
        }));

        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'ResourceTagsRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'tag:GetResources',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // X-Ray Read Permissions (for Grafana X-Ray datasource)
        // Enables distributed tracing visualization in Grafana.
        // API Gateway and Lambda already emit X-Ray traces (enableTracing).
        // =================================================================
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'XRayTracesRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'xray:GetTraceSummaries',
                'xray:BatchGetTraces',
                'xray:GetServiceGraph',
                'xray:GetTraceGraph',
                'xray:GetInsightSummaries',
                'xray:GetGroups',
                'xray:GetGroup',
                'xray:GetTimeSeriesServiceStatistics',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // SSM State Manager Association
        //
        // Automatically runs the SSM document on any new instance that
        // registers with SSM Agent and matches the ASG tag. This replaces
        // the previous user-data triggerSsmConfiguration approach, fully
        // decoupling application config from OS bootstrap.
        //
        // Re-run manually: aws ssm send-command --document-name <doc> ...
        // =================================================================
        new ssm.CfnAssociation(this, 'SsmConfigAssociation', {
            name: ssmDocumentName,
            targets: [{
                key: 'tag:aws:autoscaling:groupName',
                values: [this.autoScalingGroup.autoScalingGroupName],
            }],
            associationName: `${namePrefix}-configure-stack`,
            applyOnlyAtCronInterval: false,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: this.instanceRole.roleArn,
            description: 'Instance IAM Role ARN',
            exportName: `${this.stackName}-role-arn`,
        });

        new cdk.CfnOutput(this, 'AutoScalingGroupName', {
            value: this.autoScalingGroup.autoScalingGroupName,
            description: 'Auto Scaling Group Name',
            exportName: `${this.stackName}-asg-name`,
        });

        new cdk.CfnOutput(this, 'AutoScalingGroupArn', {
            value: this.autoScalingGroup.autoScalingGroupArn,
            description: 'Auto Scaling Group ARN',
        });

        if (this.logGroup) {
            new cdk.CfnOutput(this, 'LogGroupName', {
                value: this.logGroup.logGroupName,
                description: 'CloudWatch Log Group Name',
            });
        }

        // =================================================================
        // Loki/Tempo Endpoint SSM Parameters
        // NOTE: These are now written DYNAMICALLY at EC2 boot (user-data)
        // using the instance's private IP. The CDK creates placeholder
        // parameters so the Next.js stack synthesis doesn't fail on
        // ssm.StringParameter.valueForStringParameter() lookups.
        // The EC2's user-data overwrites these with the real IP at boot.
        // =================================================================
        new ssm.StringParameter(this, 'LokiEndpointParam', {
            parameterName: `/${namePrefix}/loki/endpoint`,
            stringValue: props.lokiEndpoint ?? 'placeholder://set-at-boot',
            description: 'Loki push endpoint (overwritten at EC2 boot with real IP)',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'TempoEndpointParam', {
            parameterName: `/${namePrefix}/tempo/endpoint`,
            stringValue: 'placeholder://set-at-boot',
            description: 'Tempo OTLP endpoint (overwritten at EC2 boot with real IP)',
            tier: ssm.ParameterTier.STANDARD,
        });

        if (props.lokiEndpoint) {
            new cdk.CfnOutput(this, 'LokiEndpoint', {
                value: props.lokiEndpoint,
                description: 'Loki endpoint URL (static fallback — real value set at boot)',
            });
        }

        // =================================================================
        // Monitoring SG SSM Parameter (for cross-project discovery)
        // NextJS Compute Stack imports this to allow Prometheus scraping
        // =================================================================
        new ssm.StringParameter(this, 'MonitoringSgIdParam', {
            parameterName: `/${namePrefix}/security-group/id`,
            stringValue: this.securityGroup.securityGroupId,
            description: 'Monitoring security group ID for cross-project Prometheus scraping',
            tier: ssm.ParameterTier.STANDARD,
        });
    }
}

