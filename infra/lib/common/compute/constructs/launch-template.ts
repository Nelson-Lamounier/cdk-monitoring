/**
 * @format
 * Launch Template Construct
 *
 * Reusable Launch Template construct — a pure blueprint for launch template creation.
 * ONLY accepts SecurityGroup from the stack. No internal security group creation.
 *
 * Features:
 * - IMDSv2 required (security best practice)
 * - Encrypted GP3 EBS volumes with configurable IOPS/throughput
 * - IAM role with SSM and CloudWatch permissions (or bring your own)
 * - CloudWatch log group for instance logs
 * - Latest Amazon Linux 2023 AMI (or custom)
 *
 * Design Philosophy:
 * - Construct is a blueprint, not a configuration handler
 * - Stack creates SecurityGroupConstruct → passes securityGroup here
 * - This construct handles launch template-specific logic ONLY
 *
 * Blueprint Pattern Flow:
 * 1. Stack creates SecurityGroupConstruct → securityGroup
 * 2. Stack creates LaunchTemplateConstruct (with securityGroup) → launchTemplate
 * 3. Stack creates AutoScalingGroupConstruct (with launchTemplate) → autoScalingGroup
 *
 * Relationship to Ec2InstanceConstruct:
 * Both constructs share similar patterns (IAM role, log group, encrypted GP3 EBS,
 * IMDSv2). This construct creates a LaunchTemplate (for ASGs); Ec2InstanceConstruct
 * creates a standalone Instance. A future refactoring opportunity is to extract the
 * shared IAM role + log group + EBS configuration into a base utility.
 *
 * Naming convention:
 * The `namePrefix` prop is expected to be environment-aware (e.g., 'monitoring-development',
 * 'nextjs-ecs-production'). It is used in the launch template name, role name, and log group
 * name to prevent collisions across environments in the same account.
 *
 * Tag strategy:
 * Only `Component: LaunchTemplate` is applied here. Organizational tags
 * (Environment, Project, Owner, ManagedBy) come from TaggingAspect at app level.
 *
 * @example
 * ```typescript
 * // Step 1: Stack creates Security Group
 * const sgConstruct = new SecurityGroupConstruct(this, 'SG', {
 *     vpc,
 *     trustedCidrs: ['10.0.0.0/8'],
 *     namePrefix: 'nextjs-ecs',
 * });
 *
 * // Step 2: Stack creates Launch Template
 * const ltConstruct = new LaunchTemplateConstruct(this, 'LT', {
 *     securityGroup: sgConstruct.securityGroup,
 *     instanceType: new ec2.InstanceType('t3.medium'),
 *     machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
 *     namePrefix: 'nextjs-ecs-development',
 *     additionalManagedPolicies: [
 *         iam.ManagedPolicy.fromAwsManagedPolicyName(
 *             'service-role/AmazonEC2ContainerServiceforEC2Role',
 *         ),
 *     ],
 * });
 *
 * // Step 3: Stack creates ASG
 * const asgConstruct = new AutoScalingGroupConstruct(this, 'ASG', {
 *     vpc,
 *     launchTemplate: ltConstruct.launchTemplate,
 * });
 *
 * // Grant policies to the instance role (works with both created and existing roles)
 * ltConstruct.addToRolePolicy(new iam.PolicyStatement({
 *     actions: ['s3:GetObject'],
 *     resources: ['arn:aws:s3:::my-bucket/*'],
 * }));
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';



/**
 * Props for LaunchTemplateConstruct
 */
export interface LaunchTemplateConstructProps {
    /**
     * Security group for the instances (REQUIRED).
     * Must be created by the stack using SecurityGroupConstruct or raw ec2.SecurityGroup.
     * This construct does NOT create security groups internally.
     */
    readonly securityGroup: ec2.ISecurityGroup;

    /** Instance type @default t3.small */
    readonly instanceType?: ec2.InstanceType;

    /** EBS root volume size in GB @default 30 */
    readonly volumeSizeGb?: number;

    /** EBS volume IOPS @default 3000 */
    readonly volumeIops?: number;

    /** EBS volume throughput in MiB/s @default 125 */
    readonly volumeThroughput?: number;

    /** SSH key pair name @default undefined */
    readonly keyPairName?: string;

    /** Enable detailed CloudWatch monitoring @default true */
    readonly detailedMonitoring?: boolean;

    /** User data to run on instance launch @default undefined (no user data) */
    readonly userData?: ec2.UserData;

    /** Custom machine image @default Amazon Linux 2023 */
    readonly machineImage?: ec2.IMachineImage;

    /**
     * Existing IAM role to attach.
     * When provided, the construct skips role creation and uses this role.
     * The log group write grant is still applied to the existing role.
     * @default creates new role
     */
    readonly existingRole?: iam.IRole;

    /** Additional IAM managed policies to attach (only when creating new role) */
    readonly additionalManagedPolicies?: iam.IManagedPolicy[];

    /**
     * Name prefix for resources.
     * Should be environment-aware (e.g., 'monitoring-development') to prevent
     * collisions across environments in the same AWS account.
     * @default 'monitoring'
     */
    readonly namePrefix?: string;

    /** Whether to create a CloudWatch log group @default true */
    readonly createLogGroup?: boolean;

    /** KMS key for log group encryption @default undefined (uses AWS-managed key) */
    readonly logGroupKmsKey?: kms.IKey;

    /** Log retention period @default ONE_MONTH */
    readonly logRetention?: logs.RetentionDays;

    /**
     * Disable Source/Destination Check on the network interface.
     *
     * Required for Kubernetes pod overlay networking (Calico, Flannel, etc.).
     * Without this, AWS drops cross-node pod traffic because pod IPs
     * don't match the ENI's private IP.
     *
     * @default false (AWS default: source/dest check enabled)
     */
    readonly disableSourceDestCheck?: boolean;
}

/**
 * Reusable Launch Template construct for EC2 instances.
 *
 * This is a pure blueprint that ONLY accepts a security group from the stack.
 * The stack is responsible for creating:
 * 1. SecurityGroupConstruct → securityGroup
 * 2. This construct (with securityGroup) → launchTemplate
 * 3. AutoScalingGroupConstruct (with launchTemplate)
 *
 * Security Features:
 * - IMDSv2 required (protects against SSRF attacks)
 * - EBS encryption enabled by default
 * - GP3 volumes for consistent performance
 */
export class LaunchTemplateConstruct extends Construct {
    /** The Launch Template */
    public readonly launchTemplate: ec2.LaunchTemplate;

    /** IAM role attached to instances */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs (if created) */
    public readonly logGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: LaunchTemplateConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'monitoring';
        const volumeSize = props.volumeSizeGb ?? 30;
        const volumeIops = props.volumeIops ?? 3000;
        const volumeThroughput = props.volumeThroughput ?? 125;
        const createLogGroup = props.createLogGroup ?? true;

        // =================================================================
        // CLOUDWATCH LOG GROUP
        // =================================================================
        if (createLogGroup) {
            this.logGroup = new logs.LogGroup(this, 'LogGroup', {
                logGroupName: `/ec2/${namePrefix}/instances`,
                retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
                encryptionKey: props.logGroupKmsKey,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });
        }

        // =================================================================
        // IAM ROLE
        // =================================================================
        if (props.existingRole) {
            this.instanceRole = props.existingRole;
        } else {
            const role = new iam.Role(this, 'InstanceRole', {
                assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
                description: `IAM role for ${namePrefix} EC2 instances`,
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                    iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
                    ...(props.additionalManagedPolicies ?? []),
                ],
            });
            this.instanceRole = role;
        }

        // Grant log group write to ALL roles (created or existing).
        // Previously this only happened for created roles — an existing role
        // would silently lack CloudWatch Logs permissions.
        if (this.logGroup) {
            this.logGroup.grantWrite(this.instanceRole);
        }

        // =================================================================
        // LAUNCH TEMPLATE
        // =================================================================
        this.launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
            launchTemplateName: `${namePrefix}-lt`,
            instanceType: props.instanceType ?? ec2.InstanceType.of(
                ec2.InstanceClass.T3,
                ec2.InstanceSize.SMALL,
            ),
            machineImage: props.machineImage ?? ec2.MachineImage.latestAmazonLinux2023(),
            securityGroup: props.securityGroup,
            role: this.instanceRole,
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
                        iops: volumeIops,
                        throughput: volumeThroughput,
                    }),
                },
            ],
            detailedMonitoring: props.detailedMonitoring ?? true,
            requireImdsv2: true,
            // Only attach user data when explicitly provided.
            // undefined is valid for LaunchTemplate.userData — an empty
            // UserData.forLinux() would add a shebang-only script to every instance.
            userData: props.userData,
        });

        // =================================================================
        // SOURCE/DEST CHECK OVERRIDE (Kubernetes overlay networking)
        //
        // When disableSourceDestCheck is true, we use a CloudFormation
        // escape hatch to set SourceDestCheck: false via NetworkInterfaces.
        // CloudFormation requires SecurityGroupIds to be removed when
        // NetworkInterfaces is present (they are mutually exclusive).
        // =================================================================
        if (props.disableSourceDestCheck) {
            const cfnLaunchTemplate = this.launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;

            // Remove top-level SecurityGroupIds (mutually exclusive with NetworkInterfaces)
            cfnLaunchTemplate.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');

            // Add NetworkInterfaces with SourceDestCheck disabled
            cfnLaunchTemplate.addPropertyOverride(
                'LaunchTemplateData.NetworkInterfaces',
                [{
                    DeviceIndex: 0,
                    Groups: [props.securityGroup.securityGroupId],
                    SourceDestCheck: false,
                }],
            );
        }

        // =================================================================
        // TAGS
        //
        // Organizational tags (Environment, Project, Owner, ManagedBy) are
        // applied by TaggingAspect at the app level — not duplicated here.
        // =================================================================
        cdk.Tags.of(this.launchTemplate).add('Component', 'LaunchTemplate');
    }

    // =========================================================================
    // GRANT HELPERS
    // =========================================================================

    /**
     * Add an IAM policy statement to the instance role.
     *
     * Uses `addToPrincipalPolicy` which works on both concrete `Role` and
     * imported `IRole`. This replaces the previous `grantS3Read` and
     * `grantSecretsManagerRead` methods that silently no-op'd when using
     * an existing role (due to `instanceof iam.Role` check).
     *
     * @param statement The IAM policy statement to add
     *
     * @example
     * ```typescript
     * // S3 read access
     * lt.addToRolePolicy(new iam.PolicyStatement({
     *     actions: ['s3:GetObject', 's3:ListBucket'],
     *     resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
     * }));
     *
     * // Secrets Manager read
     * lt.addToRolePolicy(new iam.PolicyStatement({
     *     actions: ['secretsmanager:GetSecretValue'],
     *     resources: [secret.secretArn],
     * }));
     *
     * // DynamoDB access
     * lt.addToRolePolicy(new iam.PolicyStatement({
     *     actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
     *     resources: [table.tableArn],
     * }));
     * ```
     */
    addToRolePolicy(statement: iam.PolicyStatement): void {
        this.instanceRole.addToPrincipalPolicy(statement);
    }
}
