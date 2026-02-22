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
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

/**
 * Read a value from process.env at synth time.
 * Returns undefined if the variable is not set.
 */
function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

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
 * Golden AMI configuration (EC2 Image Builder)
 *
 * Controls the AMI baking pipeline that pre-installs Docker, AWS CLI,
 * k3s binary, and Calico manifests to reduce instance boot time.
 */
export interface K8sImageConfig {
    /** SSM parameter path storing the latest Golden AMI ID */
    readonly amiSsmPath: string;
    /** Whether to create the Image Builder pipeline (first run bootstraps) */
    readonly enableImageBuilder: boolean;
    /** Parent image for Image Builder (base Amazon Linux 2023 AMI) */
    readonly parentImageSsmPath: string;
    /** Software versions to bake into the AMI */
    readonly bakedVersions: {
        readonly dockerCompose: string;
        readonly awsCli: string;
        readonly k3sBinary: string;
    };
}

/**
 * SSM State Manager configuration
 *
 * Controls post-boot configuration management via SSM associations.
 * State Manager handles tasks like k3s bootstrap, CNI installation,
 * manifest deployment, and drift remediation.
 */
export interface K8sSsmConfig {
    /** Whether to create SSM State Manager associations */
    readonly enableStateManager: boolean;
    /** Association schedule (rate expression, e.g., 'rate(30 minutes)') */
    readonly associationSchedule: string;
    /** Maximum concurrent targets for association execution */
    readonly maxConcurrency: string;
    /** Maximum allowed errors before stopping */
    readonly maxErrors: string;
}

export interface K8sEdgeConfig {
    // Synth-time context — DNS/Edge (env var > hardcoded default)
    /** Domain name for monitoring CloudFront distribution */
    readonly domainName?: string;
    /** Route53 Hosted Zone ID for DNS validation and alias records */
    readonly hostedZoneId?: string;
    /** Cross-account IAM role ARN for Route53 access */
    readonly crossAccountRoleArn?: string;

    // WAF configuration
    /** WAF rate limit per IP per 5 minutes @default 2000 */
    readonly rateLimitPerIp: number;
    /** Enable WAF rate limiting @default true */
    readonly enableRateLimiting: boolean;
    /** Enable IP reputation list @default true */
    readonly enableIpReputationList: boolean;
}

/**
 * Complete resource configurations for k3s/Kubernetes project
 */
export interface K8sConfigs {
    readonly cluster: K3sClusterConfig;
    readonly compute: K8sComputeConfig;
    readonly storage: K8sStorageConfig;
    readonly networking: K8sNetworkingConfig;
    readonly image: K8sImageConfig;
    readonly ssm: K8sSsmConfig;
    readonly edge: K8sEdgeConfig;
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
        image: {
            amiSsmPath: '/k8s/development/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                k3sBinary: K3S_DEFAULT_CHANNEL,
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            // Synth-time context — Edge (env var > hardcoded default)
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.dev.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            // WAF
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
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
        image: {
            amiSsmPath: '/k8s/staging/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                k3sBinary: K3S_DEFAULT_CHANNEL,
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.staging.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
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
        image: {
            amiSsmPath: '/k8s/production/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                k3sBinary: K3S_DEFAULT_CHANNEL,
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
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
