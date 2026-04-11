/**
 * @format
 * Bootstrap Orchestrator Construct
 *
 * Step Functions state machine that orchestrates K8s instance bootstrap:
 *   1. Router Lambda reads ASG tags and resolves instance constraints
 *   2. Updates instance-id SSM parameter
 *   3. Triggers targeted SSM RunCommand scripts natively
 *   4. Polls for completion (wait → check → loop)
 *   5. For control-plane: explicitly chains robust Python secrets deployment steps + worker CA re-join
 *
 * Non-K8s ASGs are silently ignored (no `k8s:bootstrap-role` tag).
 *
 * ## EventBridge Integration
 * Triggers automatically on any ASG `EC2 Instance Launch Successful` event.
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { JsonPath } from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapOrchestratorProps {
    readonly prefix: string;
    readonly ssmPrefix: string;
    readonly automationRoleArn: string;
    readonly scriptsBucketName: string;
    readonly bootstrapRunnerName: string;
    readonly deployRunnerName: string;
    readonly bootstrapLogGroupName: string;
    readonly deployLogGroupName: string;
}

export interface BootstrapStep {
    name: string;
    scriptPath: string;
    timeoutSeconds: number;
    description: string;
}

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

const CONTROL_PLANE_STEPS: BootstrapStep[] = [
    {
        name: 'BootstrapControlPlane',
        scriptPath: 'boot/steps/control_plane.py',
        timeoutSeconds: 1800,
        description: 'Run consolidated control plane bootstrap',
    },
];

const WORKER_STEPS: BootstrapStep[] = [
    {
        name: 'BootstrapWorker',
        scriptPath: 'boot/steps/worker.py',
        timeoutSeconds: 900,
        description: 'Run consolidated worker bootstrap',
    },
];

const DEPLOY_SECRETS_STEPS: BootstrapStep[] = [
    {
        name: 'DeployNextjsSecrets',
        scriptPath: 'app-deploy/nextjs/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create Nextjs K8s Secret',
    },
    {
        name: 'DeployMonitoringSecrets',
        scriptPath: 'app-deploy/monitoring/deploy.py',
        timeoutSeconds: 600,
        description: 'Resolve SSM parameters and create Monitoring K8s Secrets',
    },
    {
        name: 'DeployStartAdminSecrets',
        scriptPath: 'app-deploy/start-admin/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create Start Admin K8s Secret',
    },
    {
        name: 'DeployAdminApiSecrets',
        scriptPath: 'app-deploy/admin-api/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create Admin API K8s Secret',
    },
    {
        name: 'DeployPublicApiSecrets',
        scriptPath: 'app-deploy/public-api/deploy.py',
        timeoutSeconds: 300,
        description: 'Resolve SSM parameters and create Public API K8s Secret',
    },
];

// =============================================================================
// CONSTRUCT
// =============================================================================

export class BootstrapOrchestratorConstruct extends Construct {
    public readonly stateMachine: sfn.StateMachine;
    public readonly routerFunction: lambda.Function;

    constructor(scope: Construct, id: string, props: BootstrapOrchestratorProps) {
        super(scope, id);

        const stack = cdk.Stack.of(this);

        // =====================================================================
        // Router Lambda
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

def _skip(reason):
    logger.info("Skipping: %s", reason)
    return {
        "role": None,
        "instanceId": "",
        "asgName": "",
        "ssmPrefix": "",
        "s3Bucket": "",
        "region": "",
        "reason": reason,
    }

def handler(event, context):
    detail = event.get("detail", {})
    instance_id = detail.get("EC2InstanceId", "")
    asg_name = detail.get("AutoScalingGroupName", "")

    if not instance_id or not asg_name:
        return _skip("Missing instance or ASG info")

    logger.info("Instance launched: %s in ASG %s", instance_id, asg_name)

    resp = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[asg_name])
    groups = resp.get("AutoScalingGroups", [])
    if not groups:
        return _skip(f"ASG {asg_name} not found")

    tags = {t["Key"]: t["Value"] for t in groups[0].get("Tags", [])}
    role = tags.get("k8s:bootstrap-role")
    ssm_prefix = tags.get("k8s:ssm-prefix")

    if not role or not ssm_prefix:
        return _skip(f"No k8s tags on ASG {asg_name}")

    s3_bucket = ssm_client.get_parameter(Name=f"{ssm_prefix}/scripts-bucket")["Parameter"]["Value"]

    result = {
        "role": role,
        "instanceId": instance_id,
        "asgName": asg_name,
        "ssmPrefix": ssm_prefix,
        "s3Bucket": s3_bucket,
        "region": context.invoked_function_arn.split(":")[3],
        "reason": "ok",
    }
    logger.info("Router result: %s", result)
    return result
`),
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            tracing: lambda.Tracing.ACTIVE,
            description: 'Thin router: reads ASG tags and resolves details for Step Functions',
        });

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

        const invokeRouter = new sfnTasks.LambdaInvoke(this, 'InvokeRouter', {
            lambdaFunction: this.routerFunction,
            resultSelector: {
                'role.$': '$.Payload.role',
                'instanceId.$': '$.Payload.instanceId',
                'asgName.$': '$.Payload.asgName',
                'ssmPrefix.$': '$.Payload.ssmPrefix',
                's3Bucket.$': '$.Payload.s3Bucket',
                'region.$': '$.Payload.region',
            },
            resultPath: '$.router',
            comment: 'Read ASG tags to identify role',
        });

        const skipNonK8s = new sfn.Succeed(this, 'SkipNonK8s', {
            comment: 'Not a K8s ASG — no bootstrap role tag',
        });

        const updateInstanceId = new sfnTasks.CallAwsService(this, 'UpdateInstanceId', {
            service: 'ssm',
            action: 'putParameter',
            parameters: {
                Name: JsonPath.format(
                    '{}/bootstrap/{}-instance-id',
                    JsonPath.stringAt('$.router.ssmPrefix'),
                    JsonPath.stringAt('$.router.role'),
                ),
                Value: JsonPath.stringAt('$.router.instanceId'),
                Type: 'String',
                Overwrite: true,
            },
            iamResources: [
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultPath: JsonPath.DISCARD,
            comment: 'Update logical role SSM instance ID mapping',
        });

        // ── Fail Block ──
        const workflowFailed = new sfn.Fail(this, 'WorkflowFailed', {
            error: 'OrchestrationFailed',
            cause: 'One of the SSM commands failed or timed out',
        });

        // ── Helper to chain steps explicitly ──
        const chainSteps = (steps: BootstrapStep[], runnerDocName: string, logGroupName: string) => {
            if (steps.length === 0) throw new Error('Cannot chain empty steps array');
            const builtSteps = steps.map(step => this.buildRunCommandChain(
                step,
                runnerDocName,
                logGroupName,
                '$.router.instanceId',
                '$.router.ssmPrefix',
                '$.router.s3Bucket',
                '$.router.region',
                workflowFailed
            ));

            for (let i = 0; i < builtSteps.length - 1; i++) {
                builtSteps[i].end.next(builtSteps[i + 1].start);
            }

            return { start: builtSteps[0].start, end: builtSteps[builtSteps.length - 1].end };
        };

        // ── Branches ──
        const cpSteps = chainSteps(CONTROL_PLANE_STEPS, props.bootstrapRunnerName, props.bootstrapLogGroupName);
        const deploySteps = chainSteps(DEPLOY_SECRETS_STEPS, props.deployRunnerName, props.deployLogGroupName);
        const workerSteps = chainSteps(WORKER_STEPS, props.bootstrapRunnerName, props.bootstrapLogGroupName);

        const waitForCa = new sfn.Wait(this, 'WaitForCaPublish', {
            time: sfn.WaitTime.duration(cdk.Duration.minutes(15)),
            comment: 'Wait for CP to publish new CA hash before worker re-bootstrap',
        });

        const workerRejoinParallel = new sfn.Parallel(this, 'RejoinAllWorkers', {
            comment: 'Re-bootstrap all worker nodes in parallel after CP replacement',
            resultPath: JsonPath.DISCARD,
        });

        workerRejoinParallel.branch(this.buildWorkerRejoinBranch('app-worker', props));
        workerRejoinParallel.branch(this.buildWorkerRejoinBranch('mon-worker', props));
        workerRejoinParallel.branch(this.buildWorkerRejoinBranch('argocd-worker', props));

        workerRejoinParallel.addCatch(workflowFailed, { errors: ['States.ALL'] });

        // Stitch Control Plane branch
        cpSteps.end.next(deploySteps.start);
        deploySteps.end.next(waitForCa);
        waitForCa.next(workerRejoinParallel);

        const cpChain = sfn.Chain.start(cpSteps.start);
        const workerChain = sfn.Chain.start(workerSteps.start);

        const roleBranch = new sfn.Choice(this, 'RoleBranch')
            .when(
                sfn.Condition.stringEquals('$.router.role', 'control-plane'),
                cpChain,
            )
            .otherwise(workerChain);

        const hasRole = new sfn.Choice(this, 'HasRole')
            .when(
                sfn.Condition.isPresent('$.router.role'),
                new sfn.Choice(this, 'RoleNotNull')
                    .when(sfn.Condition.isNull('$.router.role'), skipNonK8s)
                    .otherwise(updateInstanceId.next(roleBranch)),
            )
            .otherwise(skipNonK8s);

        const definition = sfn.Chain.start(invokeRouter).next(hasRole);

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
            comment: 'Orchestrates K8s instance bootstrap using native SSM SendCommand',
            logs: {
                destination: sfnLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

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

    private buildRunCommandChain(
        step: BootstrapStep,
        runnerDocName: string,
        logGroupName: string,
        instanceIdPath: string,
        ssmPrefixPath: string,
        s3BucketPath: string,
        regionPath: string,
        failureTarget: sfn.IChainable,
    ): { start: sfn.IChainable; end: sfn.Pass } {
        const id = step.name;

        const MAX_POLL_ITERATIONS = Math.ceil(step.timeoutSeconds / 30);
        const pollCountPath = `$.${id}PollCount`;

        const startExec = new sfnTasks.CallAwsService(this, `${id}Start`, {
            service: 'ssm',
            action: 'sendCommand',
            parameters: {
                DocumentName: runnerDocName,
                InstanceIds: JsonPath.array(JsonPath.stringAt(instanceIdPath)),
                CloudWatchOutputConfig: {
                    CloudWatchLogGroupName: logGroupName,
                    CloudWatchOutputEnabled: true,
                },
                Parameters: {
                    ScriptPath: JsonPath.array(step.scriptPath),
                    SsmPrefix: JsonPath.array(JsonPath.stringAt(ssmPrefixPath)),
                    S3Bucket: JsonPath.array(JsonPath.stringAt(s3BucketPath)),
                    Region: JsonPath.array(JsonPath.stringAt(regionPath)),
                },
            },
            iamResources: ['*'],
            resultSelector: {
                'CommandId.$': '$.Command.CommandId',
            },
            resultPath: `$.${id}Result`,
            comment: step.description,
        });

        startExec.addCatch(failureTarget, { errors: ['States.ALL'] });

        const initCounter = new sfn.CustomState(this, `${id}InitCount`, {
            stateJson: {
                Type: 'Pass',
                Result: { value: 0 },
                ResultPath: pollCountPath,
            },
        });

        const waitStep = new sfn.Wait(this, `${id}Wait`, {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
        });

        const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
            service: 'ssm',
            action: 'getCommandInvocation',
            parameters: {
                CommandId: JsonPath.stringAt(`$.${id}Result.CommandId`),
                InstanceId: JsonPath.stringAt(instanceIdPath),
            },
            iamResources: ['*'],
            resultSelector: {
                'Status.$': '$.Status',
            },
            resultPath: `$.${id}Status`,
        });

        pollStatus.addCatch(failureTarget, { errors: ['States.ALL'] });

        const incrPollCount = new sfn.CustomState(this, `${id}IncrCount`, {
            stateJson: {
                Type: 'Pass',
                Parameters: {
                    'value.$': `States.MathAdd(${pollCountPath}.value, 1)`,
                },
                ResultPath: pollCountPath,
            },
        });

        const successState = new sfn.Pass(this, `${id}Done`);

        const checkTimeout = new sfn.Choice(this, `${id}CheckTimeout`)
            .when(
                sfn.Condition.numberGreaterThanEquals(`${pollCountPath}.value`, MAX_POLL_ITERATIONS),
                failureTarget,
            )
            .otherwise(waitStep);

        const checkStatus = new sfn.Choice(this, `${id}Check`)
            .when(
                sfn.Condition.stringEquals(`$.${id}Status.Status`, 'Success'),
                successState,
            )
            .when(
                sfn.Condition.or(
                    sfn.Condition.stringEquals(`$.${id}Status.Status`, 'Pending'),
                    sfn.Condition.stringEquals(`$.${id}Status.Status`, 'InProgress'),
                    sfn.Condition.stringEquals(`$.${id}Status.Status`, 'Delayed'),
                ),
                incrPollCount,
            )
            .otherwise(failureTarget);

        startExec.next(initCounter);
        initCounter.next(waitStep);
        waitStep.next(pollStatus);
        pollStatus.next(checkStatus);
        incrPollCount.next(checkTimeout);

        return { start: startExec, end: successState };
    }

    private buildWorkerRejoinBranch(
        workerRole: string,
        props: BootstrapOrchestratorProps
    ): sfn.Chain {
        const stack = cdk.Stack.of(this);
        const instanceParamName = `${props.ssmPrefix}/bootstrap/${workerRole}-instance-id`;

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

        // Note: We use the generic BootstrapRunner directly for re-join
        const startWorkerReboot = new sfnTasks.CallAwsService(this, `Rejoin-${workerRole}`, {
            service: 'ssm',
            action: 'sendCommand',
            parameters: {
                DocumentName: props.bootstrapRunnerName,
                InstanceIds: JsonPath.array(JsonPath.stringAt('$.workerInst.instanceId')),
                CloudWatchOutputConfig: {
                    CloudWatchLogGroupName: props.bootstrapLogGroupName,
                    CloudWatchOutputEnabled: true,
                },
                Parameters: {
                    ScriptPath: JsonPath.array('boot/steps/worker.py'),
                    SsmPrefix: JsonPath.array(JsonPath.stringAt('$.router.ssmPrefix')),
                    S3Bucket: JsonPath.array(JsonPath.stringAt('$.router.s3Bucket')),
                    Region: JsonPath.array(JsonPath.stringAt('$.router.region')),
                },
            },
            iamResources: ['*'],
            resultPath: JsonPath.DISCARD,
        });

        return sfn.Chain.start(getWorkerInstance).next(startWorkerReboot);
    }
}
