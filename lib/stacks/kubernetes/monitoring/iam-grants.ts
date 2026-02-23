/**
 * @format
 * Monitoring-tier IAM grants for the shared Kubernetes compute stack.
 *
 * Extracted from the original K8sComputeStack (monitoring) to cleanly
 * separate monitoring-specific permissions from the shared compute layer.
 *
 * Permissions granted:
 *   - EBS volume management (attach/detach/describe)
 *   - ECR pull (deploy container images to Kubernetes)
 *   - Elastic IP association
 *   - SSM parameter write (cluster discovery)
 */

import * as iam from 'aws-cdk-lib/aws-iam';

// =============================================================================
// INTERFACE
// =============================================================================

export interface MonitoringIamGrantsProps {
    /** SSM parameter prefix for monitoring k8s parameters */
    readonly ssmPrefix: string;

    /** AWS region for ARN construction */
    readonly region: string;

    /** AWS account ID for ARN construction */
    readonly account: string;
}

// =============================================================================
// FUNCTION
// =============================================================================

/**
 * Grant monitoring-tier IAM permissions to the instance role.
 *
 * These permissions are required for the Kubernetes cluster to manage:
 * - EBS persistent volumes (attach on boot, detach on terminate)
 * - ECR images (pull for pod scheduling)
 * - Elastic IP (stable external endpoint)
 * - SSM parameters (publish cluster metadata for cross-stack discovery)
 */
export function grantMonitoringPermissions(
    role: iam.IRole,
    props: MonitoringIamGrantsProps,
): void {
    const { ssmPrefix, region, account } = props;

    // EBS volume management
    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'EbsVolumeManagement',
        effect: iam.Effect.ALLOW,
        actions: [
            'ec2:AttachVolume',
            'ec2:DetachVolume',
            'ec2:DescribeVolumes',
            'ec2:DescribeInstances',
        ],
        resources: ['*'],
    }));

    // ECR pull (for deploying container images to Kubernetes)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'EcrPull',
        effect: iam.Effect.ALLOW,
        actions: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetAuthorizationToken',
        ],
        resources: ['*'],
    }));

    // SSM parameter write (kubeadm stores instance ID, elastic IP in SSM)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'SsmParameterWrite',
        effect: iam.Effect.ALLOW,
        actions: [
            'ssm:PutParameter',
            'ssm:GetParameter',
            'ssm:GetParameters',
            'ssm:GetParametersByPath',
        ],
        resources: [
            `arn:aws:ssm:${region}:${account}:parameter${ssmPrefix}/*`,
        ],
    }));

    // Elastic IP association (needed for user-data and SSM-based EIP re-association)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'EipAssociation',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:AssociateAddress', 'ec2:DescribeAddresses'],
        resources: ['*'],
    }));

    // Secrets Manager write (ArgoCD CI bot token — pushed during bootstrap)
    // The bootstrap-argocd.sh script generates an API token for the ci-bot
    // account and stores it in Secrets Manager so the CI pipeline can
    // retrieve it for ArgoCD application health verification.
    const k8sEnv = ssmPrefix.split('/').pop() || 'development';
    role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'SecretsManagerArgoCdWrite',
        effect: iam.Effect.ALLOW,
        actions: [
            'secretsmanager:CreateSecret',
            'secretsmanager:PutSecretValue',
            'secretsmanager:UpdateSecret',
            'secretsmanager:DescribeSecret',
        ],
        resources: [
            `arn:aws:secretsmanager:${region}:${account}:secret:k8s/${k8sEnv}/*`,
        ],
    }));
}
