/**
 * @format
 * Self-Healing Gateway Stack
 *
 * Creates the AgentCore Gateway using the official L2 construct from
 * `@aws-cdk/aws-bedrock-agentcore-alpha`. The Gateway acts as the central
 * MCP-compatible tool discovery and invocation layer for the Self-Healing
 * Agent in the companion AgentStack.
 *
 * Resources:
 * - AgentCore Gateway (L2 construct — CloudFormation-managed lifecycle)
 * - Default Cognito authoriser for M2M (machine-to-machine) JWT auth
 * - 6 Lambda tool functions registered as MCP targets:
 *   1. diagnose-alarm
 *   2. ebs-detach
 *   3. check-node-health
 *   4. analyse-cluster-health
 *   5. get-node-diagnostic-json
 *   6. remediate-node-bootstrap
 * - SSM parameters for cross-stack discovery
 * - CloudWatch log group for Gateway invocations
 *
 * The L2 construct automatically provisions:
 * - IAM role for tool invocation (no manual role required)
 * - Cognito User Pool + Client for OAuth 2.0 client credentials flow
 * - MCP protocol configuration (MCP 2025-03-26, SEMANTIC search)
 */

import * as path from 'node:path';

import {
    Gateway,
    ToolSchema,
    SchemaDefinitionType,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { ApplicationInferenceProfile } from '../../constructs/observability/application-inference-profile';


/**
 * Props for SelfHealingGatewayStack
 */
export interface SelfHealingGatewayStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'self-healing-dev') */
    readonly namePrefix: string;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Gateway throttle — sustained requests per second */
    readonly throttlingRateLimit: number;
    /** Gateway throttle — burst capacity */
    readonly throttlingBurstLimit: number;
    /** System inference profile ARN for Sonnet 4.6 (used as CopyFrom source) */
    readonly sonnetProfileSourceArn: string;
    /** Runtime environment name (for profile tags) */
    readonly environmentName: string;
    /**
     * SSM Parameter Store path for the Step Functions bootstrap orchestrator ARN.
     * The ARN is resolved within the Stack constructor using
     * `StringParameter.valueForStringParameter`, emitting a CloudFormation
     * dynamic reference. Set by `K8sSsmAutomationStack` at deploy time.
     * Example: `/k8s/development/bootstrap/state-machine-arn`
     */
    readonly stateMachineArnSsmPath: string;
}

/**
 * Gateway Stack for Self-Healing Pipeline.
 *
 * Creates an AgentCore Gateway using the official L2 construct and
 * registers tool Lambda functions as MCP-compatible tools accessible
 * to the Bedrock ConverseCommand agent.
 */
export class SelfHealingGatewayStack extends cdk.Stack {
    /** The AgentCore Gateway L2 construct */
    public readonly gateway: Gateway;

    /** The Gateway URL endpoint */
    public readonly gatewayUrl: string;

    /** The Gateway unique identifier */
    public readonly gatewayId: string;

    /** Cognito OAuth2 token endpoint for client credentials flow */
    public readonly tokenEndpointUrl: string;

    /** Cognito User Pool ID (needed to retrieve client secret at runtime) */
    public readonly userPoolId: string;

    /** Cognito User Pool Client ID for M2M auth */
    public readonly userPoolClientId: string;

    /** OAuth2 scope strings for client credentials flow */
    public readonly oauthScopes: string;

    /** Application Inference Profile ARN — Self-Healing Agent Sonnet 4.6 */
    public readonly agentProfileArn: string;

    constructor(scope: Construct, id: string, props: SelfHealingGatewayStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // Resolve the Step Functions bootstrap orchestrator ARN.
        //
        // valueForStringParameter must be called on a Stack scope (this),
        // not on the App. It emits {{resolve:ssm:...}} CloudFormation token
        // resolved at deploy time — no synth-time AWS call needed.
        // =================================================================
        const stateMachineArn = ssm.StringParameter.valueForStringParameter(
            this,
            props.stateMachineArnSsmPath,
        );

        // =================================================================
        // CloudWatch Log Group — Gateway invocations
        // =================================================================
        new logs.LogGroup(this, 'GatewayLogGroup', {
            logGroupName: `/aws/agentcore/${namePrefix}-gateway`,
            retention: props.logRetention,
            removalPolicy: props.removalPolicy,
        });

        // =================================================================
        // AgentCore Gateway — L2 Construct
        //
        // Creates a fully CloudFormation-managed MCP Gateway with:
        // - Auto-generated IAM role for Lambda tool invocation
        // - Default Cognito authoriser (M2M client credentials flow)
        // - MCP protocol v2025-03-26 with SEMANTIC search
        // =================================================================
        this.gateway = new Gateway(this, 'Gateway', {
            gatewayName: `${namePrefix}-gateway`,
            description: `Self-healing MCP tool gateway for ${namePrefix}`,
        });

        // Expose gateway URL and ID — populated by CloudFormation after deploy
        this.gatewayUrl = this.gateway.gatewayUrl ?? `https://${namePrefix}-gateway.bedrock.${this.region}.amazonaws.com`;
        this.gatewayId = this.gateway.gatewayId;

        // Expose Cognito auth details for the Agent Lambda
        this.tokenEndpointUrl = this.gateway.tokenEndpointUrl ?? '';
        this.userPoolId = this.gateway.userPool?.userPoolId ?? '';
        this.userPoolClientId = this.gateway.userPoolClient?.userPoolClientId ?? '';
        this.oauthScopes = (this.gateway.oauthScopes ?? []).join(' ');

        // =================================================================
        // Tool Lambda 1: Diagnose Alarm
        //
        // Queries CloudWatch for alarm configuration, current state,
        // and recent metric datapoints. Returns a structured diagnostic
        // report that helps the agent understand what went wrong.
        // =================================================================
        const diagnoseAlarmFn = new lambdaNode.NodejsFunction(this, 'DiagnoseAlarmFunction', {
            functionName: `${namePrefix}-tool-diagnose-alarm`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'tools', 'diagnose-alarm', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'DiagnoseAlarmLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-diagnose-alarm`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: diagnose CloudWatch alarms for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant CloudWatch read access for alarm diagnosis
        diagnoseAlarmFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ReadCloudWatchAlarms',
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:DescribeAlarms',
                'cloudwatch:GetMetricData',
            ],
            resources: ['*'],
        }));


        // =================================================================
        // Tool Lambda 3: Check Node Health
        //
        // Runs `kubectl get nodes -o json` on the control plane node via
        // SSM SendCommand and returns a structured node health report.
        // Enables the agent to verify worker nodes joined the cluster.
        // =================================================================
        const checkNodeHealthFn = new lambdaNode.NodejsFunction(this, 'CheckNodeHealthFunction', {
            functionName: `${namePrefix}-tool-check-node-health`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'tools', 'check-node-health', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            logGroup: new logs.LogGroup(this, 'CheckNodeHealthLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-check-node-health`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: check K8s node health via SSM for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant EC2 read access (resolve control plane instance by tag)
        checkNodeHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        // Grant SSM SendCommand + GetCommandInvocation (run kubectl on CP node)
        checkNodeHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 4: Analyse Cluster Health (K8sGPT)
        //
        // Runs K8sGPT on the control plane via SSM to diagnose workload
        // issues (failing pods, misconfigured services, etc.).
        // Falls back to kubectl if K8sGPT is not installed.
        // =================================================================
        const analyseClusterHealthFn = new lambdaNode.NodejsFunction(this, 'AnalyseClusterHealthFunction', {
            functionName: `${namePrefix}-tool-analyse-cluster-health`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'tools', 'analyse-cluster-health', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(90),
            logGroup: new logs.LogGroup(this, 'AnalyseClusterHealthLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-analyse-cluster-health`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: K8sGPT cluster health analysis for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant EC2 read access (resolve control plane instance by tag)
        analyseClusterHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'DescribeInstances',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        // Grant SSM SendCommand + GetCommandInvocation (run k8sgpt/kubectl on CP node)
        analyseClusterHealthFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 5: Get Node Diagnostic JSON
        //
        // Fetches the machine-readable `run_summary.json` from a K8s node
        // via SSM SendCommand. Contains bootstrap status, failure
        // classification, and per-step timing from the Python StepRunner.
        // =================================================================
        const getNodeDiagnosticFn = new lambdaNode.NodejsFunction(this, 'GetNodeDiagnosticFunction', {
            functionName: `${namePrefix}-tool-get-node-diagnostic`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'tools', 'get-node-diagnostic-json', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'GetNodeDiagnosticLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-get-node-diagnostic`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: fetch bootstrap run_summary.json from node for ${namePrefix}`,
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant SSM SendCommand + GetCommandInvocation to read diagnostic file
        getNodeDiagnosticFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'SsmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        // =================================================================
        // Tool Lambda 6: Remediate Node Bootstrap
        //
        // Triggers an SSM Automation Document to re-run the bootstrap
        // sequence on a failed K8s node. Resolves Document names and
        // IAM roles from SSM Parameter Store at runtime.
        // =================================================================
        const remediateNodeBootstrapFn = new lambdaNode.NodejsFunction(this, 'RemediateNodeBootstrapFunction', {
            functionName: `${namePrefix}-tool-remediate-bootstrap`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(__dirname, '..', '..', '..', '..', 'bedrock-applications', 'self-healing', 'src', 'tools', 'remediate-node-bootstrap', 'index.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            logGroup: new logs.LogGroup(this, 'RemediateNodeBootstrapLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-tool-remediate-bootstrap`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            tracing: lambda.Tracing.ACTIVE,
            description: `MCP tool: trigger Step Functions bootstrap orchestrator for ${namePrefix}`,
            environment: {
                SSM_PREFIX: '/k8s/development',
                // Injected at deploy time from SSM — avoids runtime parameter lookup
                STATE_MACHINE_ARN: stateMachineArn,
            },
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant states:StartExecution + DescribeExecution on the bootstrap state machine.
        // The tool re-triggers the orchestrator as the self-healing remediation action.
        remediateNodeBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'StartSfnExecution',
            effect: iam.Effect.ALLOW,
            actions: [
                'states:StartExecution',
                'states:DescribeExecution',
            ],
            resources: [stateMachineArn],
        }));

        // SSM GetParameter: allows fallback ARN resolution at runtime (local testing)
        remediateNodeBootstrapFn.addToRolePolicy(new iam.PolicyStatement({
            sid: 'ResolveSsmParameters',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/k8s/*`],
        }));

        // =================================================================
        // Register Tools with AgentCore Gateway
        //
        // Each tool is registered via addLambdaTarget() with an inline
        // ToolSchema defining the MCP tool interface. The L2 construct
        // automatically grants the Gateway's IAM role permission to
        // invoke each Lambda function.
        // =================================================================
        this.gateway.addLambdaTarget('DiagnoseAlarmTarget', {
            gatewayTargetName: 'diagnose-alarm',
            description: 'Analyse a CloudWatch Alarm and return diagnostic information',
            lambdaFunction: diagnoseAlarmFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'diagnose_alarm',
                description: 'Analyse a CloudWatch Alarm and return diagnostic information about the affected resource, including alarm configuration, threshold, recent metric datapoints, and affected resources.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        alarmName: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Name of the CloudWatch Alarm to diagnose',
                        },
                    },
                    required: ['alarmName'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        alarmName: { type: SchemaDefinitionType.STRING, description: 'Alarm name' },
                        exists: { type: SchemaDefinitionType.BOOLEAN, description: 'Whether the alarm exists' },
                        state: { type: SchemaDefinitionType.STRING, description: 'Current alarm state' },
                        stateReason: { type: SchemaDefinitionType.STRING, description: 'Reason for current state' },
                        recentDatapoints: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Recent metric values (last 30 minutes)',
                            items: { type: SchemaDefinitionType.NUMBER },
                        },
                    },
                },
            }]),
        });


        this.gateway.addLambdaTarget('CheckNodeHealthTarget', {
            gatewayTargetName: 'check-node-health',
            description: 'Check Kubernetes node health via SSM on the control plane',
            lambdaFunction: checkNodeHealthFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'check_node_health',
                description: 'Check whether Kubernetes worker nodes have joined the cluster and are in Ready state. Runs kubectl on the control plane node via SSM.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        nodeNameFilter: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional substring filter for node names (e.g. "worker" or "app")',
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used for the check' },
                        totalNodes: { type: SchemaDefinitionType.NUMBER, description: 'Total number of nodes' },
                        readyNodes: { type: SchemaDefinitionType.NUMBER, description: 'Number of Ready nodes' },
                        notReadyNodes: { type: SchemaDefinitionType.NUMBER, description: 'Number of NotReady nodes' },
                        nodes: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Per-node health details',
                            items: { type: SchemaDefinitionType.OBJECT },
                        },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('AnalyseClusterHealthTarget', {
            gatewayTargetName: 'analyse-cluster-health',
            description: 'Analyse Kubernetes cluster health using K8sGPT diagnostics',
            lambdaFunction: analyseClusterHealthFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'analyse_cluster_health',
                description: 'Analyse Kubernetes cluster health using K8sGPT. Diagnoses workload issues such as failing pods, misconfigured services, and unhealthy deployments. Falls back to kubectl if K8sGPT is not installed.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        namespace: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Optional namespace to analyse (e.g. "argocd", "cert-manager"). Omit for cluster-wide analysis.',
                        },
                        filters: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Optional K8sGPT analyser filters (e.g. ["Pod", "Service", "Ingress"])',
                            items: { type: SchemaDefinitionType.STRING },
                        },
                    },
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        controlPlaneInstanceId: { type: SchemaDefinitionType.STRING, description: 'EC2 instance used' },
                        healthy: { type: SchemaDefinitionType.BOOLEAN, description: 'True if no issues found' },
                        totalIssues: { type: SchemaDefinitionType.NUMBER, description: 'Total issues found' },
                        criticalIssues: { type: SchemaDefinitionType.NUMBER, description: 'Critical workload issues' },
                        analysisMethod: { type: SchemaDefinitionType.STRING, description: 'k8sgpt or kubectl-fallback' },
                        issues: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Per-issue diagnostics',
                            items: { type: SchemaDefinitionType.OBJECT },
                        },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('GetNodeDiagnosticTarget', {
            gatewayTargetName: 'get-node-diagnostic-json',
            description: 'Fetch bootstrap diagnostic run_summary.json from a Kubernetes node',
            lambdaFunction: getNodeDiagnosticFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'get_node_diagnostic_json',
                description: 'Fetch the machine-readable run_summary.json bootstrap diagnostic file from a Kubernetes node via SSM. Returns the overall bootstrap status, failure classification code, and per-step timing and errors.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: {
                            type: SchemaDefinitionType.STRING,
                            description: 'EC2 instance ID of the node to diagnose',
                        },
                    },
                    required: ['instanceId'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: { type: SchemaDefinitionType.STRING, description: 'Target instance ID' },
                        found: { type: SchemaDefinitionType.BOOLEAN, description: 'Whether run_summary.json exists on the node' },
                        failureCode: { type: SchemaDefinitionType.STRING, description: 'Machine-readable failure classification (e.g. AMI_MISMATCH, KUBEADM_FAIL)' },
                        failedSteps: {
                            type: SchemaDefinitionType.ARRAY,
                            description: 'Names of bootstrap steps that failed',
                            items: { type: SchemaDefinitionType.STRING },
                        },
                        summary: { type: SchemaDefinitionType.OBJECT, description: 'Full parsed run_summary.json content' },
                    },
                },
            }]),
        });

        this.gateway.addLambdaTarget('RemediateNodeBootstrapTarget', {
            gatewayTargetName: 'remediate-node-bootstrap',
            description: 'Trigger Step Functions bootstrap orchestrator to re-bootstrap a failed Kubernetes node',
            lambdaFunction: remediateNodeBootstrapFn,
            toolSchema: ToolSchema.fromInline([{
                name: 'remediate_node_bootstrap',
                description: 'Trigger the Step Functions bootstrap orchestrator to re-run the full bootstrap sequence on a failed Kubernetes node. Starts a new execution targeting the specified instance and role. Returns the execution ARN for tracking progress in the AWS console.',
                inputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: {
                            type: SchemaDefinitionType.STRING,
                            description: 'EC2 instance ID of the node to remediate',
                        },
                        role: {
                            type: SchemaDefinitionType.STRING,
                            description: 'Node role: "control-plane" or "worker"',
                        },
                    },
                    required: ['instanceId', 'role'],
                },
                outputSchema: {
                    type: SchemaDefinitionType.OBJECT,
                    properties: {
                        instanceId: { type: SchemaDefinitionType.STRING, description: 'Target instance ID' },
                        role: { type: SchemaDefinitionType.STRING, description: 'Node role used for remediation' },
                        executionArn: { type: SchemaDefinitionType.STRING, description: 'Step Functions execution ARN for tracking' },
                        status: { type: SchemaDefinitionType.STRING, description: 'triggered or error' },
                    },
                },
            }]),
        });

        // =================================================================
        // CDK-Nag Suppressions
        // =================================================================
        NagSuppressions.addResourceSuppressions(
            this.gateway,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'Gateway L2 construct auto-generates IAM role with least-privilege for registered Lambda targets',
            }, {
                id: 'AwsSolutions-COG1',
                reason: 'Cognito User Pool is auto-created by Gateway L2 for M2M auth — password policy not applicable for client credentials flow',
            }, {
                id: 'AwsSolutions-COG2',
                reason: 'MFA not applicable for M2M client credentials flow — no end-user authentication involved',
            }, {
                id: 'AwsSolutions-COG3',
                reason: 'AdvancedSecurityMode not applicable for M2M client credentials flow — no end-user passwords to protect from compromise',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            diagnoseAlarmFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'CloudWatch DescribeAlarms and GetMetricData require wildcard resource — alarm ARN is not known at synthesis time',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );


        NagSuppressions.addResourceSuppressions(
            checkNodeHealthFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances and SSM SendCommand require wildcard — instance IDs are dynamic (resolved by tag at runtime)',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            analyseClusterHealthFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'EC2 DescribeInstances and SSM SendCommand require wildcard — instance IDs are dynamic (resolved by tag at runtime)',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            getNodeDiagnosticFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'SSM SendCommand requires wildcard — instance IDs are dynamic (resolved at runtime)',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        NagSuppressions.addResourceSuppressions(
            remediateNodeBootstrapFn,
            [{
                id: 'AwsSolutions-IAM5',
                reason: 'ssm:GetParameter requires wildcard path prefix for fallback ARN resolution. states:StartExecution is scoped to the specific bootstrap state machine ARN.',
            }, {
                id: 'AwsSolutions-L1',
                reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
            }],
            true,
        );

        // =================================================================
        // Application Inference Profile — FinOps Cost Attribution
        //
        // Creates a tagged profile for the Self-Healing Agent to enable
        // per-pipeline Bedrock billing in AWS Cost Explorer.
        // =================================================================
        const agentProfile = new ApplicationInferenceProfile(this, 'AgentSonnetProfile', {
            profileName: `${namePrefix}-agent-sonnet`,
            modelSourceArn: props.sonnetProfileSourceArn,
            description: 'Self healing agent Sonnet 4.6',
            tags: [
                { key: 'project', value: 'self-healing' },
                { key: 'cost-centre', value: 'platform' },
                { key: 'component', value: 'compute' },
                { key: 'environment', value: props.environmentName },
                { key: 'owner', value: 'nelson-l' },
                { key: 'managed-by', value: 'cdk' },
            ],
        });
        this.agentProfileArn = agentProfile.profileArn;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'GatewayUrlParam', {
            parameterName: `/${namePrefix}/gateway-url`,
            stringValue: this.gatewayUrl,
            description: `AgentCore Gateway URL for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'GatewayIdParam', {
            parameterName: `/${namePrefix}/gateway-id`,
            stringValue: this.gatewayId,
            description: `AgentCore Gateway ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'GatewayUrl', {
            value: this.gatewayUrl,
            description: 'AgentCore Gateway endpoint URL',
        });

        new cdk.CfnOutput(this, 'GatewayId', {
            value: this.gatewayId,
            description: 'AgentCore Gateway identifier',
        });

        new cdk.CfnOutput(this, 'GatewayArn', {
            value: this.gateway.gatewayArn,
            description: 'AgentCore Gateway ARN',
        });

        // Suppress log group output for gateway
        // CloudWatch log group is automatically created on first invocation
    }
}
