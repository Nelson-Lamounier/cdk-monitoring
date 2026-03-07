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
    LaunchTemplateConstruct,
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
            additionalSecurityGroups: [baseStack.controlPlaneSg],
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
            // Required: Kubernetes pod overlay networking (Calico) uses pod IPs
            // that don't match ENI IPs — AWS drops this traffic unless disabled.
            disableSourceDestCheck: true,
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
        // seed bootstrap scripts BEFORE the Compute stack launches EC2 instances.
        // Content sync (k8s-bootstrap/, app-deploy/) is handled by CI via
        // `aws s3 sync`, NOT by CDK BucketDeployment.
        // =====================================================================
        const scriptsBucket = baseStack.scriptsBucket;




        // =====================================================================
        // Golden AMI Pipeline — MOVED to dedicated GoldenAmiStack
        //
        // The Image Builder pipeline was decoupled into its own stack to
        // eliminate the Day-1 chicken-and-egg: the pipeline must exist before
        // the AMI build job runs, but both used to live in this stack.
        // See: golden-ami-stack.ts
        // =====================================================================

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
        // User Data — infrastructure readiness stub
        //
        // Exports CDK-resolved env vars, persists them for SSM Automation,
        // resolves instance ID, and sends cfn-signal immediately to confirm
        // EC2 infrastructure is ready. SSM Automation bootstrap is triggered
        // separately by the CI pipeline after the stack deploys.
        // =====================================================================
        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            'echo "=== kubeadm user data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
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

# Persist env vars for SSM Automation to source later
cat > /etc/profile.d/k8s-env.sh << 'ENVEOF'
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
ENVEOF

# ─── Resolve instance ID via IMDSv2 ──────────────────────────────────
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \\
  http://169.254.169.254/latest/meta-data/instance-id)

# Publish instance ID so the pipeline can target SSM Automation
aws ssm put-parameter \\
  --name "\${SSM_PREFIX}/bootstrap/control-plane-instance-id" \\
  --value "$INSTANCE_ID" \\
  --type String \\
  --overwrite \\
  --region "\${AWS_REGION}" 2>/dev/null || true

echo "Infrastructure ready — instance $INSTANCE_ID"
echo "SSM Automation will be triggered by the CI pipeline"

# ─── Signal CloudFormation: infrastructure ready ──────────────────────
/opt/aws/bin/cfn-signal --success true \\
  --stack "\${STACK_NAME}" \\
  --resource "\${ASG_LOGICAL_ID}" \\
  --region "\${AWS_REGION}" 2>/dev/null || true
`);

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // Grant S3 read access for manifest download
        scriptsBucket.grantRead(this.instanceRole);

        // Grant SSM Automation permissions — start/poll/publish execution ID
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmAutomationExecution',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:StartAutomationExecution',
                'ssm:GetAutomationExecution',
                'ssm:DescribeAutomationStepExecutions',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:automation-definition/*`,
                `arn:aws:ssm:${this.region}:${this.account}:automation-execution/*`,
            ],
        }));

        // Grant SSM PutParameter for publishing execution ID
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmPublishExecutionId',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:PutParameter'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/bootstrap/*`,
            ],
        }));

        // Grant iam:PassRole for the SSM Automation execution role
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'PassSsmAutomationRole',
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: [
                `arn:aws:iam::${this.account}:role/*-SsmAutomation-*`,
            ],
            conditions: {
                StringEquals: {
                    'iam:PassedToService': 'ssm.amazonaws.com',
                },
            },
        }));

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



        new cdk.CfnOutput(this, 'ScriptsBucketName', {
            value: scriptsBucket.bucketName,
            description: 'S3 bucket containing k8s scripts and manifests',
        });

        // Golden AMI outputs are now in GoldenAmiStack

        if (stateManager) {
            new cdk.CfnOutput(this, 'SsmDocumentName', {
                value: stateManager.document.ref,
                description: 'SSM Document name for post-boot Kubernetes configuration',
            });

            new cdk.CfnOutput(this, 'SsmAssociationName', {
                value: stateManager.association.ref,
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
