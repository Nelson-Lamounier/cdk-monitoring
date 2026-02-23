/**
 * @format
 * SSM State Manager Construct
 *
 * Creates SSM State Manager associations for post-boot configuration
 * management on k8s nodes. State Manager ensures continuous compliance
 * by re-applying configuration at a scheduled interval, providing
 * automatic drift remediation.
 *
 * Architecture (Layer 3 of hybrid bootstrap):
 * - Layer 1: Golden AMI (pre-baked software)
 * - Layer 2: Light User Data (EBS attach, EIP, cfn-signal)
 * - Layer 3: SSM State Manager (THIS) — k3s bootstrap, CNI, manifests
 * - Layer 4: SSM Documents (on-demand runbooks)
 *
 * The association targets instances by tag (matching the ASG tag) and
 * runs an SSM document that handles:
 * 1. Calico CNI installation (if not already applied)
 * 2. kubeconfig setup
 * 3. Manifest deployment (kubectl apply -k)
 * 4. Health checks
 *
 * Design Decision: Uses 'rate(30 minutes)' schedule for drift
 * remediation. The first execution happens immediately after instance
 * boot when the SSM agent registers.
 *
 * @example
 * ```typescript
 * const stateManager = new SsmStateManagerConstruct(this, 'StateManager', {
 *     namePrefix: 'k8s-development',
 *     ssmConfig: configs.ssm,
 *     clusterConfig: configs.cluster,
 *     instanceRole: asgConstruct.instanceRole,
 *     targetTag: { key: 'Application', value: 'k8s-monitoring' },
 *     s3BucketName: manifestsBucket.bucketName,
 *     ssmPrefix: '/k8s/development',
 *     region: 'eu-west-1',
 * });
 * ```
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { KubernetesClusterConfig, K8sSsmConfig } from '../../../config/kubernetes/configurations';

// =============================================================================
// PROPS
// =============================================================================

export interface SsmStateManagerProps {
    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;
    /** SSM configuration from K8sConfigs */
    readonly ssmConfig: K8sSsmConfig;
    /** Cluster configuration for k3s settings */
    readonly clusterConfig: KubernetesClusterConfig;
    /** IAM role to grant SSM permissions to */
    readonly instanceRole: iam.IRole;
    /** Tag key/value pair for targeting ASG instances */
    readonly targetTag: { key: string; value: string };
    /** S3 bucket containing k8s manifests */
    readonly s3BucketName: string;
    /** SSM parameter prefix (e.g., '/k8s/development') */
    readonly ssmPrefix: string;
    /** AWS region */
    readonly region: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class SsmStateManagerConstruct extends Construct {
    /** The SSM document for post-boot k8s configuration */
    public readonly document: ssm.CfnDocument;
    /** The State Manager association */
    public readonly association: ssm.CfnAssociation;

    constructor(scope: Construct, id: string, props: SsmStateManagerProps) {
        super(scope, id);

        const {
            namePrefix,
            ssmConfig,
            clusterConfig,
            instanceRole,
            targetTag,
            s3BucketName,
            ssmPrefix,
            region,
        } = props;

        // -----------------------------------------------------------------
        // 1. SSM Document — Post-boot k8s configuration
        //
        // This document handles everything that should happen AFTER the
        // user-data completes (and cfn-signal is sent). It's designed
        // to be idempotent so it can re-run safely on every schedule tick.
        // -----------------------------------------------------------------
        this.document = new ssm.CfnDocument(this, 'ConfigDocument', {
            name: `${namePrefix}-k8s-post-boot-config`,
            documentType: 'Command',
            documentFormat: 'YAML',
            targetType: '/AWS::EC2::Instance',
            content: {
                schemaVersion: '2.2',
                description: `Post-boot k8s configuration for ${namePrefix}. Installs Calico CNI, configures kubeconfig, and deploys manifests. Designed for idempotent re-execution via State Manager.`,
                parameters: {
                    K3sDataDir: {
                        type: 'String',
                        default: clusterConfig.dataDir,
                        description: 'k3s data directory',
                    },
                    S3Bucket: {
                        type: 'String',
                        default: s3BucketName,
                        description: 'S3 bucket containing manifests',
                    },
                    SsmPrefix: {
                        type: 'String',
                        default: ssmPrefix,
                        description: 'SSM parameter prefix',
                    },
                    AwsRegion: {
                        type: 'String',
                        default: region,
                        description: 'AWS region',
                    },
                },
                mainSteps: [
                    {
                        action: 'aws:runShellScript',
                        name: 'WaitForK3s',
                        precondition: {
                            StringEquals: ['platformType', 'Linux'],
                        },
                        inputs: {
                            runCommand: [
                                '#!/bin/bash',
                                'set -euo pipefail',
                                '',
                                '# Wait for k3s to be ready (user-data starts it)',
                                'echo "Waiting for k3s API server..."',
                                'TIMEOUT=120',
                                'WAITED=0',
                                'export KUBECONFIG={{ K3sDataDir }}/server/cred/admin.kubeconfig',
                                '',
                                'while ! kubectl get nodes &>/dev/null; do',
                                '  if [ $WAITED -ge $TIMEOUT ]; then',
                                '    echo "ERROR: k3s not ready after ${TIMEOUT}s"',
                                '    exit 1',
                                '  fi',
                                '  sleep 5',
                                '  WAITED=$((WAITED + 5))',
                                '  echo "  Waiting... (${WAITED}s/${TIMEOUT}s)"',
                                'done',
                                'echo "✓ k3s API server is ready"',
                            ],
                        },
                    },
                    {
                        action: 'aws:runShellScript',
                        name: 'ApplyCalicoCNI',
                        inputs: {
                            runCommand: [
                                '#!/bin/bash',
                                'set -euo pipefail',
                                'export KUBECONFIG={{ K3sDataDir }}/server/cred/admin.kubeconfig',
                                '',
                                '# Check if Calico is already applied',
                                'if kubectl get daemonset calico-node -n kube-system &>/dev/null; then',
                                '  echo "✓ Calico CNI already installed — skipping"',
                                '  exit 0',
                                'fi',
                                '',
                                '# Apply from pre-cached manifests (baked into AMI)',
                                'if [ -f /opt/calico/calico.yaml ]; then',
                                '  echo "Applying Calico CNI from /opt/calico/calico.yaml"',
                                '  kubectl apply -f /opt/calico/calico.yaml',
                                '  echo "✓ Calico CNI applied"',
                                'else',
                                '  echo "WARNING: /opt/calico/calico.yaml not found — downloading"',
                                '  CALICO_VERSION="v3.29.3"',
                                '  kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"',
                                '  echo "✓ Calico CNI applied from remote"',
                                'fi',
                            ],
                        },
                    },
                    {
                        action: 'aws:runShellScript',
                        name: 'ConfigureKubeconfig',
                        inputs: {
                            runCommand: [
                                '#!/bin/bash',
                                'set -euo pipefail',
                                '',
                                '# Setup kubeconfig for root and ec2-user',
                                'K3S_KUBECONFIG="{{ K3sDataDir }}/server/cred/admin.kubeconfig"',
                                '',
                                '# Root',
                                'mkdir -p /root/.kube',
                                'cp -f "${K3S_KUBECONFIG}" /root/.kube/config',
                                'chmod 600 /root/.kube/config',
                                '',
                                '# ec2-user',
                                'mkdir -p /home/ec2-user/.kube',
                                'cp -f "${K3S_KUBECONFIG}" /home/ec2-user/.kube/config',
                                'chown ec2-user:ec2-user /home/ec2-user/.kube/config',
                                'chmod 600 /home/ec2-user/.kube/config',
                                '',
                                'echo "✓ kubeconfig configured for root and ec2-user"',
                            ],
                        },
                    },
                    {
                        action: 'aws:runShellScript',
                        name: 'DeployManifests',
                        inputs: {
                            runCommand: [
                                '#!/bin/bash',
                                'set -euo pipefail',
                                'export KUBECONFIG={{ K3sDataDir }}/server/cred/admin.kubeconfig',
                                'export S3_BUCKET={{ S3Bucket }}',
                                'export SSM_PREFIX={{ SsmPrefix }}',
                                'export AWS_REGION={{ AwsRegion }}',
                                'export MANIFESTS_DIR=/data/k8s/manifests/apps/monitoring/manifests',
                                '',
                                '# Run the deploy-manifests.sh script',
                                'DEPLOY_SCRIPT="/data/k8s/manifests/apps/monitoring/deploy-manifests.sh"',
                                '',
                                'if [ -f "${DEPLOY_SCRIPT}" ]; then',
                                '  chmod +x "${DEPLOY_SCRIPT}"',
                                '  exec "${DEPLOY_SCRIPT}"',
                                'else',
                                '  echo "WARNING: Deploy script not found at ${DEPLOY_SCRIPT}"',
                                '  echo "Syncing manifests from S3 first..."',
                                '  aws s3 sync "s3://${S3_BUCKET}/k8s/" /data/k8s/manifests/ --region ${AWS_REGION}',
                                '  find /data/k8s/manifests -name "*.sh" -exec chmod +x {} +',
                                '  exec "${DEPLOY_SCRIPT}"',
                                'fi',
                            ],
                        },
                    },
                ],
            },
        });

        // -----------------------------------------------------------------
        // 2. State Manager Association
        //
        // Targets ASG instances by tag. Runs on schedule for drift
        // remediation. First execution happens immediately on instance
        // registration with SSM.
        // -----------------------------------------------------------------
        this.association = new ssm.CfnAssociation(this, 'Association', {
            name: this.document.name!,
            associationName: `${namePrefix}-k8s-post-boot`,
            targets: [
                {
                    key: `tag:${targetTag.key}`,
                    values: [targetTag.value],
                },
            ],
            scheduleExpression: ssmConfig.associationSchedule,
            maxConcurrency: ssmConfig.maxConcurrency,
            maxErrors: ssmConfig.maxErrors,
            complianceSeverity: 'HIGH',
            applyOnlyAtCronInterval: false, // Also apply on new instance registration
        });

        // Ensure document is created before association
        this.association.addDependency(this.document);

        // -----------------------------------------------------------------
        // 3. IAM Permissions for the instance role
        // -----------------------------------------------------------------
        instanceRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                sid: 'SsmStateManagerAssociation',
                effect: iam.Effect.ALLOW,
                actions: [
                    'ssm:GetDocument',
                    'ssm:DescribeDocument',
                    'ssm:UpdateInstanceAssociationStatus',
                    'ssm:DescribeAssociation',
                    'ssm:ListAssociations',
                ],
                resources: ['*'],
            }),
        );

        // Tag for identification
        cdk.Tags.of(this).add('Component', 'SsmStateManager');
    }
}
