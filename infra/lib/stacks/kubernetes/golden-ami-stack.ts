/**
 * @format
 * Golden AMI Stack — Image Builder Pipeline
 *
 * Dedicated stack for the EC2 Image Builder pipeline that bakes Docker, AWS CLI,
 * kubeadm toolchain, ecr-credential-provider, and Calico manifests into a
 * Golden AMI.
 *
 * This stack handles all K8s-specific domain logic:
 * - Builds the component YAML document via `buildGoldenAmiComponent()`
 * - Provides K8s-specific IAM managed policies
 * - Configures K8s-specific AMI tags and description
 * - Resolves base infrastructure from SSM (VPC, SG, S3)
 *
 * The underlying `GoldenAmiImageConstruct` is a generic, reusable Image Builder
 * blueprint that knows nothing about Kubernetes.
 *
 * Decoupled from the ControlPlane stack to eliminate the Day-1 dependency cycle:
 *   1. deploy-base       → creates VPC, SG, scripts bucket
 *   2. deploy-goldenami  → creates Image Builder pipeline (this stack)
 *   3. build-golden-ami  → triggers pipeline to bake the AMI
 *   4. deploy-controlplane → ASG launches EC2 with baked Golden AMI
 *
 * Usage:
 * ```typescript
 * const goldenAmiStack = new GoldenAmiStack(scope, 'GoldenAmi-dev', {
 *     vpcId: sharedVpcId,
 *     configs,
 *     namePrefix: 'k8s-development',
 *     ssmPrefix: '/k8s/development',
 *     env,
 * });
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    GoldenAmiImageConstruct,
} from '../../constructs/compute/constructs/golden-ami-image';
import { buildGoldenAmiComponent } from '../../constructs/compute/utils/build-golden-ami-component';
import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

// =============================================================================
// PROPS
// =============================================================================

export interface GoldenAmiStackProps extends cdk.StackProps {
    /** VPC ID from base stack (SSM lookup in factory) */
    readonly vpcId: string;

    /** Target environment (development, staging, production) */
    readonly targetEnvironment: Environment;

    /** Full K8s configuration (imageConfig + clusterConfig) */
    readonly configs: K8sConfigs;

    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;

    /** SSM parameter prefix for the base stack */
    readonly ssmPrefix: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Golden AMI Stack — EC2 Image Builder Pipeline.
 *
 * Orchestrates the generic `GoldenAmiImageConstruct` with K8s-specific
 * domain logic: component YAML generation, IAM policies, and AMI tags.
 * Creates the Image Builder pipeline as a standalone resource so it can
 * be deployed before the Compute stacks.
 */
export class GoldenAmiStack extends cdk.Stack {
    /** The underlying image builder construct (for cross-stack references if needed) */
    public readonly imageBuilder: GoldenAmiImageConstruct;
    /** The AMI ID produced by Image Builder */
    public readonly imageId: string;

    constructor(scope: Construct, id: string, props: GoldenAmiStackProps) {
        super(scope, id, props);

        const { configs, namePrefix } = props;

        // -----------------------------------------------------------------
        // 1. Resolve base infrastructure via SSM (no cross-stack exports)
        // -----------------------------------------------------------------
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/scripts-bucket`,
        );
        const scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);
        const securityGroupId = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/security-group-id`,
        );

        // -----------------------------------------------------------------
        // 2. Build K8s-specific component YAML document
        //
        // The utility function generates the full Image Builder component
        // YAML with all Kubernetes install steps. Software versions come
        // from the centralized K8sImageConfig.
        // -----------------------------------------------------------------
        const componentDocument = buildGoldenAmiComponent({
            imageConfig: configs.image,
            clusterConfig: configs.cluster,
        });

        // -----------------------------------------------------------------
        // 3. Create generic Image Builder pipeline
        //
        // The construct is a reusable blueprint — all K8s-specific values
        // are injected here as props.
        // -----------------------------------------------------------------
        this.imageBuilder = new GoldenAmiImageConstruct(this, 'GoldenAmi', {
            namePrefix,
            componentDocument,
            componentDescription: 'Installs Docker, AWS CLI, kubeadm toolchain, and Calico CNI manifests',
            parentImageSsmPath: configs.image.parentImageSsmPath,
            vpc,
            subnetId: vpc.publicSubnets[0].subnetId,
            securityGroupId,
            scriptsBucket,
            amiSsmPath: configs.image.amiSsmPath,

            // K8s-specific IAM policies for Image Builder instances
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
            ],

            // K8s-specific AMI distribution tags
            amiTags: {
                'Purpose': 'GoldenAMI',
                'KubernetesVersion': configs.cluster.kubernetesVersion,
                'Component': 'ImageBuilder',
            },
            amiDescription: `Golden AMI for ${namePrefix} (kubeadm ${configs.cluster.kubernetesVersion})`,
        });

        this.imageId = this.imageBuilder.imageId;
    }
}
