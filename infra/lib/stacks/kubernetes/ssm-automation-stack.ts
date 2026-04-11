/**
 * @format
 * SSM Automation Stack — K8s Bootstrap Orchestration
 *
 * Standalone CDK stack containing SSM Automation documents that orchestrate
 * the Kubernetes bootstrap process. Deployed independently from the Compute
 * stack so that bootstrap scripts can be updated without re-deploying EC2.
 *
 * Resources Created:
 *   - SSM Automation Documents (6): CP, app-worker, mon-worker, argocd-worker,
 *     nextjs-secrets, monitoring-secrets
 *   - SSM Parameters: Document name discovery for EC2 user data
 *   - IAM Role: Automation execution role with RunCommand permissions
 *   - Step Functions: Bootstrap orchestrator state machine
 *   - Lambda: Thin router for ASG tag resolution
 *   - EventBridge: Auto-trigger on ASG instance launch
 *   - CloudWatch Alarm + SNS: Failure notifications
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

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';
import {
    SsmAutomationDocument,
} from '../../constructs/ssm/automation-document';
import type { AutomationStep } from '../../constructs/ssm/automation-document';
import {
    BootstrapAlarmConstruct,
} from '../../constructs/ssm/bootstrap-alarm';
import {
    BootstrapOrchestratorConstruct,
} from '../../constructs/ssm/bootstrap-orchestrator';
import {
    NodeDriftEnforcementConstruct,
} from '../../constructs/ssm/node-drift-enforcement';
import {
    ResourceCleanupProvider,
} from '../../constructs/ssm/resource-cleanup-provider';
import { 
    SsmRunCommandDocument, 
} from '../../constructs/ssm/ssm-run-command-document';

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

    /**
     * Email address for alarm notifications.
     * When provided, subscribes to the bootstrap failure alarm topic.
     * Sourced from NOTIFICATION_EMAIL env var via the factory.
     */
    readonly notificationEmail?: string;
}

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

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

const DEPLOY_SECRETS_STEPS: AutomationStep[] = [
    {
        name: 'deployNextjsSecrets',
        scriptPath: 'app-deploy/nextjs/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create/update nextjs-secrets K8s Secret',
    },
    {
        name: 'deployMonitoringSecrets',
        scriptPath: 'app-deploy/monitoring/deploy.py',
        timeoutSeconds: 600,
        description: 'Resolve SSM parameters and create monitoring K8s Secrets',
    },
    {
        name: 'deployStartAdminSecrets',
        scriptPath: 'app-deploy/start-admin/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create/update start-admin-secrets K8s Secret',
    },
    {
        name: 'deployAdminApiSecrets',
        scriptPath: 'app-deploy/admin-api/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create/update admin-api K8s resources',
    },
    {
        name: 'deployPublicApiSecrets',
        scriptPath: 'app-deploy/public-api/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create/update public-api K8s resources',
    },
];

// =============================================================================
// STACK
// =============================================================================

/**
 * SSM Automation Stack — K8s Bootstrap Orchestration.
 *
 * Composes from reusable constructs:
 * - {@link SsmAutomationDocument} — SSM Automation documents
 * - {@link BootstrapOrchestratorConstruct} — Step Functions state machine
 * - {@link BootstrapAlarmConstruct} — CloudWatch alarm + SNS
 */
export class K8sSsmAutomationStack extends cdk.Stack {
    /** Control plane SSM Automation document name */
    public readonly controlPlaneDocName: string;

    /** Unified worker SSM Automation document name (all worker roles) */
    public readonly workerDocName: string;

    /** Consolidated deploy secrets SSM Automation document name (nextjs + monitoring + start-admin) */
    public readonly deploySecretsDocName: string;

    /** Automation execution role ARN */
    public readonly automationRoleArn: string;

    /** CloudWatch Log Group for SSM bootstrap RunCommand output */
    public readonly bootstrapLogGroup: logs.LogGroup;

    /** CloudWatch Log Group for SSM deploy RunCommand output */
    public readonly deployLogGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: K8sSsmAutomationStackProps) {
        super(scope, id, props);

        const prefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // Resource Cleanup — pre-emptive orphan deletion
        //
        // Resources with hardcoded physical names become orphans after
        // CloudFormation UPDATE_ROLLBACK_COMPLETE. This provider runs a
        // cleanup Lambda before each CREATE, deleting any pre-existing
        // resource so the deployment always succeeds.
        // =====================================================================

        const cleanup = new ResourceCleanupProvider(this, 'ResourceCleanup');

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


        this.automationRoleArn = automationRole.roleArn;

        // =====================================================================
        // CloudWatch Log Groups — SSM RunCommand Output
        //
        // Pre-create log groups so retention and removal policies are enforced.
        // Without this, the SSM Agent auto-creates groups with infinite retention.
        // The SSM Agent on the EC2 instance writes RunCommand stdout/stderr here.
        // =====================================================================

        this.bootstrapLogGroup = new logs.LogGroup(this, 'BootstrapLogGroup', {
            logGroupName: `/ssm${props.ssmPrefix}/bootstrap`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        cleanup.addLogGroup(`/ssm${props.ssmPrefix}/bootstrap`, this.bootstrapLogGroup);

        this.deployLogGroup = new logs.LogGroup(this, 'DeployLogGroup', {
            logGroupName: `/ssm${props.ssmPrefix}/deploy`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        cleanup.addLogGroup(`/ssm${props.ssmPrefix}/deploy`, this.deployLogGroup);

        // =====================================================================
        // Common document props
        // =====================================================================
        const docBaseProps = {
            ssmPrefix: props.ssmPrefix,
            s3Bucket: props.scriptsBucketName,
            automationRoleArn: automationRole.roleArn,
        };

        // =====================================================================
        // SSM Automation Documents — Bootstrap (4)
        // =====================================================================

        const cpDoc = new SsmAutomationDocument(this, 'ControlPlaneAutomation', {
            documentName: `${prefix}-bootstrap-control-plane`,
            description: 'Orchestrates Kubernetes control plane bootstrap (consolidated)',
            documentCategory: 'bootstrap',
            steps: CONTROL_PLANE_STEPS,
            ...docBaseProps,
        });
        this.controlPlaneDocName = cpDoc.documentName;

        // Unified worker document — serves app-worker, mon-worker, and
        // argocd-worker roles.  The NODE_LABEL env var (set by user data /
        // SSM Automation parameters) controls per-role behaviour inside the
        // Python bootstrap script.
        const workerDoc = new SsmAutomationDocument(this, 'WorkerAutomation', {
            documentName: `${prefix}-bootstrap-worker`,
            description: 'Orchestrates Kubernetes worker node bootstrap (all roles — app, monitoring, argocd)',
            documentCategory: 'bootstrap',
            steps: WORKER_STEPS,
            ...docBaseProps,
        });
        this.workerDocName = workerDoc.documentName;

        // =====================================================================
        // SSM Automation Documents — Deploy (1 — consolidated)
        // =====================================================================

        const deployDoc = new SsmAutomationDocument(this, 'DeploySecretsAutomation', {
            documentName: `${prefix}-deploy-secrets`,
            description: 'Deploy K8s secrets (nextjs + monitoring + start-admin) — syncs from S3, resolves SSM parameters, creates Secrets',
            documentCategory: 'deploy',
            steps: DEPLOY_SECRETS_STEPS,
            ...docBaseProps,
        });
        this.deploySecretsDocName = deployDoc.documentName;

        // =====================================================================
        // SSM Run Command Documents — NEW Step Functions Orchestrators
        // =====================================================================

        const runnerParams = {
            ScriptPath: { type: 'String' as const, description: 'Relative path to python script' },
            SsmPrefix: { type: 'String' as const, description: 'SSM parameter prefix' },
            S3Bucket: { type: 'String' as const, description: 'S3 scripts bucket name' },
            Region: { type: 'String' as const, description: 'AWS region' },
        };

        const bootstrapRunner = new SsmRunCommandDocument(this, 'BootstrapRunnerCommand', {
            documentName: `${prefix}-bootstrap-runner`,
            description: 'Step Functions Runner for K8s Bootstrap Scripts',
            parameters: runnerParams,
            steps: [{
                name: 'runScript',
                commands: [
                    'export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
                    'set -euo pipefail',
                    'SCRIPT_PATH="{{ScriptPath}}"',
                    'STEPS_DIR="/data/k8s-bootstrap/$(dirname "$SCRIPT_PATH")"',
                    'SCRIPT="/data/k8s-bootstrap/$SCRIPT_PATH"',
                    'mkdir -p "$STEPS_DIR"',
                    'aws s3 sync "s3://{{S3Bucket}}/k8s-bootstrap/boot/steps/" "$STEPS_DIR/" --region {{Region}} --quiet',
                    '',
                    'echo "Clearing retryable step markers..."',
                    'rm -f /etc/kubernetes/.calico-installed',
                    'rm -f /etc/kubernetes/.ccm-installed',
                    'echo "Retryable markers cleared"',
                    '',
                    'if [ -f /etc/profile.d/k8s-env.sh ]; then',
                    '  source /etc/profile.d/k8s-env.sh',
                    'fi',
                    '',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    'export MOUNT_POINT="/data"',
                    'export KUBECONFIG="/etc/kubernetes/admin.conf"',
                    '',
                    'cd "$STEPS_DIR"',
                    'python3 "$SCRIPT" 2>&1'
                ],
            }],
        });

        const deployRunner = new SsmRunCommandDocument(this, 'DeployRunnerCommand', {
            documentName: `${prefix}-deploy-runner`,
            description: 'Step Functions Runner for K8s Deploy Scripts',
            parameters: runnerParams,
            steps: [{
                name: 'runScript',
                commands: [
                    'export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
                    'set -euo pipefail',
                    'mkdir -p "/data/k8s-bootstrap"',
                    'aws s3 sync "s3://{{S3Bucket}}/k8s-bootstrap/" "/data/k8s-bootstrap/" --region {{Region}} --quiet',
                    '',
                    'SCRIPT_PATH="{{ScriptPath}}"',
                    'DEPLOY_DIR="/data/$(dirname "$SCRIPT_PATH")"',
                    'SCRIPT="/data/$SCRIPT_PATH"',
                    'mkdir -p "$DEPLOY_DIR"',
                    'aws s3 sync "s3://{{S3Bucket}}/$(dirname "$SCRIPT_PATH")/" "$DEPLOY_DIR/" --region {{Region}} --quiet',
                    '',
                    'if [ -f "$DEPLOY_DIR/requirements.txt" ]; then',
                    '  /opt/k8s-venv/bin/pip install -q -r "$DEPLOY_DIR/requirements.txt" 2>/dev/null',
                    'fi',
                    '',
                    'export KUBECONFIG="/etc/kubernetes/admin.conf"',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    '',
                    'cd "$DEPLOY_DIR"',
                    'python3 "$SCRIPT" 2>&1'
                ],
            }],
        });


        // =====================================================================
        // SSM Parameters — Document Discovery
        //
        // EC2 user data reads these parameters to find the document names
        // without needing cross-stack references.
        // =====================================================================

        const cpDocParam = new ssm.StringParameter(this, 'ControlPlaneDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/control-plane-doc-name`,
            stringValue: cpDoc.documentName,
            description: 'SSM Automation document name for control plane bootstrap',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/control-plane-doc-name`, cpDocParam);

        const workerDocParam = new ssm.StringParameter(this, 'WorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/worker-doc-name`,
            stringValue: workerDoc.documentName,
            description: 'SSM Automation document name for worker node bootstrap (all roles)',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/worker-doc-name`, workerDocParam);

        const deployDocParam = new ssm.StringParameter(this, 'DeploySecretsDocNameParam', {
            parameterName: `${props.ssmPrefix}/deploy/secrets-doc-name`,
            stringValue: deployDoc.documentName,
            description: 'SSM Automation document name for consolidated secrets deployment (nextjs + monitoring + start-admin)',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/deploy/secrets-doc-name`, deployDocParam);

        const roleArnParam = new ssm.StringParameter(this, 'AutomationRoleArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/automation-role-arn`,
            stringValue: automationRole.roleArn,
            description: 'IAM role ARN for SSM Automation execution',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/automation-role-arn`, roleArnParam);

        const bootstrapLogGroupParam = new ssm.StringParameter(this, 'BootstrapLogGroupParam', {
            parameterName: `${props.ssmPrefix}/cloudwatch/ssm-bootstrap-log-group`,
            stringValue: this.bootstrapLogGroup.logGroupName,
            description: 'CloudWatch Log Group for SSM RunCommand bootstrap output',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/cloudwatch/ssm-bootstrap-log-group`, bootstrapLogGroupParam);

        const deployLogGroupParam = new ssm.StringParameter(this, 'DeployLogGroupParam', {
            parameterName: `${props.ssmPrefix}/cloudwatch/ssm-deploy-log-group`,
            stringValue: this.deployLogGroup.logGroupName,
            description: 'CloudWatch Log Group for SSM RunCommand deploy output',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/cloudwatch/ssm-deploy-log-group`, deployLogGroupParam);

        // =====================================================================
        // Step Functions Orchestrator — EventBridge → State Machine → SSM
        // =====================================================================

        const orchestrator = new BootstrapOrchestratorConstruct(this, 'Orchestrator', {
            prefix,
            ssmPrefix: props.ssmPrefix,
            automationRoleArn: automationRole.roleArn,
            scriptsBucketName: props.scriptsBucketName,
            bootstrapRunnerName: bootstrapRunner.documentName,
            deployRunnerName: deployRunner.documentName,
            bootstrapLogGroupName: this.bootstrapLogGroup.logGroupName,
            deployLogGroupName: this.deployLogGroup.logGroupName,
        });

        // Register orchestrator log group for cleanup
        const orchestratorLogGroupName = `/aws/vendedlogs/states/${prefix}-bootstrap-orchestrator`;
        cleanup.addLogGroup(orchestratorLogGroupName, orchestrator.stateMachine);

        // Register router Lambda log group for cleanup
        const routerLogGroupName = `/aws/lambda/${prefix}-bootstrap-router`;
        cleanup.addLogGroup(routerLogGroupName, orchestrator.routerFunction);

        // =====================================================================
        // CloudWatch Alarm — Step Functions Execution Failures
        // =====================================================================

        const alarm = new BootstrapAlarmConstruct(this, 'BootstrapAlarm', {
            prefix,
            stateMachine: orchestrator.stateMachine,
            notificationEmail: props.notificationEmail,
        });

        // Permission: Publish to SNS alarm topic on step failure
        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowSnsPublish',
            effect: iam.Effect.ALLOW,
            actions: ['sns:Publish'],
            resources: [alarm.topic.topicArn],
        }));

        // Register alarm SNS topic for cleanup
        const alarmTopicName = `${prefix}-bootstrap-alarm`;
        cleanup.addSnsTopic(alarmTopicName, alarm.topic);

        // =====================================================================
        // Node Drift Enforcement — SSM State Manager Association
        //
        // Continuously enforces OS-level K8s prerequisites (kernel modules,
        // sysctl parameters, containerd/kubelet service state) across all
        // compute nodes. Runs every 30 minutes via State Manager.
        // =====================================================================

        new NodeDriftEnforcementConstruct(this, 'DriftEnforcement', {
            prefix,
            targetEnvironment: props.targetEnvironment,
            ssmPrefix: props.ssmPrefix,
        });

        // =====================================================================
        // CDK-Nag Suppressions
        // =====================================================================

        // cdk-nag: Python 3.13 is the latest GA runtime
        NagSuppressions.addResourceSuppressions(orchestrator.routerFunction, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. PYTHON_3_14 is a CDK placeholder for an unreleased version.',
        }], true);

        // cdk-nag: Cleanup Lambda and Provider framework Lambda
        NagSuppressions.addResourceSuppressions(cleanup, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. Provider framework Lambda runtime is managed by CDK.',
        }, {
            id: 'AwsSolutions-IAM5',
            reason: 'Cleanup Lambda requires wildcard for log group/SSM parameter ARNs as orphaned resource names are dynamic.',
        }, {
            id: 'AwsSolutions-IAM4',
            reason: 'Provider framework uses AWS managed policy for Lambda basic execution — standard CDK pattern.',
        }], true);
    }
}
