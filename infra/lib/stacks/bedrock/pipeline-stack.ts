/**
 * @format
 * Pipeline Stack — Multi-Agent Step Functions Pipeline
 *
 * Creates the Step Functions state machine and 4 agent-specific Lambda
 * functions for the lean 3-agent article generation pipeline.
 *
 * Architecture:
 *   S3 (drafts/*.md) → Trigger Lambda → Step Functions
 *     → Research Lambda (Haiku 4.5)
 *     → Writer Lambda (Sonnet 4.6)
 *     → QA Lambda (Sonnet 4.6)
 *     → S3 (review/*.mdx) + DynamoDB (status: review/flagged)
 *
 *   Admin Dashboard → Publish Lambda → S3 (published/*.mdx) + DynamoDB
 *
 * Observability:
 *   - Per-agent EMF metrics in BedrockMultiAgent namespace
 *   - X-Ray tracing on all Lambdas
 *   - CloudWatch Logs with configurable retention
 *   - Pipeline-level cost & QA score metrics
 */

import * as path from 'node:path';


import { NagSuppressions } from 'cdk-nag';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { JsonPath } from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for BedrockPipelineStack.
 */
export interface BedrockPipelineStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Name of the S3 bucket for drafts and published output (from DataStack) */
    readonly assetsBucketName: string;
    /** DynamoDB table for article metadata (from AiContentStack) */
    readonly tableName: string;
    /** Research Agent model ID */
    readonly researchModel: string;
    /** Writer Agent model ID */
    readonly writerModel: string;
    /** QA Agent model ID */
    readonly qaModel: string;
    /** Writer maximum output tokens */
    readonly writerMaxTokens: number;
    /** Writer thinking budget tokens */
    readonly writerThinkingBudgetTokens: number;
    /** Lambda memory in MB for agent functions */
    readonly agentLambdaMemoryMb: number;
    /** Lambda timeout in seconds for agent functions */
    readonly agentLambdaTimeoutSeconds: number;
    /** Lambda memory in MB for the trigger function */
    readonly triggerLambdaMemoryMb: number;
    /** Lambda memory in MB for the publish function */
    readonly publishLambdaMemoryMb: number;
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
    /** S3 prefixes */
    readonly draftPrefix: string;
    readonly publishedPrefix: string;
    readonly contentPrefix: string;
    readonly reviewPrefix: string;
    readonly archivedPrefix: string;
    /** ISR revalidation endpoint URL (optional) */
    readonly isrEndpoint?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Multi-Agent Pipeline Stack — Step Functions Orchestration.
 *
 * Creates a 3-stage Step Functions pipeline (Research → Writer → QA)
 * with a separate Publish Lambda for admin-invoked article approval.
 */
export class BedrockPipelineStack extends cdk.Stack {
    /** Step Functions state machine */
    public readonly stateMachine: sfn.StateMachine;

    /** Publish Handler Lambda (invoked by admin dashboard) */
    public readonly publishFunction: lambdaNode.NodejsFunction;

    /** Trigger Handler Lambda (S3 event → Step Functions) */
    public readonly triggerFunction: lambdaNode.NodejsFunction;

    /** Dead Letter Queue for pipeline failures */
    public readonly pipelineDlq: sqs.Queue;

    constructor(scope: Construct, id: string, props: BedrockPipelineStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // Import shared resources
        const assetsBucket = s3.Bucket.fromBucketName(
            this,
            'ImportedAssetsBucket',
            props.assetsBucketName,
        );

        const contentTable = dynamodb.TableV2.fromTableName(
            this,
            'ImportedContentTable',
            props.tableName,
        );

        // =================================================================
        // SQS — Pipeline Dead Letter Queue
        // =================================================================
        this.pipelineDlq = new sqs.Queue(this, 'PipelineDlq', {
            queueName: `${namePrefix}-pipeline-dlq`,
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
        // Lambda entry point path (bedrock-applications/article-pipeline/src/handlers/)
        // =================================================================
        const handlersDir = path.join(
            __dirname, '..', '..', '..', '..', 'bedrock-applications', 'article-pipeline', 'src', 'handlers',
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
            functionName: `${namePrefix}-pipeline-research`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'research-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                RESEARCH_MODEL: props.researchModel,
                ASSETS_BUCKET: assetsBucket.bucketName,
                PIPELINE_TABLE_NAME: contentTable.tableName,
                ENVIRONMENT: props.environmentName,
                ...(props.knowledgeBaseId ? { KNOWLEDGE_BASE_ID: props.knowledgeBaseId } : {}),
            },
            description: `Pipeline Research Agent (${props.researchModel})`,
            logGroup: new logs.LogGroup(this, 'ResearchLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-pipeline-research`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // Lambda — Writer Handler
        // =================================================================
        const writerFn = new lambdaNode.NodejsFunction(this, 'WriterFunction', {
            functionName: `${namePrefix}-pipeline-writer`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'writer-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                FOUNDATION_MODEL: props.writerModel,
                MAX_TOKENS: String(props.writerMaxTokens),
                THINKING_BUDGET_TOKENS: String(props.writerThinkingBudgetTokens),
                ENVIRONMENT: props.environmentName,
            },
            description: `Pipeline Writer Agent (${props.writerModel})`,
            logGroup: new logs.LogGroup(this, 'WriterLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-pipeline-writer`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // Lambda — QA Handler
        // =================================================================
        const qaFn = new lambdaNode.NodejsFunction(this, 'QaFunction', {
            functionName: `${namePrefix}-pipeline-qa`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'qa-handler.ts'),
            handler: 'handler',
            memorySize: props.agentLambdaMemoryMb,
            timeout: cdk.Duration.seconds(props.agentLambdaTimeoutSeconds),
            environment: {
                QA_MODEL: props.qaModel,
                ASSETS_BUCKET: assetsBucket.bucketName,
                PIPELINE_TABLE_NAME: contentTable.tableName,
                REVIEW_PREFIX: props.reviewPrefix,
                ENVIRONMENT: props.environmentName,
            },
            description: `Pipeline QA Agent (${props.qaModel})`,
            logGroup: new logs.LogGroup(this, 'QaLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-pipeline-qa`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // Lambda — Publish Handler (admin-invoked)
        // =================================================================
        this.publishFunction = new lambdaNode.NodejsFunction(this, 'PublishFunction', {
            functionName: `${namePrefix}-pipeline-publish`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'publish-handler.ts'),
            handler: 'handler',
            memorySize: props.publishLambdaMemoryMb,
            timeout: cdk.Duration.seconds(30),
            environment: {
                ASSETS_BUCKET: assetsBucket.bucketName,
                PIPELINE_TABLE_NAME: contentTable.tableName,
                REVIEW_PREFIX: props.reviewPrefix,
                PUBLISHED_PREFIX: props.publishedPrefix,
                CONTENT_PREFIX: props.contentPrefix,
                ARCHIVED_PREFIX: props.archivedPrefix,
                ENVIRONMENT: props.environmentName,
                ...(props.isrEndpoint ? { ISR_ENDPOINT: props.isrEndpoint } : {}),
            },
            description: `Pipeline Publish Handler — admin approval/rejection`,
            logGroup: new logs.LogGroup(this, 'PublishLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-pipeline-publish`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // =================================================================
        // IAM — Grant permissions
        // =================================================================

        // Research: S3 read (drafts + review/), DynamoDB read, Bedrock InvokeModel + KB Retrieve
        assetsBucket.grantRead(researchFn, `${props.draftPrefix}*`);
        assetsBucket.grantRead(researchFn, `${props.reviewPrefix}*`);
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

        // Writer: Bedrock InvokeModel only
        writerFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: ['*'],
        }));

        // QA: S3 write (review/), DynamoDB write, Bedrock InvokeModel
        assetsBucket.grantWrite(qaFn, `${props.reviewPrefix}*`);
        contentTable.grantWriteData(qaFn);
        qaFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: ['*'],
        }));

        // Publish: S3 read/write/delete, DynamoDB read/write (needs Query for supersede logic)
        assetsBucket.grantReadWrite(this.publishFunction);
        assetsBucket.grantDelete(this.publishFunction);
        contentTable.grantReadWriteData(this.publishFunction);

        // CDK-Nag suppression for NODEJS_22_X
        const allFunctions = [researchFn, writerFn, qaFn, this.publishFunction];
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
                reason: 'Bedrock InvokeModel requires wildcard for cross-region inference profiles. S3 grants use specific prefixes.',
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
            comment: 'Research Agent: KB retrieval, complexity analysis, outline',
        });

        const writerTask = new tasks.LambdaInvoke(this, 'WriterTask', {
            lambdaFunction: writerFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'Writer Agent: full MDX article generation',
        });

        const qaTask = new tasks.LambdaInvoke(this, 'QaTask', {
            lambdaFunction: qaFn,
            outputPath: '$.Payload',
            resultPath: '$',
            comment: 'QA Agent: quality validation + S3/DynamoDB persistence',
        });

        // =================================================================
        // Error Handling — DynamoUpdateItem → Fail
        //
        // When any Lambda task fails, the Catch block preserves the
        // original task input (which includes context.slug) and adds
        // the error details at $.error. The DynamoUpdateItem task
        // writes status='failed' to the article's METADATA record
        // so the frontend can display the failure state instead of
        // hanging on 'processing' indefinitely.
        // =================================================================

        const pipelineFailed = new sfn.Fail(this, 'PipelineFailed', {
            error: 'PipelineExecutionFailed',
            cause: 'One of the pipeline agents threw an unrecoverable error',
        });

        /**
         * Write status='failed' to the VERSION#v<n> record before transitioning to Fail state.
         *
         * CRITICAL: Both gsi1pk AND gsi1sk must be set together. DynamoDB GSIs
         * require both partition key and sort key to project an item into the
         * index. Without gsi1sk, the failed record is invisible to GSI queries.
         */
        const markArticleFailed = new tasks.DynamoUpdateItem(this, 'MarkArticleFailed', {
            table: contentTable,
            key: {
                pk: tasks.DynamoAttributeValue.fromString(
                    JsonPath.format('ARTICLE#{}', JsonPath.stringAt('$.context.slug')),
                ),
                sk: tasks.DynamoAttributeValue.fromString(
                    JsonPath.format('VERSION#v{}', JsonPath.stringAt('$.context.version')),
                ),
            },
            updateExpression: 'SET #status = :failed, #updatedAt = :now, #errorMessage = :error, #gsi1pk = :gsi1pk, #gsi1sk = :gsi1sk',
            expressionAttributeNames: {
                '#status': 'status',
                '#updatedAt': 'updatedAt',
                '#errorMessage': 'errorMessage',
                '#gsi1pk': 'gsi1pk',
                '#gsi1sk': 'gsi1sk',
            },
            expressionAttributeValues: {
                ':failed': tasks.DynamoAttributeValue.fromString('failed'),
                ':now': tasks.DynamoAttributeValue.fromString(
                    JsonPath.stringAt('$$.State.EnteredTime'),
                ),
                ':error': tasks.DynamoAttributeValue.fromString(
                    JsonPath.stringAt('$.error.Cause'),
                ),
                ':gsi1pk': tasks.DynamoAttributeValue.fromString('STATUS#failed'),
                ':gsi1sk': tasks.DynamoAttributeValue.fromString(
                    JsonPath.format('{}#{}', JsonPath.stringAt('$.context.startedAt'), JsonPath.stringAt('$.context.slug')),
                ),
            },
            resultPath: sfn.JsonPath.DISCARD,
            comment: 'Write status=failed + GSI keys to VERSION#v<n> record so frontend can display failure',
        });

        markArticleFailed.next(pipelineFailed);

        // Chain: Research → Writer → QA (all catch → MarkFailed → Fail)
        const definition = researchTask
            .addCatch(markArticleFailed, {
                errors: ['States.ALL'],
                resultPath: '$.error',
            })
            .next(
                writerTask.addCatch(markArticleFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            )
            .next(
                qaTask.addCatch(markArticleFailed, {
                    errors: ['States.ALL'],
                    resultPath: '$.error',
                }),
            );

        this.stateMachine = new sfn.StateMachine(this, 'PipelineStateMachine', {
            stateMachineName: `${namePrefix}-article-pipeline`,
            definitionBody: sfn.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.minutes(30),
            tracingEnabled: true,
            stateMachineType: sfn.StateMachineType.STANDARD,
            logs: {
                level: sfn.LogLevel.ALL,
                destination: new logs.LogGroup(this, 'StateMachineLogGroup', {
                    logGroupName: `/aws/vendedlogs/states/${namePrefix}-article-pipeline`,
                    retention: props.logRetention,
                    removalPolicy: props.removalPolicy,
                }),
            },
        });

        // Grant the state machine's execution role permission to write to DynamoDB
        contentTable.grantWriteData(this.stateMachine);

        // =================================================================
        // Lambda — Trigger Handler (S3 event → Step Functions)
        // =================================================================
        this.triggerFunction = new lambdaNode.NodejsFunction(this, 'TriggerFunction', {
            functionName: `${namePrefix}-pipeline-trigger`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'trigger-handler.ts'),
            handler: 'handler',
            memorySize: props.triggerLambdaMemoryMb,
            timeout: cdk.Duration.seconds(30),
            environment: {
                STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
                ASSETS_BUCKET: assetsBucket.bucketName,
                PIPELINE_TABLE_NAME: contentTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Pipeline Trigger — S3 event → Step Functions`,
            logGroup: new logs.LogGroup(this, 'TriggerLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-pipeline-trigger`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        // Grant trigger Lambda permission to start executions + read/write DynamoDB
        // Read is required for the resolveNextVersion() query
        this.stateMachine.grantStartExecution(this.triggerFunction);
        contentTable.grantReadWriteData(this.triggerFunction);

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
        // S3 Event Notification — drafts/ prefix → Trigger Lambda
        //
        // When the admin uploads a .md draft to s3://bucket/drafts/,
        // this event triggers the pipeline automatically.
        // =================================================================
        assetsBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.LambdaDestination(this.triggerFunction),
            { prefix: 'drafts/', suffix: '.md' },
        );

        // =================================================================
        // SSM — Export pipeline configuration
        // =================================================================
        new ssm.StringParameter(this, 'StateMachineArnParam', {
            parameterName: `/${props.namePrefix}/pipeline-state-machine-arn`,
            stringValue: this.stateMachine.stateMachineArn,
            description: 'ARN of the article pipeline Step Functions state machine',
        });

        new ssm.StringParameter(this, 'PublishFunctionArnParam', {
            parameterName: `/${props.namePrefix}/pipeline-publish-function-arn`,
            stringValue: this.publishFunction.functionArn,
            description: 'ARN of the Publish Handler Lambda (for admin dashboard)',
        });

        new ssm.StringParameter(this, 'TriggerFunctionArnParam', {
            parameterName: `/${props.namePrefix}/pipeline-trigger-function-arn`,
            stringValue: this.triggerFunction.functionArn,
            description: 'ARN of the Trigger Handler Lambda (for S3 events)',
        });

        // =================================================================
        // Lambda — Version History Handler (admin dashboard query)
        // =================================================================
        const versionHistoryFn = new lambdaNode.NodejsFunction(this, 'VersionHistoryFunction', {
            functionName: `${namePrefix}-pipeline-version-history`,
            runtime: lambda.Runtime.NODEJS_22_X,
            entry: path.join(handlersDir, 'version-history-handler.ts'),
            handler: 'handler',
            memorySize: props.triggerLambdaMemoryMb, // lightweight query function
            timeout: cdk.Duration.seconds(15),
            environment: {
                PIPELINE_TABLE_NAME: contentTable.tableName,
                ENVIRONMENT: props.environmentName,
            },
            description: `Pipeline Version History — query article versions`,
            logGroup: new logs.LogGroup(this, 'VersionHistoryLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-pipeline-version-history`,
                retention: props.logRetention,
                removalPolicy: props.removalPolicy,
            }),
            bundling: bundlingConfig,
            tracing: lambda.Tracing.ACTIVE,
        });

        contentTable.grantReadData(versionHistoryFn);

        NagSuppressions.addResourceSuppressions(
            versionHistoryFn,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Using NODEJS_22_X — latest Node.js LTS runtime',
                },
            ],
            true,
        );

        new ssm.StringParameter(this, 'VersionHistoryFunctionArnParam', {
            parameterName: `/${props.namePrefix}/pipeline-version-history-function-arn`,
            stringValue: versionHistoryFn.functionArn,
            description: 'ARN of the Version History Lambda (for admin dashboard)',
        });
    }
}
