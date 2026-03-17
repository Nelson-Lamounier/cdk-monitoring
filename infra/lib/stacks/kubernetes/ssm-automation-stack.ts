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

import { NagSuppressions } from 'cdk-nag';

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
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

    /**
     * Email address for alarm notifications.
     * When provided, subscribes to the bootstrap failure alarm topic.
     * Sourced from NOTIFICATION_EMAIL env var via the factory.
     */
    readonly notificationEmail?: string;
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
        // SSM Automation Document — ArgoCD Worker Node Bootstrap
        // =====================================================================

        const argocdWorkerDocName = `${prefix}-bootstrap-argocd-worker`;

        const _argocdWorkerDocument = new ssm.CfnDocument(this, 'ArgocdWorkerAutomation', {
            documentType: 'Automation',
            name: argocdWorkerDocName,
            content: this.buildAutomationContent({
                description: 'Orchestrates Kubernetes argocd-worker node bootstrap (consolidated)',
                steps: WORKER_STEPS,
                ssmPrefix: props.ssmPrefix,
                s3Bucket: props.scriptsBucketName,
                automationRoleArn: automationRole.roleArn,
            }),
            documentFormat: 'JSON',
            updateMethod: 'NewVersion',
        });

        this.argocdWorkerDocName = argocdWorkerDocName;

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

        new ssm.StringParameter(this, 'ArgocdWorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/argocd-worker-doc-name`,
            stringValue: argocdWorkerDocName,
            description: 'SSM Automation document name for argocd-worker node bootstrap',
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
        // Step Functions Orchestrator — EventBridge → State Machine → SSM
        //
        // When an ASG launches a replacement instance, this state machine:
        //   1. Invokes a thin router Lambda to read ASG tags and resolve role
        //   2. Updates the instance-id SSM parameter
        //   3. Starts the appropriate SSM Automation document
        //   4. Waits for completion (polling loop)
        //   5. For control-plane: chains secrets deployment + worker re-join
        //
        // Non-K8s ASGs are silently ignored (no k8s:bootstrap-role tag).
        // =====================================================================

        // --- Thin Router Lambda: reads ASG tags, resolves doc names ---
        const routerFn = new lambda.Function(this, 'BootstrapRouterFn', {
            functionName: `${prefix}-bootstrap-router`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import logging, boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

asg_client = boto3.client("autoscaling")
ssm_client = boto3.client("ssm")

ROLE_DOC_MAP = {
    "control-plane": "bootstrap/control-plane-doc-name",
    "app-worker": "bootstrap/app-worker-doc-name",
    "mon-worker": "bootstrap/mon-worker-doc-name",
    "argocd-worker": "bootstrap/argocd-worker-doc-name",
}

def handler(event, context):
    """Read ASG tags and return role + SSM metadata for Step Functions."""
    detail = event.get("detail", {})
    instance_id = detail.get("EC2InstanceId", "")
    asg_name = detail.get("AutoScalingGroupName", "")

    if not instance_id or not asg_name:
        logger.info("Missing instance or ASG info, skipping")
        return {"role": None, "reason": "Missing instance or ASG info"}

    logger.info("Instance launched: %s in ASG %s", instance_id, asg_name)

    resp = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[asg_name])
    groups = resp.get("AutoScalingGroups", [])
    if not groups:
        logger.info("ASG %s not found, skipping", asg_name)
        return {"role": None, "reason": f"ASG {asg_name} not found"}

    tags = {t["Key"]: t["Value"] for t in groups[0].get("Tags", [])}
    role = tags.get("k8s:bootstrap-role")
    ssm_prefix = tags.get("k8s:ssm-prefix")

    if not role or not ssm_prefix:
        logger.info("No k8s tags on ASG %s, skipping", asg_name)
        return {"role": None, "reason": f"No k8s tags on ASG {asg_name}"}

    doc_param = ROLE_DOC_MAP.get(role)
    if not doc_param:
        logger.warning("Unknown bootstrap role: %s", role)
        return {"role": None, "reason": f"Unknown role: {role}"}

    # Resolve the SSM Automation document name + S3 bucket
    doc_name = ssm_client.get_parameter(Name=f"{ssm_prefix}/{doc_param}")["Parameter"]["Value"]
    s3_bucket = ssm_client.get_parameter(Name=f"{ssm_prefix}/scripts-bucket")["Parameter"]["Value"]

    result = {
        "role": role,
        "instanceId": instance_id,
        "asgName": asg_name,
        "ssmPrefix": ssm_prefix,
        "docName": doc_name,
        "s3Bucket": s3_bucket,
        "region": context.invoked_function_arn.split(":")[3],
    }
    logger.info("Router result: %s", result)
    return result
`),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            description: 'Thin router: reads ASG tags and resolves SSM doc names for Step Functions',
        });

        // IAM for router Lambda
        routerFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'RouterDescribeAsg',
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:DescribeAutoScalingGroups'],
            resources: ['*'],
        }));

        routerFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'RouterReadSsmParams',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        // --- Step Functions State Machine ---


        // Helper: build an SSM Automation polling loop (wait → check → loop/proceed)
        const buildAutomationChain = (
            id: string,
            docNamePath: string,
            instanceIdPath: string,
            ssmPrefixPath: string,
            s3BucketPath: string,
            regionPath: string,
        ): { start: sfn.IChainable; end: sfn.Pass } => {
            const startExec = new sfnTasks.CallAwsService(this, `${id}Start`, {
                service: 'ssm',
                action: 'startAutomationExecution',
                parameters: {
                    DocumentName: sfn.JsonPath.stringAt(docNamePath),
                    Parameters: {
                        InstanceId: sfn.JsonPath.array(sfn.JsonPath.stringAt(instanceIdPath)),
                        SsmPrefix: sfn.JsonPath.array(sfn.JsonPath.stringAt(ssmPrefixPath)),
                        S3Bucket: sfn.JsonPath.array(sfn.JsonPath.stringAt(s3BucketPath)),
                        Region: sfn.JsonPath.array(sfn.JsonPath.stringAt(regionPath)),
                    },
                },
                iamResources: [
                    `arn:aws:ssm:${this.region}:${this.account}:automation-definition/*`,
                    `arn:aws:ssm:${this.region}:${this.account}:automation-execution/*`,
                ],
                additionalIamStatements: [
                    new iam.PolicyStatement({
                        actions: ['iam:PassRole'],
                        resources: [automationRole.roleArn],
                    }),
                ],
                resultSelector: {
                    'AutomationExecutionId.$': '$.AutomationExecutionId',
                },
                resultPath: `$.${id}Result`,
            });

            const waitStep = new sfn.Wait(this, `${id}Wait`, {
                time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
            });

            const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
                service: 'ssm',
                action: 'getAutomationExecution',
                parameters: {
                    AutomationExecutionId: sfn.JsonPath.stringAt(`$.${id}Result.AutomationExecutionId`),
                },
                iamResources: [
                    `arn:aws:ssm:${this.region}:${this.account}:automation-execution/*`,
                ],
                resultSelector: {
                    'Status.$': '$.AutomationExecution.AutomationExecutionStatus',
                },
                resultPath: `$.${id}Status`,
            });

            const successState = new sfn.Pass(this, `${id}Done`);

            const failState = new sfn.Fail(this, `${id}Failed`, {
                cause: `SSM Automation ${id} failed`,
                error: 'AutomationFailed',
            });

            const checkStatus = new sfn.Choice(this, `${id}Check`)
                .when(
                    sfn.Condition.stringEquals(`$.${id}Status.Status`, 'Success'),
                    successState,
                )
                .when(
                    sfn.Condition.or(
                        sfn.Condition.stringEquals(`$.${id}Status.Status`, 'InProgress'),
                        sfn.Condition.stringEquals(`$.${id}Status.Status`, 'Waiting'),
                        sfn.Condition.stringEquals(`$.${id}Status.Status`, 'Pending'),
                    ),
                    waitStep,
                )
                .otherwise(failState);

            // Chain: Start → Wait → Poll → Check → (loop back to Wait or proceed)
            startExec.next(waitStep);
            waitStep.next(pollStatus);
            pollStatus.next(checkStatus);

            return { start: startExec, end: successState };
        };

        // ── Router Lambda invocation ──
        const invokeRouter = new sfnTasks.LambdaInvoke(this, 'InvokeRouter', {
            lambdaFunction: routerFn,
            resultSelector: {
                'role.$': '$.Payload.role',
                'instanceId.$': '$.Payload.instanceId',
                'asgName.$': '$.Payload.asgName',
                'ssmPrefix.$': '$.Payload.ssmPrefix',
                'docName.$': '$.Payload.docName',
                's3Bucket.$': '$.Payload.s3Bucket',
                'region.$': '$.Payload.region',
                'reason.$': '$.Payload.reason',
            },
            resultPath: '$.router',
        });

        // ── Skip non-K8s instances ──
        const skipNonK8s = new sfn.Succeed(this, 'SkipNonK8s', {
            comment: 'Not a K8s ASG — no bootstrap role tag',
        });

        // ── Update instance ID in SSM ──
        const updateInstanceId = new sfnTasks.CallAwsService(this, 'UpdateInstanceId', {
            service: 'ssm',
            action: 'putParameter',
            parameters: {
                Name: sfn.JsonPath.format(
                    '{}/bootstrap/{}-instance-id',
                    sfn.JsonPath.stringAt('$.router.ssmPrefix'),
                    sfn.JsonPath.stringAt('$.router.role'),
                ),
                Value: sfn.JsonPath.stringAt('$.router.instanceId'),
                Type: 'String',
                Overwrite: true,
            },
            iamResources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultPath: sfn.JsonPath.DISCARD,
        });

        // ── Control Plane Branch ──

        // Step 1: CP Bootstrap
        const cpBootstrap = buildAutomationChain(
            'CpBootstrap',
            '$.router.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
        );

        // Step 2: Resolve nextjs secrets doc name
        const getNextjsDocName = new sfnTasks.CallAwsService(this, 'GetNextjsDocName', {
            service: 'ssm',
            action: 'getParameter',
            parameters: {
                Name: sfn.JsonPath.format(
                    '{}/deploy/nextjs-secrets-doc-name',
                    sfn.JsonPath.stringAt('$.router.ssmPrefix'),
                ),
            },
            iamResources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultSelector: {
                'docName.$': '$.Parameter.Value',
            },
            resultPath: '$.nextjsDoc',
        });

        // Step 3: Deploy nextjs secrets
        const nextjsSecrets = buildAutomationChain(
            'NextjsSecrets',
            '$.nextjsDoc.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
        );

        // Step 4: Resolve monitoring secrets doc name
        const getMonDocName = new sfnTasks.CallAwsService(this, 'GetMonDocName', {
            service: 'ssm',
            action: 'getParameter',
            parameters: {
                Name: sfn.JsonPath.format(
                    '{}/deploy/monitoring-secrets-doc-name',
                    sfn.JsonPath.stringAt('$.router.ssmPrefix'),
                ),
            },
            iamResources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultSelector: {
                'docName.$': '$.Parameter.Value',
            },
            resultPath: '$.monDoc',
        });

        // Step 5: Deploy monitoring secrets
        const monSecrets = buildAutomationChain(
            'MonSecrets',
            '$.monDoc.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
        );

        // Step 6: Wait for CA to propagate before worker re-join
        const waitForCa = new sfn.Wait(this, 'WaitForCaPublish', {
            time: sfn.WaitTime.duration(cdk.Duration.minutes(15)),
            comment: 'Wait for CP to publish new CA hash before worker re-bootstrap',
        });

        // Step 7: Resolve worker doc names and instance IDs, then re-bootstrap in parallel

        // Helper: build a worker re-bootstrap branch for the Parallel state
        const buildWorkerRejoinBranch = (workerRole: string): sfn.Chain => {
            const docParamName = `${props.ssmPrefix}/bootstrap/${workerRole}-doc-name`;
            const instanceParamName = `${props.ssmPrefix}/bootstrap/${workerRole}-instance-id`;

            const getWorkerDoc = new sfnTasks.CallAwsService(this, `GetDoc-${workerRole}`, {
                service: 'ssm',
                action: 'getParameter',
                parameters: { Name: docParamName },
                iamResources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
                ],
                resultSelector: { 'docName.$': '$.Parameter.Value' },
                resultPath: '$.workerDoc',
            });

            const getWorkerInstance = new sfnTasks.CallAwsService(this, `GetInst-${workerRole}`, {
                service: 'ssm',
                action: 'getParameter',
                parameters: { Name: instanceParamName },
                iamResources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
                ],
                resultSelector: { 'instanceId.$': '$.Parameter.Value' },
                resultPath: '$.workerInst',
            });

            const startWorkerReboot = new sfnTasks.CallAwsService(this, `Rejoin-${workerRole}`, {
                service: 'ssm',
                action: 'startAutomationExecution',
                parameters: {
                    DocumentName: sfn.JsonPath.stringAt('$.workerDoc.docName'),
                    Parameters: {
                        InstanceId: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.workerInst.instanceId')),
                        SsmPrefix: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.router.ssmPrefix')),
                        S3Bucket: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.router.s3Bucket')),
                        Region: sfn.JsonPath.array(sfn.JsonPath.stringAt('$.router.region')),
                    },
                },
                iamResources: [
                    `arn:aws:ssm:${this.region}:${this.account}:automation-definition/*`,
                    `arn:aws:ssm:${this.region}:${this.account}:automation-execution/*`,
                ],
                additionalIamStatements: [
                    new iam.PolicyStatement({
                        actions: ['iam:PassRole'],
                        resources: [automationRole.roleArn],
                    }),
                ],
                resultPath: sfn.JsonPath.DISCARD,
            });

            return sfn.Chain.start(getWorkerDoc)
                .next(getWorkerInstance)
                .next(startWorkerReboot);
        };

        const workerRejoinParallel = new sfn.Parallel(this, 'RejoinAllWorkers', {
            comment: 'Re-bootstrap all worker nodes in parallel after CP replacement',
            resultPath: sfn.JsonPath.DISCARD,
        });

        workerRejoinParallel.branch(buildWorkerRejoinBranch('app-worker'));
        workerRejoinParallel.branch(buildWorkerRejoinBranch('mon-worker'));
        workerRejoinParallel.branch(buildWorkerRejoinBranch('argocd-worker'));

        // Chain the CP branch: connect each sub-chain's end → next step
        // cpBootstrap is internally: Start → Wait → Poll → Check → Done(Pass)
        // We connect Done(Pass).next → getNextjsDocName, etc.
        cpBootstrap.end.next(getNextjsDocName);
        getNextjsDocName.next(nextjsSecrets.start as sfn.IChainable);
        nextjsSecrets.end.next(getMonDocName);
        getMonDocName.next(monSecrets.start as sfn.IChainable);
        monSecrets.end.next(waitForCa);
        waitForCa.next(workerRejoinParallel);

        const cpChain = sfn.Chain.start(cpBootstrap.start as sfn.IChainable);

        // ── Worker Branch ──
        const workerBootstrap = buildAutomationChain(
            'WorkerBootstrap',
            '$.router.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
        );

        const workerChain = sfn.Chain.start(workerBootstrap.start as sfn.IChainable);

        // ── Role Branching ──
        const roleBranch = new sfn.Choice(this, 'RoleBranch')
            .when(
                sfn.Condition.stringEquals('$.router.role', 'control-plane'),
                cpChain,
            )
            .otherwise(workerChain);

        // ── Top-Level Chain ──
        const hasRole = new sfn.Choice(this, 'HasRole')
            .when(
                sfn.Condition.isPresent('$.router.role'),
                new sfn.Choice(this, 'RoleNotNull')
                    .when(
                        sfn.Condition.isNull('$.router.role'),
                        skipNonK8s,
                    )
                    .otherwise(updateInstanceId.next(roleBranch)),
            )
            .otherwise(skipNonK8s);

        const definition = sfn.Chain.start(invokeRouter).next(hasRole);

        // ── State Machine ──
        const sfnLogGroup = new logs.LogGroup(this, 'BootstrapOrchestratorLogs', {
            logGroupName: `/aws/vendedlogs/states/${prefix}-bootstrap-orchestrator`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const stateMachine = new sfn.StateMachine(this, 'BootstrapOrchestrator', {
            stateMachineName: `${prefix}-bootstrap-orchestrator`,
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.hours(2),
            tracingEnabled: true,
            comment: 'Orchestrates K8s instance bootstrap: CP → secrets → worker CA re-join',
            logs: {
                destination: sfnLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // EventBridge: trigger on any ASG instance launch
        new events.Rule(this, 'AutoBootstrapRule', {
            ruleName: `${prefix}-auto-bootstrap`,
            description: 'Trigger Step Functions orchestrator when an ASG launches an instance',
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: ['EC2 Instance Launch Successful'],
            },
            targets: [new targets.SfnStateMachine(stateMachine)],
        });

        // =====================================================================
        // CloudWatch Alarm — Step Functions Execution Failures
        //
        // Fires when any state machine execution fails (permissions, SSM
        // Automation failures, unhandled exceptions). Sends notification to
        // SNS topic so failures are surfaced immediately.
        // =====================================================================

        const bootstrapAlarmTopic = new sns.Topic(this, 'BootstrapAlarmTopic', {
            topicName: `${prefix}-bootstrap-alarm`,
            displayName: `${prefix} Bootstrap Orchestrator Failure Alarm`,
            enforceSSL: true,  // AwsSolutions-SNS3: Require SSL for publishers
        });

        if (props.notificationEmail) {
            bootstrapAlarmTopic.addSubscription(
                new sns_subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        const bootstrapAlarm = new cloudwatch.Alarm(this, 'AutoBootstrapErrorAlarm', {
            alarmName: `${prefix}-bootstrap-orchestrator-errors`,
            alarmDescription:
                'Bootstrap orchestrator failed — K8s instance may not be bootstrapped. ' +
                'Check Step Functions execution history for ' + stateMachine.stateMachineName,
            metric: stateMachine.metricFailed({
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        bootstrapAlarm.addAlarmAction(
            new cloudwatchActions.SnsAction(bootstrapAlarmTopic),
        );

        // cdk-nag: Python 3.13 is the latest GA runtime
        NagSuppressions.addResourceSuppressions(routerFn, [{
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
