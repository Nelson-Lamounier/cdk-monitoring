/**
 * @format
 * k3s Kubernetes Compute Stack
 *
 * Creates compute and networking resources for a self-managed k3s cluster.
 * Single stack containing: Security Group, IAM Role, EBS Volume,
 * Launch Template, ASG (max=1), and Elastic IP.
 *
 * k3s is installed via UserData using the official install script.
 * All k3s data is stored on a dedicated EBS volume for persistence.
 *
 * @example
 * ```typescript
 * const computeStack = new K8sComputeStack(app, 'K8s-Compute-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     configs: getK8sConfigs(Environment.DEVELOPMENT),
 *     namePrefix: 'k8s-development',
 *     ssmPrefix: '/k8s/development',
 * });
 * ```
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    UserDataBuilder,
} from '../../../common/index';
import {
    K3S_API_PORT,
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
    PROMETHEUS_PORT,
    NODE_EXPORTER_PORT,
} from '../../../config/defaults';
import { Environment } from '../../../config/environments';
import { K8sConfigs } from '../../../config/k8s';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for K8sComputeStack
 */
export interface K8sComputeStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for storing cluster info */
    readonly ssmPrefix: string;

    /**
     * VPC Name tag for synth-time lookup via Vpc.fromLookup().
     * When provided, the stack resolves the VPC internally.
     * @default 'shared-vpc-{environment}'
     */
    readonly vpcName?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Compute Stack for k3s Kubernetes cluster.
 *
 * Creates a single EC2 node running k3s with:
 * - Security Group (HTTP/HTTPS/K8s API/monitoring ports)
 * - IAM Role (ECR pull, SSM, CloudWatch, SSM parameter write)
 * - EBS Volume (persistent storage for k3s data + PVCs)
 * - Launch Template (Amazon Linux 2023, IMDSv2)
 * - Auto Scaling Group (min=1, max=1 for single-node cluster)
 * - Elastic IP (stable endpoint for CloudFront / external access)
 */
export class K8sComputeStack extends cdk.Stack {
    /** The security group for the k3s node */
    public readonly securityGroup: ec2.SecurityGroup;

    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the k3s node */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    /** Elastic IP for stable external access */
    public readonly elasticIp: ec2.CfnEIP;

    constructor(scope: Construct, id: string, props: K8sComputeStackProps) {
        super(scope, id, props);

        const { configs, targetEnvironment } = props;
        const namePrefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // VPC Lookup
        // =====================================================================
        const vpcName = props.vpcName ?? `shared-vpc-${targetEnvironment}`;
        const vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName });

        // =====================================================================
        // Security Group
        // =====================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'K8sSecurityGroup', {
            vpc,
            description: `k3s Kubernetes node security group (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k3s-node`,
            allowAllOutbound: true,
        });

        // Traefik Ingress: HTTP/HTTPS from anywhere (CloudFront → Traefik)
        this.securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(TRAEFIK_HTTP_PORT),
            'Allow HTTP traffic (Traefik Ingress)',
        );
        this.securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(TRAEFIK_HTTPS_PORT),
            'Allow HTTPS traffic (Traefik Ingress)',
        );

        // K8s API: Only from VPC CIDR (for SSM port-forwarding access)
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(K3S_API_PORT),
            'Allow K8s API from VPC (SSM port-forwarding)',
        );

        // Monitoring ports from VPC: Prometheus and Node Exporter
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(PROMETHEUS_PORT),
            'Allow Prometheus metrics from VPC',
        );
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(NODE_EXPORTER_PORT),
            'Allow Node Exporter metrics from VPC',
        );

        // =====================================================================
        // KMS Key for CloudWatch Log Group Encryption
        // =====================================================================
        const logGroupKmsKey = new kms.Key(this, 'LogGroupKey', {
            alias: `${namePrefix}-log-group`,
            description: `KMS key for ${namePrefix} CloudWatch log group encryption`,
            enableKeyRotation: true,
            removalPolicy: configs.removalPolicy,
        });

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

        // =====================================================================
        // EBS Volume (persistent storage for k3s data)
        // =====================================================================
        const ebsVolume = new ec2.Volume(this, 'K8sDataVolume', {
            availabilityZone: `${this.region}a`,
            size: cdk.Size.gibibytes(configs.storage.volumeSizeGb),
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            removalPolicy: configs.removalPolicy,
            volumeName: `${namePrefix}-data`,
        });

        // =====================================================================
        // Launch Template + ASG
        // =====================================================================
        const userData = ec2.UserData.forLinux();

        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup: this.securityGroup,
            instanceType: configs.compute.instanceType,
            volumeSizeGb: 20, // Root volume (k3s data lives on separate EBS)
            detailedMonitoring: configs.compute.detailedMonitoring,
            userData,
            namePrefix,
            logGroupKmsKey,
        });

        // Single-node cluster: max=1 (EBS can only attach to one instance)
        const asgConstruct = new AutoScalingGroupConstruct(this, 'Compute', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 1,
            maxCapacity: 1,
            desiredCapacity: 1,
            rollingUpdate: {
                minInstancesInService: 0,
                pauseTimeMinutes: configs.compute.signalsTimeoutMinutes,
            },
            namePrefix,
            enableTerminationLifecycleHook: true,
            useSignals: configs.compute.useSignals,
            signalsTimeoutMinutes: configs.compute.signalsTimeoutMinutes,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [`${this.region}a`],
            },
        });

        // Get ASG logical ID for cfn-signal
        const asgCfnResource = asgConstruct.autoScalingGroup.node.defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // =====================================================================
        // User Data (k3s bootstrap)
        //
        // ORDERING: cfn-signal is sent after critical infrastructure
        // (system update, AWS CLI, EBS attach) but BEFORE k3s install.
        // This prevents k3s install failures from blocking the cfn-signal,
        // which would cause CREATE_FAILED with 0 SUCCESS signals.
        //
        // k3s install happens after signaling — if it fails, the instance
        // is accessible via SSM for debugging and manual re-run.
        //
        // skipPreamble: true because CDK's UserData.forLinux() already adds
        // the shebang line. We add the logging preamble here.
        // =====================================================================
        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            'echo "=== k3s user data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .updateSystem()
            .installAwsCli()
            .attachEbsVolume({
                volumeId: ebsVolume.volumeId,
                mountPoint: configs.storage.mountPoint,
            })
            .sendCfnSignal({
                stackName: this.stackName,
                asgLogicalId,
                region: this.region,
            })
            .installK3s({
                channel: configs.cluster.channel,
                dataDir: configs.cluster.dataDir,
                disableTraefik: !configs.cluster.enableTraefik,
                ssmPrefix: props.ssmPrefix,
            })
            .configureKubeconfig(configs.cluster.dataDir)
            .addCompletionMarker();

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // =====================================================================
        // IAM Grants
        // =====================================================================

        // EBS volume management
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

        // ECR pull (for deploying container images to k3s)
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'EcrPull',
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetAuthorizationToken',
            ],
            resources: ['*'],
        }));

        // SSM parameter write (k3s stores instance ID, elastic IP in SSM)
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmParameterWrite',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:PutParameter',
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParametersByPath',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        // =====================================================================
        // Elastic IP (stable endpoint for CloudFront origin)
        // =====================================================================
        this.elasticIp = new ec2.CfnEIP(this, 'K8sElasticIp', {
            domain: 'vpc',
            tags: [{
                key: 'Name',
                value: `${namePrefix}-k3s-eip`,
            }],
        });

        // =====================================================================
        // SSM Parameters (for cross-project discovery)
        // =====================================================================
        new ssm.StringParameter(this, 'SecurityGroupIdParam', {
            parameterName: `${props.ssmPrefix}/security-group-id`,
            stringValue: this.securityGroup.securityGroupId,
            description: 'k3s node security group ID',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: this.instanceRole.roleArn,
            description: 'k3s node IAM Role ARN',
        });

        new cdk.CfnOutput(this, 'AutoScalingGroupName', {
            value: this.autoScalingGroup.autoScalingGroupName,
            description: 'k3s ASG Name',
        });

        new cdk.CfnOutput(this, 'ElasticIpAddress', {
            value: this.elasticIp.ref,
            description: 'k3s Elastic IP address',
        });

        new cdk.CfnOutput(this, 'EbsVolumeId', {
            value: ebsVolume.volumeId,
            description: 'k3s data EBS volume ID',
        });

        new cdk.CfnOutput(this, 'SecurityGroupId', {
            value: this.securityGroup.securityGroupId,
            description: 'k3s node security group ID',
        });

        if (this.logGroup) {
            new cdk.CfnOutput(this, 'LogGroupName', {
                value: this.logGroup.logGroupName,
                description: 'CloudWatch Log Group for k3s node',
            });
        }

        new cdk.CfnOutput(this, 'SsmConnectCommand', {
            value: `aws ssm start-session --target <instance-id> --region ${this.region}`,
            description: 'SSM Session Manager connect command (replace <instance-id>)',
        });

        new cdk.CfnOutput(this, 'KubectlPortForward', {
            value: `aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' --region ${this.region}`,
            description: 'Port-forward K8s API via SSM (replace <instance-id>)',
        });
    }
}
