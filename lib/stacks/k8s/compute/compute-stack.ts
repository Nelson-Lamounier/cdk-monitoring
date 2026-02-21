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

import { NagSuppressions } from 'cdk-nag';

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    GoldenAmiPipelineConstruct,
    LaunchTemplateConstruct,
    SsmRunCommandDocument,
    SsmStateManagerConstruct,
    UserDataBuilder,
} from '../../../common/index';
import {
    K3S_API_PORT,
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
    PROMETHEUS_PORT,
    NODE_EXPORTER_PORT,
    LOKI_NODEPORT,
    TEMPO_NODEPORT,
    MONITORING_APP_TAG,
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

        // Loki/Tempo NodePorts: accessible from VPC (ECS tasks → k8s monitoring)
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(LOKI_NODEPORT),
            'Allow Loki push API from VPC (cross-stack log shipping)',
        );
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(TEMPO_NODEPORT),
            'Allow Tempo OTLP gRPC from VPC (cross-stack trace shipping)',
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
        // S3 Access Logs Bucket (AwsSolutions-S1)
        // =====================================================================
        const accessLogsBucket = new s3.Bucket(this, 'K8sScriptsAccessLogsBucket', {
            bucketName: `${namePrefix}-k8s-scripts-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: configs.removalPolicy,
            autoDeleteObjects: !configs.isProduction,
            enforceSSL: true,
            lifecycleRules: [{
                expiration: cdk.Duration.days(90),
            }],
        });

        NagSuppressions.addResourceSuppressions(accessLogsBucket, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Access logs bucket cannot log to itself — this is the terminal logging destination',
            },
        ]);

        // =====================================================================
        // S3 Bucket for k8s Scripts & Manifests
        // =====================================================================
        const scriptsBucket = new s3.Bucket(this, 'K8sScriptsBucket', {
            bucketName: `${namePrefix}-k8s-scripts-${this.account}`,
            removalPolicy: configs.removalPolicy,
            autoDeleteObjects: !configs.isProduction,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: configs.isProduction,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: 'k8s-scripts-bucket/',
        });

        // Sync k8s manifests + deploy script from local
        new s3deploy.BucketDeployment(this, 'K8sManifestsDeployment', {
            sources: [s3deploy.Source.asset('./k8s/apps/monitoring')],
            destinationBucket: scriptsBucket,
            destinationKeyPrefix: 'k8s',
            prune: true,
        });

        try {
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`,
                [
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'BucketDeployment Lambda runtime is managed by CDK singleton — cannot override',
                    },
                ],
            );
        } catch {
            // Suppression path may not exist in test environments — this is expected
        }

        // =====================================================================
        // SSM Run Command Document (manifest deployment)
        //
        // Enables re-running deploy-manifests.sh without instance replacement.
        // Triggered by:
        //   - GitHub Actions pipeline (deploy-manifests job)
        //   - Manual: aws ssm send-command --document-name <name> --targets ...
        // =====================================================================
        const manifestDeployDoc = new SsmRunCommandDocument(this, 'ManifestDeployDocument', {
            documentName: `${namePrefix}-deploy-manifests`,
            description: 'Deploy k8s monitoring manifests — re-syncs from S3, applies via kubectl',
            parameters: {
                S3Bucket: {
                    type: 'String',
                    description: 'S3 bucket containing k8s manifests',
                    default: scriptsBucket.bucketName,
                },
                S3KeyPrefix: {
                    type: 'String',
                    description: 'S3 key prefix',
                    default: 'k8s',
                },
                SsmPrefix: {
                    type: 'String',
                    description: 'SSM parameter prefix for secrets',
                    default: props.ssmPrefix,
                },
                Region: {
                    type: 'String',
                    description: 'AWS region',
                    default: this.region,
                },
            },
            steps: [{
                name: 'deployManifests',
                commands: [
                    'export KUBECONFIG=/data/k3s/server/cred/admin.kubeconfig',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    'export S3_KEY_PREFIX="{{S3KeyPrefix}}"',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export MANIFESTS_DIR=/data/k8s/manifests',
                    '',
                    '# Re-sync from S3 and run deploy script',
                    '/data/k8s/deploy-manifests.sh',
                ],
                timeoutSeconds: 600,
            }],
        });

        // =====================================================================
        // Golden AMI Pipeline (Layer 1 — pre-baked software)
        //
        // Creates an EC2 Image Builder pipeline that bakes Docker, AWS CLI,
        // k3s binary, and Calico manifests into a Golden AMI.
        // Gated by imageConfig.enableImageBuilder flag.
        // =====================================================================
        let goldenAmiPipeline: GoldenAmiPipelineConstruct | undefined;
        if (configs.image.enableImageBuilder) {
            goldenAmiPipeline = new GoldenAmiPipelineConstruct(this, 'GoldenAmi', {
                namePrefix,
                imageConfig: configs.image,
                clusterConfig: configs.cluster,
                vpc,
                subnetId: vpc.publicSubnets[0].subnetId,
                securityGroupId: this.securityGroup.securityGroupId,
            });
        }

        // =====================================================================
        // SSM State Manager (Layer 3 — post-boot configuration)
        //
        // Creates associations that auto-configure k8s after boot:
        // Calico CNI → kubeconfig → manifest deployment.
        // Runs on schedule for drift remediation.
        // Gated by ssmConfig.enableStateManager flag.
        // =====================================================================
        let stateManager: SsmStateManagerConstruct | undefined;
        if (configs.ssm.enableStateManager) {
            stateManager = new SsmStateManagerConstruct(this, 'StateManager', {
                namePrefix,
                ssmConfig: configs.ssm,
                clusterConfig: configs.cluster,
                instanceRole: launchTemplateConstruct.instanceRole,
                targetTag: {
                    key: MONITORING_APP_TAG.key,
                    value: MONITORING_APP_TAG.value,
                },
                s3BucketName: scriptsBucket.bucketName,
                ssmPrefix: props.ssmPrefix,
                region: this.region,
            });
        }

        // =====================================================================
        // User Data (k3s bootstrap)
        //
        // ORDERING: cfn-signal fires after critical infra (AWS CLI, EBS)
        // but BEFORE dnf update.
        //
        //   installAwsCli → attachEbs → sendCfnSignal → updateSystem → k3s
        //
        // Why: dnf update takes 10-15 min on cold boot, which exceeds the
        // 15-min signal timeout → "0 SUCCESS signals" → rollback.
        // EBS attach is critical (k3s persistent storage), so we signal
        // only after confirming it's mounted. AWS CLI is needed for
        // EBS attach (aws ec2 attach-volume).
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
            .installAwsCli()
            .attachEbsVolume({
                volumeId: ebsVolume.volumeId,
                mountPoint: configs.storage.mountPoint,
            })
            // Signal after EBS attach (critical infra confirmed) but
            // BEFORE dnf update (the 10-15 min cold-boot bottleneck).
            .sendCfnSignal({
                stackName: this.stackName,
                asgLogicalId,
                region: this.region,
            })
            .updateSystem()
            .installK3s({
                channel: configs.cluster.channel,
                dataDir: configs.cluster.dataDir,
                disableTraefik: !configs.cluster.enableTraefik,
                disableFlannel: true,
                ssmPrefix: props.ssmPrefix,
            })
            .installCalicoCNI(configs.cluster.dataDir)
            .configureKubeconfig(configs.cluster.dataDir)
            .deployK8sManifests({
                s3BucketName: scriptsBucket.bucketName,
                s3KeyPrefix: 'k8s',
                manifestsDir: '/data/k8s',
                ssmPrefix: props.ssmPrefix,
                region: this.region,
            })
            .addCompletionMarker();

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // Grant S3 read access for manifest download
        scriptsBucket.grantRead(this.instanceRole);

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

        // Elastic IP association (needed for user-data and SSM-based EIP re-association)
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'EipAssociation',
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:AssociateAddress',
                'ec2:DescribeAddresses',
            ],
            resources: ['*'],
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

        new cdk.CfnOutput(this, 'ManifestDeployDocumentName', {
            value: manifestDeployDoc.documentName,
            description: 'SSM document name for manifest deployment (use with aws ssm send-command)',
        });

        new cdk.CfnOutput(this, 'ScriptsBucketName', {
            value: scriptsBucket.bucketName,
            description: 'S3 bucket containing k8s scripts and manifests',
        });

        if (goldenAmiPipeline) {
            new cdk.CfnOutput(this, 'GoldenAmiPipelineName', {
                value: goldenAmiPipeline.pipeline.name!,
                description: 'EC2 Image Builder pipeline name for Golden AMI',
            });

            new cdk.CfnOutput(this, 'GoldenAmiSsmPath', {
                value: configs.image.amiSsmPath,
                description: 'SSM parameter path storing the latest Golden AMI ID',
            });
        }

        if (stateManager) {
            new cdk.CfnOutput(this, 'SsmDocumentName', {
                value: stateManager.document.name!,
                description: 'SSM Document name for post-boot k8s configuration',
            });

            new cdk.CfnOutput(this, 'SsmAssociationName', {
                value: stateManager.association.associationName!,
                description: 'SSM State Manager association name',
            });
        }
    }
}
