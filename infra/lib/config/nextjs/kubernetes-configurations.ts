/**
 * @format
 * Next.js K8s Deployment Configuration
 *
 * Configuration for deploying Next.js to Kubernetes (kubeadm worker node).
 * Follows the same pattern as K8sConfigs in lib/config/k8s/configurations.ts.
 *
 * Usage:
 * ```typescript
 * import { getNextJsK8sConfig } from './k8s-configurations';
 * const config = getNextJsK8sConfig(Environment.DEVELOPMENT);
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * EC2 capacity type for cost optimization
 */
export type CapacityType = 'on-demand' | 'spot';

/**
 * K8s deployment configuration for the Next.js application node.
 *
 * The application node runs as a kubeadm worker that joins the existing
 * kubeadm cluster via the join token and CA hash.
 */
export interface NextJsK8sConfig {
    /** EC2 instance type for the application node */
    readonly instanceType: ec2.InstanceType;
    /** Capacity type (on-demand or spot) */
    readonly capacityType: CapacityType;
    /** Kubernetes node label for workload isolation */
    readonly nodeLabel: string;
    /** Kubernetes node taint for workload isolation */
    readonly nodeTaint: string;
    /**
     * SSM parameter prefix of the kubeadm control plane cluster.
     * Used to discover the server URL and join token.
     * @example '/k8s/development'
     */
    readonly controlPlaneSsmPrefix: string;
    /** Whether to enable detailed CloudWatch monitoring */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals for ASG */
    readonly useSignals: boolean;
    /** Timeout for CloudFormation signals in minutes */
    readonly signalsTimeoutMinutes: number;
    /** EBS root volume size in GB */
    readonly rootVolumeSizeGb: number;
    /** Whether this is a production environment */
    readonly isProduction: boolean;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Next.js K8s configurations by environment
 */
export const NEXTJS_K8S_CONFIGS: Record<Environment, NextJsK8sConfig> = {
    [Environment.DEVELOPMENT]: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        capacityType: 'on-demand',
        nodeLabel: 'role=application',
        nodeTaint: 'role=application:NoSchedule',
        controlPlaneSsmPrefix: '/k8s/development',
        detailedMonitoring: false,
        useSignals: true,
        signalsTimeoutMinutes: 15,
        rootVolumeSizeGb: 20,
        isProduction: false,
    },

    [Environment.STAGING]: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        capacityType: 'on-demand',
        nodeLabel: 'role=application',
        nodeTaint: 'role=application:NoSchedule',
        controlPlaneSsmPrefix: '/k8s/staging',
        detailedMonitoring: true,
        useSignals: true,
        signalsTimeoutMinutes: 15,
        rootVolumeSizeGb: 20,
        isProduction: false,
    },

    [Environment.PRODUCTION]: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
        capacityType: 'on-demand', // Switch to reserved via AWS console/CLI after purchase
        nodeLabel: 'role=application',
        nodeTaint: 'role=application:NoSchedule',
        controlPlaneSsmPrefix: '/k8s/production',
        detailedMonitoring: true,
        useSignals: true,
        signalsTimeoutMinutes: 15,
        rootVolumeSizeGb: 20,
        isProduction: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Next.js K8s configuration for an environment
 */
export function getNextJsK8sConfig(env: Environment): NextJsK8sConfig {
    return NEXTJS_K8S_CONFIGS[env];
}
