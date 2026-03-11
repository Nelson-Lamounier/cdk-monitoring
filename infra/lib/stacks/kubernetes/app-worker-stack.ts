/**
 * @format
 * Kubernetes Worker Stack — Application Node
 *
 * Dedicated worker node for Next.js application workloads.
 * Joins the kubeadm control plane cluster via SSM-published
 * join token and CA certificate hash.
 *
 * Architecture:
 *   Control Plane (t3.medium) — monitoring + K8s system pods
 *   Worker Node   (t3.small)  — Next.js application pods only
 *
 * Workload placement is guided via:
 *   - Node label: workload=frontend (matches nextjs Helm chart nodeSelector)
 *   - Pod anti-affinity in manifests (Hybrid-HA spread)
 *
 * Resources Created:
 *   - Launch Template (Golden AMI, IMDSv2, GP3 root volume)
 *   - ASG (min=0, max=1, desired=1)
 *   - IAM Role (SSM + CloudWatch)
 *
 * Resources Consumed from KubernetesBaseStack:
 *   - VPC, Security Group
 *
 * @example
 * ```typescript
 * const workerStack = new KubernetesAppWorkerStack(app, 'K8s-Worker-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     baseStack: kubernetesBaseStack,
 *     workerConfig: getNextJsK8sConfig(Environment.DEVELOPMENT),
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
import { NextJsK8sConfig } from '../../config/nextjs/kubernetes-configurations';

import { KubernetesBaseStack } from './base-stack';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesAppWorkerStack.
 */
export interface KubernetesAppWorkerStackProps extends cdk.StackProps {
    /** Reference to the base infrastructure stack (VPC, SG) */
    readonly baseStack: KubernetesBaseStack;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** Worker node configuration */
    readonly workerConfig: NextJsK8sConfig;

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
 * Kubernetes Worker Stack — Dedicated Application Node.
 *
 * Runs a t3.small EC2 instance that joins the kubeadm cluster
 * as a worker node labeled for frontend application workloads only.
 * The control plane must be running and have published its
 * join token to SSM before this node boots.
 */
export class KubernetesAppWorkerStack extends cdk.Stack {
    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the worker node */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: KubernetesAppWorkerStackProps) {
        super(scope, id, props);

        const { workerConfig, baseStack } = props;
        const namePrefix = props.namePrefix ?? 'k8s';
        const workerPrefix = `${namePrefix}-worker`;

        // =====================================================================
        // Consume base infrastructure (from KubernetesBaseStack)
        // =====================================================================
        const { vpc, securityGroup } = baseStack;

        // =====================================================================
        // User Data — kubeadm join
        //
        // Steps:
        //   1. Export env vars (CDK tokens resolved at synth time)
        //   2. Resolve SSM Automation document or fallback to Python orchestrator
        //   3. exec into boot script (handles join + cfn-signal)
        // =====================================================================
        const userData = ec2.UserData.forLinux();
        const { scriptsBucket } = baseStack;

        // SSM paths used by Python orchestrator for discovery
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
            instanceType: workerConfig.instanceType,
            volumeSizeGb: workerConfig.rootVolumeSizeGb,
            detailedMonitoring: workerConfig.detailedMonitoring,
            userData,
            namePrefix: workerPrefix,
            logGroupKmsKey: baseStack.logGroupKmsKey,
            machineImage: ec2.MachineImage.fromSsmParameter(
                `${ssmPrefix}/golden-ami/latest`,
            ),
            // Required: Kubernetes pod overlay networking (Calico) uses pod IPs
            // that don't match ENI IPs — AWS drops this traffic unless disabled.
            disableSourceDestCheck: true,
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

        // Grant S3 read for boot script download + orchestrator fallback
        scriptsBucket.grantRead(launchTemplateConstruct.instanceRole);

        // Grant ECR pull + list for container images (Next.js from ECR)
        // Includes ListImages/DescribeImages for ArgoCD Image Updater
        // to discover new SHA-tagged images and update deployments.
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EcrPullImages',
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
                'ecr:ListImages',
                'ecr:DescribeImages',
            ],
            resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/*`],
        }));

        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EcrAuthToken',
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
        }));

        // Grant SSM Automation permissions — start/poll/publish execution ID
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
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
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmPublishExecutionId',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:PutParameter'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPrefix}/bootstrap/*`,
            ],
        }));

        // Grant iam:PassRole for the SSM Automation execution role
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
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

        // Grant CloudWatch read-only for Grafana CloudWatch datasource
        // Enables querying Lambda, SSM, EC2, VPC Flow, and CloudFront logs
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'CloudWatchGrafanaReadOnly',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:DescribeLogGroups',
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
                'logs:StartQuery',
                'logs:StopQuery',
                'logs:GetQueryResults',
                'logs:DescribeLogStreams',
                'cloudwatch:GetMetricData',
                'cloudwatch:ListMetrics',
            ],
            resources: ['*'],
        }));

        // ASG: min=0 allows scaling down to save costs, max=1 for single worker.
        // Scaling policy disabled — Kubernetes owns scaling decisions via HPA.
        // If node-level scaling is needed later, install Cluster Autoscaler.
        const asgConstruct = new AutoScalingGroupConstruct(this, 'WorkerAsg', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 1,
            disableScalingPolicy: true,
            namePrefix: workerPrefix,
            useSignals: workerConfig.useSignals,
            signalsTimeoutMinutes: workerConfig.signalsTimeoutMinutes,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [`${this.region}a`],
            },
        });

        const asgCfnResource = asgConstruct.autoScalingGroup.node
            .defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // =====================================================================
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
            'echo "=== Worker user data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .addCustomScript(`
# Export runtime values (CDK tokens resolved at synth time)
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_LABEL="${workerConfig.nodeLabel}"
export S3_BUCKET="${scriptsBucket.bucketName}"
export LOG_GROUP_NAME="${logGroupName}"

# Persist env vars for SSM Automation to source later
cat > /etc/profile.d/k8s-env.sh << 'ENVEOF'
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_LABEL="${workerConfig.nodeLabel}"
export S3_BUCKET="${scriptsBucket.bucketName}"
export LOG_GROUP_NAME="${logGroupName}"
ENVEOF

# ─── Resolve instance ID via IMDSv2 ──────────────────────────────────
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \\
  http://169.254.169.254/latest/meta-data/instance-id)

# Publish instance ID so the pipeline can target SSM Automation
aws ssm put-parameter \\
  --name "\${SSM_PREFIX}/bootstrap/app-worker-instance-id" \\
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

        // Expose properties
        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'WorkerAsgName', {
            value: asgConstruct.autoScalingGroup.autoScalingGroupName,
            description: 'Worker node ASG name',
        });

        new cdk.CfnOutput(this, 'WorkerInstanceRoleArn', {
            value: launchTemplateConstruct.instanceRole.roleArn,
            description: 'Worker node IAM role ARN',
        });
    }
}
