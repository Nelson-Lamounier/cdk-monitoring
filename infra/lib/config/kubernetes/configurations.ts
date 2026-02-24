/**
 * @format
 * Kubernetes (kubeadm) Project - Resource Configurations
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
    KUBERNETES_VERSION,
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
 * Kubernetes cluster configuration (kubeadm)
 */
export interface KubernetesClusterConfig {
    /** Kubernetes version (e.g., '1.32.0') */
    readonly kubernetesVersion: string;
    /** Pod network CIDR for Calico CNI @default '192.168.0.0/16' */
    readonly podNetworkCidr: string;
    /** Service subnet CIDR @default '10.96.0.0/12' */
    readonly serviceSubnet: string;
    /** Kubernetes data directory (should be on persistent storage) */
    readonly dataDir: string;
    /** Number of worker nodes @default 1 */
    readonly workerCount: number;
}

/**
 * EC2 compute configuration for Kubernetes nodes
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
 * Storage configuration for Kubernetes data (EBS volume)
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
 * kubeadm toolchain, and Calico manifests to reduce instance boot time.
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
        /** kubeadm/kubelet/kubectl version (matches kubernetesVersion) */
        readonly kubeadm: string;
        /** Container runtime version (tightly coupled to k8s release) */
        readonly containerd: string;
        /** OCI runtime version */
        readonly runc: string;
        /** CNI plugins version */
        readonly cniPlugins: string;
        /** CRI tools version (crictl — should match k8s minor version) */
        readonly crictl: string;
        /** Calico CNI version (with 'v' prefix, e.g. 'v3.29.3') */
        readonly calico: string;
    };
}

/**
 * SSM State Manager configuration
 *
 * Controls post-boot configuration management via SSM associations.
 * State Manager handles tasks like kubeadm bootstrap, CNI installation,
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
 * Complete resource configurations for kubeadm Kubernetes project
 */
export interface K8sConfigs {
    readonly cluster: KubernetesClusterConfig;
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
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 1,
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
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
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
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 1,
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
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
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
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 1,
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
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
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
