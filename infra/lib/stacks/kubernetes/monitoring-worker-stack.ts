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
 *   - Node label: workload=monitoring (matches monitoring Helm chart nodeSelector)
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
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    UserDataBuilder,
} from '../../common/index';
import { Environment } from '../../config/environments';
import { MonitoringWorkerConfig } from '../../config/kubernetes';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesMonitoringWorkerStack.
 */
export interface KubernetesMonitoringWorkerStackProps extends cdk.StackProps {
    /** VPC ID from base stack (SSM lookup in factory) */
    readonly vpcId: string;

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

    /** Email address for alert notifications */
    readonly notificationEmail?: string;

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

    /** SNS topic for monitoring alerts (Grafana → Email + SNS) */
    public readonly alertsTopic: sns.Topic;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    constructor(scope: Construct, id: string, props: KubernetesMonitoringWorkerStackProps) {
        super(scope, id, props);

        const { monitoringWorkerConfig } = props;
        const namePrefix = props.namePrefix ?? 'k8s';
        const workerPrefix = `${namePrefix}-mon-worker`;

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
        const ingressSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'IngressSg',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/ingress-sg-id`),
        );
        const monitoringSg = ec2.SecurityGroup.fromSecurityGroupId(
            this, 'MonitoringSg',
            ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/monitoring-sg-id`),
        );
        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `${ssmPrefix}/scripts-bucket`,
        );
        const scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);

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
        // =====================================================================
        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup,
            additionalSecurityGroups: [ingressSg, monitoringSg],
            instanceType: monitoringWorkerConfig.instanceType,
            volumeSizeGb: monitoringWorkerConfig.rootVolumeSizeGb,
            detailedMonitoring: monitoringWorkerConfig.detailedMonitoring,
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

        // Grant ECR pull for container images
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'EcrPullImages',
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
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

        // Grant ViewOnlyAccess for Steampipe cloud inventory queries
        // Covers EC2, EBS, VPC, IAM, and other AWS service read-only access
        launchTemplateConstruct.instanceRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('job-function/ViewOnlyAccess'),
        );

        // Grant additional read-only permissions for Steampipe cloud inventory
        // ViewOnlyAccess doesn't include S3 config hydration, Route53, CloudFront,
        // WAF, or CloudWatch Logs actions that Steampipe needs for dashboard queries
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SteampipeCloudInventoryReadOnly',
            effect: iam.Effect.ALLOW,
            actions: [
                // S3 — bucket config hydration (encryption, public access, versioning)
                's3:GetEncryptionConfiguration',
                's3:GetBucketPublicAccessBlock',
                's3:GetBucketVersioning',
                's3:GetBucketLogging',
                's3:GetBucketTagging',
                's3:GetBucketPolicy',
                's3:GetBucketAcl',
                's3:ListAllMyBuckets',
                's3:GetBucketLocation',
                // Route 53
                'route53:ListHostedZones',
                'route53:ListResourceRecordSets',
                'route53:GetHostedZone',
                // CloudFront
                'cloudfront:ListDistributions',
                'cloudfront:GetDistribution',
                // WAF
                'wafv2:ListWebACLs',
                'wafv2:GetWebACL',
                'wafv2:ListRuleGroups',
                // CloudWatch Logs (supplements existing policy with List/Describe)
                'logs:ListTagsForResource',
            ],
            resources: ['*'],
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

        // =====================================================================
        // SNS Topic — Monitoring Alerts
        //
        // Dedicated topic for Grafana unified alerting (Email + SNS).
        // Grafana's SNS contact point publishes to this topic.
        // =====================================================================
        const alertsTopic = new sns.Topic(this, 'MonitoringAlertsTopic', {
            topicName: `${workerPrefix}-monitoring-alerts`,
            displayName: 'Monitoring Alerts',
            enforceSSL: true,
            masterKey: kms.Alias.fromAliasName(this, 'SnsEncryptionKey', 'alias/aws/sns'),
        });

        if (props.notificationEmail) {
            alertsTopic.addSubscription(
                new sns_subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        // Grant sns:Publish for Grafana's SNS contact point
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SnsPublishAlerts',
            effect: iam.Effect.ALLOW,
            actions: ['sns:Publish'],
            resources: [alertsTopic.topicArn],
        }));

        // Grant KMS for SNS encryption
        launchTemplateConstruct.addToRolePolicy(new iam.PolicyStatement({
            sid: 'KmsForSns',
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'kms:ViaService': `sns.${this.region}.amazonaws.com`,
                },
            },
        }));

        // ASG: min=0 allows scaling down to save costs, max=1 for single monitoring worker.
        // Scaling policy disabled — Kubernetes owns scaling decisions, not AWS.
        const asgConstruct = new AutoScalingGroupConstruct(this, 'MonWorkerAsg', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 0,
            maxCapacity: 1,
            desiredCapacity: 1,
            disableScalingPolicy: true,
            namePrefix: workerPrefix,
            instanceName: `${namePrefix}-mon-worker`,
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
export S3_BUCKET="${scriptsBucketName}"
export LOG_GROUP_NAME="${logGroupName}"

# Persist env vars for SSM Automation to source later
cat > /etc/profile.d/k8s-env.sh << 'ENVEOF'
export STACK_NAME="${this.stackName}"
export ASG_LOGICAL_ID="${asgLogicalId}"
export AWS_REGION="${this.region}"
export SSM_PREFIX="${ssmPrefix}"
export NODE_LABEL="${monitoringWorkerConfig.nodeLabel}"
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
  --name "\${SSM_PREFIX}/bootstrap/mon-worker-instance-id" \\
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
        this.alertsTopic = alertsTopic;
        this.logGroup = launchTemplateConstruct.logGroup;

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

        new cdk.CfnOutput(this, 'MonitoringAlertsTopicArn', {
            value: alertsTopic.topicArn,
            description: 'SNS topic ARN for Grafana monitoring alerts',
        });

        // SSM Parameter — discoverable by bootstrap_argocd.py
        new ssm.StringParameter(this, 'MonitoringAlertsTopicArnParam', {
            parameterName: `${ssmPrefix}/monitoring/alerts-topic-arn`,
            stringValue: alertsTopic.topicArn,
            description: 'SNS topic ARN for Grafana monitoring alerts — used by ArgoCD bootstrap',
        });
    }
}
