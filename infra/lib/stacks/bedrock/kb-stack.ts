/**
 * @format
 * Bedrock Knowledge Base Stack
 *
 * Creates a Bedrock Knowledge Base backed by Pinecone (free tier).
 * Uses @cdklabs/generative-ai-cdk-constructs for L2 Bedrock + Pinecone constructs.
 *
 * Architecture:
 *   S3 (repo docs) → Bedrock KB (Titan Embeddings V2) → Pinecone (vector store)
 *   Agent queries KB → retrieves context → generates grounded answers
 *
 * Pinecone eliminates the OpenSearch Serverless minimum idle cost,
 * reducing the monthly bill from ~£15–35 to ~£2–8 (token cost only).
 */

import {
    bedrock,
} from '@cdklabs/generative-ai-cdk-constructs';
import { PineconeVectorStore } from '@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/pinecone';
import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Pinecone field names used by Bedrock KB integration */
const PINECONE_METADATA_FIELD = 'metadata';
const PINECONE_TEXT_FIELD = 'text';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for BedrockKbStack
 */
export interface BedrockKbStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Embedding model ID (e.g. 'amazon.titan-embed-text-v2:0') */
    readonly embeddingsModel: string;
    /** ARN of the S3 bucket containing Knowledge Base documents */
    readonly dataBucketArn: string;
    /** Pinecone index connection string (e.g. 'https://portfolio-kb-xxx.svc.aped-xxx.pinecone.io') */
    readonly pineconeConnectionString: string;
    /** Name of the Secrets Manager secret containing the Pinecone API key */
    readonly pineconeSecretName: string;
    /** Pinecone namespace for data isolation */
    readonly pineconeNamespace: string;
    /** Knowledge Base description */
    readonly kbDescription: string;
    /** Knowledge Base instruction for agent interaction */
    readonly kbInstruction: string;
    /** Removal policy for resources */
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Knowledge Base Stack for Bedrock Agent.
 *
 * Creates a Bedrock Knowledge Base backed by Pinecone vector store.
 * Pinecone's free tier (100K vectors) is more than sufficient for
 * a portfolio repository's documentation.
 *
 * The KB uses Titan Embeddings V2 (1024 dimensions) for embedding
 * and Pinecone for vector storage/retrieval.
 */
export class BedrockKbStack extends cdk.Stack {
    /** The Bedrock Knowledge Base */
    public readonly knowledgeBase: bedrock.VectorKnowledgeBase;

    /** The S3 data source */
    public readonly dataSource: bedrock.S3DataSource;

    /** Knowledge Base ID (for cross-stack reference) */
    public readonly knowledgeBaseId: string;

    /** Knowledge Base ARN (for cross-stack reference) */
    public readonly knowledgeBaseArn: string;

    constructor(scope: Construct, id: string, props: BedrockKbStackProps) {
        super(scope, id, props);

        const { namePrefix } = props;

        // =================================================================
        // Resolve Full Pinecone Secret ARN
        //
        // Bedrock requires the COMPLETE secret ARN (with random suffix)
        // to build its session policy for secretsmanager:GetSecretValue.
        // Secret.fromSecretNameV2 returns a partial ARN without the suffix,
        // which causes session policy evaluation to fail.
        //
        // Uses AwsCustomResource to call DescribeSecret at deploy time
        // and retrieve the full ARN.
        // =================================================================
        const describeSecret = new cr.AwsCustomResource(this, 'DescribePineconeSecret', {
            onCreate: {
                service: 'SecretsManager',
                action: 'describeSecret',
                parameters: { SecretId: props.pineconeSecretName },
                physicalResourceId: cr.PhysicalResourceId.of(`${namePrefix}-pinecone-secret-lookup`),
            },
            onUpdate: {
                service: 'SecretsManager',
                action: 'describeSecret',
                parameters: { SecretId: props.pineconeSecretName },
                physicalResourceId: cr.PhysicalResourceId.of(`${namePrefix}-pinecone-secret-lookup`),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['secretsmanager:DescribeSecret'],
                    resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.pineconeSecretName}-??????`],
                }),
            ]),
        });

        const pineconeSecretFullArn = describeSecret.getResponseField('ARN');

        // CDK-Nag suppression: AwsCustomResource uses a singleton Lambda at the
        // stack root (AWS679f53fac002430cb0da5b7982bd2287). Its runtime is managed
        // by the CDK custom-resources framework and cannot be overridden.
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [{ id: 'AwsSolutions-L1', reason: 'Lambda runtime managed by CDK AwsCustomResource singleton — cannot override' }],
        );

        // =================================================================
        // Pinecone Vector Store Configuration
        //
        // Uses the full secret ARN (with random suffix) so Bedrock can
        // correctly build its session policy for GetSecretValue.
        // =================================================================
        const pineconeStore = new PineconeVectorStore({
            connectionString: props.pineconeConnectionString,
            credentialsSecretArn: pineconeSecretFullArn,
            metadataField: PINECONE_METADATA_FIELD,
            textField: PINECONE_TEXT_FIELD,
            namespace: props.pineconeNamespace,
        });

        // =================================================================
        // Bedrock Knowledge Base
        //
        // Uses Titan Embeddings V2 (1024 dimensions) for embedding.
        // Pinecone stores/retrieves vectors at zero idle cost.
        // =================================================================
        this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
            name: `${namePrefix}-kb`,
            description: props.kbDescription,
            instruction: props.kbInstruction,
            embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
            vectorStore: pineconeStore,
        });

        this.knowledgeBaseId = this.knowledgeBase.knowledgeBaseId;
        this.knowledgeBaseArn = this.knowledgeBase.knowledgeBaseArn;

        // =================================================================
        // S3 Data Source — Points to the Data Stack's bucket
        //
        // Upload repo documentation (README, ADRs, articles) to this
        // bucket and sync the data source to populate the KB.
        //
        // Chunking: HIERARCHICAL_TITAN preset
        //   Parent chunks: 1500 tokens (captures a full ## section)
        //   Child chunks:  300 tokens  (precise paragraph retrieval)
        //   Overlap:       60 tokens   (prevents hard cuts mid-sentence)
        //
        // This aligns with the KB's Markdown heading structure —
        // each ## section becomes a parent chunk with its paragraphs
        // as child chunks, preserving section-level context.
        // =================================================================
        const dataBucket = s3.Bucket.fromBucketArn(this, 'ImportedDataBucket', props.dataBucketArn);

        this.dataSource = this.knowledgeBase.addS3DataSource({
            bucket: dataBucket,
            dataSourceName: `${namePrefix}-repo-docs`,
            chunkingStrategy: bedrock.ChunkingStrategy.HIERARCHICAL_TITAN,
        });

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'KnowledgeBaseIdParam', {
            parameterName: `/${namePrefix}/knowledge-base-id`,
            stringValue: this.knowledgeBase.knowledgeBaseId,
            description: `Bedrock Knowledge Base ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'KnowledgeBaseArnParam', {
            parameterName: `/${namePrefix}/knowledge-base-arn`,
            stringValue: this.knowledgeBase.knowledgeBaseArn,
            description: `Bedrock Knowledge Base ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'KnowledgeBaseId', {
            value: this.knowledgeBase.knowledgeBaseId,
            description: 'Bedrock Knowledge Base ID',
        });

        new cdk.CfnOutput(this, 'KnowledgeBaseArn', {
            value: this.knowledgeBase.knowledgeBaseArn,
            description: 'Bedrock Knowledge Base ARN',
        });
    }
}
