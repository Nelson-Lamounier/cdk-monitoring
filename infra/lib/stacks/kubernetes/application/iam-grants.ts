/**
 * @format
 * Application-tier IAM grants for the shared Kubernetes compute stack.
 *
 * Extracted from the original NextJsK8sComputeStack to cleanly separate
 * application-specific permissions (DynamoDB, S3, Secrets Manager) from
 * the shared compute layer.
 *
 * All grants are conditional — only applied when the corresponding
 * props are provided. This allows the shared stack to operate in
 * monitoring-only mode when no application grants are needed.
 */

import * as iam from 'aws-cdk-lib/aws-iam';

// =============================================================================
// INTERFACE
// =============================================================================

export interface ApplicationIamGrantsProps {
    /** AWS region for ARN construction */
    readonly region: string;

    /** AWS account ID for ARN construction */
    readonly account: string;

    /**
     * DynamoDB table ARNs to grant read access (SSR queries).
     * If empty/undefined, no DynamoDB grants are created.
     */
    readonly dynamoTableArns?: string[];

    /**
     * SSM path for DynamoDB KMS key ARN.
     * When provided, grants kms:Decrypt for customer-managed key.
     */
    readonly dynamoKmsKeySsmPath?: string;

    /**
     * S3 bucket ARNs to grant read access (static assets).
     * If empty/undefined, no S3 grants are created.
     */
    readonly s3ReadBucketArns?: string[];

    /**
     * SSM parameter path wildcard for granting read access.
     * @example '/nextjs/development/*'
     */
    readonly ssmParameterPath?: string;

    /**
     * Secrets Manager path pattern for granting read access.
     * @example 'nextjs/development/*'
     */
    readonly secretsManagerPathPattern?: string;
}

// =============================================================================
// FUNCTION
// =============================================================================

/**
 * Grant application-tier IAM permissions to the instance role.
 *
 * These permissions support the Next.js application workload:
 * - DynamoDB read (SSR data queries)
 * - DynamoDB KMS decrypt (customer-managed encryption keys)
 * - S3 read (static asset serving)
 * - SSM parameter read (application env vars)
 * - Secrets Manager read (auth secrets)
 *
 * All grants are conditional — no-op if the corresponding props are absent.
 */
export function grantApplicationPermissions(
    role: iam.IRole,
    props: ApplicationIamGrantsProps,
): void {
    const { region, account } = props;

    // Grant application-level SSM read (for Next.js env vars)
    if (props.ssmParameterPath) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmNextJsParameterRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParametersByPath',
            ],
            resources: [
                `arn:aws:ssm:${region}:${account}:parameter${props.ssmParameterPath}`,
            ],
        }));
    }

    // DynamoDB read access (for SSR queries)
    if (props.dynamoTableArns && props.dynamoTableArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'DynamoDbRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:BatchGetItem',
            ],
            resources: [
                ...props.dynamoTableArns,
                ...props.dynamoTableArns.map(arn => `${arn}/index/*`),
            ],
        }));
    }

    // DynamoDB KMS key access (customer-managed key)
    if (props.dynamoKmsKeySsmPath) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'DynamoKmsDecrypt',
            effect: iam.Effect.ALLOW,
            actions: [
                'kms:Decrypt',
                'kms:DescribeKey',
            ],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'kms:ViaService': `dynamodb.${region}.amazonaws.com`,
                },
            },
        }));
    }

    // S3 read access (for static assets bucket)
    if (props.s3ReadBucketArns && props.s3ReadBucketArns.length > 0) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'S3Read',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:ListBucket',
            ],
            resources: [
                ...props.s3ReadBucketArns,
                ...props.s3ReadBucketArns.map(arn => `${arn}/*`),
            ],
        }));
    }

    // Secrets Manager access (for auth-secret, auth-url, etc.)
    if (props.secretsManagerPathPattern) {
        role.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SecretsManagerRead',
            effect: iam.Effect.ALLOW,
            actions: [
                'secretsmanager:GetSecretValue',
            ],
            resources: [
                `arn:aws:secretsmanager:${region}:${account}:secret:${props.secretsManagerPathPattern}`,
            ],
        }));
    }
}
