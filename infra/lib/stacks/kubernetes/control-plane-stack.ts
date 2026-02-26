/**
 * @format
 * Kubernetes Compute Stack — Runtime Layer
 *
 * Runtime compute resources for the kubeadm Kubernetes cluster.
 * Consumes long-lived base infrastructure (VPC, Security Group, KMS,
 * EBS, Elastic IP) from KubernetesBaseStack via cross-stack reference.
 *
 * Resources Created:
 *   - Launch Template (Amazon Linux 2023, IMDSv2)
 *   - ASG (min=1, max=1, single-node cluster)
 *   - IAM Role (monitoring grants + optional application grants)
 *   - SSM Run Command Document (manifest re-deploy)
 *   - Golden AMI Pipeline (optional, Image Builder)
 *   - SSM State Manager (optional, post-boot configuration)
 *
 * Resources from KubernetesBaseStack (consumed, not created):
 *   - VPC, Security Group, KMS Key, EBS Volume, Elastic IP
 *   - S3 Bucket (k8s scripts & manifests)
 *
 * @example
 * ```typescript
 * const computeStack = new KubernetesControlPlaneStack(app, 'K8s-Compute-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     baseStack: kubernetesBaseStack,
 *     configs: getK8sConfigs(Environment.DEVELOPMENT),
 *     namePrefix: 'k8s-development',
 *     ssmPrefix: '/k8s/development',
 * });
 * ```
 */


import { NagSuppressions } from 'cdk-nag';

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
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
import {
    MONITORING_APP_TAG,
} from '../../config/defaults';
import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

import { KubernetesBaseStack } from './base-stack';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesControlPlaneStack.
 *
 * Core props are required for every deployment. Application-tier grants
 * are optional — when omitted, the stack runs monitoring workloads only.
 */
export interface KubernetesControlPlaneStackProps extends cdk.StackProps {
    /** Reference to the base infrastructure stack (VPC, SG, KMS, EBS, EIP) */
    readonly baseStack: KubernetesBaseStack;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for storing cluster info */
    readonly ssmPrefix: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Compute Stack — Runtime Layer.
 *
 * Runs a kubeadm Kubernetes cluster hosting both monitoring and application
 * workloads. Consumes base infrastructure (VPC, Security Group, KMS, EBS,
 * Elastic IP) from KubernetesBaseStack.
 *
 * Security and resource isolation between tiers is enforced
 * at the Kubernetes layer (Namespaces, NetworkPolicies, ResourceQuotas,
 * PriorityClasses).
 */
export class KubernetesControlPlaneStack extends cdk.Stack {
    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the Kubernetes nodes */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: KubernetesControlPlaneStackProps) {
        super(scope, id, props);

        const { configs, targetEnvironment: _targetEnvironment, baseStack } = props;
        const namePrefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // Consume base infrastructure (from KubernetesBaseStack)
        // =====================================================================
        const { vpc, securityGroup, logGroupKmsKey, ebsVolume } = baseStack;

        // =====================================================================
        // Launch Template + ASG
        // =====================================================================
        const userData = ec2.UserData.forLinux();

        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup,
            instanceType: configs.compute.instanceType,
            volumeSizeGb: configs.compute.rootVolumeSizeGb, // Must be >= Golden AMI snapshot size
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
        // S3 Bucket (consumed from BaseStack — Day-1 safety)
        //
        // The scripts bucket lives in BaseStack so that the CI sync job can
        // seed boot-k8s.sh BEFORE the Compute stack launches EC2 instances.
        // Content sync (k8s-bootstrap/, app-deploy/) is handled by CI via
        // `aws s3 sync`, NOT by CDK BucketDeployment.
        // =====================================================================
        const scriptsBucket = baseStack.scriptsBucket;

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
                    default: 'app-deploy',
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
                ManifestsDir: {
                    type: 'String',
                    description: 'Local path to manifests directory',
                    default: '/data/app-deploy/monitoring/manifests',
                },
                DeployScript: {
                    type: 'String',
                    description: 'Local path to the deploy script',
                    default: '/data/app-deploy/monitoring/deploy-manifests.sh',
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
                    'export MANIFESTS_DIR="{{ManifestsDir}}"',
                    '',
                    '# Re-sync all manifests from S3 and run deploy script',
                    '"{{DeployScript}}"',
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
                    default: 'app-deploy',
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
                ManifestsDir: {
                    type: 'String',
                    description: 'Local path to manifests directory',
                    default: '/data/app-deploy/nextjs',
                },
                DeployScript: {
                    type: 'String',
                    description: 'Local path to the deploy script',
                    default: '/data/app-deploy/nextjs/deploy-manifests.sh',
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
                    'export MANIFESTS_DIR="{{ManifestsDir}}"',
                    '',
                    '# Re-sync manifests from S3 and run Next.js deploy script',
                    '"{{DeployScript}}"',
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
                securityGroupId: securityGroup.securityGroupId,
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
        // Heavy logic lives in k8s-bootstrap/boot/boot-k8s.sh (uploaded to S3 via
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
export EIP_ALLOC_ID="${baseStack.elasticIp.attrAllocationId}"

# Download boot script from S3 — "Patient" retry for Day-1 coordination
# On first-ever deploy, the Sync pipeline may not have uploaded boot-k8s.sh
# yet. Retry for up to 10 minutes (30 × 20s) before giving up.
BOOT_SCRIPT="/tmp/boot-k8s.sh"
S3_BOOT_PATH="s3://${scriptsBucket.bucketName}/k8s-bootstrap/boot/boot-k8s.sh"
MAX_RETRIES=30
RETRY_INTERVAL=20

for i in $(seq 1 $MAX_RETRIES); do
  if aws s3 cp "$S3_BOOT_PATH" "$BOOT_SCRIPT" --region ${this.region} 2>/dev/null; then
    echo "✓ Boot script downloaded (attempt $i/$MAX_RETRIES)"
    chmod +x "$BOOT_SCRIPT"
    exec "$BOOT_SCRIPT"
  fi
  echo "Boot script not in S3 yet (attempt $i/$MAX_RETRIES). Retrying in \${RETRY_INTERVAL}s..."
  sleep $RETRY_INTERVAL
done

echo "ERROR: Boot script not found at $S3_BOOT_PATH after $((MAX_RETRIES * RETRY_INTERVAL))s"
exit 1
`);

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // Grant S3 read access for manifest download
        scriptsBucket.grantRead(this.instanceRole);

        // =====================================================================
        // IAM Grants — Monitoring tier (always applied)
        //
        // Application-tier grants (DynamoDB, S3, Secrets Manager) live in the
        // separate KubernetesAppIamStack — decoupled from compute lifecycle.
        // =====================================================================
        grantMonitoringPermissions(this.instanceRole, {
            ssmPrefix: props.ssmPrefix,
            region: this.region,
            account: this.account,
        });

        // Publish instance role ARN to SSM for cross-stack import (AppIamStack)
        new ssm.StringParameter(this, 'InstanceRoleArnParam', {
            parameterName: `${props.ssmPrefix}/instance-role-arn`,
            stringValue: this.instanceRole.roleArn,
            description: 'Kubernetes instance role ARN (used by AppIamStack for app-tier grants)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // EIP Failover Lambda — Hybrid-HA Guardian
        //
        // Automatically re-associates the cluster EIP when a node terminates.
        // Triggered by EventBridge on ASG "EC2 Instance Terminate Successful".
        // Discovers healthy instances by EC2 tag (works across all ASGs).
        // =====================================================================
        const eipFailoverFn = new lambda.Function(this, 'EipFailoverFn', {
            functionName: `${namePrefix}-eip-failover`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json, logging, os, boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)
ec2 = boto3.client("ec2")

EIP_ALLOCATION_ID = os.environ["EIP_ALLOCATION_ID"]
TAG_KEY = os.environ["CLUSTER_TAG_KEY"]
TAG_VALUE = os.environ["CLUSTER_TAG_VALUE"]

def handler(event, context):
    terminated = event.get("detail", {}).get("EC2InstanceId", "")
    logger.info("Terminated instance: %s", terminated)

    eip = ec2.describe_addresses(AllocationIds=[EIP_ALLOCATION_ID])["Addresses"][0]
    current = eip.get("InstanceId", "")

    if current and current != terminated:
        logger.info("EIP on %s (healthy). No action.", current)
        return {"statusCode": 200}

    instances = ec2.describe_instances(Filters=[
        {"Name": f"tag:{TAG_KEY}", "Values": [TAG_VALUE]},
        {"Name": "instance-state-name", "Values": ["running"]},
    ])
    candidates = [
        i["InstanceId"]
        for r in instances["Reservations"]
        for i in r["Instances"]
        if i["InstanceId"] != terminated
    ]

    if not candidates:
        logger.error("No healthy instances for EIP failover")
        return {"statusCode": 503}

    if eip.get("AssociationId"):
        ec2.disassociate_address(AssociationId=eip["AssociationId"])

    ec2.associate_address(AllocationId=EIP_ALLOCATION_ID, InstanceId=candidates[0], AllowReassociation=True)
    logger.info("EIP moved to %s", candidates[0])
    return {"statusCode": 200}
`),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            environment: {
                EIP_ALLOCATION_ID: baseStack.elasticIp.attrAllocationId,
                CLUSTER_TAG_KEY: MONITORING_APP_TAG.key,
                CLUSTER_TAG_VALUE: MONITORING_APP_TAG.value,
            },
            description: 'Re-associates the K8s cluster EIP when a node terminates (Hybrid-HA)',
        });

        // Grant the Lambda permissions to manage EIP and discover instances
        eipFailoverFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EipFailoverPermissions',
            effect: iam.Effect.ALLOW,
            actions: [
                'ec2:DescribeAddresses',
                'ec2:AssociateAddress',
                'ec2:DisassociateAddress',
                'ec2:DescribeInstances',
            ],
            resources: ['*'],
        }));

        // EventBridge rule: trigger on any ASG instance termination
        new events.Rule(this, 'EipFailoverRule', {
            ruleName: `${namePrefix}-eip-failover`,
            description: 'Trigger EIP failover when an ASG instance terminates',
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: ['EC2 Instance Terminate Successful'],
            },
            targets: [new targets.LambdaFunction(eipFailoverFn)],
        });

        // Python 3.13 is the latest GA Lambda runtime. CDK defines PYTHON_3_14
        // as a placeholder (not yet released), causing cdk-nag to flag 3.13.
        NagSuppressions.addResourceSuppressions(eipFailoverFn, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. PYTHON_3_14 is a CDK placeholder for an unreleased version.',
        }], true);

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

// =============================================================================
// MONITORING IAM GRANTS (inlined — single consumer)
// =============================================================================

interface MonitoringIamGrantsProps {
    readonly ssmPrefix: string;
    readonly region: string;
    readonly account: string;
}

/**
 * Grant monitoring-tier IAM permissions to the instance role.
 *
 * Permissions:
 * - EBS volume management (attach/detach/describe)
 * - ECR pull (deploy container images to Kubernetes)
 * - Elastic IP association
 * - SSM parameter write (cluster discovery)
 * - Secrets Manager write (ArgoCD CI bot token)
 */
function grantMonitoringPermissions(
    role: iam.IRole,
    props: MonitoringIamGrantsProps,
): void {
    const { ssmPrefix, region, account } = props;

    role.addToPrincipalPolicy(new iam.PolicyStatement({
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

    role.addToPrincipalPolicy(new iam.PolicyStatement({
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

    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'SsmParameterWrite',
        effect: iam.Effect.ALLOW,
        actions: [
            'ssm:PutParameter',
            'ssm:GetParameter',
            'ssm:GetParameters',
            'ssm:GetParametersByPath',
        ],
        resources: [
            `arn:aws:ssm:${region}:${account}:parameter${ssmPrefix}/*`,
        ],
    }));

    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'EipAssociation',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:AssociateAddress', 'ec2:DescribeAddresses'],
        resources: ['*'],
    }));

    const k8sEnv = ssmPrefix.split('/').pop() || 'development';
    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'SecretsManagerArgoCdWrite',
        effect: iam.Effect.ALLOW,
        actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:PutSecretValue',
            'secretsmanager:UpdateSecret',
            'secretsmanager:DescribeSecret',
        ],
        resources: [
            `arn:aws:secretsmanager:${region}:${account}:secret:k8s/${k8sEnv}/*`,
        ],
    }));
}
