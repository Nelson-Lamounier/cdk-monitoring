/**
 * @format
 * Kubernetes (k3s) Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, instance sizing) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getK8sConfigs } from '../../config/k8s';
 * const configs = getK8sConfigs(Environment.DEVELOPMENT);
 * const instanceType = configs.instanceType; // 't3.medium'
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import {
    K3S_DEFAULT_CHANNEL,
} from '../defaults';
import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * k3s cluster configuration
 */
export interface K3sClusterConfig {
    /** k3s release channel (e.g., 'v1.31') */
    readonly channel: string;
    /** Whether to install Traefik ingress controller (built-in to k3s) */
    readonly enableTraefik: boolean;
    /** k3s data directory (should be on persistent storage) */
    readonly dataDir: string;
}

/**
 * EC2 compute configuration for k3s node
 */
export interface K8sComputeConfig {
    /** EC2 instance type */
    readonly instanceType: ec2.InstanceType;
    /** Whether to enable detailed CloudWatch monitoring */
    readonly detailedMonitoring: boolean;
    /** Whether to use CloudFormation signals for ASG */
    readonly useSignals: boolean;
    /** Timeout for CloudFormation signals in minutes */
    readonly signalsTimeoutMinutes: number;
}

/**
 * Storage configuration for k3s data (EBS volume)
 */
export interface K8sStorageConfig {
    /** EBS volume size in GB */
    readonly volumeSizeGb: number;
    /** EBS mount point on the instance */
    readonly mountPoint: string;
}

/**
 * Networking configuration
 */
export interface K8sNetworkingConfig {
    /** Whether to allocate an Elastic IP for stable CloudFront origin */
    readonly useElasticIp: boolean;
    /** Security group: SSM-only access (no SSH) */
    readonly ssmOnlyAccess: boolean;
}

/**
 * Complete resource configurations for k3s/Kubernetes project
 */
export interface K8sConfigs {
    readonly cluster: K3sClusterConfig;
    readonly compute: K8sComputeConfig;
    readonly storage: K8sStorageConfig;
    readonly networking: K8sNetworkingConfig;
    readonly logRetention: logs.RetentionDays;
    readonly isProduction: boolean;
    readonly removalPolicy: cdk.RemovalPolicy;
    readonly createKmsKeys: boolean;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * k8s resource configurations by environment
 */
export const K8S_CONFIGS: Record<Environment, K8sConfigs> = {
    [Environment.DEVELOPMENT]: {
        cluster: {
            channel: K3S_DEFAULT_CHANNEL,
            enableTraefik: true,
            dataDir: '/data/k3s',
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 15,
        },
        storage: {
            volumeSizeGb: 30,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.STAGING]: {
        cluster: {
            channel: K3S_DEFAULT_CHANNEL,
            enableTraefik: true,
            dataDir: '/data/k3s',
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 15,
        },
        storage: {
            volumeSizeGb: 40,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        cluster: {
            channel: K3S_DEFAULT_CHANNEL,
            enableTraefik: true,
            dataDir: '/data/k3s',
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 15,
        },
        storage: {
            volumeSizeGb: 50,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get k8s configurations for an environment
 */
export function getK8sConfigs(env: Environment): K8sConfigs {
    return K8S_CONFIGS[env];
}
