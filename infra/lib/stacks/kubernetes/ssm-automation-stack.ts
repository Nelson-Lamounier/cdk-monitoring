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

const NEXTJS_SECRETS_STEPS: AutomationStep[] = [
    {
        name: 'deployNextjsSecrets',
        scriptPath: 'app-deploy/nextjs/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create/update nextjs-secrets K8s Secret',
    },
];

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
 * Composes from reusable constructs:
 * - {@link SsmAutomationDocument} — SSM Automation documents
 * - {@link BootstrapOrchestratorConstruct} — Step Functions state machine
 * - {@link BootstrapAlarmConstruct} — CloudWatch alarm + SNS
 */
export class K8sSsmAutomationStack extends cdk.Stack {
    /** Control plane SSM Automation document name */
    public readonly controlPlaneDocName: string;

    /** App worker SSM Automation document name */
    public readonly appWorkerDocName: string;

    /** Monitoring worker SSM Automation document name */
    public readonly monWorkerDocName: string;

    /** ArgoCD worker SSM Automation document name */
    public readonly argocdWorkerDocName: string;

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

        const appWorkerDoc = new SsmAutomationDocument(this, 'AppWorkerAutomation', {
            documentName: `${prefix}-bootstrap-app-worker`,
            description: 'Orchestrates Kubernetes app-worker node bootstrap (consolidated)',
            documentCategory: 'bootstrap',
            steps: WORKER_STEPS,
            ...docBaseProps,
        });
        this.appWorkerDocName = appWorkerDoc.documentName;

        const monWorkerDoc = new SsmAutomationDocument(this, 'MonWorkerAutomation', {
            documentName: `${prefix}-bootstrap-mon-worker`,
            description: 'Orchestrates Kubernetes mon-worker node bootstrap (consolidated)',
            documentCategory: 'bootstrap',
            steps: WORKER_STEPS,
            ...docBaseProps,
        });
        this.monWorkerDocName = monWorkerDoc.documentName;

        const argocdWorkerDoc = new SsmAutomationDocument(this, 'ArgocdWorkerAutomation', {
            documentName: `${prefix}-bootstrap-argocd-worker`,
            description: 'Orchestrates Kubernetes argocd-worker node bootstrap (consolidated)',
            documentCategory: 'bootstrap',
            steps: WORKER_STEPS,
            ...docBaseProps,
        });
        this.argocdWorkerDocName = argocdWorkerDoc.documentName;

        // =====================================================================
        // SSM Automation Documents — Deploy (2)
        // =====================================================================

        const nextjsDoc = new SsmAutomationDocument(this, 'NextjsSecretsAutomation', {
            documentName: `${prefix}-deploy-nextjs-secrets`,
            description: 'Deploy Next.js K8s secrets — syncs from S3, resolves SSM parameters, creates Secret',
            documentCategory: 'deploy',
            steps: NEXTJS_SECRETS_STEPS,
            ...docBaseProps,
        });
        this.nextjsSecretsDocName = nextjsDoc.documentName;

        const monitoringDoc = new SsmAutomationDocument(this, 'MonitoringSecretsAutomation', {
            documentName: `${prefix}-deploy-monitoring-secrets`,
            description: 'Deploy monitoring K8s secrets — syncs from S3, resolves SSM parameters, deploys Helm chart',
            documentCategory: 'deploy',
            steps: MONITORING_SECRETS_STEPS,
            ...docBaseProps,
        });
        this.monitoringSecretsDocName = monitoringDoc.documentName;

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

        const appWorkerDocParam = new ssm.StringParameter(this, 'AppWorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/app-worker-doc-name`,
            stringValue: appWorkerDoc.documentName,
            description: 'SSM Automation document name for app-worker node bootstrap',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/app-worker-doc-name`, appWorkerDocParam);

        const monWorkerDocParam = new ssm.StringParameter(this, 'MonWorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/mon-worker-doc-name`,
            stringValue: monWorkerDoc.documentName,
            description: 'SSM Automation document name for mon-worker node bootstrap',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/mon-worker-doc-name`, monWorkerDocParam);

        const argocdWorkerDocParam = new ssm.StringParameter(this, 'ArgocdWorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/argocd-worker-doc-name`,
            stringValue: argocdWorkerDoc.documentName,
            description: 'SSM Automation document name for argocd-worker node bootstrap',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/argocd-worker-doc-name`, argocdWorkerDocParam);

        const nextjsDocParam = new ssm.StringParameter(this, 'NextjsSecretsDocNameParam', {
            parameterName: `${props.ssmPrefix}/deploy/nextjs-secrets-doc-name`,
            stringValue: nextjsDoc.documentName,
            description: 'SSM Automation document name for Next.js secrets deployment',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/deploy/nextjs-secrets-doc-name`, nextjsDocParam);

        const monDocParam = new ssm.StringParameter(this, 'MonitoringSecretsDocNameParam', {
            parameterName: `${props.ssmPrefix}/deploy/monitoring-secrets-doc-name`,
            stringValue: monitoringDoc.documentName,
            description: 'SSM Automation document name for monitoring secrets deployment',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/deploy/monitoring-secrets-doc-name`, monDocParam);

        const roleArnParam = new ssm.StringParameter(this, 'AutomationRoleArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/automation-role-arn`,
            stringValue: automationRole.roleArn,
            description: 'IAM role ARN for SSM Automation execution',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/automation-role-arn`, roleArnParam);

        // =====================================================================
        // Step Functions Orchestrator — EventBridge → State Machine → SSM
        // =====================================================================

        const orchestrator = new BootstrapOrchestratorConstruct(this, 'Orchestrator', {
            prefix,
            ssmPrefix: props.ssmPrefix,
            automationRoleArn: automationRole.roleArn,
            scriptsBucketName: props.scriptsBucketName,
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
