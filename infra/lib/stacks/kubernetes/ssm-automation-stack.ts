/**
 * @format
 * SSM Automation Stack — K8s Bootstrap Orchestration
 *
 * Standalone CDK stack containing SSM Automation documents that orchestrate
 * the Kubernetes bootstrap process. Deployed independently from the Compute
 * stack so that bootstrap scripts can be updated without re-deploying EC2.
 *
 * Resources Created:
 *   - SSM Automation Document: Control plane bootstrap (1 consolidated step)
 *   - SSM Automation Document: Worker node bootstrap (1 consolidated step)
 *   - SSM Parameter: Document name for discovery by EC2 user data
 *   - IAM Role: Automation execution role with RunCommand permissions
 *
 * Lifecycle:
 *   - Day-1: Deployed by K8s pipeline before Compute stack
 *   - Day-2+: Updated independently via dedicated SSM Automation pipeline
 *
 * @example
 * ```typescript
 * const ssmAutomationStack = new K8sSsmAutomationStack(app, 'K8s-SsmAutomation-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     configs: getK8sConfigs(Environment.DEVELOPMENT),
 *     ssmPrefix: '/k8s/development',
 *     scriptsBucketName: 'my-scripts-bucket',
 * });
 * ```
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import { NagSuppressions } from 'cdk-nag';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

// =============================================================================
// PROPS
// =============================================================================

export interface K8sSsmAutomationStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration */
    readonly configs: K8sConfigs;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for cluster info (e.g. /k8s/development) */
    readonly ssmPrefix: string;

    /**
     * S3 bucket name containing bootstrap scripts.
     * Imported via SSM parameter — no cross-stack reference.
     */
    readonly scriptsBucketName: string;
}

// =============================================================================
// CONTROL PLANE STEP DEFINITIONS
// =============================================================================

interface AutomationStep {
    name: string;
    scriptPath: string;
    timeoutSeconds: number;
    description: string;
}

const CONTROL_PLANE_STEPS: AutomationStep[] = [
    {
        name: 'bootstrapControlPlane',
        scriptPath: 'boot/steps/control_plane.py',
        timeoutSeconds: 1800,
        description: 'Run consolidated control plane bootstrap (validate AMI, EIP, kubeadm, Calico, kubectl, S3 sync, ArgoCD, verify, CloudWatch)',
    },
];

const WORKER_STEPS: AutomationStep[] = [
    {
        name: 'bootstrapWorker',
        scriptPath: 'boot/steps/worker.py',
        timeoutSeconds: 900,
        description: 'Run consolidated worker bootstrap (validate AMI, join cluster, CloudWatch, EIP association)',
    },
];

// =============================================================================
// NEXTJS SECRETS STEP DEFINITION
// =============================================================================

const NEXTJS_SECRETS_STEPS: AutomationStep[] = [
    {
        name: 'deployNextjsSecrets',
        scriptPath: 'app-deploy/nextjs/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create/update nextjs-secrets K8s Secret',
    },
];

// =============================================================================
// MONITORING SECRETS STEP DEFINITION
// =============================================================================

const MONITORING_SECRETS_STEPS: AutomationStep[] = [
    {
        name: 'deployMonitoringSecrets',
        scriptPath: 'app-deploy/monitoring/deploy.py',
        timeoutSeconds: 600,
        description: 'Resolve SSM parameters and create monitoring K8s Secrets',
    },
];

// =============================================================================
// STACK
// =============================================================================

/**
 * SSM Automation Stack — K8s Bootstrap Orchestration.
 *
 * Creates SSM Automation documents for orchestrating the Kubernetes
 * bootstrap process on control plane and worker nodes.
 */
export class K8sSsmAutomationStack extends cdk.Stack {
    /** Control plane SSM Automation document name */
    public readonly controlPlaneDocName: string;

    /** App worker SSM Automation document name */
    public readonly appWorkerDocName: string;

    /** Monitoring worker SSM Automation document name */
    public readonly monWorkerDocName: string;

    /** Next.js secrets SSM Automation document name */
    public readonly nextjsSecretsDocName: string;

    /** Monitoring secrets SSM Automation document name */
    public readonly monitoringSecretsDocName: string;

    /** Automation execution role ARN */
    public readonly automationRoleArn: string;

    constructor(scope: Construct, id: string, props: K8sSsmAutomationStackProps) {
        super(scope, id, props);

        const prefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // IAM Role — Automation Execution
        // =====================================================================

        const automationRole = new iam.Role(this, 'AutomationExecutionRole', {
            roleName: `${prefix}-ssm-automation-role`,
            assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
            description: 'Allows SSM Automation to run commands on EC2 instances',
        });

        // Permission: RunCommand lifecycle (send, poll, list, cancel)
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowRunCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:ListCommands',
                'ssm:ListCommandInvocations',
                'ssm:GetCommandInvocation',
                'ssm:CancelCommand',
                'ssm:DescribeInstanceInformation',
            ],
            resources: ['*'], // Scoped by instance tags in production
        }));

        // Permission: Automation execution self-introspection
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowAutomationIntrospection',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetAutomationExecution',
                'ssm:DescribeAutomationStepExecutions',
            ],
            resources: ['*'],
        }));

        // Permission: Read/write SSM parameters (for step status)
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowSsmParameters',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        // Permission: S3 read for bootstrap scripts
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowS3Read',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:ListBucket',
            ],
            resources: [
                `arn:aws:s3:::${props.scriptsBucketName}`,
                `arn:aws:s3:::${props.scriptsBucketName}/*`,
            ],
        }));

        // Permission: EC2 DescribeInstances (for automation target resolution)
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowEc2Describe',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        // Permission: CloudWatch Logs for RunCommand output
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowCloudWatchLogs',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams',
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/ssm${props.ssmPrefix}/*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/ssm${props.ssmPrefix}/*:*`,
            ],
        }));

        // TODO: SNS alerting (future)
        // Permission: Publish to SNS topic on step failure
        // automationRole.addToPolicy(new iam.PolicyStatement({
        //     sid: 'AllowSnsPublish',
        //     actions: ['sns:Publish'],
        //     resources: [alertTopic.topicArn],
        // }));

        this.automationRoleArn = automationRole.roleArn;

        // =====================================================================
        // SSM Automation Document — Control Plane Bootstrap
        // =====================================================================

        const cpDocName = `${prefix}-bootstrap-control-plane`;

        const _cpDocument = new ssm.CfnDocument(this, 'ControlPlaneAutomation', {
            documentType: 'Automation',
            name: cpDocName,
            content: this.buildAutomationContent({
                description: 'Orchestrates Kubernetes control plane bootstrap (consolidated)',
                steps: CONTROL_PLANE_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.controlPlaneDocName = cpDocName;

        // =====================================================================
        // SSM Automation Document — Worker Node Bootstrap
        // =====================================================================

        const appWorkerDocName = `${prefix}-bootstrap-app-worker`;

        const _appWorkerDocument = new ssm.CfnDocument(this, 'AppWorkerAutomation', {
            documentType: 'Automation',
            name: appWorkerDocName,
            content: this.buildAutomationContent({
                description: 'Orchestrates Kubernetes app-worker node bootstrap (consolidated)',
                steps: WORKER_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.appWorkerDocName = appWorkerDocName;

        // =====================================================================
        // SSM Automation Document — Monitoring Worker Node Bootstrap
        // =====================================================================

        const monWorkerDocName = `${prefix}-bootstrap-mon-worker`;

        const _monWorkerDocument = new ssm.CfnDocument(this, 'MonWorkerAutomation', {
            documentType: 'Automation',
            name: monWorkerDocName,
            content: this.buildAutomationContent({
                description: 'Orchestrates Kubernetes mon-worker node bootstrap (consolidated)',
                steps: WORKER_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.monWorkerDocName = monWorkerDocName;

        // =====================================================================
        // SSM Automation Document — Next.js Secrets Deployment
        //
        // Single-step automation that syncs deploy scripts from S3 and runs
        // deploy.py to create/update the nextjs-secrets K8s Secret.
        // Triggered by the SSM Automation pipeline after bootstrap completes.
        // =====================================================================

        const nextjsDocName = `${prefix}-deploy-nextjs-secrets`;

        const _nextjsDocument = new ssm.CfnDocument(this, 'NextjsSecretsAutomation', {
            documentType: 'Automation',
            name: nextjsDocName,
            content: this.buildNextjsSecretsContent({
                description: 'Deploy Next.js K8s secrets — syncs from S3, resolves SSM parameters, creates Secret',
                steps: NEXTJS_SECRETS_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.nextjsSecretsDocName = nextjsDocName;

        // =====================================================================
        // SSM Automation Document — Monitoring Secrets Deployment
        //
        // Single-step automation that syncs deploy scripts from S3 and runs
        // deploy.py to resolve SSM parameters (grafana-admin-password,
        // github-token), create K8s Secrets, deploy the Helm chart, and
        // reset the Grafana admin password.
        // Triggered by the SSM Automation pipeline after bootstrap completes.
        // =====================================================================

        const monitoringDocName = `${prefix}-deploy-monitoring-secrets`;

        const _monitoringDocument = new ssm.CfnDocument(this, 'MonitoringSecretsAutomation', {
            documentType: 'Automation',
            name: monitoringDocName,
            content: this.buildNextjsSecretsContent({
                description: 'Deploy monitoring K8s secrets — syncs from S3, resolves SSM parameters, deploys Helm chart',
                steps: MONITORING_SECRETS_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.monitoringSecretsDocName = monitoringDocName;

        // =====================================================================
        // SSM Parameters — Document Discovery
        //
        // EC2 user data reads these parameters to find the document names
        // without needing cross-stack references.
        // =====================================================================

        new ssm.StringParameter(this, 'ControlPlaneDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/control-plane-doc-name`,
            stringValue: cpDocName,
            description: 'SSM Automation document name for control plane bootstrap',
        });

        new ssm.StringParameter(this, 'AppWorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/app-worker-doc-name`,
            stringValue: appWorkerDocName,
            description: 'SSM Automation document name for app-worker node bootstrap',
        });

        new ssm.StringParameter(this, 'MonWorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/mon-worker-doc-name`,
            stringValue: monWorkerDocName,
            description: 'SSM Automation document name for mon-worker node bootstrap',
        });

        new ssm.StringParameter(this, 'NextjsSecretsDocNameParam', {
            parameterName: `${props.ssmPrefix}/deploy/nextjs-secrets-doc-name`,
            stringValue: nextjsDocName,
            description: 'SSM Automation document name for Next.js secrets deployment',
        });

        new ssm.StringParameter(this, 'MonitoringSecretsDocNameParam', {
            parameterName: `${props.ssmPrefix}/deploy/monitoring-secrets-doc-name`,
            stringValue: monitoringDocName,
            description: 'SSM Automation document name for monitoring secrets deployment',
        });

        new ssm.StringParameter(this, 'AutomationRoleArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/automation-role-arn`,
            stringValue: automationRole.roleArn,
            description: 'IAM role ARN for SSM Automation execution',
        });

        // =====================================================================
        // Auto-Bootstrap Lambda — EventBridge → SSM Automation
        //
        // When an ASG launches a replacement instance, this Lambda:
        //   1. Reads the ASG's k8s:bootstrap-role tag
        //   2. Maps role → SSM Automation document
        //   3. Updates the instance-id SSM parameter
        //   4. Starts SSM Automation execution
        //
        // Non-K8s ASGs are silently ignored (no k8s:bootstrap-role tag).
        // =====================================================================

        const autoBootstrapFn = new lambda.Function(this, 'AutoBootstrapFn', {
            functionName: `${prefix}-auto-bootstrap`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json, logging, os, boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

asg_client = boto3.client("autoscaling")
ssm_client = boto3.client("ssm")

# Role → SSM parameter suffix for doc name and instance ID
ROLE_MAP = {
    "control-plane": {
        "doc_param": "bootstrap/control-plane-doc-name",
        "instance_param": "bootstrap/control-plane-instance-id",
    },
    "app-worker": {
        "doc_param": "bootstrap/app-worker-doc-name",
        "instance_param": "bootstrap/app-worker-instance-id",
    },
    "mon-worker": {
        "doc_param": "bootstrap/mon-worker-doc-name",
        "instance_param": "bootstrap/mon-worker-instance-id",
    },
}

def handler(event, context):
    detail = event.get("detail", {})
    instance_id = detail.get("EC2InstanceId", "")
    asg_name = detail.get("AutoScalingGroupName", "")

    if not instance_id or not asg_name:
        logger.info("Missing instance or ASG info, skipping")
        return {"statusCode": 200}

    logger.info("Instance launched: %s in ASG %s", instance_id, asg_name)

    # Read ASG tags to determine role
    resp = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[asg_name])
    groups = resp.get("AutoScalingGroups", [])
    if not groups:
        logger.info("ASG %s not found, skipping", asg_name)
        return {"statusCode": 200}

    tags = {t["Key"]: t["Value"] for t in groups[0].get("Tags", [])}
    role = tags.get("k8s:bootstrap-role")
    ssm_prefix = tags.get("k8s:ssm-prefix")

    if not role or not ssm_prefix:
        logger.info("No k8s:bootstrap-role tag on ASG %s, skipping (not a K8s node)", asg_name)
        return {"statusCode": 200}

    if role not in ROLE_MAP:
        logger.warning("Unknown bootstrap role: %s", role)
        return {"statusCode": 400}

    mapping = ROLE_MAP[role]
    doc_param_path = f"{ssm_prefix}/{mapping['doc_param']}"
    instance_param_path = f"{ssm_prefix}/{mapping['instance_param']}"
    bucket_param_path = f"{ssm_prefix}/scripts-bucket"

    # Update instance ID in SSM
    ssm_client.put_parameter(
        Name=instance_param_path,
        Value=instance_id,
        Type="String",
        Overwrite=True,
    )
    logger.info("Updated SSM %s = %s", instance_param_path, instance_id)

    # Resolve automation document name and S3 bucket
    doc_name = ssm_client.get_parameter(Name=doc_param_path)["Parameter"]["Value"]
    s3_bucket = ssm_client.get_parameter(Name=bucket_param_path)["Parameter"]["Value"]
    region = os.environ.get("AWS_REGION", "eu-west-1")

    # Start SSM Automation (tag-based targeting)
    # Uses Targets to resolve the instance by its k8s:bootstrap-role tag.
    # TargetParameterName tells SSM which document parameter receives the
    # resolved instance ID, populating Targets + ResolvedTargets in metadata.
    result = ssm_client.start_automation_execution(
        DocumentName=doc_name,
        Targets=[{
            "Key": "tag:k8s:bootstrap-role",
            "Values": [role],
        }],
        TargetParameterName="InstanceId",
        Parameters={
            "SsmPrefix": [ssm_prefix],
            "S3Bucket": [s3_bucket],
            "Region": [region],
        },
    )

    exec_id = result.get("AutomationExecutionId", "unknown")
    logger.info("Started %s automation for %s: %s", role, instance_id, exec_id)

    # Publish execution ID for observability
    try:
        exec_param = f"{ssm_prefix}/bootstrap/execution-id" if role == "control-plane" else f"{ssm_prefix}/bootstrap/{role.replace('-', '-')}-execution-id"
        ssm_client.put_parameter(Name=exec_param, Value=exec_id, Type="String", Overwrite=True)
    except Exception:
        logger.warning("Could not publish execution ID (non-fatal)")

    return {"statusCode": 200, "executionId": exec_id}
`),
            timeout: cdk.Duration.seconds(60),
            memorySize: 128,
            description: 'Auto-triggers SSM Automation bootstrap when an ASG launches a K8s instance',
        });

        // IAM: Allow Lambda to read ASG tags, manage SSM params, and start automation
        autoBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'AutoBootstrapDescribeAsg',
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:DescribeAutoScalingGroups'],
            resources: ['*'],
        }));

        autoBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'AutoBootstrapSsmParams',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter', 'ssm:PutParameter'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        autoBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'AutoBootstrapStartAutomation',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:StartAutomationExecution'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:automation-definition/*`,
                `arn:aws:ssm:${this.region}:${this.account}:automation-execution/*`,
            ],
        }));

        autoBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'AutoBootstrapPassRole',
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: [automationRole.roleArn],
        }));

        // EventBridge: trigger on any ASG instance launch
        new events.Rule(this, 'AutoBootstrapRule', {
            ruleName: `${prefix}-auto-bootstrap`,
            description: 'Trigger SSM Automation bootstrap when an ASG launches an instance',
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: ['EC2 Instance Launch Successful'],
            },
            targets: [new targets.LambdaFunction(autoBootstrapFn)],
        });

        // cdk-nag: Python 3.13 is the latest GA runtime
        NagSuppressions.addResourceSuppressions(autoBootstrapFn, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. PYTHON_3_14 is a CDK placeholder for an unreleased version.',
        }], true);

    }

    // =========================================================================
    // Build SSM Automation Document Content
    // =========================================================================

    private buildAutomationContent(opts: {
        description: string;
        steps: AutomationStep[];
        ssmPrefix: string;
        s3Bucket: string;
        automationRoleArn: string;
    }): Record<string, unknown> {
        return {
            schemaVersion: '0.3',
            description: opts.description,
            assumeRole: opts.automationRoleArn,
            parameters: {
                InstanceId: {
                    type: 'String',
                    description: 'Target EC2 instance ID',
                },
                SsmPrefix: {
                    type: 'String',
                    description: 'SSM parameter prefix for cluster info',
                    default: opts.ssmPrefix,
                },
                S3Bucket: {
                    type: 'String',
                    description: 'S3 bucket containing bootstrap scripts',
                    default: opts.s3Bucket,
                },
                Region: {
                    type: 'String',
                    description: 'AWS region',
                    default: this.region,
                },
            },
            mainSteps: opts.steps.map((step) => ({
                name: step.name,
                action: 'aws:runCommand',
                timeoutSeconds: step.timeoutSeconds,
                onFailure: 'Abort',
                // TODO: Add SNS notification on failure
                // onFailure: 'step:notifyFailure',
                inputs: {
                    DocumentName: 'AWS-RunShellScript',
                    InstanceIds: ['{{ InstanceId }}'],
                    CloudWatchOutputConfig: {
                        CloudWatchOutputEnabled: true,
                        CloudWatchLogGroupName: `/ssm${opts.ssmPrefix}/bootstrap`,
                    },
                    Parameters: {
                        commands: [
                            `# Step: ${step.name} — ${step.description}`,
                            ``,
                            `# Ensure PATH includes all standard binary locations`,
                            `export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"`,
                            `set -euo pipefail`,
                            ``,
                            `# Always sync latest scripts from S3 (AMI copy may be stale)`,
                            `STEPS_DIR="/data/k8s-bootstrap/${step.scriptPath.replace(/\/[^/]+$/, '')}"`,
                            `SCRIPT="/data/k8s-bootstrap/${step.scriptPath}"`,
                            ``,
                            `mkdir -p "$STEPS_DIR"`,
                            `aws s3 sync "s3://{{ S3Bucket }}/k8s-bootstrap/boot/steps/" "$STEPS_DIR/" --region {{ Region }} --quiet`,
                            ``,
                            `echo "=== Executing: ${step.name} ==="`,
                            ``,
                            `# Source CDK-configured env vars (HOSTED_ZONE_ID, API_DNS_NAME,`,
                            `# K8S_VERSION, NODE_LABEL, etc.) set by EC2 user-data at boot.`,
                            `if [ -f /etc/profile.d/k8s-env.sh ]; then`,
                            `  source /etc/profile.d/k8s-env.sh`,
                            `fi`,
                            ``,
                            `# Override with SSM Automation parameters (takes precedence)`,
                            `export SSM_PREFIX="{{ SsmPrefix }}"`,
                            `export AWS_REGION="{{ Region }}"`,
                            `export S3_BUCKET="{{ S3Bucket }}"`,
                            `export MOUNT_POINT="/data"`,
                            `export KUBECONFIG="/etc/kubernetes/admin.conf"`,
                            ``,
                            `cd "$STEPS_DIR"`,
                            `python3 "$SCRIPT" 2>&1`,
                            `echo "=== Completed: ${step.name} ==="`,
                        ],
                        workingDirectory: ['/tmp'],
                        executionTimeout: [String(step.timeoutSeconds)],
                    },
                },
            })),
            // Surface RunCommand CommandId in execution metadata Outputs
            outputs: opts.steps.map((step) => `${step.name}.CommandId`),
        };
    }

    // =========================================================================
    // Build Next.js Secrets Automation Document Content
    //
    // Separate from buildAutomationContent because:
    //   - S3 sync path: app-deploy/nextjs/ (not k8s-bootstrap/boot/steps/)
    //   - CloudWatch log group: /deploy (not /bootstrap)
    //   - Requires KUBECONFIG for kubectl access
    // =========================================================================

    private buildNextjsSecretsContent(opts: {
        description: string;
        steps: AutomationStep[];
        ssmPrefix: string;
        s3Bucket: string;
        automationRoleArn: string;
    }): Record<string, unknown> {
        return {
            schemaVersion: '0.3',
            description: opts.description,
            assumeRole: opts.automationRoleArn,
            parameters: {
                InstanceId: {
                    type: 'String',
                    description: 'Target EC2 instance ID',
                },
                SsmPrefix: {
                    type: 'String',
                    description: 'SSM parameter prefix for cluster info',
                    default: opts.ssmPrefix,
                },
                S3Bucket: {
                    type: 'String',
                    description: 'S3 bucket containing deploy scripts',
                    default: opts.s3Bucket,
                },
                Region: {
                    type: 'String',
                    description: 'AWS region',
                    default: this.region,
                },
            },
            mainSteps: opts.steps.map((step) => ({
                name: step.name,
                action: 'aws:runCommand',
                timeoutSeconds: step.timeoutSeconds,
                onFailure: 'Abort',
                inputs: {
                    DocumentName: 'AWS-RunShellScript',
                    InstanceIds: ['{{ InstanceId }}'],
                    CloudWatchOutputConfig: {
                        CloudWatchOutputEnabled: true,
                        CloudWatchLogGroupName: `/ssm${opts.ssmPrefix}/deploy`,
                    },
                    Parameters: {
                        commands: [
                            `# Step: ${step.name} — ${step.description}`,
                            ``,
                            `# Ensure PATH includes all standard binary locations`,
                            `export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"`,
                            `set -euo pipefail`,
                            ``,
                            `# Sync deploy scripts from S3`,
                            `DEPLOY_DIR="/data/${step.scriptPath.replace(/\/[^/]+$/, '')}"`,
                            `SCRIPT="/data/${step.scriptPath}"`,
                            ``,
                            `mkdir -p "$DEPLOY_DIR"`,
                            `aws s3 sync "s3://{{ S3Bucket }}/${step.scriptPath.replace(/\/[^/]+$/, '')}/" "$DEPLOY_DIR/" --region {{ Region }} --quiet`,
                            ``,
                            `echo "=== Executing: ${step.name} ==="`,
                            `export KUBECONFIG="/etc/kubernetes/admin.conf"`,
                            `export SSM_PREFIX="{{ SsmPrefix }}"`,
                            `export AWS_REGION="{{ Region }}"`,
                            `export S3_BUCKET="{{ S3Bucket }}"`,
                            ``,
                            `cd "$DEPLOY_DIR"`,
                            `python3 "$SCRIPT" 2>&1`,
                            `echo "=== Completed: ${step.name} ==="`,
                        ],
                        workingDirectory: ['/tmp'],
                        executionTimeout: [String(step.timeoutSeconds)],
                    },
                },
            })),
            // Surface RunCommand CommandId in execution metadata Outputs
            outputs: opts.steps.map((step) => `${step.name}.CommandId`),
        };
    }
}
