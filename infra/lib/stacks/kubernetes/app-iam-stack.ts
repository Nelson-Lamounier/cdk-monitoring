/**
 * @format
 * Kubernetes Application IAM Stack
 *
 * Attaches application-specific IAM policies (DynamoDB, S3, Secrets Manager,
 * SSM) to the instance role created by KubernetesControlPlaneStack.
 *
 * This stack is fully decoupled from the compute lifecycle. Adding a
 * DynamoDB table or S3 bucket only requires redeploying this stack,
 * not the underlying infrastructure.
 *
 * Key design decisions:
 * - Imports the instance role via direct cross-stack reference (loose coupling)
 * - All grants are conditional — no-op when props are absent
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

import { KubernetesControlPlaneStack } from './control-plane-stack';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesAppIamStack.
 *
 * All grant props are optional — omit to run the stack in
 * monitoring-only mode (no application IAM grants attached).
 */
export interface KubernetesAppIamStackProps extends cdk.StackProps {
    /** Reference to the control plane stack (for instance role) */
    readonly controlPlaneStack: KubernetesControlPlaneStack;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** SSM parameter prefix */
    readonly ssmPrefix: string;

    // =========================================================================
    // Application-tier grants (all optional)
    // =========================================================================

    /** DynamoDB table ARNs to grant read access (SSR queries) */
    readonly dynamoTableArns?: string[];

    /** SSM path for DynamoDB KMS key ARN (customer-managed key) */
    readonly dynamoKmsKeySsmPath?: string;

    /** S3 bucket ARNs to grant read access (static assets) */
    readonly s3ReadBucketArns?: string[];

    /** SSM parameter path wildcard for Next.js env vars */
    readonly ssmParameterPath?: string;

    /** Secrets Manager path pattern for Next.js auth secrets */
    readonly secretsManagerPathPattern?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Application IAM Stack
 *
 * Decouples application-specific IAM grants from the compute infrastructure.
 * When you add a new DynamoDB table or S3 bucket, only this stack needs
 * redeployment — the ASG, Launch Template, and AMI remain untouched.
 */
export class KubernetesAppIamStack extends cdk.Stack {

    constructor(scope: Construct, id: string, props: KubernetesAppIamStackProps) {
        super(scope, id, props);

        // Import the instance role from the control plane stack
        const instanceRole = props.controlPlaneStack.instanceRole;

        // =====================================================================
        // Application-tier IAM grants
        //
        // All grants are conditional — no-op if the corresponding props
        // are absent. This allows the stack to be deployed in
        // monitoring-only mode without any application-tier permissions.
        // =====================================================================
        grantApplicationPermissions(instanceRole, {
            region: this.region,
            account: this.account,
            dynamoTableArns: props.dynamoTableArns,
            dynamoKmsKeySsmPath: props.dynamoKmsKeySsmPath,
            s3ReadBucketArns: props.s3ReadBucketArns,
            ssmParameterPath: props.ssmParameterPath,
            secretsManagerPathPattern: props.secretsManagerPathPattern,
        });

        // =====================================================================
        // Tags
        // =====================================================================
        cdk.Tags.of(this).add('Stack', 'KubernetesAppIam');
        cdk.Tags.of(this).add('Layer', 'Application');

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: instanceRole.roleArn,
            description: 'Instance role ARN receiving application-tier grants',
        });
    }
}

// =============================================================================
// APPLICATION IAM GRANTS (inlined — single consumer)
// =============================================================================

interface ApplicationIamGrantsProps {
    readonly region: string;
    readonly account: string;
    readonly dynamoTableArns?: string[];
    readonly dynamoKmsKeySsmPath?: string;
    readonly s3ReadBucketArns?: string[];
    readonly ssmParameterPath?: string;
    readonly secretsManagerPathPattern?: string;
}

/**
 * Grant application-tier IAM permissions to the instance role.
 *
 * Permissions (all conditional — no-op if corresponding props are absent):
 * - DynamoDB read (SSR data queries)
 * - DynamoDB KMS decrypt (customer-managed keys)
 * - S3 read (static assets)
 * - SSM parameter read (application env vars)
 * - Secrets Manager read (auth secrets)
 */
function grantApplicationPermissions(
    role: iam.IRole,
    props: ApplicationIamGrantsProps,
): void {
    const { region, account } = props;

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
