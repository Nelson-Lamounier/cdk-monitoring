/**
 * @format
 * Bootstrap Orchestrator Construct
 *
 * Step Functions state machine that orchestrates K8s instance bootstrap:
 *   1. Router Lambda reads ASG tags and resolves SSM doc names
 *   2. Updates instance-id SSM parameter
 *   3. Starts SSM Automation document
 *   4. Polls for completion (wait → check → loop)
 *   5. For control-plane: chains secrets deployment + worker CA re-join
 *
 * Non-K8s ASGs are silently ignored (no `k8s:bootstrap-role` tag).
 *
 * ## EventBridge Integration
 * Triggers automatically on any ASG `EC2 Instance Launch Successful` event.
 *
 * @example
 * ```typescript
 * const orchestrator = new BootstrapOrchestratorConstruct(this, 'Orchestrator', {
 *     prefix: 'k8s',
 *     ssmPrefix: '/k8s/development',
 *     automationRoleArn: role.roleArn,
 *     scriptsBucketName: 'my-scripts-bucket',
 * });
 * ```
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for the Bootstrap Orchestrator construct.
 */
export interface BootstrapOrchestratorProps {
    /** Resource name prefix (e.g. 'k8s') */
    readonly prefix: string;

    /** SSM parameter prefix (e.g. '/k8s/development') */
    readonly ssmPrefix: string;

    /** IAM role ARN for SSM Automation execution */
    readonly automationRoleArn: string;

    /** S3 bucket name containing bootstrap scripts */
    readonly scriptsBucketName: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Bootstrap Orchestrator — Step Functions + Lambda + EventBridge.
 *
 * Orchestrates K8s instance bootstrap via a state machine:
 * - **Router Lambda**: thin Python function that reads ASG tags, resolves
 *   SSM doc names, and returns metadata for Step Functions
 * - **State Machine**: branches by role (control-plane vs worker), chains
 *   SSM Automation executions, and handles worker CA re-join
 * - **EventBridge Rule**: triggers on ASG instance launch events
 */
export class BootstrapOrchestratorConstruct extends Construct {
    /** The Step Functions state machine */
    public readonly stateMachine: sfn.StateMachine;

    /** The router Lambda function */
    public readonly routerFunction: lambda.Function;

    constructor(scope: Construct, id: string, props: BootstrapOrchestratorProps) {
        super(scope, id);

        const stack = cdk.Stack.of(this);

        // =====================================================================
        // Router Lambda — reads ASG tags, resolves SSM doc names
        // =====================================================================

        const routerLogGroup = new logs.LogGroup(this, 'RouterLogs', {
            logGroupName: `/aws/lambda/${props.prefix}-bootstrap-router`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.routerFunction = new lambda.Function(this, 'RouterFn', {
            functionName: `${props.prefix}-bootstrap-router`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            logGroup: routerLogGroup,
            code: lambda.Code.fromInline(`
import logging, boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

asg_client = boto3.client("autoscaling")
ssm_client = boto3.client("ssm")

ROLE_DOC_MAP = {
    "control-plane": "bootstrap/control-plane-doc-name",
    "app-worker": "bootstrap/worker-doc-name",
    "mon-worker": "bootstrap/worker-doc-name",
    "argocd-worker": "bootstrap/worker-doc-name",
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
        "reason": "ok",
    }
    logger.info("Router result: %s", result)
    return result
`),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            description: 'Thin router: reads ASG tags and resolves SSM doc names for Step Functions',
        });

        // IAM for router Lambda
        this.routerFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'RouterDescribeAsg',
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:DescribeAutoScalingGroups'],
            resources: ['*'],
        }));

        this.routerFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'RouterReadSsmParams',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        // =====================================================================
        // Step Functions State Machine
        // =====================================================================

        // ── Router Lambda invocation ──
        const invokeRouter = new sfnTasks.LambdaInvoke(this, 'InvokeRouter', {
            lambdaFunction: this.routerFunction,
            resultSelector: {
                'role.$': '$.Payload.role',
                'instanceId.$': '$.Payload.instanceId',
                'asgName.$': '$.Payload.asgName',
                'ssmPrefix.$': '$.Payload.ssmPrefix',
                'docName.$': '$.Payload.docName',
                's3Bucket.$': '$.Payload.s3Bucket',
                'region.$': '$.Payload.region',
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
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultPath: sfn.JsonPath.DISCARD,
        });

        // ── Control Plane Branch ──
        const cpBootstrap = this.buildAutomationChain(
            'CpBootstrap',
            '$.router.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
            props.automationRoleArn,
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
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultSelector: {
                'docName.$': '$.Parameter.Value',
            },
            resultPath: '$.nextjsDoc',
        });

        // Step 3: Deploy nextjs secrets
        const nextjsSecrets = this.buildAutomationChain(
            'NextjsSecrets',
            '$.nextjsDoc.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
            props.automationRoleArn,
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
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultSelector: {
                'docName.$': '$.Parameter.Value',
            },
            resultPath: '$.monDoc',
        });

        // Step 5: Deploy monitoring secrets
        const monSecrets = this.buildAutomationChain(
            'MonSecrets',
            '$.monDoc.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
            props.automationRoleArn,
        );

        // Step 6: Wait for CA to propagate before worker re-join
        const waitForCa = new sfn.Wait(this, 'WaitForCaPublish', {
            time: sfn.WaitTime.duration(cdk.Duration.minutes(15)),
            comment: 'Wait for CP to publish new CA hash before worker re-bootstrap',
        });

        // Step 7: Worker re-bootstrap in parallel
        const workerRejoinParallel = new sfn.Parallel(this, 'RejoinAllWorkers', {
            comment: 'Re-bootstrap all worker nodes in parallel after CP replacement',
            resultPath: sfn.JsonPath.DISCARD,
        });

        workerRejoinParallel.branch(this.buildWorkerRejoinBranch('app-worker', props));
        workerRejoinParallel.branch(this.buildWorkerRejoinBranch('mon-worker', props));
        workerRejoinParallel.branch(this.buildWorkerRejoinBranch('argocd-worker', props));

        // Chain the CP branch
        cpBootstrap.end.next(getNextjsDocName);
        getNextjsDocName.next(nextjsSecrets.start as sfn.IChainable);
        nextjsSecrets.end.next(getMonDocName);
        getMonDocName.next(monSecrets.start as sfn.IChainable);
        monSecrets.end.next(waitForCa);
        waitForCa.next(workerRejoinParallel);

        const cpChain = sfn.Chain.start(cpBootstrap.start as sfn.IChainable);

        // ── Worker Branch ──
        const workerBootstrap = this.buildAutomationChain(
            'WorkerBootstrap',
            '$.router.docName',
            '$.router.instanceId',
            '$.router.ssmPrefix',
            '$.router.s3Bucket',
            '$.router.region',
            props.automationRoleArn,
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
        const sfnLogGroup = new logs.LogGroup(this, 'OrchestratorLogs', {
            logGroupName: `/aws/vendedlogs/states/${props.prefix}-bootstrap-orchestrator`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
            stateMachineName: `${props.prefix}-bootstrap-orchestrator`,
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

        // =====================================================================
        // EventBridge — trigger on any ASG instance launch
        // =====================================================================

        new events.Rule(this, 'AutoBootstrapRule', {
            ruleName: `${props.prefix}-auto-bootstrap`,
            description: 'Trigger Step Functions orchestrator when an ASG launches an instance',
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: ['EC2 Instance Launch Successful'],
            },
            targets: [new targets.SfnStateMachine(this.stateMachine)],
        });
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /**
     * Builds an SSM Automation polling loop with a step-level timeout guard:
     * Start → InitCounter → Wait → Poll → IncrCount → CheckTimeout → CheckStatus → (loop)
     *
     * The counter prevents infinite polling — fails after {@link MAX_POLL_ITERATIONS}
     * iterations (default: 120 × 30s = 60 min) instead of relying solely on the
     * 2-hour global state machine timeout.
     */
    private buildAutomationChain(
        id: string,
        docNamePath: string,
        instanceIdPath: string,
        ssmPrefixPath: string,
        s3BucketPath: string,
        regionPath: string,
        automationRoleArn: string,
    ): { start: sfn.IChainable; end: sfn.Pass } {
        const stack = cdk.Stack.of(this);

        /** Max polling iterations before failing (120 × 30s = 60 min). */
        const MAX_POLL_ITERATIONS = 120;

        const pollCountPath = `$.${id}PollCount`;

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
                `arn:aws:ssm:${stack.region}:${stack.account}:automation-definition/*`,
                `arn:aws:ssm:${stack.region}:${stack.account}:automation-execution/*`,
            ],
            additionalIamStatements: [
                new iam.PolicyStatement({
                    actions: ['iam:PassRole'],
                    resources: [automationRoleArn],
                }),
            ],
            resultSelector: {
                'AutomationExecutionId.$': '$.AutomationExecutionId',
            },
            resultPath: `$.${id}Result`,
        });

        // Initialise poll counter to 0
        const initCounter = new sfn.Pass(this, `${id}InitCount`, {
            result: sfn.Result.fromNumber(0),
            resultPath: pollCountPath,
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
                `arn:aws:ssm:${stack.region}:${stack.account}:automation-execution/*`,
            ],
            resultSelector: {
                'Status.$': '$.AutomationExecution.AutomationExecutionStatus',
            },
            resultPath: `$.${id}Status`,
        });

        // Increment poll counter using States.MathAdd intrinsic
        const incrPollCount = new sfn.Pass(this, `${id}IncrCount`, {
            resultPath: pollCountPath,
            parameters: {
                'count.$': sfn.JsonPath.mathAdd(
                    sfn.JsonPath.numberAt(pollCountPath),
                    1,
                ),
            },
        });

        const successState = new sfn.Pass(this, `${id}Done`);

        const failState = new sfn.Fail(this, `${id}Failed`, {
            cause: `SSM Automation ${id} failed`,
            error: 'AutomationFailed',
        });

        const timeoutState = new sfn.Fail(this, `${id}Timeout`, {
            cause: `SSM Automation ${id} polling exceeded ${MAX_POLL_ITERATIONS} iterations (~${(MAX_POLL_ITERATIONS * 30) / 60} min)`,
            error: 'AutomationTimeout',
        });

        // Check poll count before looping back to wait
        const checkTimeout = new sfn.Choice(this, `${id}CheckTimeout`)
            .when(
                sfn.Condition.numberGreaterThanEquals(pollCountPath, MAX_POLL_ITERATIONS),
                timeoutState,
            )
            .otherwise(waitStep);

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
                incrPollCount,
            )
            .otherwise(failState);

        // Chain: Start → InitCounter → Wait → Poll → CheckStatus → IncrCount → CheckTimeout → (loop)
        startExec.next(initCounter);
        initCounter.next(waitStep);
        waitStep.next(pollStatus);
        pollStatus.next(checkStatus);
        incrPollCount.next(checkTimeout);

        return { start: startExec, end: successState };
    }

    /**
     * Builds a worker re-bootstrap branch for the Parallel state.
     * Resolves doc name + instance ID from SSM, then starts SSM Automation.
     */
    private buildWorkerRejoinBranch(
        workerRole: string,
        props: BootstrapOrchestratorProps,
    ): sfn.Chain {
        const stack = cdk.Stack.of(this);
        const docParamName = `${props.ssmPrefix}/bootstrap/worker-doc-name`;
        const instanceParamName = `${props.ssmPrefix}/bootstrap/${workerRole}-instance-id`;

        const getWorkerDoc = new sfnTasks.CallAwsService(this, `GetDoc-${workerRole}`, {
            service: 'ssm',
            action: 'getParameter',
            parameters: { Name: docParamName },
            iamResources: [
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultSelector: { 'docName.$': '$.Parameter.Value' },
            resultPath: '$.workerDoc',
        });

        const getWorkerInstance = new sfnTasks.CallAwsService(this, `GetInst-${workerRole}`, {
            service: 'ssm',
            action: 'getParameter',
            parameters: { Name: instanceParamName },
            iamResources: [
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
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
                `arn:aws:ssm:${stack.region}:${stack.account}:automation-definition/*`,
                `arn:aws:ssm:${stack.region}:${stack.account}:automation-execution/*`,
            ],
            additionalIamStatements: [
                new iam.PolicyStatement({
                    actions: ['iam:PassRole'],
                    resources: [props.automationRoleArn],
                }),
            ],
            resultPath: sfn.JsonPath.DISCARD,
        });

        return sfn.Chain.start(getWorkerDoc)
            .next(getWorkerInstance)
            .next(startWorkerReboot);
    }
}
