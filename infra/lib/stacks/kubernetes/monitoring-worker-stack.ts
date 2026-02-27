/**
 * @format
 * Kubernetes Monitoring Worker Stack — Dedicated Monitoring Node
 *
 * Dedicated worker node for K8s-native monitoring workloads
 * (Prometheus Operator, Grafana, Loki, Tempo).
 * Joins the kubeadm control plane cluster via SSM-published
 * join token and CA certificate hash.
 *
 * Architecture (3-node cluster):
 *   Control Plane (t3.small) — K8s system pods + etcd
 *   App Worker    (t3.small) — Next.js application pods only
 *   Mon Worker    (t3.small) — Monitoring stack only (this stack)
 *
 * Workload isolation is enforced via:
 *   - Node label: role=monitoring
 *   - Node taint: none (Hybrid-HA — all nodes accept all workloads)
 *   - Pod tolerations + nodeSelector in monitoring Helm values
 *
 * Resources Created:
 *   - Launch Template (Golden AMI, IMDSv2, GP3 root volume)
 *   - ASG (min=0, max=1, desired=1)
 *   - IAM Role (SSM + CloudWatch + join-token read)
 *
 * Resources Consumed from KubernetesBaseStack:
 *   - VPC, Security Group
 *
 * @example
 * ```typescript
 * const monWorkerStack = new KubernetesMonitoringWorkerStack(app, 'K8s-MonWorker-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     baseStack: kubernetesBaseStack,
 *     monitoringWorkerConfig: configs.monitoringWorker,
 *     controlPlaneSsmPrefix: '/k8s/development',
 *     namePrefix: 'k8s-development',
 * });
 * ```
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    UserDataBuilder,
} from '../../common/index';
import { Environment } from '../../config/environments';
import { MonitoringWorkerConfig } from '../../config/kubernetes';

import { KubernetesBaseStack } from './base-stack';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesMonitoringWorkerStack.
 */
export interface KubernetesMonitoringWorkerStackProps extends cdk.StackProps {
    /** Reference to the base infrastructure stack (VPC, SG) */
    readonly baseStack: KubernetesBaseStack;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** Monitoring worker node configuration */
    readonly monitoringWorkerConfig: MonitoringWorkerConfig;

    /**
     * SSM parameter prefix for the control plane cluster.
     * Used to discover join token, CA hash, and control plane endpoint.
     * @example '/k8s/development'
     */
    readonly controlPlaneSsmPrefix: string;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** Log retention @default ONE_WEEK */
    readonly logRetention?: logs.RetentionDays;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Monitoring Worker Stack — Dedicated Monitoring Node.
 *
 * Runs a t3.small EC2 instance that joins the kubeadm cluster
 * as a worker node labeled for monitoring workloads only.
 * The control plane must be running and have published its
 * join token to SSM before this node boots.
 */
export class KubernetesMonitoringWorkerStack extends cdk.Stack {
    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the monitoring worker node */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: KubernetesMonitoringWorkerStackProps) {
        super(scope, id, props);

        const { monitoringWorkerConfig, baseStack } = props;
        const namePrefix = props.namePrefix ?? 'k8s';
        const workerPrefix = `${namePrefix}-mon-worker`;

        // =====================================================================
        // Consume base infrastructure (from KubernetesBaseStack)
        // =====================================================================
        const { vpc, securityGroup } = baseStack;

        // =====================================================================
        // User Data — kubeadm join
        //
        // Steps:
        //   1. Export env vars (CDK tokens resolved at synth time)
        //   2. Download boot-worker.sh from S3
        //   3. exec into boot script (handles join + cfn-signal)
        // =====================================================================
        const userData = ec2.UserData.forLinux();
        const { scriptsBucket } = baseStack;

        // SSM paths used by boot-worker.sh for discovery
        const ssmPrefix = props.controlPlaneSsmPrefix;
        const tokenSsmPath = `${ssmPrefix}/join-token`;
        const caHashSsmPath = `${ssmPrefix}/ca-hash`;
        const controlPlaneEndpointSsmPath = `${ssmPrefix}/control-plane-endpoint`;

        // =====================================================================
        // Launch Template + ASG (created first so asgLogicalId is available
        // for user data interpolation below)
        // =====================================================================
        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup,
            instanceType: monitoringWorkerConfig.instanceType,
            volumeSizeGb: monitoringWorkerConfig.rootVolumeSizeGb,
            detailedMonitoring: monitoringWorkerConfig.detailedMonitoring,
            userData,
            namePrefix: workerPrefix,
            logGroupKmsKey: baseStack.logGroupKmsKey,
            machineImage: ec2.MachineImage.fromSsmParameter(
                `${ssmPrefix}/golden-ami/latest`,
            ),
        });

        const logGroupName = launchTemplateConstruct.logGroup?.logGroupName
            ?? `/ec2/${workerPrefix}/instances`;

        // Grant SSM parameter read for join token + CA hash
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ReadK8sJoinParams',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${tokenSsmPath}`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter${caHashSsmPath}`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter${controlPlaneEndpointSsmPath}`,
            ],
        }));

        // Grant SSM GetParameter with decryption (join-token is SecureString)
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DecryptJoinToken',
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt'],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
                },
            },
        }));

        // Grant S3 read for boot script download
        scriptsBucket.grantRead(launchTemplateConstruct.instanceRole);

        // ASG: min=0 allows scaling down to save costs, max=1 for single monitoring worker
        const asgConstruct = new AutoScalingGroupConstruct(this, 'MonWorkerAsg', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 1,
            namePrefix: workerPrefix,
            useSignals: monitoringWorkerConfig.useSignals,
            signalsTimeoutMinutes: monitoringWorkerConfig.signalsTimeoutMinutes,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [`${this.region}a`],
            },
        });

        const asgCfnResource = asgConstruct.autoScalingGroup.node
            .defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // =====================================================================
        // User Data — slim bootstrap stub
        //
        // Heavy logic lives in boot-worker.sh (uploaded to S3 via CI sync).
        // Inline user data exports env vars with CDK token values, then
        // downloads & executes the boot script. AWS CLI is baked into the
        // Golden AMI. This keeps user data well under CloudFormation's 16 KB limit.
        // =====================================================================
        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            'echo "=== Monitoring worker user data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .addCustomScript(`
# Export runtime values (CDK tokens resolved at synth time)
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_LABEL="${monitoringWorkerConfig.nodeLabel}"
export S3_BUCKET="${scriptsBucket.bucketName}"
export LOG_GROUP_NAME="${logGroupName}"

# ─── Fail-safe trap ───────────────────────────────────────────────────
# If boot-worker.sh never downloads (S3 sync race / missing file),
# send cfn-signal --success false so CloudFormation fails fast instead
# of waiting the full signalsTimeoutMinutes.
# boot-worker.sh has its own trap; once exec replaces this shell,
# this trap is no longer active.
# ──────────────────────────────────────────────────────────────────────
send_stub_failure() {
  local rc=$?
  [ $rc -eq 0 ] && return
  echo "FATAL: user-data stub exited with code $rc before exec boot-worker.sh"
  if ! command -v /opt/aws/bin/cfn-signal &> /dev/null; then
    echo "WARNING: cfn-signal not found — expected in Golden AMI"
  fi
  /opt/aws/bin/cfn-signal --success false \\
    --stack "\${STACK_NAME}" \\
    --resource "\${ASG_LOGICAL_ID}" \\
    --region "\${AWS_REGION}" \\
    --reason "boot-worker.sh download failed (exit $rc)" 2>/dev/null || true
}
trap send_stub_failure EXIT

# Download boot script from S3 — "Patient" retry for Day-1 coordination
# On first-ever deploy, the Sync pipeline may not have uploaded boot-worker.sh
# yet. Retry for up to 10 minutes (30 × 20s) before giving up.
BOOT_SCRIPT="/tmp/boot-worker.sh"
S3_BOOT_PATH="s3://${scriptsBucket.bucketName}/k8s-bootstrap/boot/boot-worker.sh"
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

        // Expose properties
        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // =====================================================================
        // Tags
        // =====================================================================
        cdk.Tags.of(this).add('Stack', 'KubernetesMonitoringWorker');
        cdk.Tags.of(this).add('Layer', 'Compute');
        cdk.Tags.of(this).add('NodeRole', 'MonitoringWorker');
        cdk.Tags.of(this).add('Purpose', 'Monitoring');

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'MonitoringWorkerAsgName', {
            value: asgConstruct.autoScalingGroup.autoScalingGroupName,
            description: 'Monitoring worker node ASG name',
        });

        new cdk.CfnOutput(this, 'MonitoringWorkerInstanceRoleArn', {
            value: launchTemplateConstruct.instanceRole.roleArn,
            description: 'Monitoring worker node IAM role ARN',
        });
    }
}
