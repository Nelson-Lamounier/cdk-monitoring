/**
 * @format
 * SSM Automation Stack — K8s Bootstrap Orchestration
 *
 * Standalone CDK stack containing SSM Automation documents that orchestrate
 * the Kubernetes bootstrap process. Deployed independently from the Compute
 * stack so that bootstrap scripts can be updated without re-deploying EC2.
 *
 * Resources Created:
 *   - SSM Automation Document: Control plane bootstrap (7 steps)
 *   - SSM Automation Document: Worker node bootstrap (2 steps)
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

import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

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
        name: 'validateGoldenAMI',
        scriptPath: 'boot/steps/01_validate_ami.py',
        timeoutSeconds: 60,
        description: 'Verify Golden AMI has required binaries and kernel settings',
    },
    {
        name: 'initKubeadm',
        scriptPath: 'boot/steps/02_init_kubeadm.py',
        timeoutSeconds: 300,
        description: 'Run kubeadm init and publish join credentials to SSM',
    },
    {
        name: 'installCalicoCNI',
        scriptPath: 'boot/steps/03_install_calico.py',
        timeoutSeconds: 180,
        description: 'Install Calico CNI operator and configure IP pools',
    },
    {
        name: 'configureKubectl',
        scriptPath: 'boot/steps/04_configure_kubectl.py',
        timeoutSeconds: 60,
        description: 'Set up kubectl access for root, ec2-user, and ssm-user',
    },
    {
        name: 'syncManifests',
        scriptPath: 'boot/steps/05_sync_manifests.py',
        timeoutSeconds: 360,
        description: 'Download bootstrap manifests from S3 (patient retry for Day-1)',
    },
    {
        name: 'bootstrapArgoCD',
        scriptPath: 'boot/steps/06_bootstrap_argocd.py',
        timeoutSeconds: 600,
        description: 'Install ArgoCD and apply App-of-Apps root application',
    },
    {
        name: 'verifyCluster',
        scriptPath: 'boot/steps/07_verify_cluster.py',
        timeoutSeconds: 120,
        description: 'Lightweight post-boot health checks',
    },
];

const WORKER_STEPS: AutomationStep[] = [
    {
        name: 'validateGoldenAMI',
        scriptPath: 'boot/steps/01_validate_ami.py',
        timeoutSeconds: 60,
        description: 'Verify Golden AMI has required binaries and kernel settings',
    },
    {
        name: 'joinCluster',
        scriptPath: 'boot/steps/join_cluster.py',
        timeoutSeconds: 600,
        description: 'Join worker node to kubeadm cluster via SSM discovery',
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

    /** Worker node SSM Automation document name */
    public readonly workerDocName: string;

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
                description: 'Orchestrates Kubernetes control plane bootstrap (7 steps)',
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

        const workerDocName = `${prefix}-bootstrap-worker`;

        const _workerDocument = new ssm.CfnDocument(this, 'WorkerAutomation', {
            documentType: 'Automation',
            name: workerDocName,
            content: this.buildAutomationContent({
                description: 'Orchestrates Kubernetes worker node bootstrap (2 steps)',
                steps: WORKER_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.workerDocName = workerDocName;

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

        new ssm.StringParameter(this, 'WorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/worker-doc-name`,
            stringValue: workerDocName,
            description: 'SSM Automation document name for worker node bootstrap',
        });

        new ssm.StringParameter(this, 'AutomationRoleArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/automation-role-arn`,
            stringValue: automationRole.roleArn,
            description: 'IAM role ARN for SSM Automation execution',
        });

        // =====================================================================
        // Tags
        // =====================================================================

        cdk.Tags.of(this).add('Component', 'ssm-automation');
        cdk.Tags.of(this).add('Environment', props.targetEnvironment);
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
                    Parameters: {
                        commands: [
                            `# Step: ${step.name} — ${step.description}`,
                            `set -euo pipefail`,
                            ``,
                            `# Ensure step scripts are available locally`,
                            `STEPS_DIR="/data/k8s-bootstrap/${step.scriptPath.replace(/\/[^/]+$/, '')}"`,
                            `SCRIPT="/data/k8s-bootstrap/${step.scriptPath}"`,
                            ``,
                            `if [ ! -f "$SCRIPT" ]; then`,
                            `  echo "Step script not found locally, syncing from S3..."`,
                            `  aws s3 sync "s3://{{ S3Bucket }}/k8s-bootstrap/boot/steps/" "$STEPS_DIR/" --region {{ Region }}`,
                            `fi`,
                            ``,
                            `echo "=== Executing: ${step.name} ==="`,
                            `export SSM_PREFIX="{{ SsmPrefix }}"`,
                            `export AWS_REGION="{{ Region }}"`,
                            `export S3_BUCKET="{{ S3Bucket }}"`,
                            `export MOUNT_POINT="/data"`,
                            ``,
                            `cd "$STEPS_DIR"`,
                            `python3 "$SCRIPT"`,
                            `echo "=== Completed: ${step.name} ==="`,
                        ],
                        workingDirectory: ['/tmp'],
                        executionTimeout: [String(step.timeoutSeconds)],
                    },
                },
            })),
        };
    }
}
