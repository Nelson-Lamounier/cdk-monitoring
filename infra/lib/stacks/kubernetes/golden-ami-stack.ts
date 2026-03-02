/**
 * @format
 * Golden AMI Stack — Image Builder Pipeline
 *
 * Dedicated stack for the EC2 Image Builder pipeline that bakes Docker, AWS CLI,
 * kubeadm toolchain, ecr-credential-provider, and Calico manifests into a
 * Golden AMI.
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
 *     baseStack,
 *     configs,
 *     namePrefix: 'k8s-development',
 *     env,
 * });
 * ```
 */

import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    GoldenAmiImageConstruct,
} from '../../common/compute/constructs/golden-ami-image';
import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

import { KubernetesBaseStack } from './base-stack';

// =============================================================================
// PROPS
// =============================================================================

export interface GoldenAmiStackProps extends cdk.StackProps {
    /** Base stack providing VPC, security group, and scripts bucket */
    readonly baseStack: KubernetesBaseStack;

    /** Target environment (development, staging, production) */
    readonly targetEnvironment: Environment;

    /** Full K8s configuration (imageConfig + clusterConfig) */
    readonly configs: K8sConfigs;

    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Golden AMI Stack — EC2 Image Builder Pipeline.
 *
 * Creates the Image Builder pipeline as a standalone resource so it can
 * be deployed before the Compute stacks. This ensures the AMI is baked
 * before any ASG launches EC2 instances.
 */
export class GoldenAmiStack extends cdk.Stack {
    /** The underlying image builder construct (for cross-stack references if needed) */
    public readonly imageBuilder: GoldenAmiImageConstruct;
    /** The AMI ID produced by Image Builder */
    public readonly imageId: string;

    constructor(scope: Construct, id: string, props: GoldenAmiStackProps) {
        super(scope, id, props);

        const { baseStack, configs, namePrefix } = props;

        this.imageBuilder = new GoldenAmiImageConstruct(this, 'GoldenAmi', {
            namePrefix,
            imageConfig: configs.image,
            clusterConfig: configs.cluster,
            vpc: baseStack.vpc,
            subnetId: baseStack.vpc.publicSubnets[0].subnetId,
            securityGroupId: baseStack.securityGroup.securityGroupId,
            scriptsBucket: baseStack.scriptsBucket,
        });
        this.imageId = this.imageBuilder.imageId;
    }
}
