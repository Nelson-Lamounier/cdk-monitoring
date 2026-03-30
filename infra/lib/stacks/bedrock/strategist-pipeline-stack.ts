/**
 * @format
 * Strategist Pipeline Stack — Multi-Agent Step Functions Pipeline
 *
 * Creates the Step Functions state machine and 4 Lambda functions
 * for the 3-agent job strategist pipeline.
 *
 * Architecture:
 *   Admin Dashboard → API Gateway → Trigger Lambda → Step Functions
 *     → Research Lambda (Haiku 3.5) — KB retrieval, resume, gap analysis
 *     → Strategist Lambda (Sonnet 4.6) — 5-phase XML analysis
 *     → Coach Lambda (Haiku 4.5) — Stage-specific interview prep
 *     → DynamoDB (results) + S3 (analysis artefacts)
 *
 * Observability:
 *   - Per-agent EMF metrics in BedrockMultiAgent namespace
 *   - X-Ray tracing on all Lambdas
 *   - CloudWatch Logs with configurable retention
 *   - Pipeline-level cost metrics
 */

import * as path from 'node:path';

import { NagSuppressions } from 'cdk-nag';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for StrategistPipelineStack.
 */
export interface StrategistPipelineStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Name of the shared S3 assets bucket (from BedrockDataStack) */
    readonly assetsBucketName: string;
    /** DynamoDB table for strategist data (from StrategistDataStack) */
    readonly tableName: string;
    /** Research Agent model ID */
    readonly researchModel: string;
    /** Strategist Agent model ID */
    readonly strategistModel: string;
    /** Strategist maximum output tokens */
    readonly strategistMaxTokens: number;
    /** Strategist thinking budget tokens */
    readonly strategistThinkingBudgetTokens: number;
    /** Interview Coach model ID */
    readonly coachModel: string;
    /** Coach maximum output tokens */
    readonly coachMaxTokens: number;
    /** Coach thinking budget tokens */
    readonly coachThinkingBudgetTokens: number;
    /** Lambda memory in MB for agent functions */
    readonly agentLambdaMemoryMb: number;
    /** Lambda timeout in seconds for agent functions */
    readonly agentLambdaTimeoutSeconds: number;
    /** Lambda memory in MB for the trigger function */
    readonly triggerLambdaMemoryMb: number;
    /** CloudWatch log retention */
    readonly logRetention: logs.RetentionDays;
    /** Removal policy for ephemeral resources */
    readonly removalPolicy: cdk.RemovalPolicy;
    /** Bedrock Knowledge Base ID (optional) */
    readonly knowledgeBaseId?: string;
    /** Bedrock Knowledge Base ARN for IAM permissions (optional) */
    readonly knowledgeBaseArn?: string;
    /** Runtime environment name */
    readonly environmentName: string;
    /** DynamoDB table name for the article content table (resume source) */
    readonly contentTableName: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Multi-Agent Strategist Pipeline Stack — Step Functions Orchestration.
 *
 * Creates a 3-stage Step Functions pipeline:
 *   Research → Strategist → Interview Coach
 *
 * The pipeline is triggered by the admin dashboard via API Gateway.
 * Results are persisted to DynamoDB and S3.
 */
export class StrategistPipelineStack extends cdk.Stack {
    /** Step Functions state machine */
    public readonly stateMachine: sfn.StateMachine;

    /** Trigger Handler Lambda (API Gateway → Step Functions) */
    public readonly triggerFunction: lambdaNode.NodejsFunction;

    /** Dead Letter Queue for pipeline failures */
    public readonly pipelineDlq: sqs.Queue;

    constructor(scope: Construct, id: string, props: StrategistPipelineStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // Import shared resources
        const assetsBucket = s3.Bucket.fromBucketName(
            this,
            'ImportedAssetsBucket',
            props.assetsBucketName,
        );

        const strategistTable = dynamodb.TableV2.fromTableName(
            this,
            'ImportedStrategistTable',
            props.tableName,
        );

        const contentTable = dynamodb.TableV2.fromTableName(
            this,
            'ImportedContentTable',
            props.contentTableName,
        );

        // =================================================================
        // SQS — Pipeline Dead Letter Queue
        // =================================================================
        this.pipelineDlq = new sqs.Queue(this, 'PipelineDlq', {
            queueName: `${namePrefix}-strategist-dlq`,
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
            encryption: sqs.QueueEncryption.SQS_MANAGED,
            removalPolicy: props.removalPolicy,
        });

        NagSuppressions.addResourceSuppressions(this.pipelineDlq, [
            {
                id: 'AwsSolutions-SQS3',
                reason: 'This queue IS the dead-letter queue — it does not need its own DLQ',
            },
        ]);

        // =================================================================
        // Lambda entry point path
        // =================================================================
        const handlersDir = path.join(
            __dirname, '..', '..', '..', '..', 'bedrock-applications', 'job-strategist', 'src', 'handlers',
        );

        /** Shared bundling config for all pipeline Lambdas */
        const bundlingConfig: lambdaNode.BundlingOptions = {
            minify: true,
            sourceMap: true,
            externalModules: ['@aws-sdk/*'],
        };

        // =================================================================
        // Lambda — Research Handler
        // =================================================================
        const researchFn = new lambdaNode.NodejsFunction(this, 'ResearchFunction', {
            functionName: `${namePrefix}-strategist-research`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'research-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                RESEARCH_MODEL: props.researchModel,
                ASSETS_BUCKET: assetsBucket.bucketName,
                TABLE_NAME: strategistTable.tableName,
                CONTENT_TABLE_NAME: contentTable.tableName,
                ENVIRONMENT: props.environmentName,
                ...(props.knowledgeBaseId ? { KNOWLEDGE_BASE_ID: props.knowledgeBaseId } : {}),
            },
            description: `Strategist Research Agent (${props.researchModel})`,
            logGroup: new logs.LogGroup(this, 'ResearchLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-research`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // Lambda — Strategist Handler
        // =================================================================
        const strategistFn = new lambdaNode.NodejsFunction(this, 'StrategistFunction', {
            functionName: `${namePrefix}-strategist-writer`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'strategist-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                FOUNDATION_MODEL: props.strategistModel,
                MAX_TOKENS: String(props.strategistMaxTokens),
                THINKING_BUDGET_TOKENS: String(props.strategistThinkingBudgetTokens),
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Strategist Agent (${props.strategistModel})`,
            logGroup: new logs.LogGroup(this, 'StrategistLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-writer`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // Lambda — Interview Coach Handler
        // =================================================================
        const coachFn = new lambdaNode.NodejsFunction(this, 'CoachFunction', {
            functionName: `${namePrefix}-strategist-coach`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'coach-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                COACH_MODEL: props.coachModel,
                MAX_TOKENS: String(props.coachMaxTokens),
                THINKING_BUDGET_TOKENS: String(props.coachThinkingBudgetTokens),
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Interview Coach Agent (${props.coachModel})`,
            logGroup: new logs.LogGroup(this, 'CoachLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-coach`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // IAM — Grant permissions
        // =================================================================

        // Research: S3 read, Bedrock InvokeModel, KB Retrieve, DynamoDB read/write
        assetsBucket.grantRead(researchFn);
        strategistTable.grantWriteData(researchFn);
        contentTable.grantReadData(researchFn);
        researchFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: ['*'], // Model ARNs are region-specific inference profiles
        }));
        if (props.knowledgeBaseArn) {
            researchFn.addToRolePolicy(new iam.PolicyStatement({
                actions: ['bedrock:Retrieve'],
                resources: [props.knowledgeBaseArn],
            }));
        }

        // Strategist: Bedrock InvokeModel, DynamoDB write (persist analysis)
        strategistFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: ['*'],
        }));
        strategistTable.grantWriteData(strategistFn);

        // Coach: Bedrock InvokeModel, DynamoDB read/write
        coachFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: ['*'],
        }));
        strategistTable.grantReadWriteData(coachFn);

        // CDK-Nag suppression for NODEJS_22_X
        const allFunctions = [researchFn, strategistFn, coachFn];
        for (const fn of allFunctions) {
            NagSuppressions.addResourceSuppressions(
                fn,
                [
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'Using NODEJS_22_X — latest Node.js LTS runtime',
                    },
                ],
                true,
            );
        }

        // Bedrock wildcard resource suppression
        NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'Bedrock InvokeModel requires wildcard for cross-region inference profiles.',
            },
        ]);

        // =================================================================
        // Step Functions — Pipeline State Machine
        // =================================================================

        // Lambda invoke tasks
        const researchTask = new tasks.LambdaInvoke(this, 'ResearchTask', {
            lambdaFunction: researchFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Research Agent: KB retrieval, resume parsing, gap analysis',
        });

        const strategistTask = new tasks.LambdaInvoke(this, 'StrategistTask', {
            lambdaFunction: strategistFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Strategist Agent: 5-phase XML analysis and document generation',
        });

        const coachTask = new tasks.LambdaInvoke(this, 'CoachTask', {
            lambdaFunction: coachFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Interview Coach: stage-specific interview preparation',
        });

        // Error handling: catch all and fail state
        const pipelineFailed = new sfn.Fail(this, 'PipelineFailed', {
            error: 'StrategistPipelineExecutionFailed',
            cause: 'One of the strategist pipeline agents threw an unrecoverable error',
        });

        // Chain: Research → Strategist → Coach
        const definition = researchTask
            .addCatch(pipelineFailed, {
                errors: ['States.ALL'],
                resultPath: '$.error',
            })
            .next(
                strategistTask.addCatch(pipelineFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            )
            .next(
                coachTask.addCatch(pipelineFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            );

        this.stateMachine = new sfn.StateMachine(this, 'PipelineStateMachine', {
            stateMachineName: `${namePrefix}-strategist-pipeline`,
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.minutes(30),
            tracingEnabled: true,
            stateMachineType: sfn.StateMachineType.STANDARD,
            logs: {
                level: sfn.LogLevel.ALL,
                destination: new logs.LogGroup(this, 'StateMachineLogGroup', {
                    logGroupName: `/aws/vendedlogs/states/${namePrefix}-strategist-pipeline`,
                    retention: props.logRetention,
                    removalPolicy: props.removalPolicy,
                }),
            },
        });

        // =================================================================
        // Lambda — Trigger Handler (API Gateway → Step Functions)
        // =================================================================
        this.triggerFunction = new lambdaNode.NodejsFunction(this, 'TriggerFunction', {
            functionName: `${namePrefix}-strategist-trigger`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'trigger-handler.ts'),
            handler: 'handler',
            memorySize: props.triggerLambdaMemoryMb,
            timeout: cdk.Duration.seconds(30),
            environment: {
                STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
                TABLE_NAME: strategistTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Strategist Trigger — API Gateway → Step Functions`,
            logGroup: new logs.LogGroup(this, 'TriggerLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-strategist-trigger`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // Grant trigger Lambda permission to start executions + write DynamoDB
        this.stateMachine.grantStartExecution(this.triggerFunction);
        strategistTable.grantWriteData(this.triggerFunction);

        NagSuppressions.addResourceSuppressions(
            this.triggerFunction,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Using NODEJS_22_X — latest Node.js LTS runtime',
                },
            ],
            true,
        );

        // =================================================================
        // SSM — Export pipeline configuration
        // =================================================================
        new ssm.StringParameter(this, 'StateMachineArnParam', {
            parameterName: `/${namePrefix}/strategist-state-machine-arn`,
            stringValue: this.stateMachine.stateMachineArn,
            description: 'ARN of the strategist pipeline Step Functions state machine',
        });

        new ssm.StringParameter(this, 'TriggerFunctionArnParam', {
            parameterName: `/${namePrefix}/strategist-trigger-function-arn`,
            stringValue: this.triggerFunction.functionArn,
            description: 'ARN of the Strategist Trigger Handler Lambda',
        });
    }
}
