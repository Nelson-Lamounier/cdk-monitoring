/**
 * @format
 * Bootstrap Orchestrator Construct (SM-A — Cluster Infrastructure Only)
 *
 * Step Functions state machine that orchestrates K8s cluster infrastructure:
 *   1. Router Lambda reads ASG tags and resolves instance constraints
 *   2. Updates instance-id SSM parameter
 *   3. Triggers targeted SSM RunCommand scripts natively
 *   4. Polls for completion (wait → check → loop)
 *   5. For control-plane: waits for CA hash publication, then re-joins all worker pools in parallel
 *
 * ## Separation of Concerns
 * SM-A is responsible for cluster infrastructure only:
 *   - control_plane.py — kubeadm init, Calico, CCM, ArgoCD bootstrap
 *   - worker.py — kubeadm join, CloudWatch, EIP association
 *
 * App config injection (SSM → K8s Secrets/ConfigMaps) is handled by SM-B
 * (`ConfigOrchestratorConstruct`), which triggers automatically via EventBridge
 * when this state machine emits an `ExecutionSucceeded` event.
 *
 * ## Self-Healing Path
 * EC2 replacement → SM-A rebuilds cluster → SM-A SUCCEEDS →
 * EventBridge fires → SM-B re-injects all app secrets automatically.
 *
 * Non-K8s ASGs are silently ignored (no `k8s:bootstrap-role` tag).
 *
 * ## Manual Trigger (GitHub Actions)
 * The state machine ARN is exported via `stateMachineArn` and stored in SSM
 * at `{ssmPrefix}/bootstrap/state-machine-arn` for `trigger-bootstrap.ts` to
 * start executions directly using `states:StartExecution`.
 *
 * ## Worker Pool Names
 * The rejoin branches use ASG pool names (`general-pool`, `monitoring-pool`)
 * which are configurable via `workerRoles` in props.
 */

import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sfnTasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as cdk from "aws-cdk-lib/core";

import { Construct } from "constructs";

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapOrchestratorProps {
  readonly prefix: string;
  readonly ssmPrefix: string;
  readonly automationRoleArn: string;
  readonly scriptsBucketName: string;
  /** SSM Run Command document name for bootstrap scripts (control_plane.py, worker.py) */
  readonly bootstrapRunnerName: string;
  /** CloudWatch Log Group name for bootstrap RunCommand output */
  readonly bootstrapLogGroupName: string;
  /**
   * Worker pool role names that will be re-joined after control-plane replacement.
   * Defaults to `['general-pool', 'monitoring-pool']`.
   * These must match the `k8s:bootstrap-role` tag values on the ASGs and the
   * SSM parameter names `{ssmPrefix}/bootstrap/{role}-instance-id`.
   */
  readonly workerRoles?: readonly string[];
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
    name: "BootstrapControlPlane",
    scriptPath: "boot/steps/control_plane.py",
    timeoutSeconds: 1800,
    description: "Run consolidated control plane bootstrap",
  },
];

const WORKER_STEPS: BootstrapStep[] = [
  {
    name: "BootstrapWorker",
    scriptPath: "boot/steps/worker.py",
    timeoutSeconds: 900,
    description: "Run consolidated worker bootstrap",
  },
];

/**
 * Default worker pool names — matches the `k8s:bootstrap-role` ASG tag values
 * and the SSM parameter suffix `{ssmPrefix}/bootstrap/{role}-instance-id`.
 */
const DEFAULT_WORKER_ROLES: readonly string[] = [
  "general-pool",
  "monitoring-pool",
];

// =============================================================================
// CONSTRUCT
// =============================================================================

export class BootstrapOrchestratorConstruct extends Construct {
  /** The Step Functions state machine that drives the entire bootstrap flow */
  public readonly stateMachine: sfn.StateMachine;

  /** Thin router Lambda that reads ASG tags and resolves role/instanceId/s3Bucket */
  public readonly routerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: BootstrapOrchestratorProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const workerRoles = props.workerRoles ?? DEFAULT_WORKER_ROLES;

    // =====================================================================
    // Router Lambda
    // =====================================================================

    const routerLogGroup = new logs.LogGroup(this, "RouterLogs", {
      logGroupName: `/aws/lambda/${props.prefix}-bootstrap-router`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.routerFunction = new lambda.Function(this, "RouterFn", {
      functionName: `${props.prefix}-bootstrap-router`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.handler",
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
      description:
        "Thin router: reads ASG tags and resolves details for Step Functions",
    });

    this.routerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "RouterDescribeAsg",
        effect: iam.Effect.ALLOW,
        actions: ["autoscaling:DescribeAutoScalingGroups"],
        resources: ["*"],
      }),
    );

    this.routerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "RouterReadSsmParams",
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
        ],
      }),
    );

    // =====================================================================
    // Step Functions State Machine
    // =====================================================================

    const invokeRouter = new sfnTasks.LambdaInvoke(this, "InvokeRouter", {
      lambdaFunction: this.routerFunction,
      resultSelector: {
        "role.$": "$.Payload.role",
        "instanceId.$": "$.Payload.instanceId",
        "asgName.$": "$.Payload.asgName",
        "ssmPrefix.$": "$.Payload.ssmPrefix",
        "s3Bucket.$": "$.Payload.s3Bucket",
        "region.$": "$.Payload.region",
      },
      resultPath: "$.router",
      comment: "Read ASG tags to identify role",
    });

    const skipNonK8s = new sfn.Succeed(this, "SkipNonK8s", {
      comment: "Not a K8s ASG — no bootstrap role tag",
    });

    const updateInstanceId = new sfnTasks.CallAwsService(
      this,
      "UpdateInstanceId",
      {
        service: "ssm",
        action: "putParameter",
        parameters: {
          Name: JsonPath.format(
            "{}/bootstrap/{}-instance-id",
            JsonPath.stringAt("$.router.ssmPrefix"),
            JsonPath.stringAt("$.router.role"),
          ),
          Value: JsonPath.stringAt("$.router.instanceId"),
          Type: "String",
          Overwrite: true,
        },
        iamResources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
        ],
        resultPath: JsonPath.DISCARD,
        comment: "Update logical role SSM instance ID mapping",
      },
    );

    // ── Helper to chain steps explicitly ──
    //
    // Each step creates its own Fail state so it can be used independently
    // inside the main graph or inside a Parallel branch sub-graph.
    // (CDK forbids a state from being referenced in more than one graph).
    const chainSteps = (
      steps: BootstrapStep[],
      runnerDocName: string,
      logGroupName: string,
    ) => {
      if (steps.length === 0) throw new Error("Cannot chain empty steps array");
      const builtSteps = steps.map((step) =>
        this.buildRunCommandChain(
          step,
          runnerDocName,
          logGroupName,
          "$.router.instanceId",
          "$.router.ssmPrefix",
          "$.router.s3Bucket",
          "$.router.region",
        ),
      );

      for (let i = 0; i < builtSteps.length - 1; i++) {
        builtSteps[i].end.next(builtSteps[i + 1].start);
      }

      return {
        start: builtSteps[0].start,
        end: builtSteps[builtSteps.length - 1].end,
      };
    };

    // ── Branches ──
    const cpSteps = chainSteps(
      CONTROL_PLANE_STEPS,
      props.bootstrapRunnerName,
      props.bootstrapLogGroupName,
    );
    const workerSteps = chainSteps(
      WORKER_STEPS,
      props.bootstrapRunnerName,
      props.bootstrapLogGroupName,
    );

    // ── Poll SSM for join-token instead of a fixed 15-minute sleep ──────────
    //
    // control_plane.py writes /k8s/{env}/join-token after kubeadm init.
    // Workers need this token to join the cluster. Instead of sleeping a
    // fixed 15 minutes, poll SSM every 30s for up to 20 minutes (40 attempts).
    // Typically resolves within 1–2 minutes of CP completion.
    //
    // Pattern: InitCount → CheckParam → (success) workers
    //                               → (catch)   IncrCount → MaxCheck
    //                                                      → (≥ 40) Timeout
    //                                                      → (<  40) Wait30s → CheckParam
    const CA_POLL_MAX = 40; // 40 × 30s = 20 min

    const initCaPollCount = new sfn.CustomState(this, "InitCaPollCount", {
      stateJson: {
        Type: "Pass",
        Result: { value: 0 },
        ResultPath: "$.CaPollCount",
      },
    });

    const checkCaParam = new sfnTasks.CallAwsService(this, "CheckCaParam", {
      service: "ssm",
      action: "getParameter",
      parameters: {
        Name: JsonPath.format(
          "{}/join-token",
          JsonPath.stringAt("$.router.ssmPrefix"),
        ),
      },
      iamResources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
      ],
      resultPath: JsonPath.DISCARD,
      comment: "Poll SSM for join-token written by control_plane.py after kubeadm init",
    });

    const waitForCaPoll = new sfn.Wait(this, "WaitForCaPublish", {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
      comment: "Wait 30s before re-checking join-token in SSM",
    });

    const incrCaPollCount = new sfn.CustomState(this, "IncrCaPollCount", {
      stateJson: {
        Type: "Pass",
        Parameters: {
          "value.$": "States.MathAdd($.CaPollCount.value, 1)",
        },
        ResultPath: "$.CaPollCount",
      },
    });

    const caPublishTimeout = new sfn.Fail(this, "CaPublishTimeout", {
      error: "CaPublishTimeout",
      cause:
        "join-token not published to SSM within 20 min of CP completion — " +
        "check control_plane.py CloudWatch logs for kubeadm init failure",
    });

    const checkCaPollMax = new sfn.Choice(this, "CaPollMaxCheck", {
      comment: "Abort if join-token still absent after 20 min",
    })
      .when(
        sfn.Condition.numberGreaterThanEquals("$.CaPollCount.value", CA_POLL_MAX),
        caPublishTimeout,
      )
      .otherwise(waitForCaPoll);

    // Wire the poll loop: catch (param absent) → increment → max-check → wait → retry
    checkCaParam.addCatch(incrCaPollCount, {
      errors: ["States.ALL"],
      resultPath: JsonPath.DISCARD,
    });
    incrCaPollCount.next(checkCaPollMax);
    waitForCaPoll.next(checkCaParam);

    // ── Worker Rejoin Parallel — with full poll loop per branch ──
    //
    // Build one parallel branch per worker role. Each branch:
    //   1. Reads the persisted instance-id SSM param for that role
    //   2. Runs the worker.py bootstrap script via SSM SendCommand
    //   3. Polls for completion (same wait→check→loop pattern as cpSteps)
    //
    // Each branch creates its own Fail states (CDK requires unique states
    // per graph — sub-graphs inside Parallel are independent).
    const workerRejoinParallel = new sfn.Parallel(this, "RejoinAllWorkers", {
      comment: "Re-bootstrap all worker nodes in parallel after CP replacement",
      resultPath: JsonPath.DISCARD,
    });

    // Top-level Fail for the outer Parallel wrapper (not inside any sub-graph)
    const rejoinFailed = new sfn.Fail(this, "RejoinFailed", {
      error: "WorkerRejoinFailed",
      cause: "At least one worker re-join branch failed",
    });

    for (const role of workerRoles) {
      workerRejoinParallel.branch(this.buildWorkerRejoinBranch(role, props));
    }

    workerRejoinParallel.addCatch(rejoinFailed, { errors: ["States.ALL"] });

    // ── Stitch Control Plane branch (SM-A: cluster infrastructure only) ──
    // App config injection is SM-B's responsibility — triggered automatically
    // by EventBridge when this state machine emits ExecutionSucceeded.
    // CP completes → initialise poll counter → poll SSM for join-token
    // → (param present) trigger worker rejoin parallel
    // → (param absent) wait 30s loop → timeout after 20 min
    checkCaParam.next(workerRejoinParallel);
    cpSteps.end.next(initCaPollCount);
    initCaPollCount.next(checkCaParam);

    const cpChain = sfn.Chain.start(cpSteps.start);
    const workerChain = sfn.Chain.start(workerSteps.start);

    const roleBranch = new sfn.Choice(this, "RoleBranch")
      .when(
        sfn.Condition.stringEquals("$.router.role", "control-plane"),
        cpChain,
      )
      .otherwise(workerChain);

    const hasRole = new sfn.Choice(this, "HasRole")
      .when(
        sfn.Condition.isPresent("$.router.role"),
        new sfn.Choice(this, "RoleNotNull")
          .when(sfn.Condition.isNull("$.router.role"), skipNonK8s)
          .otherwise(updateInstanceId.next(roleBranch)),
      )
      .otherwise(skipNonK8s);

    const definition = sfn.Chain.start(invokeRouter).next(hasRole);

    const sfnLogGroup = new logs.LogGroup(this, "OrchestratorLogs", {
      logGroupName: `/aws/vendedlogs/states/${props.prefix}-bootstrap-orchestrator`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: `${props.prefix}-bootstrap-orchestrator`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
      comment:
        "Orchestrates K8s instance bootstrap using native SSM SendCommand",
      logs: {
        destination: sfnLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    new events.Rule(this, "AutoBootstrapRule", {
      ruleName: `${props.prefix}-auto-bootstrap`,
      description:
        "Trigger Step Functions orchestrator when an ASG launches an instance",
      eventPattern: {
        source: ["aws.autoscaling"],
        detailType: ["EC2 Instance Launch Successful"],
        detail: {
          AutoScalingGroupName: [
            {
              prefix: `${props.prefix}-`,
            },
          ],
        },
      },
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * Builds a full send → init-counter → wait → poll → check-status chain
   * for a single bootstrap step.
   *
   * Each call creates uniquely-named states (prefixed by `step.name`) so the
   * chain can be safely composed inside both the outer state machine graph
   * and isolated Parallel branch sub-graphs without violating CDK's
   * single-graph constraint.
   *
   * @param step          - Step definition (name, scriptPath, timeoutSeconds)
   * @param runnerDocName - SSM Command document name
   * @param logGroupName  - CloudWatch log group for SSM output
   * @param instanceIdPath - JSONPath to EC2 instance ID
   * @param ssmPrefixPath - JSONPath to SSM prefix
   * @param s3BucketPath  - JSONPath to S3 bucket name
   * @param regionPath    - JSONPath to AWS region
   * @returns `{ start, end }` for chaining via `.next()`
   */
  private buildRunCommandChain(
    step: BootstrapStep,
    runnerDocName: string,
    logGroupName: string,
    instanceIdPath: string,
    ssmPrefixPath: string,
    s3BucketPath: string,
    regionPath: string,
  ): { start: sfn.IChainable; end: sfn.Pass } {
    const id = step.name;

    // Step Functions intrinsic functions (e.g. States.MathAdd) require dot-notation
    // JSONPath inside their arguments. Keys containing hyphens are invalid in dot-notation
    // (e.g. $.Rejoin-general-poolPollCount.value fails schema validation).
    // safeId strips hyphens so the state data key is a valid identifier.
    // CDK construct IDs and state names continue to use `id` directly — hyphens are fine there.
    const safeId = id.replace(/-/g, "");

    const MAX_POLL_ITERATIONS = Math.ceil(step.timeoutSeconds / 30);
    const pollCountPath = `$.${safeId}PollCount`;

    // Local Fail states — unique per step so they can live in any graph.
    const sendFailed = new sfn.Fail(this, `${id}SendFailed`, {
      error: "SendCommandFailed",
      cause: `SSM SendCommand failed for step ${id}`,
    });

    /**
     * Static API-error fail — fired when the SSM `getCommandInvocation`
     * API call itself fails (permissions / network), so no output is
     * available to enrich the failure message.
     */
    const pollApiFailed = new sfn.Fail(this, `${id}PollApiFailed`, {
      error: "PollApiFailed",
      cause: `SSM getCommandInvocation API error for step ${id} — check CloudWatch log group: ${logGroupName}`,
    });

    /**
     * Dynamic command-failure fail — Cause and Error are populated at
     * runtime by the enrichment chain (fetchFailureOutput → formatFailureCause).
     * Surfaces stdout snapshot, stderr, CloudWatch stream path, and SSM
     * step-status query hints directly in the Step Functions console.
     */
    const pollFailed = new sfn.Fail(this, `${id}PollFailed`, {
      causePath: `$.${safeId}FailCause.cause`,
      errorPath: `$.${safeId}FailCause.error`,
    });

    // ── Failure enrichment chain ─────────────────────────────────────────────
    // On non-Success SSM status OR poll timeout, this chain:
    //   1. Calls GetCommandInvocation for StatusDetails + stdout/stderr head
    //   2. Formats an enriched Cause string via States.Format intrinsic
    //   3. Routes to the dynamic pollFailed Fail state
    //
    // Note: StandardOutputContent returns the FIRST 2500 chars of stdout.
    // The Layer-1 SSM step-status parameters written by the Python scripts
    // hold the exact failing step name and error message (the tail),
    // which you can retrieve via:
    //   aws ssm get-parameter --name <ssmPrefix>/bootstrap/status/argocd/<step>
    //   aws ssm get-parameter --name <ssmPrefix>/bootstrap/status/boot/<step>
    const fetchFailureOutput = new sfnTasks.CallAwsService(
      this,
      `${id}FetchOutput`,
      {
        service: "ssm",
        action: "getCommandInvocation",
        parameters: {
          CommandId: JsonPath.stringAt(`$.${id}Result.CommandId`),
          InstanceId: JsonPath.stringAt(instanceIdPath),
        },
        iamResources: ["*"],
        resultSelector: {
          "StatusDetails.$": "$.StatusDetails",
          "StandardOutputContent.$": "$.StandardOutputContent",
          "StandardErrorContent.$": "$.StandardErrorContent",
        },
        resultPath: `$.${safeId}FailureOutput`,
        comment: `Fetch SSM stdout/stderr for failure diagnostics (step ${id})`,
      },
    );
    // If the diagnostic fetch itself fails, fall through to the static API-error state
    fetchFailureOutput.addCatch(pollApiFailed, { errors: ["States.ALL"] });

    /**
     * Formats an enriched Step Functions error Cause via States.Format, embedding:
     *   - SSM StatusDetails (Failed / TimedOut / Cancelled)
     *   - First 2500 chars of stdout (head — CloudWatch has the full tail)
     *   - Stderr content
     *   - CloudWatch log group name + log stream naming pattern
     *   - SSM Parameter Store query hints for the per-step status markers
     *     written by Layer-1 (BootstrapLogger / StepRunner)
     *
     * The formatted string is written to $.${safeId}FailCause and read
     * by the dynamic pollFailed Fail state via causePath/errorPath.
     */
    const formatFailureCause = new sfn.CustomState(this, `${id}FormatCause`, {
      stateJson: {
        Type: "Pass",
        Parameters: {
          error: "CommandFailed",
          // States.Format args: StatusDetails, stdout, stderr, ssmPrefix (×2)
          "cause.$": `States.Format('⚠ Bootstrap step ${id} FAILED.\nSSM status: {}.\n\n─── stdout snapshot (first 2500 chars — see CloudWatch for tail) ───\n{}\n─── stderr ───\n{}\n\nFull logs in CloudWatch:\n  Log group:  ${logGroupName}\n  Log stream: <CommandId>/<InstanceId>/aws-runShellScript/stdout\n\nLast step detail (query SSM after run):\n  aws ssm get-parameter --name {}/bootstrap/status/argocd/<step-name>\n  aws ssm get-parameter --name {}/bootstrap/status/boot/<step-name>', $.${safeId}FailureOutput.StatusDetails, $.${safeId}FailureOutput.StandardOutputContent, $.${safeId}FailureOutput.StandardErrorContent, $.router.ssmPrefix, $.router.ssmPrefix)`,
        },
        ResultPath: `$.${safeId}FailCause`,
      },
    });
    fetchFailureOutput.next(formatFailureCause);
    formatFailureCause.next(pollFailed);

    const startExec = new sfnTasks.CallAwsService(this, `${id}Start`, {
      service: "ssm",
      action: "sendCommand",
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
      iamResources: ["*"],
      resultSelector: {
        "CommandId.$": "$.Command.CommandId",
      },
      resultPath: `$.${id}Result`,
      comment: step.description,
    });

    startExec.addRetry({
      errors: ["Ssm.InvalidInstanceIdException", "Ssm.SsmException"],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 5,
      backoffRate: 1.5,
    });
    startExec.addCatch(sendFailed, { errors: ["States.ALL"] });

    const initCounter = new sfn.CustomState(this, `${id}InitCount`, {
      stateJson: {
        Type: "Pass",
        Result: { value: 0 },
        ResultPath: pollCountPath,
      },
    });

    const waitStep = new sfn.Wait(this, `${id}Wait`, {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
      service: "ssm",
      action: "getCommandInvocation",
      parameters: {
        CommandId: JsonPath.stringAt(`$.${id}Result.CommandId`),
        InstanceId: JsonPath.stringAt(instanceIdPath),
      },
      iamResources: ["*"],
      resultSelector: {
        "Status.$": "$.Status",
      },
      resultPath: `$.${id}Status`,
    });

    // GetCommandInvocation API errors → static fail (no output to enrich)
    pollStatus.addCatch(pollApiFailed, { errors: ["States.ALL"] });

    const incrPollCount = new sfn.CustomState(this, `${id}IncrCount`, {
      stateJson: {
        Type: "Pass",
        Parameters: {
          "value.$": `States.MathAdd(${pollCountPath}.value, 1)`,
        },
        ResultPath: pollCountPath,
      },
    });

    const successState = new sfn.Pass(this, `${id}Done`);

    // Timeout → enrichment chain → dynamic pollFailed (has CommandId in context)
    const checkTimeout = new sfn.Choice(this, `${id}CheckTimeout`)
      .when(
        sfn.Condition.numberGreaterThanEquals(
          `${pollCountPath}.value`,
          MAX_POLL_ITERATIONS,
        ),
        fetchFailureOutput,
      )
      .otherwise(waitStep);

    // Non-Success / non-InProgress status → enrichment chain → dynamic pollFailed
    const checkStatus = new sfn.Choice(this, `${id}Check`)
      .when(
        sfn.Condition.stringEquals(`$.${id}Status.Status`, "Success"),
        successState,
      )
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals(`$.${id}Status.Status`, "Pending"),
          sfn.Condition.stringEquals(`$.${id}Status.Status`, "InProgress"),
          sfn.Condition.stringEquals(`$.${id}Status.Status`, "Delayed"),
        ),
        incrPollCount,
      )
      .otherwise(fetchFailureOutput);

    startExec.next(initCounter);
    initCounter.next(waitStep);
    waitStep.next(pollStatus);
    pollStatus.next(checkStatus);
    incrPollCount.next(checkTimeout);

    return { start: startExec, end: successState };
  }

  /**
   * Builds a complete worker re-join branch with full SSM poll loop.
   *
   * Each call creates a fully self-contained set of states (uniquely named
   * with the role prefix) so the branch can live in an isolated Parallel
   * sub-graph without conflicting with the outer state machine graph.
   *
   * Flow:
   *   1. Read `{ssmPrefix}/bootstrap/{role}-instance-id` from SSM
   *   2. Send SSM RunCommand (worker.py) to that instance
   *   3. Poll for completion using the same wait → check → loop pattern
   *
   * @param workerRole - Role name matching SSM param suffix and k8s:bootstrap-role tag
   * @param props      - Orchestrator props (runner doc name, log group, SSM prefix)
   * @returns A `sfn.Chain` representing the complete self-contained branch
   */
  private buildWorkerRejoinBranch(
    workerRole: string,
    props: BootstrapOrchestratorProps,
  ): sfn.Chain {
    const stack = cdk.Stack.of(this);
    const instanceParamName = `${props.ssmPrefix}/bootstrap/${workerRole}-instance-id`;
    const branchId = `Rejoin-${workerRole}`;

    // Local Fail state for SSM GetParameter (lives in this branch sub-graph)
    const getInstFailed = new sfn.Fail(this, `${branchId}GetInstFailed`, {
      error: "GetParameterFailed",
      cause: `Could not read instance ID for ${workerRole} from SSM`,
    });

    // Step 1: Read persisted instance ID from SSM
    const getWorkerInstance = new sfnTasks.CallAwsService(
      this,
      `GetInst-${workerRole}`,
      {
        service: "ssm",
        action: "getParameter",
        parameters: { Name: instanceParamName },
        iamResources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
        ],
        resultSelector: { "instanceId.$": "$.Parameter.Value" },
        resultPath: "$.workerInst",
        comment: `Read persisted instance ID for ${workerRole}`,
      },
    );

    getWorkerInstance.addCatch(getInstFailed, { errors: ["States.ALL"] });

    // Step 2: Build full send+poll chain for the worker.py step.
    //
    // buildRunCommandChain creates its own local Fail states, so this chain
    // is fully independent of the outer state machine graph.
    const workerStep: BootstrapStep = {
      name: branchId,
      scriptPath: "boot/steps/worker.py",
      timeoutSeconds: 900,
      description: `Re-join ${workerRole} to the cluster after CP replacement`,
    };

    const chain = this.buildRunCommandChain(
      workerStep,
      props.bootstrapRunnerName,
      props.bootstrapLogGroupName,
      "$.workerInst.instanceId",
      "$.router.ssmPrefix",
      "$.router.s3Bucket",
      "$.router.region",
    );

    // Link: getWorkerInstance → sendCommand poll chain
    getWorkerInstance.next(chain.start as sfn.TaskStateBase);

    return sfn.Chain.start(getWorkerInstance);
  }
}
