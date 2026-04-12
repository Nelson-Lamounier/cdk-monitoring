/**
 * @format
 * Config Orchestrator Construct (SM-B — App Config Injection)
 *
 * Step Functions state machine responsible for injecting runtime application
 * configuration (SSM parameters → Kubernetes Secrets and ConfigMaps) after
 * the cluster infrastructure is confirmed healthy.
 *
 * ## Separation of Concerns
 * SM-B owns everything that touches application configuration:
 *   - nextjs/deploy.py       — nextjs-secrets K8s Secret + IngressRoute originSecret
 *   - monitoring/deploy.py   — grafana + github K8s Secrets + Helm chart (Grafana reset)
 *   - start-admin/deploy.py  — start-admin-secrets K8s Secret (Cognito / DynamoDB / Bedrock)
 *   - admin-api/deploy.py    — admin-api K8s Secret + ConfigMap + IngressRoute
 *   - public-api/deploy.py   — public-api K8s Secret + ConfigMap + IngressRoute
 *
 * ## Self-Healing Trigger (Primary Path)
 * An EventBridge rule listens for `ExecutionSucceeded` events from SM-A
 * (BootstrapOrchestratorConstruct). When SM-A completes, SM-B starts
 * automatically — ensuring every cluster rebuild re-injects all app secrets
 * without manual intervention or a GHA run.
 *
 * ## Manual Triggers (Secondary Paths)
 *   - GitHub Actions: reads `{ssmPrefix}/bootstrap/config-state-machine-arn`
 *     and calls `states:StartExecution` via `trigger-config.ts`
 *   - Local: `just config-run <environment>`
 *   - Secrets-only update: `deploy-post-bootstrap.yml` standalone workflow
 *
 * ## Instance Discovery
 * SM-B reads the control plane instance ID from SSM
 * (`{ssmPrefix}/bootstrap/control-plane-instance-id`), written by SM-A's
 * UpdateInstanceId step. No router Lambda is needed.
 *
 * ## Script Execution Order
 * Deploy scripts run sequentially to avoid concurrent K8s API server pressure:
 *   nextjs → monitoring → start-admin → admin-api → public-api
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { JsonPath } from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

/** A single deploy script step definition for SM-B */
export interface ConfigStep {
    /** Unique identifier used as CDK Construct ID suffix and state name */
    name: string;
    /** S3-relative script path (e.g. `app-deploy/nextjs/deploy.py`) */
    scriptPath: string;
    /** Maximum seconds to wait for the script to complete */
    timeoutSeconds: number;
    /** Human-readable description shown in the Step Functions console */
    description: string;
}

export interface ConfigOrchestratorProps {
    /** Prefix for all resource names (e.g. `k8s-dev`) */
    readonly prefix: string;
    /** SSM parameter prefix (e.g. `/k8s/development`) */
    readonly ssmPrefix: string;
    /** S3 bucket name containing the deploy scripts */
    readonly scriptsBucketName: string;
    /** SSM Run Command document name for deploy scripts (`k8s-dev-deploy-runner`) */
    readonly deployRunnerName: string;
    /** CloudWatch Log Group name for deploy RunCommand output */
    readonly deployLogGroupName: string;
    /**
     * ARN of SM-A (BootstrapOrchestratorConstruct state machine).
     * Used to build the EventBridge rule: SM-A SUCCEEDED → start SM-B.
     */
    readonly bootstrapStateMachineArn: string;
    /**
     * AWS region for SSM/S3 operations inside the RunCommand document.
     * @default cdk.Stack.of(this).region
     */
    readonly region?: string;
}

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

/**
 * Ordered list of app config deploy scripts.
 *
 * Sequential order is intentional:
 *   1. nextjs     — public-facing app, highest priority
 *   2. monitoring — Grafana/Prometheus secrets (independent of app secrets)
 *   3. start-admin — admin panel (internal tooling)
 *   4. admin-api  — BFF service (depends on start-admin Cognito pool)
 *   5. public-api — BFF service (depends on DynamoDB/Bedrock config)
 */
const DEPLOY_STEPS: ConfigStep[] = [
    {
        name: 'DeployNextjsSecrets',
        scriptPath: 'app-deploy/nextjs/deploy.py',
        timeoutSeconds: 300,
        description: 'nextjs-secrets K8s Secret + IngressRoute originSecret',
    },
    {
        name: 'DeployMonitoringSecrets',
        scriptPath: 'app-deploy/monitoring/deploy.py',
        timeoutSeconds: 600,
        description: 'Monitoring K8s Secrets + Helm chart install',
    },
    {
        name: 'DeployStartAdminSecrets',
        scriptPath: 'app-deploy/start-admin/deploy.py',
        timeoutSeconds: 300,
        description: 'start-admin-secrets K8s Secret (Cognito/DynamoDB/Bedrock)',
    },
    {
        name: 'DeployAdminApiSecrets',
        scriptPath: 'app-deploy/admin-api/deploy.py',
        timeoutSeconds: 300,
        description: 'admin-api K8s Secret + ConfigMap + IngressRoute',
    },
    {
        name: 'DeployPublicApiSecrets',
        scriptPath: 'app-deploy/public-api/deploy.py',
        timeoutSeconds: 300,
        description: 'public-api K8s Secret + ConfigMap + IngressRoute',
    },
];

// =============================================================================
// CONSTRUCT
// =============================================================================

export class ConfigOrchestratorConstruct extends Construct {
    /** The Step Functions state machine that drives app config injection (SM-B) */
    public readonly stateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: ConfigOrchestratorProps) {
        super(scope, id);

        const stack = cdk.Stack.of(this);
        const region = props.region ?? stack.region;

        // =====================================================================
        // Step 1: Read Control Plane Instance ID from SSM
        //
        // SM-A writes the CP instance ID to SSM during UpdateInstanceId.
        // SM-B reads it here at execution start — no router Lambda needed.
        // =====================================================================

        const readInstanceId = new sfnTasks.CallAwsService(this, 'ReadCpInstanceId', {
            comment: 'Read control-plane instance ID written by SM-A UpdateInstanceId',
            service: 'ssm',
            action: 'getParameter',
            parameters: {
                Name: `${props.ssmPrefix}/bootstrap/control-plane-instance-id`,
            },
            iamResources: [
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultPath: '$.cpParam',
        });

        const extractInstanceId = new sfn.Pass(this, 'ExtractInstanceId', {
            comment: 'Flatten SSM response: $.cpParam.Parameter.Value → $.instanceId',
            parameters: {
                'instanceId.$': '$.cpParam.Parameter.Value',
                'trigger.$':    '$.trigger',
                'source.$':     '$.source',
            },
        });

        readInstanceId.next(extractInstanceId);

        // =====================================================================
        // Step 2-N: Build send → wait → poll chain per deploy step
        //
        // Each step follows the same pattern as BootstrapOrchestratorConstruct:
        //   sendCommand → initCounter → wait → poll → checkStatus → (next step | Fail)
        // =====================================================================

        interface StepChain { start: sfn.State; successPass: sfn.Pass }

        /**
         * Builds a complete SSM RunCommand send → wait → poll → check chain.
         *
         * @param step - Deploy step definition
         * @returns start state and the success Pass state (for chaining to next step)
         */
        const buildDeployStep = (step: ConfigStep): StepChain => {
            const id = step.name;
            const safeId = id.replace(/-/g, '');

            const sendFailed = new sfn.Fail(this, `${id}SendFailed`, {
                error: `${id}SendFailed`,
                cause: `SSM SendCommand failed for ${step.scriptPath}`,
            });
            const stepFailed = new sfn.Fail(this, `${id}Failed`, {
                error: `${id}Failed`,
                cause: `${step.scriptPath}: ${step.description}`,
            });

            // 1. Send SSM RunCommand
            const sendCommand = new sfnTasks.CallAwsService(this, `${id}Send`, {
                comment: step.description,
                service: 'ssm',
                action: 'sendCommand',
                parameters: {
                    DocumentName: props.deployRunnerName,
                    InstanceIds:  [JsonPath.stringAt('$.instanceId')],
                    Parameters: {
                        ScriptPath: [step.scriptPath],
                        SsmPrefix:  [props.ssmPrefix],
                        S3Bucket:   [props.scriptsBucketName],
                        Region:     [region],
                    },
                    CloudWatchOutputConfig: {
                        CloudWatchLogGroupName:  props.deployLogGroupName,
                        CloudWatchOutputEnabled: true,
                    },
                    TimeoutSeconds: step.timeoutSeconds,
                },
                iamResources: ['*'],
                resultPath: `$.${safeId}Cmd`,
            });
            sendCommand.addCatch(sendFailed, { errors: ['States.ALL'] });

            // 2. Init poll counter
            const initCounter = new sfn.Pass(this, `${id}InitCounter`, {
                parameters: {
                    'instanceId.$':             '$.instanceId',
                    'trigger.$':                '$.trigger',
                    'source.$':                 '$.source',
                    [`${safeId}CommandId.$`]:   `$.${safeId}Cmd.Command.CommandId`,
                    [`${safeId}PollCount`]:     0,
                },
            });

            // 3. Wait 30 s
            const waitState = new sfn.Wait(this, `${id}Wait`, {
                time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
            });

            // 4. Poll
            const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
                service: 'ssm',
                action: 'getCommandInvocation',
                parameters: {
                    CommandId:  JsonPath.stringAt(`$.${safeId}CommandId`),
                    InstanceId: JsonPath.stringAt('$.instanceId'),
                },
                iamResources: ['*'],
                resultSelector: { 'StatusDetails.$': '$.StatusDetails' },
                resultPath: `$.${safeId}Poll`,
            });

            // 5. Increment counter
            const incrCounter = new sfn.Pass(this, `${id}IncrCounter`, {
                parameters: {
                    'instanceId.$':             '$.instanceId',
                    'trigger.$':                '$.trigger',
                    'source.$':                 '$.source',
                    [`${safeId}CommandId.$`]:   `$.${safeId}CommandId`,
                    [`${safeId}PollCount.$`]:   JsonPath.mathAdd(
                        JsonPath.numberAt(`$.${safeId}PollCount`), 1,
                    ),
                    [`${safeId}Poll.$`]:        `$.${safeId}Poll`,
                },
            });

            // 6. Timeout guard (60 × 30s = 30 min)
            const timeoutGuard = new sfn.Choice(this, `${id}TimeoutCheck`)
                .when(
                    sfn.Condition.numberGreaterThan(`$.${safeId}PollCount`, 60),
                    new sfn.Fail(this, `${id}Timeout`, {
                        error: `${id}Timeout`,
                        cause: `${step.scriptPath} did not complete within 30 minutes`,
                    }),
                )
                .otherwise(waitState);

            // 7. Success pass (caller chains .next() on this)
            const successPass = new sfn.Pass(this, `${id}Succeeded`, {
                parameters: {
                    'instanceId.$': '$.instanceId',
                    'trigger.$':    '$.trigger',
                    'source.$':     '$.source',
                },
            });

            // 8. Status branch
            const checkStatus = new sfn.Choice(this, `${id}CheckStatus`)
                .when(
                    sfn.Condition.stringEquals(`$.${safeId}Poll.StatusDetails`, 'InProgress'),
                    incrCounter.next(timeoutGuard),
                )
                .when(
                    sfn.Condition.stringEquals(`$.${safeId}Poll.StatusDetails`, 'Success'),
                    successPass,
                )
                .otherwise(stepFailed);

            sendCommand
                .next(initCounter)
                .next(waitState)
                .next(pollStatus)
                .next(checkStatus);

            return { start: sendCommand, successPass };
        };

        // =====================================================================
        // Build and chain all steps
        // =====================================================================

        const builtSteps = DEPLOY_STEPS.map(buildDeployStep);

        // Chain success passes: step[i].successPass → step[i+1].start
        for (let i = 0; i < builtSteps.length - 1; i++) {
            builtSteps[i]!.successPass.next(builtSteps[i + 1]!.start);
        }

        const succeed = new sfn.Succeed(this, 'ConfigApplied', {
            comment: 'All app config deploy scripts completed successfully',
        });
        // Last step success → overall Succeed
        builtSteps[builtSteps.length - 1]!.successPass.next(succeed);

        // Entry: ReadCpInstanceId → ExtractInstanceId → first deploy step
        extractInstanceId.next(builtSteps[0]!.start);

        // =====================================================================
        // State Machine (SM-B)
        // =====================================================================

        const smLogGroup = new logs.LogGroup(this, 'ConfigOrchestratorLogs', {
            logGroupName:    `/aws/vendedlogs/states/${props.prefix}-config-orchestrator`,
            retention:       logs.RetentionDays.ONE_WEEK,
            removalPolicy:   cdk.RemovalPolicy.DESTROY,
        });

        this.stateMachine = new sfn.StateMachine(this, 'ConfigStateMachine', {
            stateMachineName: `${props.prefix}-config-orchestrator`,
            definitionBody:   sfn.DefinitionBody.fromChainable(
                sfn.Chain.start(readInstanceId),
            ),
            stateMachineType: sfn.StateMachineType.EXPRESS,
            timeout:          cdk.Duration.hours(1),
            tracingEnabled:   true,
            comment:          'Injects SSM-sourced app config into K8s. Triggered by SM-A SUCCEEDED for self-healing.',
            logs: {
                destination:          smLogGroup,
                level:                sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // =====================================================================
        // EventBridge Rule — Self-Healing Trigger
        //
        // Listens for SM-A (Bootstrap) ExecutionSucceeded events.
        // Fires SM-B automatically on every cluster rebuild.
        // =====================================================================

        new events.Rule(this, 'PostBootstrapTrigger', {
            ruleName:    `${props.prefix}-post-bootstrap-config-trigger`,
            description: 'Triggers Config Orchestrator (SM-B) when Bootstrap Orchestrator (SM-A) succeeds',
            eventPattern: {
                source:     ['aws.states'],
                detailType: ['Step Functions Execution Status Change'],
                detail: {
                    stateMachineArn: [props.bootstrapStateMachineArn],
                    status:          ['SUCCEEDED'],
                },
            },
            targets: [
                new targets.SfnStateMachine(this.stateMachine, {
                    input: events.RuleTargetInput.fromObject({
                        trigger: 'post-bootstrap',
                        source:  'eventbridge',
                    }),
                }),
            ],
        });
    }
}
