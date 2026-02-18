/**
 * @format
 * KMS Key Construct
 *
 * Reusable KMS key construct with key rotation enabled.
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for EncryptionKeyConstruct
 */
export interface EncryptionKeyConstructProps {
    /** Key alias (without alias/ prefix) */
    readonly alias: string;
    /** Key description */
    readonly description?: string;
    /** Enable key rotation @default true (Checkov CKV_AWS_7) */
    readonly enableKeyRotation?: boolean;
    /** Removal policy @default RETAIN */
    readonly removalPolicy?: cdk.RemovalPolicy;
    /** Allow CloudWatch Logs to use this key */
    readonly allowCloudWatchLogs?: boolean;
}

/**
 * Reusable KMS key construct with security best practices
 *
 * Features:
 * - Key rotation enabled by default (Checkov compliance)
 * - Optional CloudWatch Logs permissions
 * - RETAIN removal policy by default
 */
export class EncryptionKeyConstruct extends Construct {
    /** The KMS key */
    public readonly key: kms.Key;

    constructor(scope: Construct, id: string, props: EncryptionKeyConstructProps) {
        super(scope, id);

        this.key = new kms.Key(this, 'Key', {
            alias: props.alias,
            description: props.description ?? `KMS key: ${props.alias}`,
            enableKeyRotation: props.enableKeyRotation ?? true,
            removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
        });

        // Grant CloudWatch Logs permission if requested
        if (props.allowCloudWatchLogs) {
            const stack = cdk.Stack.of(this);
            this.key.addToResourcePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
                actions: [
                    'kms:Encrypt*',
                    'kms:Decrypt*',
                    'kms:ReEncrypt*',
                    'kms:GenerateDataKey*',
                    'kms:Describe*',
                ],
                resources: ['*'],
                conditions: {
                    ArnLike: {
                        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${stack.region}:${stack.account}:*`,
                    },
                },
            }));
        }
    }
}
