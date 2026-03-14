/**
 * @format
 * Kubernetes Control Plane Stack — Runtime Layer
 *
 * Runtime compute resources for the kubeadm Kubernetes cluster.
 * Consumes long-lived base infrastructure from KubernetesBaseStack
 * via SSM parameter lookups (no cross-stack CloudFormation exports).
 *
 * Resources Created:
 *   - Launch Template (Amazon Linux 2023, IMDSv2, Golden AMI from SSM)
 *   - ASG (min=1, max=1, single-node cluster with self-healing)
 *   - IAM Role (SSM, EBS, S3, Route53, KMS, CloudWatch grants)
 *   - EIP Failover Lambda (EventBridge → auto-associate on instance replace)
 *   - CloudWatch Log Group (KMS-encrypted)
 *   - SSM State Manager (optional post-boot configuration)
 *
 * Resources from KubernetesBaseStack (resolved via SSM):
 *   - VPC, Security Groups ×3 (cluster, control-plane, ingress)
 *   - KMS Key, EBS Volume, Elastic IP
 *   - S3 Bucket (scripts & manifests), Route 53 Hosted Zone
 *
 * @example
 * ```typescript
 * const computeStack = new KubernetesControlPlaneStack(app, 'K8s-Compute-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     vpcId: 'vpc-xxxx',
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
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    SsmStateManagerConstruct,
    UserDataBuilder,
} from '../../common/index';
import { Environment } from '../../config/environments';
import { K8sConfigs, MONITORING_APP_TAG } from '../../config/kubernetes';

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
    /** VPC ID from base stack (SSM lookup in factory) */
    readonly vpcId: string;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for storing cluster info */
    readonly ssmPrefix: string;

    /**
     * Public Route 53 Hosted Zone ID (e.g., nelsonlamounier.com).
     * Required for cert-manager DNS-01 challenge — TXT records are
     * created in this zone to prove domain ownership to Let's Encrypt.
     * Written to SSM for bootstrap consumption.
     */
    readonly publicHostedZoneId?: string;

    /**
     * Cross-account IAM role ARN for Route 53 access.
     * cert-manager assumes this role (via the instance profile) to
     * create ACME DNS-01 TXT records in the root account's hosted zone.
     * Written to SSM for bootstrap consumption.
     */
    readonly crossAccountDnsRoleArn?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Control Plane Stack — Runtime Layer.
 *
 * Runs a kubeadm Kubernetes cluster hosting both monitoring and application
 * workloads. Resolves all base infrastructure (VPC, 3 Security Groups, KMS,
 * EBS, EIP, S3 scripts bucket, Route 53 hosted zone) from SSM parameters
 * published by KubernetesBaseStack — no cross-stack CloudFormation exports.
 *
 * Security and resource isolation between tiers is enforced at the
 * Kubernetes layer (Namespaces, NetworkPolicies, ResourceQuotas,
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

        const { configs, targetEnvironment: _targetEnvironment } = props;
        const namePrefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // Resolve base infrastructure via SSM (no cross-stack exports)
        // =====================================================================
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
        const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'ClusterSg',
            ssm.StringParameter.valueForStringParameter(this, `${props.ssmPrefix}/security-group-id`),
        );
        const controlPlaneSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'ControlPlaneSg',
            ssm.StringParameter.valueForStringParameter(this, `${props.ssmPrefix}/control-plane-sg-id`),
        );
        const ingressSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'IngressSg',
            ssm.StringParameter.valueForStringParameter(this, `${props.ssmPrefix}/ingress-sg-id`),
        );
        const logGroupKmsKey = kms.Key.fromKeyArn(
            this, 'LogKmsKey',
            ssm.StringParameter.valueForStringParameter(this, `${props.ssmPrefix}/kms-key-arn`),
        );
        const ebsVolumeId = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/ebs-volume-id`,
        );
        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/scripts-bucket`,
        );
        const scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);

        const hostedZoneId = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/hosted-zone-id`,
        );
        const apiDnsName = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/api-dns-name`,
        );

        // =====================================================================
        // Launch Template + ASG
        // =====================================================================
        const userData = ec2.UserData.forLinux();

        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup,
            additionalSecurityGroups: [controlPlaneSg, ingressSg],
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
        // Scaling policy disabled — Kubernetes owns scaling decisions, not AWS.
        // The ASG provides self-healing (replacement on termination) only.
        const asgConstruct = new AutoScalingGroupConstruct(this, 'Compute', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 1,
            maxCapacity: 1,
            desiredCapacity: 1,
            disableScalingPolicy: true,
            rollingUpdate: {
                minInstancesInService: 0,
                pauseTimeMinutes: configs.compute.signalsTimeoutMinutes,
            },
            namePrefix,
            instanceName: `${namePrefix}-control-plane`,
            bootstrapRole: 'control-plane',
            ssmPrefix: props.ssmPrefix,
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

        // S3 Bucket resolved above from SSM (Day-1 safety — lives in BaseStack
        // so CI sync seeds scripts BEFORE compute launches EC2 instances).




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
        // =====================================================================
        const stateManager = new SsmStateManagerConstruct(this, 'StateManager', {
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
export VOLUME_ID="${ebsVolumeId}"
export MOUNT_POINT="${configs.storage.mountPoint}"
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export K8S_VERSION="${configs.cluster.kubernetesVersion}"
export DATA_DIR="${configs.cluster.dataDir}"
export POD_CIDR="${configs.cluster.podNetworkCidr}"
export SERVICE_CIDR="${configs.cluster.serviceSubnet}"
export SSM_PREFIX="${props.ssmPrefix}"
export S3_BUCKET="${scriptsBucketName}"
export CALICO_VERSION="${configs.image.bakedVersions.calico}"
export LOG_GROUP_NAME="${launchTemplateConstruct.logGroup?.logGroupName ?? `/ec2/${namePrefix}/instances`}"

export HOSTED_ZONE_ID="${hostedZoneId}"
export API_DNS_NAME="${apiDnsName}"

# Persist env vars for SSM Automation to source later
cat > /etc/profile.d/k8s-env.sh << 'ENVEOF'
export VOLUME_ID="${ebsVolumeId}"
export MOUNT_POINT="${configs.storage.mountPoint}"
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export K8S_VERSION="${configs.cluster.kubernetesVersion}"
export DATA_DIR="${configs.cluster.dataDir}"
export POD_CIDR="${configs.cluster.podNetworkCidr}"
export SERVICE_CIDR="${configs.cluster.serviceSubnet}"
export SSM_PREFIX="${props.ssmPrefix}"
export S3_BUCKET="${scriptsBucketName}"
export CALICO_VERSION="${configs.image.bakedVersions.calico}"
export LOG_GROUP_NAME="${launchTemplateConstruct.logGroup?.logGroupName ?? `/ec2/${namePrefix}/instances`}"

export HOSTED_ZONE_ID="${hostedZoneId}"
export API_DNS_NAME="${apiDnsName}"
ENVEOF

# ─── Resolve instance ID via IMDSv2 ──────────────────────────────────
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \\
  http://169.254.169.254/latest/meta-data/instance-id)

# Publish instance ID to SSM (retry — IAM instance profile may take ~15s to propagate)
SSM_WRITE_OK=false
for SSM_ATTEMPT in 1 2 3 4 5; do
  if aws ssm put-parameter \\
    --name "\${SSM_PREFIX}/bootstrap/control-plane-instance-id" \\
    --value "$INSTANCE_ID" \\
    --type String \\
    --overwrite \\
    --region "\${AWS_REGION}" 2>&1; then
    echo "SSM instance ID published (attempt $SSM_ATTEMPT)"
    SSM_WRITE_OK=true
    break
  fi
  echo "WARNING: SSM put-parameter failed (attempt $SSM_ATTEMPT/5), retrying in 5s..."
  sleep 5
done
if [ "$SSM_WRITE_OK" = "false" ]; then
  echo "ERROR: Failed to publish instance ID to SSM after 5 attempts"
  echo "Pipeline may target the wrong instance. Manual fix:"
  echo "  aws ssm put-parameter --name '\${SSM_PREFIX}/bootstrap/control-plane-instance-id' --value '$INSTANCE_ID' --type String --overwrite --region '\${AWS_REGION}'"
fi

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

        // Grant Route 53 record update for DNS-based API server discovery.
        // The control plane updates k8s-api.k8s.internal → its private IP at boot.
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'Route53ApiDnsUpdate',
            effect: iam.Effect.ALLOW,
            actions: ['route53:ChangeResourceRecordSets'],
            resources: [
                `arn:aws:route53:::hostedzone/${hostedZoneId}`,
            ],
        }));

        // =====================================================================
        // cert-manager DNS-01 — Cross-account Route 53 access
        //
        // cert-manager runs on the node using the instance profile. For DNS-01
        // challenges, it needs to assume the cross-account Route53DnsValidation
        // role in the root account to create TXT records in the public hosted
        // zone. The values are written to SSM so the bootstrap script can
        // template the ClusterIssuer manifest at runtime.
        // =====================================================================
        if (props.crossAccountDnsRoleArn) {
            // Grant the instance role permission to assume the cross-account DNS role
            this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
                sid: 'AssumeRoute53DnsRole',
                effect: iam.Effect.ALLOW,
                actions: ['sts:AssumeRole'],
                resources: [props.crossAccountDnsRoleArn],
            }));

            new ssm.StringParameter(this, 'CrossAccountDnsRoleArnParam', {
                parameterName: `${props.ssmPrefix}/cross-account-dns-role-arn`,
                stringValue: props.crossAccountDnsRoleArn,
                description: 'Cross-account IAM role ARN for cert-manager DNS-01 (Route 53)',
                tier: ssm.ParameterTier.STANDARD,
            });
        }

        if (props.publicHostedZoneId) {
            new ssm.StringParameter(this, 'PublicHostedZoneIdParam', {
                parameterName: `${props.ssmPrefix}/public-hosted-zone-id`,
                stringValue: props.publicHostedZoneId,
                description: 'Public Route 53 Hosted Zone ID for cert-manager DNS-01',
                tier: ssm.ParameterTier.STANDARD,
            });
        }

        // Publish instance role ARN to SSM for cross-stack import (AppIamStack)
        new ssm.StringParameter(this, 'InstanceRoleArnParam', {
            parameterName: `${props.ssmPrefix}/instance-role-arn`,
            stringValue: this.instanceRole.roleArn,
            description: 'Kubernetes instance role ARN (used by AppIamStack for app-tier grants)',
            tier: ssm.ParameterTier.STANDARD,
        });



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
            value: scriptsBucketName,
            description: 'S3 bucket containing k8s scripts and manifests',
        });

        // Golden AMI outputs are now in GoldenAmiStack

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
