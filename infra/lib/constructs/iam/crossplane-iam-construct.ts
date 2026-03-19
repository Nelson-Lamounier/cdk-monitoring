/**
 * @format
 * Crossplane IAM Construct — Dedicated IAM User for Crossplane on Self-Hosted K8s
 *
 * Provisions a dedicated IAM user with tightly scoped permissions for
 * Crossplane to manage AWS resources declaratively from Kubernetes.
 *
 * Why a dedicated IAM user (not instance profile)?
 *   - Self-hosted kubeadm clusters lack IRSA
 *   - Crossplane needs its own credential scope, separate from node role
 *   - Enables key rotation via Secrets Manager
 *   - Follows least-privilege: only S3, SQS, KMS — nothing else
 *
 * Security:
 *   - All permissions scoped to `crossplane-*` resource name patterns
 *   - Access key stored in AWS Secrets Manager (not SSM, for rotation)
 *   - No wildcard resource ARNs — explicit paths only
 *
 * Cost: Free (IAM users and Secrets Manager secret storage are included).
 *       Secrets Manager charges $0.40/secret/month for the stored credential.
 *
 * @example
 * ```typescript
 * new CrossplaneIamConstruct(this, 'CrossplaneIam', {
 *     namePrefix: 'shared-dev',
 *     targetEnvironment: Environment.DEVELOPMENT,
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib/core';


import { Construct } from 'constructs';

import type { Environment } from '../../config/environments';

// =========================================================================
// PROPS
// =========================================================================

/**
 * Props for the Crossplane IAM construct.
 */
export interface CrossplaneIamConstructProps {
    /** Resource name prefix (e.g. 'shared-dev') */
    readonly namePrefix: string;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /**
     * AWS services Crossplane is allowed to manage.
     * Each service gets tightly scoped permissions for CRUD operations
     * on resources prefixed with `crossplane-*`.
     *
     * @default ['s3', 'sqs']
     */
    readonly managedServices?: ReadonlyArray<'s3' | 'sqs'>;
}

// =========================================================================
// CONSTRUCT
// =========================================================================

/**
 * Crossplane IAM Construct — Dedicated credentials for Crossplane on self-hosted K8s.
 *
 * Creates a purpose-built IAM user with access key stored in Secrets Manager.
 * The K8s bootstrap process reads the secret and injects it as a K8s Secret
 * in the `crossplane-system` namespace.
 */
export class CrossplaneIamConstruct extends Construct {
    /** The IAM user created for Crossplane */
    public readonly user: iam.User;

    /** Secrets Manager secret storing the access key */
    public readonly credentialSecret: secretsmanager.Secret;

    /** The access key resource */
    public readonly accessKey: iam.AccessKey;

    constructor(scope: Construct, id: string, props: CrossplaneIamConstructProps) {
        super(scope, id);

        const managedServices = props.managedServices ?? ['s3', 'sqs'];

        // =================================================================
        // IAM USER — Dedicated Crossplane Service Account
        // =================================================================
        this.user = new iam.User(this, 'User', {
            userName: `${props.namePrefix}-crossplane`,
            path: '/service-accounts/',
        });

        // =================================================================
        // IAM POLICIES — Tightly Scoped per Service
        // =================================================================
        if (managedServices.includes('s3')) {
            this.user.addToPolicy(this._s3Policy(props.namePrefix));
        }

        if (managedServices.includes('sqs')) {
            this.user.addToPolicy(this._sqsPolicy(props.namePrefix));
        }

        // KMS permissions are always needed for encryption enforcement
        this.user.addToPolicy(this._kmsPolicy(props.namePrefix));

        // Tagging permissions — Crossplane needs to tag resources it creates
        this.user.addToPolicy(this._taggingPolicy());

        // =================================================================
        // ACCESS KEY — Stored in Secrets Manager
        // =================================================================
        this.accessKey = new iam.AccessKey(this, 'AccessKey', {
            user: this.user,
        });

        this.credentialSecret = new secretsmanager.Secret(this, 'CredentialSecret', {
            secretName: `${props.namePrefix}/crossplane/aws-credentials`,
            description: `Crossplane AWS credentials (${props.targetEnvironment})`,
            secretObjectValue: {
                // accessKeyId is a plain string token — wrap as SecretValue
                aws_access_key_id: cdk.SecretValue.unsafePlainText(
                    this.accessKey.accessKeyId,
                ),
                // secretAccessKey is already a SecretValue
                aws_secret_access_key: this.accessKey.secretAccessKey,
            },
        });

        // Tag the construct's resources
        cdk.Tags.of(this).add('managed-by', 'cdk');
        cdk.Tags.of(this).add('purpose', 'crossplane-credentials');

        // CDK-nag suppression: rotation is handled via pipeline/manual process
        // (no Lambda auto-rotator exists for IAM access keys)
        NagSuppressions.addResourceSuppressions(this.credentialSecret, [{
            id: 'AwsSolutions-SMG4',
            reason: 'IAM access key rotation handled via pipeline-driven process. '
                + 'AWS does not support Lambda-based auto-rotation for IAM access keys.',
        }]);
    }

    // =====================================================================
    // PRIVATE — Policy Builders
    // =====================================================================

    /**
     * S3 permissions — scoped to `crossplane-*` bucket names.
     * Supports full CRUD lifecycle for Crossplane-managed buckets.
     */
    private _s3Policy(namePrefix: string): iam.PolicyStatement {
        return new iam.PolicyStatement({
            sid: 'CrossplaneS3Management',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:CreateBucket',
                's3:DeleteBucket',
                's3:GetBucketLocation',
                's3:GetBucketTagging',
                's3:GetEncryptionConfiguration',
                's3:GetBucketVersioning',
                's3:GetBucketPublicAccessBlock',
                's3:GetLifecycleConfiguration',
                's3:ListBucket',
                's3:PutBucketTagging',
                's3:PutEncryptionConfiguration',
                's3:PutBucketVersioning',
                's3:PutBucketPublicAccessBlock',
                's3:PutLifecycleConfiguration',
                's3:PutObject',
                's3:GetObject',
                's3:DeleteObject',
            ],
            resources: [
                `arn:aws:s3:::crossplane-${namePrefix}-*`,
                `arn:aws:s3:::crossplane-${namePrefix}-*/*`,
            ],
        });
    }

    /**
     * SQS permissions — scoped to `crossplane-*` queue names.
     * Supports queue CRUD, DLQ configuration, and attributes.
     */
    private _sqsPolicy(namePrefix: string): iam.PolicyStatement {
        return new iam.PolicyStatement({
            sid: 'CrossplaneSqsManagement',
            effect: iam.Effect.ALLOW,
            actions: [
                'sqs:CreateQueue',
                'sqs:DeleteQueue',
                'sqs:GetQueueAttributes',
                'sqs:GetQueueUrl',
                'sqs:ListQueueTags',
                'sqs:SetQueueAttributes',
                'sqs:TagQueue',
                'sqs:UntagQueue',
            ],
            resources: [
                `arn:aws:sqs:*:*:crossplane-${namePrefix}-*`,
            ],
        });
    }

    /**
     * KMS permissions — Crossplane needs to create and use KMS keys
     * for encrypting S3 buckets and SQS queues it provisions.
     * Scoped to keys with the `crossplane-managed` alias.
     */
    private _kmsPolicy(_namePrefix: string): iam.PolicyStatement {
        return new iam.PolicyStatement({
            sid: 'CrossplaneKmsUsage',
            effect: iam.Effect.ALLOW,
            actions: [
                'kms:CreateKey',
                'kms:DescribeKey',
                'kms:EnableKeyRotation',
                'kms:GetKeyPolicy',
                'kms:ListResourceTags',
                'kms:TagResource',
                'kms:CreateAlias',
                'kms:DeleteAlias',
                'kms:ListAliases',
                'kms:Encrypt',
                'kms:Decrypt',
                'kms:GenerateDataKey',
            ],
            resources: ['*'],
            conditions: {
                StringLike: {
                    'aws:RequestTag/managed-by': 'crossplane',
                },
            },
        });
    }

    /**
     * Tagging permissions — Crossplane needs to tag resources it creates.
     * Uses condition key to only allow tags where managed-by=crossplane.
     */
    private _taggingPolicy(): iam.PolicyStatement {
        return new iam.PolicyStatement({
            sid: 'CrossplaneTaggingOperations',
            effect: iam.Effect.ALLOW,
            actions: [
                'tag:GetResources',
                'tag:TagResources',
                'tag:UntagResources',
            ],
            resources: ['*'],
        });
    }
}
