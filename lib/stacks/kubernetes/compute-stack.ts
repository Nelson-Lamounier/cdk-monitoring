/**
 * @format
 * Kubernetes Compute Stack — kubeadm Cluster
 *
 * kubeadm Kubernetes cluster hosting both monitoring (Grafana, Prometheus, Loki,
 * Tempo) and application (Next.js) workloads on a control plane + worker nodes.
 *
 * Workload isolation is enforced at the Kubernetes layer via:
 *   1. Namespaces (monitoring / nextjs-app)
 *   2. NetworkPolicies (restrict cross-namespace traffic)
 *   3. ResourceQuotas (prevent resource starvation)
 *   4. Container resource limits (requests + limits on every container)
 *   5. PriorityClasses (monitoring pods preempt application pods)
 *
 * Resources Created:
 *   - Security Group (unified: HTTP/HTTPS, K8s API, monitoring ports)
 *   - IAM Role (monitoring grants + optional application grants)
 *   - EBS Volume (persistent storage for Kubernetes data + PVCs)
 *   - Launch Template (Amazon Linux 2023, IMDSv2)
 *   - ASG (min=1, max=1, single-node cluster)
 *   - Elastic IP (shared by Next.js CloudFront and SSM access)
 *   - S3 Bucket (syncs all k8s manifests: monitoring + application)
 *   - SSM Run Command Document (manifest re-deploy)
 *   - Golden AMI Pipeline (optional, Image Builder)
 *   - SSM State Manager (optional, post-boot configuration)
 *
 * @example
 * ```typescript
 * const computeStack = new KubernetesComputeStack(app, 'K8s-Compute-dev', {
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
} from '../../common/index';
import { S3BucketConstruct } from '../../common/storage';
import {
    K8S_API_PORT,
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
    PROMETHEUS_PORT,
    NODE_EXPORTER_PORT,
    LOKI_NODEPORT,
    TEMPO_NODEPORT,
    MONITORING_APP_TAG,
} from '../../config/defaults';
import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

import { grantApplicationPermissions, ApplicationIamGrantsProps } from './application';
import { grantMonitoringPermissions } from './monitoring';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesComputeStack.
 *
 * Core props are required for every deployment. Application-tier grants
 * are optional — when omitted, the stack runs monitoring workloads only.
 */
export interface KubernetesComputeStackProps extends cdk.StackProps {
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
     * @default 'shared-vpc-{environment}'
     */
    readonly vpcName?: string;

    // =========================================================================
    // Application-tier grants (optional — for Next.js workload)
    // =========================================================================

    /** DynamoDB table ARNs to grant read access (SSR queries) */
    readonly dynamoTableArns?: string[];

    /** SSM path for DynamoDB KMS key ARN (customer-managed key) */
    readonly dynamoKmsKeySsmPath?: string;

    /** S3 bucket ARNs to grant read access (static assets) */
    readonly s3ReadBucketArns?: string[];

    /** SSM parameter path wildcard for Next.js env vars */
    readonly ssmParameterPath?: string;

    /** Secrets Manager path pattern for Next.js auth secrets */
    readonly secretsManagerPathPattern?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Shared Kubernetes Compute Stack.
 *
 * Runs a kubeadm Kubernetes cluster hosting both monitoring and application
 * workloads. Security and resource isolation between tiers is enforced
 * at the Kubernetes layer (Namespaces, NetworkPolicies, ResourceQuotas,
 * PriorityClasses).
 */
export class KubernetesComputeStack extends cdk.Stack {
    /** The security group for the Kubernetes cluster */
    public readonly securityGroup: ec2.SecurityGroup;

    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the Kubernetes nodes */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    /** Elastic IP for stable external access */
    public readonly elasticIp: ec2.CfnEIP;

    constructor(scope: Construct, id: string, props: KubernetesComputeStackProps) {
        super(scope, id, props);

        const { configs, targetEnvironment } = props;
        const namePrefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // VPC Lookup
        // =====================================================================
        const vpcName = props.vpcName ?? `shared-vpc-${targetEnvironment}`;
        const vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName });

        // =====================================================================
        // Security Group (unified — superset of monitoring + application ports)
        // =====================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'K8sSecurityGroup', {
            vpc,
            description: `Shared Kubernetes cluster security group (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k8s-cluster`,
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
            ec2.Port.tcp(K8S_API_PORT),
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
        // EBS Volume (persistent storage for Kubernetes data)
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
            volumeSizeGb: 20, // Root volume (k8s data lives on separate EBS)
            detailedMonitoring: configs.compute.detailedMonitoring,
            userData,
            namePrefix,
            logGroupKmsKey,
            // Resolve AMI from SSM parameter written by Image Builder pipeline.
            // On Day-0, this points to the parent AL2023 AMI (boot script handles
            // missing software). On Day-1+, it resolves to the baked Golden AMI.
            machineImage: ec2.MachineImage.fromSsmParameter(configs.image.amiSsmPath),
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
        const asgCfnResource = asgConstruct.autoScalingGroup.node
            .defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // =====================================================================
        // S3 Access Logs Bucket (AwsSolutions-S1)
        // =====================================================================
        const accessLogsBucketConstruct = new S3BucketConstruct(this, 'K8sScriptsAccessLogsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${namePrefix}-k8s-scripts-logs-${this.account}-${this.region}`,
                purpose: 'k8s-scripts-access-logs',
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: configs.removalPolicy,
                autoDeleteObjects: !configs.isProduction,
                lifecycleRules: [{
                    expiration: cdk.Duration.days(90),
                }],
            },
        });

        NagSuppressions.addResourceSuppressions(accessLogsBucketConstruct.bucket, [{
            id: 'AwsSolutions-S1',
            reason: 'Access logs bucket cannot log to itself — this is the terminal logging destination',
        }]);

        // =====================================================================
        // S3 Bucket for K8s Scripts & Manifests
        //
        // Syncs the ENTIRE k8s/ directory (monitoring + application manifests).
        // This replaces both the monitoring-only and nextjs-only buckets.
        // =====================================================================
        const scriptsBucketConstruct = new S3BucketConstruct(this, 'K8sScriptsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${namePrefix}-k8s-scripts-${this.account}`,
                purpose: 'k8s-scripts-and-manifests',
                versioned: configs.isProduction,
                removalPolicy: configs.removalPolicy,
                autoDeleteObjects: !configs.isProduction,
                accessLogsBucket: accessLogsBucketConstruct.bucket,
                accessLogsPrefix: 'k8s-scripts-bucket/',
            },
        });
        const scriptsBucket = scriptsBucketConstruct.bucket;

        // Sync all k8s manifests (monitoring + application + system)
        new s3deploy.BucketDeployment(this, 'K8sManifestsDeployment', {
            sources: [s3deploy.Source.asset('./k8s')],
            destinationBucket: scriptsBucket,
            destinationKeyPrefix: 'k8s',
            prune: true,
        });

        try {
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`,
                [{
                    id: 'AwsSolutions-L1',
                    reason: 'BucketDeployment Lambda runtime is managed by CDK singleton — cannot override',
                }],
            );
        } catch {
            // Suppression path may not exist in test environments — this is expected
        }

        // =====================================================================
        // SSM Run Command Document (unified manifest deployment)
        //
        // Deploys BOTH monitoring and application manifests.
        // Triggered by GitHub Actions pipeline or manual SSM send-command.
        // =====================================================================
        const manifestDeployDoc = new SsmRunCommandDocument(this, 'ManifestDeployDocument', {
            documentName: `${namePrefix}-deploy-manifests`,
            description: 'Deploy all k8s manifests (monitoring + application) — re-syncs from S3, applies via kubectl',
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
                    'export KUBECONFIG=/etc/kubernetes/admin.conf',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    'export S3_KEY_PREFIX="{{S3KeyPrefix}}"',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export MANIFESTS_DIR=/data/k8s/manifests',
                    '',
                    '# Re-sync all manifests from S3 and run deploy script',
                    '/data/k8s/apps/monitoring/deploy-manifests.sh',
                ],
                timeoutSeconds: 600,
            }],
        });

        // =====================================================================
        // SSM Run Command Document — Next.js Application Manifests
        //
        // Separate from monitoring: allows independent app manifest deployment
        // without rerunning the monitoring deploy script.
        // Triggered by GitHub Actions pipeline or manual SSM send-command.
        // =====================================================================
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const appManifestDeployDoc = new SsmRunCommandDocument(this, 'AppManifestDeployDocument', {
            documentName: `${namePrefix}-deploy-app-manifests`,
            description: 'Deploy Next.js application k8s manifests — re-syncs from S3, resolves secrets, applies via kubectl',
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
                    description: 'SSM parameter prefix for k8s',
                    default: props.ssmPrefix,
                },
                Region: {
                    type: 'String',
                    description: 'AWS region',
                    default: this.region,
                },
            },
            steps: [{
                name: 'deployAppManifests',
                commands: [
                    'export KUBECONFIG=/etc/kubernetes/admin.conf',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    'export S3_KEY_PREFIX="{{S3KeyPrefix}}"',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export MANIFESTS_DIR=/data/k8s/apps/nextjs',
                    '',
                    '# Re-sync manifests from S3 and run Next.js deploy script',
                    '/data/k8s/apps/nextjs/deploy-manifests.sh',
                ],
                timeoutSeconds: 600,
            }],
        });

        // =====================================================================
        // Golden AMI Pipeline (Layer 1 — pre-baked software)
        //
        // Creates an EC2 Image Builder pipeline that bakes Docker, AWS CLI,
        // kubeadm toolchain, and Calico manifests into a Golden AMI.
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
        // User Data — slim bootstrap stub
        //
        // Heavy logic lives in k8s/boot/boot-k8s.sh (uploaded to S3 via
        // BucketDeployment). Inline user data just installs AWS CLI,
        // exports env vars with CDK token values, then downloads & executes
        // the boot script. This keeps user data well under CloudFormation's
        // 16 KB limit (~1 KB vs 18 KB previously).
        // =====================================================================
        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            'echo "=== kubeadm user data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .installAwsCli()
            .addCustomScript(`
# Export runtime values (CDK tokens resolved at synth time)
export VOLUME_ID="${ebsVolume.volumeId}"
export MOUNT_POINT="${configs.storage.mountPoint}"
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export K8S_VERSION="${configs.cluster.kubernetesVersion}"
export DATA_DIR="${configs.cluster.dataDir}"
export POD_CIDR="${configs.cluster.podNetworkCidr}"
export SERVICE_CIDR="${configs.cluster.serviceSubnet}"
export SSM_PREFIX="${props.ssmPrefix}"
export S3_BUCKET="${scriptsBucket.bucketName}"
export CALICO_VERSION="${configs.image.bakedVersions.calico}"
export LOG_GROUP_NAME="${launchTemplateConstruct.logGroup?.logGroupName ?? `/ec2/${namePrefix}/instances`}"

# Download and execute the boot script from S3
BOOT_SCRIPT="/tmp/boot-k8s.sh"
aws s3 cp s3://${scriptsBucket.bucketName}/k8s/boot/boot-k8s.sh "$BOOT_SCRIPT" --region ${this.region}
chmod +x "$BOOT_SCRIPT"
exec "$BOOT_SCRIPT"
`);

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // Grant S3 read access for manifest download
        scriptsBucket.grantRead(this.instanceRole);

        // =====================================================================
        // IAM Grants — Monitoring tier (always applied)
        // =====================================================================
        grantMonitoringPermissions(this.instanceRole, {
            ssmPrefix: props.ssmPrefix,
            region: this.region,
            account: this.account,
        });

        // =====================================================================
        // IAM Grants — Application tier (conditional)
        // =====================================================================
        const appGrantProps: ApplicationIamGrantsProps = {
            region: this.region,
            account: this.account,
            dynamoTableArns: props.dynamoTableArns,
            dynamoKmsKeySsmPath: props.dynamoKmsKeySsmPath,
            s3ReadBucketArns: props.s3ReadBucketArns,
            ssmParameterPath: props.ssmParameterPath,
            secretsManagerPathPattern: props.secretsManagerPathPattern,
        };
        grantApplicationPermissions(this.instanceRole, appGrantProps);

        // =====================================================================
        // Elastic IP (shared endpoint for Next.js CloudFront + SSM access)
        // =====================================================================
        this.elasticIp = new ec2.CfnEIP(this, 'K8sElasticIp', {
            domain: 'vpc',
            tags: [{
                key: 'Name',
                value: `${namePrefix}-k8s-eip`,
            }],
        });

        // =====================================================================
        // SSM Parameters (for cross-project discovery)
        // =====================================================================
        new ssm.StringParameter(this, 'SecurityGroupIdParam', {
            parameterName: `${props.ssmPrefix}/security-group-id`,
            stringValue: this.securityGroup.securityGroupId,
            description: 'Kubernetes cluster security group ID',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ElasticIpParam', {
            parameterName: `${props.ssmPrefix}/elastic-ip`,
            stringValue: this.elasticIp.ref,
            description: 'Kubernetes cluster Elastic IP address (used by Edge stack as CloudFront origin)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // Tags
        // =====================================================================
        cdk.Tags.of(this).add('Stack', 'KubernetesCompute');
        cdk.Tags.of(this).add('Layer', 'Compute');

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: this.instanceRole.roleArn,
            description: 'Kubernetes cluster IAM Role ARN',
        });

        new cdk.CfnOutput(this, 'AutoScalingGroupName', {
            value: this.autoScalingGroup.autoScalingGroupName,
            description: 'Kubernetes cluster ASG Name',
        });

        new cdk.CfnOutput(this, 'ElasticIpAddress', {
            value: this.elasticIp.ref,
            description: 'Kubernetes cluster Elastic IP address',
        });

        new cdk.CfnOutput(this, 'EbsVolumeId', {
            value: ebsVolume.volumeId,
            description: 'Kubernetes data EBS volume ID',
        });

        new cdk.CfnOutput(this, 'SecurityGroupId', {
            value: this.securityGroup.securityGroupId,
            description: 'Kubernetes cluster security group ID',
        });

        if (this.logGroup) {
            new cdk.CfnOutput(this, 'LogGroupName', {
                value: this.logGroup.logGroupName,
                description: 'CloudWatch Log Group for Kubernetes nodes',
            });
        }

        new cdk.CfnOutput(this, 'SsmConnectCommand', {
            value: `aws ssm start-session --target <instance-id> --region ${this.region}`,
            description: 'SSM Session Manager connect command (replace <instance-id>)',
        });

        new cdk.CfnOutput(this, 'GrafanaPortForward', {
            value: `aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}' --region ${this.region}`,
            description: 'Port-forward Grafana via SSM (replace <instance-id>)',
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
                description: 'SSM Document name for post-boot Kubernetes configuration',
            });

            new cdk.CfnOutput(this, 'SsmAssociationName', {
                value: stateManager.association.associationName!,
                description: 'SSM State Manager association name',
            });
        }
    }
}
