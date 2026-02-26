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
        //   1. Install AWS CLI (if not baked)
        //   2. Start containerd
        //   3. Retrieve join token + CA hash from SSM
        //   4. Run kubeadm join with monitoring label (no taint — Hybrid-HA)
        //   5. Signal CloudFormation
        // =====================================================================
        const userData = ec2.UserData.forLinux();
        const builder = new UserDataBuilder(userData);

        // SSM paths published by the control plane
        const ssmPrefix = props.controlPlaneSsmPrefix;
        const tokenSsmPath = `${ssmPrefix}/join-token`;
        const caHashSsmPath = `${ssmPrefix}/ca-hash`;
        const controlPlaneEndpointSsmPath = `${ssmPrefix}/control-plane-endpoint`;

        // The control plane endpoint is dynamic (private IP), so we resolve
        // it from SSM at boot time rather than passing a static value.
        builder.addCustomScript(`
# =============================================================================
# Resolve control plane endpoint from SSM (dynamic private IP)
# =============================================================================

echo "=== Resolving control plane endpoint from SSM ==="

IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)

# Wait for control plane to publish its endpoint (may not be ready on Day-1)
CP_MAX_WAIT=300
CP_WAITED=0
CONTROL_PLANE_ENDPOINT=""

while [ -z "$CONTROL_PLANE_ENDPOINT" ] || [ "$CONTROL_PLANE_ENDPOINT" = "None" ]; do
    CONTROL_PLANE_ENDPOINT=$(aws ssm get-parameter \\\\
        --name "${controlPlaneEndpointSsmPath}" \\\\
        --query "Parameter.Value" \\\\
        --output text \\\\
        --region "$REGION" 2>/dev/null || echo "")

    if [ -n "$CONTROL_PLANE_ENDPOINT" ] && [ "$CONTROL_PLANE_ENDPOINT" != "None" ]; then
        echo "Control plane endpoint: $CONTROL_PLANE_ENDPOINT"
        break
    fi

    if [ $CP_WAITED -ge $CP_MAX_WAIT ]; then
        echo "ERROR: Control plane endpoint not found in SSM after \${CP_MAX_WAIT}s"
        echo "The control plane must be running and have published its endpoint to ${controlPlaneEndpointSsmPath}"
        exit 1
    fi

    echo "Waiting for control plane endpoint... (\${CP_WAITED}s / \${CP_MAX_WAIT}s)"
    sleep 10
    CP_WAITED=$((CP_WAITED + 10))
done

# Enable IP forwarding (required for kubeadm preflight)
echo "Configuring networking prerequisites..."
modprobe overlay 2>/dev/null || true
modprobe br_netfilter 2>/dev/null || true

cat > /etc/modules-load.d/k8s.conf <<MODULES
overlay
br_netfilter
MODULES

cat > /etc/sysctl.d/k8s.conf <<SYSCTL
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
SYSCTL

sysctl --system > /dev/null 2>&1
echo "Networking prerequisites configured"
`);

        // Join the cluster with monitoring label (no taint — Hybrid-HA)
        builder.joinKubeadmCluster({
            controlPlaneEndpoint: '$CONTROL_PLANE_ENDPOINT',
            tokenSsmPath,
            caHashSsmPath,
            nodeLabel: monitoringWorkerConfig.nodeLabel,
        });

        // =====================================================================
        // Launch Template + ASG
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

        // Get ASG logical ID for cfn-signal
        const asgCfnResource = asgConstruct.autoScalingGroup.node
            .defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // Add cfn-signal AFTER kubeadm join
        builder.sendCfnSignal({
            stackName: this.stackName,
            asgLogicalId,
            region: this.region,
        });

        builder.addCompletionMarker();

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
