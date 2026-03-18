/**
 * @format
 * Crossplane Stack — Platform Engineering IAM Foundation
 *
 * Deploys the IAM identity that Crossplane uses to manage AWS resources
 * from self-hosted Kubernetes. Pairs with the Crossplane K8s deployment
 * (ArgoCD Application in `platform/argocd-apps/crossplane.yaml`).
 *
 * What this stack creates:
 *   - Dedicated IAM user with tightly scoped S3/SQS/KMS permissions
 *   - Access key stored in AWS Secrets Manager (supports rotation)
 *   - Stack outputs for cross-stack discovery
 *
 * Deploy alongside the other Shared stacks:
 *
 * @example
 * ```bash
 * npx cdk deploy -c project=shared -c environment=development 'Shared-Crossplane-development'
 * ```
 *
 * Cost: ~$0.40/month (single Secrets Manager secret).
 */

import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import type { Environment } from '../../config/environments';
import { CrossplaneIamConstruct } from '../../common/iam/crossplane-iam-construct';

// =========================================================================
// PROPS
// =========================================================================

/**
 * Props for CrossplaneStack.
 */
export interface CrossplaneStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** Resource name prefix (e.g. 'shared-dev') */
    readonly namePrefix: string;

    /**
     * AWS services Crossplane is allowed to manage.
     * @default ['s3', 'sqs']
     */
    readonly managedServices?: ReadonlyArray<'s3' | 'sqs'>;
}

// =========================================================================
// STACK
// =========================================================================

/**
 * Crossplane Stack — Account-Level IAM for Platform Engineering.
 *
 * Creates the IAM user and credential that Crossplane uses to provision
 * AWS resources declaratively via Kubernetes CRDs.
 *
 * Integration points:
 * - Secrets Manager → K8s Secret (bootstrap script reads + creates)
 * - IAM User → Crossplane ProviderConfig (references K8s Secret)
 * - CDK tags → Crossplane-created resources inherit project tagging schema
 */
export class CrossplaneStack extends cdk.Stack {
    /** The Crossplane IAM construct */
    public readonly crossplaneIam: CrossplaneIamConstruct;

    /** Target environment this stack was deployed for */
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: CrossplaneStackProps) {
        super(scope, id, props);

        this.targetEnvironment = props.targetEnvironment;

        // =================================================================
        // CROSSPLANE IAM — Dedicated Credentials
        // =================================================================
        this.crossplaneIam = new CrossplaneIamConstruct(this, 'CrossplaneIam', {
            namePrefix: props.namePrefix,
            targetEnvironment: props.targetEnvironment,
            managedServices: props.managedServices,
        });

        // =================================================================
        // STACK OUTPUTS
        // =================================================================
        new cdk.CfnOutput(this, 'CrossplaneUserArn', {
            description: 'IAM User ARN for Crossplane',
            value: this.crossplaneIam.user.userArn,
        });

        new cdk.CfnOutput(this, 'CrossplaneCredentialSecretArn', {
            description: 'Secrets Manager ARN storing Crossplane AWS credentials',
            value: this.crossplaneIam.credentialSecret.secretArn,
            exportName: `${props.namePrefix}-crossplane-credential-arn`,
        });

        new cdk.CfnOutput(this, 'CrossplaneManagedServices', {
            description: 'AWS services Crossplane can manage',
            value: (props.managedServices ?? ['s3', 'sqs']).join(', '),
        });
    }
}
