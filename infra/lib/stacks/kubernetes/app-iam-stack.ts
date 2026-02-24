/**
 * @format
 * Kubernetes Application IAM Stack
 *
 * Attaches application-specific IAM policies (DynamoDB, S3, Secrets Manager,
 * SSM) to the instance role created by KubernetesComputeStack.
 *
 * This stack is fully decoupled from the compute lifecycle. Adding a
 * DynamoDB table or S3 bucket only requires redeploying this stack,
 * not the underlying infrastructure.
 *
 * Key design decisions:
 * - Imports the instance role via `iam.Role.fromRoleArn()` (loose coupling)
 * - Reuses the existing `grantApplicationPermissions()` function
 * - All grants are conditional — no-op when props are absent
 */

import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

import { grantApplicationPermissions, ApplicationIamGrantsProps } from './application';
import { KubernetesComputeStack } from './compute-stack';

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
    /** Reference to the compute stack (for instance role) */
    readonly computeStack: KubernetesComputeStack;

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

        // Import the instance role from the compute stack
        const instanceRole = props.computeStack.instanceRole;

        // =====================================================================
        // Application-tier IAM grants
        //
        // Reuses the existing grantApplicationPermissions() function,
        // which applies permissions conditionally based on prop presence.
        // =====================================================================
        const appGrantProps: ApplicationIamGrantsProps = {
            region: this.region,
            account: this.account,
            dynamoTableArns: props.dynamoTableArns,
            dynamoKmsKeySsmPath: props.dynamoKmsKeySsmPath,
            s3ReadBucketArns: props.s3ReadBucketArns,
            ssmParameterPath: props.ssmParameterPath,
            secretsManagerPathPattern: props.secretsManagerPathPattern,
        };
        grantApplicationPermissions(instanceRole, appGrantProps);

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
