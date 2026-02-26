/**
 * @format
 * NextJS Compute Stack
 *
 * Consolidated compute resources for the Next.js application.
 * This stack combines ECS Cluster and IAM Roles.
 *
 * Domain: Compute Layer (rarely changes)
 *
 * Resources:
 * 1. IAM Roles (EC2 Instance, Task Execution, Task)
 * 2. ECS Security Group (for EC2 instances)
 * 3. Launch Template (EC2 configuration)
 * 4. Auto Scaling Group (capacity management)
 * 5. ECS Cluster (EC2-backed with capacity provider)
 *
 * @example
 * ```typescript
 * const computeStack = new NextJsComputeStack(app, 'NextJS-ComputeStack-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     vpc: sharedVpc,
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudmap from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    EcsClusterConstruct,
    LaunchTemplateConstruct,
    AutoScalingGroupConstruct,
} from '../../../common/compute';
import { EcsSecurityGroupConstruct } from '../../../common/security';
import { EcsCapacityType } from '../../../config/defaults';
import { Environment } from '../../../config/environments';
import { getNextJsConfigs } from '../../../config/nextjs/configurations';
import { nextjsSsmPaths } from '../../../config/ssm-paths';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Props for NextJsComputeStack
 */
export interface NextJsComputeStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /**
     * VPC for the cluster.
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

    /** Instance type for EC2 instances @default t3.small */
    readonly instanceType?: ec2.InstanceType;

    /** Minimum ASG capacity @default 1 */
    readonly minCapacity?: number;

    /** Maximum ASG capacity @default 2 */
    readonly maxCapacity?: number;

    /** SSH key pair name (optional) */
    readonly keyPairName?: string;

    /**
     * SSM parameter path pattern for secrets access
     * Task execution role gets ssm:GetParameter(s) for this path
     * @example '/nextjs/prod/*'
     */
    readonly ssmParameterPath?: string;

    /**
     * Secrets Manager path pattern for secrets access
     * Task execution role gets secretsmanager:GetSecretValue for this path
     * @example 'nextjs/development/*'
     */
    readonly secretsManagerPathPattern?: string;

    /**
     * KMS key ARN for decrypting secrets (optional)
     */
    readonly secretsKmsKeyArn?: string;

    /**
     * S3 bucket ARNs the application needs read access
     */
    readonly s3ReadBucketArns?: string[];

    /**
     * DynamoDB table ARNs the application needs access
     */
    readonly dynamoTableArns?: string[];

    /**
     * SSM parameter path for DynamoDB KMS key ARN (customer-managed).
     * When provided, task role gets kms:Decrypt + kms:DescribeKey
     * to read from the encrypted table during SSR.
     * Resolved at deploy time via SSM, matching the monitoringSgSsmPath pattern.
     * @example '/nextjs/production/dynamodb-kms-key-arn'
     */
    readonly dynamoKmsKeySsmPath?: string;

    /**
     * Optional permissions boundary ARN for all roles
     */
    readonly permissionsBoundaryArn?: string;

    /**
     * Monitoring Security Group ID for Prometheus scraping (from SSM)
     * Enables port 9100 (Node Exporter) + port 3000 (app /metrics) ingress
     */
    /**
     * SSM parameter path for monitoring security group ID.
     * When provided, the stack resolves the SG ID internally via SSM,
     * avoiding cross-stack CloudFormation exports.
     * Takes precedence over monitoringSecurityGroupId.
     * @example '/monitoring-development/security-group/id'
     */
    readonly monitoringSgSsmPath?: string;

    /** Direct monitoring security group ID (creates cross-stack export if from another stack) */
    readonly monitoringSecurityGroupId?: string;

    /** Name prefix @default 'nextjs' */
    readonly namePrefix?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * NextJsComputeStack - Consolidated compute layer for Next.js application
 *
 * This stack consolidates all compute resources into a single deployment unit:
 *
 * IAM Roles:
 * - EC2 Instance Role: ECS agent + SSM + CloudWatch
 * - Task Execution Role: ECR pull + secrets + logging
 * - Task Role: Application runtime permissions
 *
 * ECS Cluster:
 * - EC2-backed with Auto Scaling Group
 * - Container Insights enabled
 * - Execute command with KMS-encrypted logging
 * - Managed scaling capacity provider
 */
export class NextJsComputeStack extends cdk.Stack {
    // IAM Roles
    public readonly ec2InstanceRole: iam.Role;
    public readonly taskExecutionRole: iam.Role;
    public readonly taskRole: iam.Role;
    
    // Role names for cross-stack ARN construction (avoids cyclic dependencies)
    public readonly taskExecutionRoleName: string;
    public readonly taskRoleName: string;

    // ECS Cluster
    public readonly cluster: ecs.Cluster;
    public readonly autoScalingGroup: AutoScalingGroupConstruct;
    public readonly capacityProvider: ecs.AsgCapacityProvider;
    public readonly executeCommandKmsKey?: kms.IKey;

    // Cloud Map (Service Discovery)
    public readonly cloudMapNamespace: cloudmap.PrivateDnsNamespace;
    public readonly executeCommandLogGroup?: logs.ILogGroup;

    // Security & Launch
    public readonly securityGroupConstruct: EcsSecurityGroupConstruct;
    public readonly launchTemplate: LaunchTemplateConstruct;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NextJsComputeStackProps) {
        super(scope, id, props);

        // Resolve VPC: prefer vpcName (synth-time lookup) over direct vpc reference
        if (!props.vpc && !props.vpcName) {
            throw new Error('NextJsComputeStack requires either vpc or vpcName prop');
        }
        const vpc = props.vpcName
            ? ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName: props.vpcName })
            : props.vpc!;

        this.targetEnvironment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'nextjs';
        const environment = props.targetEnvironment;
        const configs = getNextJsConfigs(environment);
        const clusterName = `${namePrefix}-cluster-${environment}`;

        // =================================================================
        // IAM ROLES
        // =================================================================

        const permissionsBoundary = props.permissionsBoundaryArn
            ? iam.ManagedPolicy.fromManagedPolicyArn(
                  this,
                  'PermissionsBoundary',
                  props.permissionsBoundaryArn
              )
            : undefined;

        // EC2 Instance Role
        const ec2InstanceRoleName = `${namePrefix}-ec2-instance-${environment}`;
        this.ec2InstanceRole = new iam.Role(this, 'Ec2InstanceRole', {
            roleName: ec2InstanceRoleName,
            description: `EC2 instance role for ECS hosts (${environment})`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            permissionsBoundary,
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonEC2ContainerServiceforEC2Role'
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
            ],
        });

        // Task Execution Role - use explicit name for cross-stack ARN construction
        this.taskExecutionRoleName = `${namePrefix}-task-exec-${environment}`;
        this.taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
            roleName: this.taskExecutionRoleName,
            description: `ECS task execution role (${environment})`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            permissionsBoundary,
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonECSTaskExecutionRolePolicy'
                ),
            ],
        });

        // Pre-grant CloudWatch Logs permissions
        this.taskExecutionRole.addToPolicy(
            new iam.PolicyStatement({
                sid: 'CloudWatchLogsAccess',
                effect: iam.Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: [
                    `arn:aws:logs:${this.region}:${this.account}:log-group:/ecs/${namePrefix}/*:*`,
                ],
            })
        );

        // SSM parameter access
        if (props.ssmParameterPath) {
            this.taskExecutionRole.addToPolicy(
                new iam.PolicyStatement({
                    sid: 'SsmSecretsAccess',
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:GetParameters', 'ssm:GetParameter'],
                    resources: [
                        `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmParameterPath}`,
                    ],
                })
            );
        }

        // Secrets Manager access for container secrets
        if (props.secretsManagerPathPattern) {
            this.taskExecutionRole.addToPolicy(
                new iam.PolicyStatement({
                    sid: 'SecretsManagerAccess',
                    effect: iam.Effect.ALLOW,
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [
                        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.secretsManagerPathPattern}`,
                    ],
                })
            );
        }

        // KMS decrypt for secrets
        if (props.secretsKmsKeyArn) {
            this.taskExecutionRole.addToPolicy(
                new iam.PolicyStatement({
                    sid: 'KmsDecryptSecrets',
                    effect: iam.Effect.ALLOW,
                    actions: ['kms:Decrypt'],
                    resources: [props.secretsKmsKeyArn],
                })
            );
        }

        // Task Role (application runtime) - use explicit name for cross-stack ARN construction
        this.taskRoleName = `${namePrefix}-task-role-${environment}`;
        this.taskRole = new iam.Role(this, 'TaskRole', {
            roleName: this.taskRoleName,
            description: `ECS task role for app runtime (${environment})`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            permissionsBoundary,
        });

        // S3 read access
        if (props.s3ReadBucketArns && props.s3ReadBucketArns.length > 0) {
            this.taskRole.addToPolicy(
                new iam.PolicyStatement({
                    sid: 'S3ReadAccess',
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:GetObject', 's3:GetObjectVersion'],
                    resources: props.s3ReadBucketArns.map((arn) => `${arn}/*`),
                })
            );
        }

        // DynamoDB read access (SSR queries only — writes go through API Gateway → Lambda)
        if (props.dynamoTableArns && props.dynamoTableArns.length > 0) {
            this.taskRole.addToPolicy(
                new iam.PolicyStatement({
                    sid: 'DynamoDbReadAccess',
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'dynamodb:GetItem',
                        'dynamodb:Query',
                        'dynamodb:Scan',
                    ],
                    resources: [
                        ...props.dynamoTableArns,
                        // GSI access (e.g. gsi1-status-date for article listings)
                        ...props.dynamoTableArns.map((arn) => `${arn}/index/*`),
                    ],
                })
            );
        }

        // KMS Decrypt for DynamoDB customer-managed encryption key
        // Without this, SSR queries fail with AccessDeniedException when
        // the table uses a customer-managed KMS key (production).
        // Resolved from SSM at deploy time (same pattern as monitoringSgSsmPath).
        if (props.dynamoKmsKeySsmPath) {
            const dynamoKmsKeyArn = ssm.StringParameter.valueForStringParameter(
                this, props.dynamoKmsKeySsmPath,
            );
            this.taskRole.addToPolicy(
                new iam.PolicyStatement({
                    sid: 'KmsDecryptDynamoDb',
                    effect: iam.Effect.ALLOW,
                    actions: ['kms:Decrypt', 'kms:DescribeKey'],
                    resources: [dynamoKmsKeyArn],
                })
            );
        }


        // =================================================================
        // ECS SECURITY GROUP
        // =================================================================

        // Import monitoring security group for Prometheus scraping (if provided).
        // NOTE: valueForStringParameter returns a CloudFormation token, not a real
        // SG ID at synth time. This is fine because EcsSecurityGroupConstruct only
        // uses the ISecurityGroup as an addIngressRule peer (CDK resolves it via
        // { Ref } in the template). Do NOT inspect monitoringSgId as a string —
        // it's a token, not a literal sg-xxx value.
        const monitoringSgId = props.monitoringSgSsmPath
            ? ssm.StringParameter.valueForStringParameter(this, props.monitoringSgSsmPath)
            : props.monitoringSecurityGroupId;
        const monitoringSg = monitoringSgId
            ? ec2.SecurityGroup.fromSecurityGroupId(
                  this,
                  'MonitoringSG',
                  monitoringSgId
              )
            : undefined;

        this.securityGroupConstruct = new EcsSecurityGroupConstruct(this, 'SecurityGroup', {
            vpc,
            namePrefix: `${namePrefix}-ecs`,
            environment,
            monitoringSecurityGroup: monitoringSg,
        });

        // =================================================================
        // USER DATA (ECS Agent Configuration)
        // =================================================================

        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            // Strict error handling — if ECS config fails, signal CFN and terminate
            'set -euo pipefail',
            `trap 'echo "UserData FAILED"; /opt/aws/bin/cfn-signal -e 1 --region ${this.region} --stack ${this.stackName} --resource AutoScalingGroup || true; shutdown -h now' ERR`,
            `echo "ECS_CLUSTER=${clusterName}" >> /etc/ecs/ecs.config`,
            'echo "ECS_ENABLE_TASK_IAM_ROLE=true" >> /etc/ecs/ecs.config',
            'echo "ECS_ENABLE_TASK_ENI=true" >> /etc/ecs/ecs.config',
            'echo "ECS_AWSVPC_BLOCK_IMDS=true" >> /etc/ecs/ecs.config'
        );

        // =================================================================
        // LAUNCH TEMPLATE
        // =================================================================

        this.launchTemplate = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup: this.securityGroupConstruct.securityGroup,
            instanceType: props.instanceType ?? new ec2.InstanceType('t3.small'),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
            keyPairName: props.keyPairName,
            userData,
            existingRole: this.ec2InstanceRole,
            namePrefix: `${namePrefix}-ecs-${environment}`,
            createLogGroup: true,
            logRetention: configs.ecsTask.logRetention,
        });

        // =================================================================
        // AUTO SCALING GROUP
        // =================================================================

        this.autoScalingGroup = new AutoScalingGroupConstruct(this, 'AutoScalingGroup', {
            vpc,
            launchTemplate: this.launchTemplate.launchTemplate,
            minCapacity: props.minCapacity ?? 1,
            maxCapacity: props.maxCapacity ?? 2,
            namePrefix: `${namePrefix}-ecs-${environment}`,
            // PUBLIC SUBNET TRADEOFF: Placing ECS instances in public subnets avoids
            // the ~$30-90/mo NAT Gateway cost. Acceptable for this portfolio project
            // because: (1) security groups restrict inbound traffic, (2) IMDSv2 is
            // enforced, (3) IMDS is blocked from tasks (ECS_AWSVPC_BLOCK_IMDS=true).
            // For production workloads, use PRIVATE subnets + NAT Gateway instead.
            subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
            useSignals: false,
            disableScalingPolicy: true, // ECS manages scaling
        });

        // =================================================================
        // ECS CLUSTER
        // =================================================================

        const ecsCluster = new EcsClusterConstruct(this, 'EcsCluster', {
            vpc,
            clusterName,
            capacityType: EcsCapacityType.EC2,
            containerInsights: ecs.ContainerInsights.ENABLED,
            executeCommand: {
                enabled: true,
                useKmsEncryption: true,
                logRetentionDays: configs.ecsTask.logRetention,
            },
            ec2Capacity: {
                autoScalingGroup: this.autoScalingGroup.autoScalingGroup,
            },
            environment,
            namePrefix,
        });

        // Grant KMS permissions to instance role
        ecsCluster.grantExecuteCommandKmsDecrypt(this.launchTemplate.instanceRole);

        // Expose cluster properties
        this.cluster = ecsCluster.cluster;
        this.capacityProvider = ecsCluster.ec2CapacityProvider!;
        this.executeCommandKmsKey = ecsCluster.executeCommandKmsKey;
        this.executeCommandLogGroup = ecsCluster.executeCommandLogGroup;

        // =================================================================
        // CLOUD MAP NAMESPACE (Service Discovery)
        // ECS auto-registers/deregisters task IPs when tasks start/stop.
        // Monitoring stack reads from Cloud Map via DiscoverInstances API.
        // =================================================================
        this.cloudMapNamespace = new cloudmap.PrivateDnsNamespace(this, 'CloudMapNamespace', {
            name: `${namePrefix}.local`,
            vpc,
            description: `Service discovery namespace for ${namePrefix} ECS services`,
        });

        // Namespace name/ARN exported via SSM below (after ssmPrefix is defined)

        // =================================================================
        // CDK-NAG SUPPRESSIONS
        // =================================================================

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AutoScalingGroup/AutoScalingGroup/DrainECSHook/Function/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Lambda runtime is managed by CDK ECS drain hook, not customizable',
                },
                {
                    id: 'AwsSolutions-IAM5',
                    reason: 'Lambda permissions are managed by CDK ECS drain hook, not customizable',
                },
                {
                    id: 'AwsSolutions-SQS3',
                    reason: 'CDK-managed drain hook Lambda - DLQ cannot be configured',
                },
                {
                    id: 'CKV_AWS_116',
                    reason: 'CDK-managed drain hook Lambda - DLQ cannot be configured',
                },
                {
                    id: 'CKV_AWS_115',
                    reason: 'CDK-managed drain hook Lambda - reserved concurrency cannot be configured',
                },
                {
                    id: 'CKV_AWS_117',
                    reason: 'CDK-managed drain hook Lambda - VPC placement cannot be configured',
                },
                {
                    id: 'CKV_CUSTOM_LAMBDA_1',
                    reason: 'CDK-managed drain hook Lambda - reserved concurrency cannot be configured',
                },
            ]
        );

        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AutoScalingGroup/AutoScalingGroup/LifecycleHookDrainHook/Topic/Resource`,
            [
                {
                    id: 'AwsSolutions-SNS2',
                    reason: 'CDK-managed lifecycle hook SNS - KMS encryption cannot be configured',
                },
                {
                    id: 'AwsSolutions-SNS3',
                    reason: 'CDK-managed lifecycle hook SNS - SSL enforcement cannot be configured',
                },
                {
                    id: 'CKV_AWS_26',
                    reason: 'CDK-managed lifecycle hook SNS - KMS encryption cannot be configured',
                },
                {
                    id: 'CKV_CUSTOM_SNS_1',
                    reason: 'CDK-managed lifecycle hook SNS - KMS encryption cannot be configured',
                },
                {
                    id: 'CKV_CUSTOM_SNS_2',
                    reason: 'CDK-managed lifecycle hook SNS - SSL enforcement cannot be configured',
                },
            ]
        );

        // =================================================================
        // TAGS
        // =================================================================

        cdk.Tags.of(this).add('Stack', 'NextJsCompute');
        cdk.Tags.of(this).add('Layer', 'Compute');
        // Purpose tag is REQUIRED for Prometheus EC2 service discovery
        // prometheus.yml filters: tag:Purpose = NextJS (jobs: ecs-nextjs-node-exporter, nextjs-app-metrics)
        cdk.Tags.of(this).add('Purpose', 'NextJS');

        // =================================================================
        // STACK OUTPUTS
        // =================================================================

        // IAM Outputs
        new cdk.CfnOutput(this, 'Ec2InstanceRoleArn', {
            value: this.ec2InstanceRole.roleArn,
            description: 'EC2 Instance Role ARN',
            exportName: `${this.stackName}-ec2-role-arn`,
        });

        new cdk.CfnOutput(this, 'TaskExecutionRoleArn', {
            value: this.taskExecutionRole.roleArn,
            description: 'Task Execution Role ARN',
            exportName: `${this.stackName}-exec-role-arn`,
        });

        new cdk.CfnOutput(this, 'TaskRoleArn', {
            value: this.taskRole.roleArn,
            description: 'Task Role ARN',
            exportName: `${this.stackName}-task-role-arn`,
        });

        // Cluster Outputs
        new cdk.CfnOutput(this, 'ClusterName', {
            value: this.cluster.clusterName,
            description: 'ECS Cluster Name',
            exportName: `${this.stackName}-cluster-name`,
        });

        new cdk.CfnOutput(this, 'ClusterArn', {
            value: this.cluster.clusterArn,
            description: 'ECS Cluster ARN',
            exportName: `${this.stackName}-cluster-arn`,
        });

        new cdk.CfnOutput(this, 'CapacityProviderName', {
            value: this.capacityProvider.capacityProviderName,
            description: 'EC2 Capacity Provider Name',
        });

        new cdk.CfnOutput(this, 'SecurityGroupId', {
            value: this.securityGroupConstruct.securityGroup.securityGroupId,
            description: 'EC2 Instance Security Group ID',
            exportName: `${this.stackName}-sg-id`,
        });

        if (this.executeCommandLogGroup) {
            new cdk.CfnOutput(this, 'ExecuteCommandLogGroup', {
                value: this.executeCommandLogGroup.logGroupName,
                description: 'Execute Command Log Group',
            });
        }

        // Cloud Map Outputs
        new cdk.CfnOutput(this, 'CloudMapNamespaceName', {
            value: this.cloudMapNamespace.namespaceName,
            description: 'Cloud Map Namespace Name for service discovery',
        });

        new cdk.CfnOutput(this, 'CloudMapNamespaceArn', {
            value: this.cloudMapNamespace.namespaceArn,
            description: 'Cloud Map Namespace ARN',
        });

        // SSM Parameters for CI/CD
        const ssmPaths = nextjsSsmPaths(environment, namePrefix);

        new ssm.StringParameter(this, 'SsmClusterName', {
            parameterName: ssmPaths.ecs.clusterName,
            stringValue: this.cluster.clusterName,
            description: 'ECS Cluster Name for NextJS deployments',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmClusterArn', {
            parameterName: ssmPaths.ecs.clusterArn,
            stringValue: this.cluster.clusterArn,
            description: 'ECS Cluster ARN for NextJS deployments',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmCloudMapNamespaceName', {
            parameterName: ssmPaths.cloudmap.namespaceName,
            stringValue: this.cloudMapNamespace.namespaceName,
            description: 'Cloud Map namespace name for Prometheus service discovery',
            tier: ssm.ParameterTier.STANDARD,
        });
    }

    // =================================================================
    // HELPER METHODS
    // =================================================================

    /**
     * Get the ECS instance security group
     */
    get securityGroup(): ec2.SecurityGroup {
        return this.securityGroupConstruct.securityGroup;
    }

    /**
     * Grant additional permissions to the task role
     */
    grantTaskRolePermissions(statement: iam.PolicyStatement): void {
        this.taskRole.addToPolicy(statement);
    }

    /**
     * Grant S3 bucket read access to the task role
     */
    grantS3Read(bucket: { bucketArn: string }): void {
        this.taskRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['s3:GetObject', 's3:GetObjectVersion'],
                resources: [`${bucket.bucketArn}/*`],
            })
        );
    }

    /**
     * Grant DynamoDB read-only access to the task role.
     * SSR queries only — writes go through API Gateway → Lambda.
     */
    grantDynamoDbRead(table: { tableArn: string }): void {
        this.taskRole.addToPolicy(
            new iam.PolicyStatement({
                sid: 'DynamoDbReadAccess',
                effect: iam.Effect.ALLOW,
                actions: [
                    'dynamodb:GetItem',
                    'dynamodb:Query',
                    'dynamodb:Scan',
                ],
                resources: [
                    table.tableArn,
                    `${table.tableArn}/index/*`,
                ],
            })
        );
    }
}
