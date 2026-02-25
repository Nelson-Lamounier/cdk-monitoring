/**
 * @format
 * Bedrock Data Stack
 *
 * Stateful resources for the Bedrock Agent project.
 * Owns the S3 bucket used as a Knowledge Base data source.
 *
 * Lifecycle: independent of Agent/API stacks — data persists across
 * agent redeployments.
 */

import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for BedrockDataStack
 */
export interface BedrockDataStackProps extends cdk.StackProps {
    /** Name prefix for resources (e.g. 'bedrock-development') */
    readonly namePrefix: string;
    /** Whether to create a customer-managed KMS key for S3 encryption */
    readonly createEncryptionKey: boolean;
    /** Removal policy for the S3 bucket */
    readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * Data Stack for Bedrock Agent.
 *
 * Creates the S3 bucket that serves as the data source for the
 * Bedrock Knowledge Base. Publishes bucket identifiers to SSM
 * for cross-stack discovery.
 */
export class BedrockDataStack extends cdk.Stack {
    /** The S3 bucket for Knowledge Base documents */
    public readonly dataBucket: s3.Bucket;

    /** Optional KMS encryption key (production only) */
    public readonly encryptionKey?: kms.Key;

    /** The bucket name (for SSM export) */
    public readonly bucketName: string;

    constructor(scope: Construct, id: string, props: BedrockDataStackProps) {
        super(scope, id, props);

        const { namePrefix, createEncryptionKey, removalPolicy } = props;

        // =================================================================
        // KMS Encryption Key (production only)
        // =================================================================
        if (createEncryptionKey) {
            this.encryptionKey = new kms.Key(this, 'DataBucketKey', {
                alias: `${namePrefix}-data-bucket`,
                description: `KMS key for ${namePrefix} Knowledge Base data bucket`,
                enableKeyRotation: true,
                removalPolicy,
            });
        }

        // =================================================================
        // S3 Bucket — Knowledge Base Data Source
        // =================================================================
        this.dataBucket = new s3.Bucket(this, 'DataBucket', {
            bucketName: `${namePrefix}-kb-data`,
            encryption: this.encryptionKey
                ? s3.BucketEncryption.KMS
                : s3.BucketEncryption.S3_MANAGED,
            encryptionKey: this.encryptionKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            removalPolicy,
            autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
        });
        this.bucketName = this.dataBucket.bucketName;

        // =================================================================
        // SSM Parameter Exports
        // =================================================================
        new ssm.StringParameter(this, 'BucketNameParam', {
            parameterName: `/${namePrefix}/data-bucket-name`,
            stringValue: this.dataBucket.bucketName,
            description: `Knowledge Base data bucket name for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'BucketArnParam', {
            parameterName: `/${namePrefix}/data-bucket-arn`,
            stringValue: this.dataBucket.bucketArn,
            description: `Knowledge Base data bucket ARN for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // =================================================================
        // Stack Outputs
        // =================================================================
        new cdk.CfnOutput(this, 'DataBucketName', {
            value: this.dataBucket.bucketName,
            description: 'Knowledge Base data bucket name',
        });

        new cdk.CfnOutput(this, 'DataBucketArn', {
            value: this.dataBucket.bucketArn,
            description: 'Knowledge Base data bucket ARN',
        });
    }
}
