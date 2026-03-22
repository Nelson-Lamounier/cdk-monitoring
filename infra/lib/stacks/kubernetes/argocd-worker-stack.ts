/**
 * @format
 * Kubernetes Worker Stack — ArgoCD Node (Spot Instance)
 *
 * Dedicated worker node for ArgoCD GitOps controller workloads.
 * Joins the kubeadm control plane cluster via SSM-published
 * join token and CA certificate hash.
 *
 * Architecture:
 *   Control Plane    (t3.medium) — K8s system pods
 *   App Worker       (t3.small)  — Next.js application pods
 *   Monitoring Worker(t3.medium) — Prometheus, Grafana, Loki, Tempo, Alloy
 *   ArgoCD Worker    (t3.small)  — ArgoCD GitOps controller (Spot)
 *
 * Traffic flow for ArgoCD UI (ops.nelsonlamounier.com/argocd):
 *   Client → NLB → Traefik (ArgoCD node, hostNetwork) → ArgoCD pod (localhost)
 *   Traefik DaemonSet runs on this node with workload=argocd toleration.
 *   The ASG registers with NLB target groups for direct traffic routing.
 *
 * Workload placement is guided via:
 *   - Node label: workload=argocd (matches ArgoCD manifest nodeSelector)
 *   - Node taint: workload=argocd:NoSchedule (only tolerated pods land here)
 *
 * Cost optimisation:
 *   - Uses EC2 Spot instances for ~70% cost savings
 *   - ArgoCD tolerates interruptions: existing deployments continue running,
 *     and the ASG auto-replaces interrupted instances
 *
 * Resources Created:
 *   - Launch Template (Golden AMI, IMDSv2, GP3 root volume, Spot)
 *   - ASG (min=0, max=1, desired=1) — registered with NLB HTTP/HTTPS TGs
 *   - IAM Role (SSM + CloudWatch + ECR pull)
 *
 * Resources Consumed from KubernetesBaseStack:
 *   - VPC, Cluster Base Security Group, Ingress Security Group
 *   - NLB HTTP/HTTPS Target Group ARNs (via SSM)
 *
 * @example
 * ```typescript
 * const argocdWorkerStack = new KubernetesArgocdWorkerStack(app, 'K8s-ArgocdWorker-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     argocdWorkerConfig: getK8sConfigs(Environment.DEVELOPMENT).argocdWorker,
 *     controlPlaneSsmPrefix: '/k8s/development',
 *     namePrefix: 'k8s-development',
 * });
 * ```
 */

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import type { ArgocdWorkerConfig } from '../../config/kubernetes/index';
import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    UserDataBuilder,
} from '../../constructs/index';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesArgocdWorkerStack.
 */
export interface KubernetesArgocdWorkerStackProps extends cdk.StackProps {
    /** VPC ID from base stack (SSM lookup in factory) */
    readonly vpcId: string;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** ArgoCD worker node configuration */
    readonly argocdWorkerConfig: ArgocdWorkerConfig;

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

    /**
     * Cross-account IAM role ARN for Route 53 access.
     * cert-manager may run on this node and needs to assume this role
     * to create DNS-01 TXT records in the root account's hosted zone.
     */
    readonly crossAccountDnsRoleArn?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Worker Stack — Dedicated ArgoCD Node (Spot Instance).
 *
 * Runs a t3.small Spot EC2 instance that joins the kubeadm cluster
 * as a worker node labeled and tainted for ArgoCD workloads only.
 * The control plane must be running and have published its
 * join token to SSM before this node boots.
 *
 * ArgoCD UI access flow:
 *   ops.nelsonlamounier.com/argocd → NLB → Traefik (this node) → ArgoCD pod
 *   (Traefik DaemonSet with hostNetwork on this node; NLB TG registered)
 */
export class KubernetesArgocdWorkerStack extends cdk.Stack {
    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the worker node */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: KubernetesArgocdWorkerStackProps) {
        super(scope, id, props);

        const { argocdWorkerConfig } = props;
        const namePrefix = props.namePrefix ?? 'k8s';
        const workerPrefix = `${namePrefix}-argocd-worker`;

        // =====================================================================
        // Resolve base infrastructure via SSM (no cross-stack exports)
        // =====================================================================
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
        const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'ClusterSg',
            ssm.StringParameter.valueForStringParameter(this, `${props.controlPlaneSsmPrefix}/security-group-id`),
        );

        // SSM paths used by Python orchestrator for discovery
        const ssmPrefix = props.controlPlaneSsmPrefix;
        const tokenSsmPath = `${ssmPrefix}/join-token`;
        const caHashSsmPath = `${ssmPrefix}/ca-hash`;
        const controlPlaneEndpointSsmPath = `${ssmPrefix}/control-plane-endpoint`;

        const logGroupKmsKey = kms.Key.fromKeyArn(
            this, 'LogKmsKey',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/kms-key-arn`),
        );
        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/scripts-bucket`,
        );
        const scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);

        // Ingress SG — allows NLB health checks and HTTP/HTTPS traffic
        const ingressSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'IngressSg',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/ingress-sg-id`),
        );

        // NLB target groups — ASG registers with both for direct traffic routing
        const nlbHttpTargetGroupArn = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/nlb-http-target-group-arn`,
        );
        const nlbHttpsTargetGroupArn = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/nlb-https-target-group-arn`,
        );
        const nlbHttpTg = elbv2.NetworkTargetGroup.fromTargetGroupAttributes(
            this, 'NlbHttpTg', { targetGroupArn: nlbHttpTargetGroupArn },
        );
        const nlbHttpsTg = elbv2.NetworkTargetGroup.fromTargetGroupAttributes(
            this, 'NlbHttpsTg', { targetGroupArn: nlbHttpsTargetGroupArn },
        );

        // =====================================================================
        // User Data — kubeadm join
        //
        // Steps:
        //   1. Export env vars (CDK tokens resolved at synth time)
        //   2. Resolve SSM Automation document or fallback to Python orchestrator
        //   3. exec into boot script (handles join + cfn-signal)
        // =====================================================================
        const userData = ec2.UserData.forLinux();

        // =====================================================================
        // Launch Template + ASG (created first so asgLogicalId is available
        // for user data interpolation below)
        //
        // Ingress SG is attached so the NLB can route HTTP/HTTPS traffic to
        // Traefik running on this node via hostNetwork.
        // =====================================================================
        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup,
            additionalSecurityGroups: [ingressSg],
            instanceType: argocdWorkerConfig.instanceType,
            volumeSizeGb: argocdWorkerConfig.rootVolumeSizeGb,
            detailedMonitoring: argocdWorkerConfig.detailedMonitoring,
            userData,
            namePrefix: workerPrefix,
            logGroupKmsKey,
            machineImage: ec2.MachineImage.fromSsmParameter(
                `${ssmPrefix}/golden-ami/latest`,
            ),
            // Required: Kubernetes pod overlay networking (Calico) uses pod IPs
            // that don't match ENI IPs — AWS drops this traffic unless disabled.
            disableSourceDestCheck: true,
        });

        // =====================================================================
        // Spot Instance Configuration
        //
        // Override the L1 CfnLaunchTemplate to add Spot market options.
        // CDK's L2 LaunchTemplate doesn't expose instanceMarketOptions,
        // so we use the escape hatch to set it on the underlying resource.
        // =====================================================================
        if (argocdWorkerConfig.useSpotInstances) {
            const cfnLaunchTemplate = launchTemplateConstruct.launchTemplate.node
                .defaultChild as ec2.CfnLaunchTemplate;
            cfnLaunchTemplate.addPropertyOverride(
                'LaunchTemplateData.InstanceMarketOptions',
                {
                    MarketType: 'spot',
                    SpotOptions: {
                        SpotInstanceType: 'one-time',
                    },
                },
            );
        }

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

        // Grant ECR access for ArgoCD container images and Image Updater tag discovery
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EcrImageAccess',
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

        // NOTE: No CloudWatch Grafana read-only permissions needed.
        // Grafana runs on the monitoring node, not on this ArgoCD node.

        // ASG: min=0 allows scaling down to save costs, max=1 for single worker.
        // Scaling policy disabled — Kubernetes owns scaling decisions via HPA.
        const asgConstruct = new AutoScalingGroupConstruct(this, 'WorkerAsg', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 1,
            disableScalingPolicy: true,
            namePrefix: workerPrefix,
            instanceName: `${namePrefix}-argocd-worker`,
            bootstrapRole: 'argocd-worker',
            ssmPrefix,
            useSignals: argocdWorkerConfig.useSignals,
            signalsTimeoutMinutes: argocdWorkerConfig.signalsTimeoutMinutes,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [`${this.region}a`],
            },
        });

        const asgCfnResource = asgConstruct.autoScalingGroup.node
            .defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

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
            'echo "=== ArgoCD Worker user data script started at $(date) ==="',
        );

        new UserDataBuilder(userData, { skipPreamble: true })
            .addCustomScript(`
# Export runtime values (CDK tokens resolved at synth time)
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_LABEL="${argocdWorkerConfig.nodeLabel}"
export S3_BUCKET="${scriptsBucketName}"
export LOG_GROUP_NAME="${logGroupName}"

# Persist env vars for SSM Automation to source later
cat > /etc/profile.d/k8s-env.sh << 'ENVEOF'
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_LABEL="${argocdWorkerConfig.nodeLabel}"
export S3_BUCKET="${scriptsBucketName}"
export LOG_GROUP_NAME="${logGroupName}"
ENVEOF

# ─── Resolve instance ID via IMDSv2 ──────────────────────────────────
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \\
  http://169.254.169.254/latest/meta-data/instance-id)

# Publish instance ID so the pipeline can target SSM Automation
aws ssm put-parameter \\
  --name "\${SSM_PREFIX}/bootstrap/argocd-worker-instance-id" \\
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
        // NLB Target Registration
        //
        // Register this ASG with the NLB target groups so the NLB can route
        // traffic directly to Traefik on this node. Combined with Traefik's
        // workload=argocd toleration, this enables full traffic isolation:
        //   NLB → Traefik (hostNetwork on this node) → ArgoCD pod (localhost)
        // =====================================================================
        asgConstruct.autoScalingGroup.attachToNetworkTargetGroup(nlbHttpTg);
        asgConstruct.autoScalingGroup.attachToNetworkTargetGroup(nlbHttpsTg);

        // =====================================================================
        // cert-manager DNS-01 — Cross-account Route 53 access
        //
        // cert-manager pods can be scheduled on any node (including this
        // worker). For DNS-01 challenges, cert-manager uses the instance
        // profile to assume the cross-account Route53DnsValidation role
        // in the root account to create TXT records.
        // =====================================================================
        if (props.crossAccountDnsRoleArn) {
            launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
                sid: 'AssumeRoute53DnsRole',
                effect: iam.Effect.ALLOW,
                actions: ['sts:AssumeRole'],
                resources: [props.crossAccountDnsRoleArn],
            }));
        }

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'ArgocdWorkerAsgName', {
            value: asgConstruct.autoScalingGroup.autoScalingGroupName,
            description: 'ArgoCD worker node ASG name',
        });

        new cdk.CfnOutput(this, 'ArgocdWorkerInstanceRoleArn', {
            value: launchTemplateConstruct.instanceRole.roleArn,
            description: 'ArgoCD worker node IAM role ARN',
        });
    }
}
