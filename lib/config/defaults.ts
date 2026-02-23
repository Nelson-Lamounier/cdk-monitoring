/**
 * @format
 * Default Configuration Values
 *
 * Centralized defaults extracted from stack implementations.
 * Uses UPPER_CASE for global constants as per AWS CDK best practices.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';

// =============================================================================
// Global Constants - Immutable compile-time values
// =============================================================================

/** Default AWS region if not specified */
export const DEFAULT_REGION = 'eu-west-1';

/** Default VPC CIDR block */
export const DEFAULT_VPC_CIDR = '10.0.0.0/16';

/** Maximum availability zones for cost optimization */
export const MAX_AZS = 2;

/** Default EBS/EC2 volume size in GB */
export const DEFAULT_VOLUME_SIZE_GB = 30;

/** GP3 baseline IOPS */
export const GP3_BASELINE_IOPS = 3000;

/** GP3 baseline throughput in MiB/s */
export const GP3_BASELINE_THROUGHPUT = 125;

/** SSH port */
export const SSH_PORT = 22;

/** Grafana default port */
export const GRAFANA_PORT = 3000;

/** Prometheus default port */
export const PROMETHEUS_PORT = 9090;

/** Node Exporter default port */
export const NODE_EXPORTER_PORT = 9100;

/** Loki push API NodePort (k8s → host, cross-stack access from ECS) */
export const LOKI_NODEPORT = 30100;

/** Tempo OTLP gRPC NodePort (k8s → host, cross-stack access from ECS) */
export const TEMPO_NODEPORT = 30417;

// =============================================================================
// Configuration Objects - Grouped defaults using the constants above
// =============================================================================

/**
 * VPC defaults
 */
export const VPC_DEFAULTS = {
    /** Default CIDR block */
    cidr: DEFAULT_VPC_CIDR,
    /** Maximum availability zones */
    maxAzs: MAX_AZS,
    /** NAT gateways (0 for cost optimization) */
    natGateways: 0,
    /** Flow log retention */
    flowLogRetention: logs.RetentionDays.ONE_MONTH,
} as const;



/**
 * EBS defaults
 */
export const EBS_DEFAULTS = {
    /** Default size in GB */
    sizeGb: DEFAULT_VOLUME_SIZE_GB,
    /** Default volume type */
    volumeType: ec2.EbsDeviceVolumeType.GP3,
    /** GP3 IOPS */
    iops: GP3_BASELINE_IOPS,
    /** GP3 throughput in MiB/s */
    throughput: GP3_BASELINE_THROUGHPUT,
} as const;

/**
 * Monitoring ports
 */
export const MONITORING_PORTS = {
    grafana: GRAFANA_PORT,
    prometheus: PROMETHEUS_PORT,
    nodeExporter: NODE_EXPORTER_PORT,
    ssh: SSH_PORT,
} as const;

// =============================================================================
// Kubernetes Constants
// =============================================================================

/** Kubernetes API server port (standard for kubeadm) */
export const K8S_API_PORT = 6443;

/** Kubernetes version for kubeadm installation */
export const KUBERNETES_VERSION = '1.35.1';

/** Traefik HTTP port (k3s built-in ingress) */
export const TRAEFIK_HTTP_PORT = 80;

/** Traefik HTTPS port (k3s built-in ingress) */
export const TRAEFIK_HTTPS_PORT = 443;

/**
 * Tag used by DLM, EBS volumes, and EC2 instances for consistent identification.
 * DLM snapshot policies target volumes with this tag — all three locations
 * must stay in sync or backups silently stop.
 */
export const MONITORING_APP_TAG = {
    key: 'Application',
    value: 'Prometheus-Grafana',
} as const;

/**
 * Docker image versions
 */
export const DOCKER_VERSIONS = {
    prometheus: 'v3.9.1',
    grafana: '12.3.0',
    nodeExporter: 'v1.8.2',
    dockerCompose: 'v2.24.0',
    promtail: '3.0.0',
    alloy: 'v1.5.1',
} as const;

/**
 * Tags applied to monitoring resources
 */
export const DEFAULT_TAGS = {
    Purpose: 'Monitoring',
    Application: 'Prometheus-Grafana',
} as const;

/**
 * Log retention defaults by environment
 */
export const LOG_RETENTION = {
    dev: logs.RetentionDays.ONE_WEEK,
    staging: logs.RetentionDays.ONE_MONTH,
    prod: logs.RetentionDays.THREE_MONTHS,
} as const;




/**
 * ECS cluster capacity type
 */
export enum EcsCapacityType {
    /** Fargate only (serverless) */
    FARGATE = 'FARGATE',
    /** EC2 only (self-managed instances) */
    EC2 = 'EC2',
    /** Both Fargate and EC2 */
    HYBRID = 'HYBRID',
}

// =============================================================================
// Networking Defaults
// =============================================================================



// =============================================================================
// ECS Defaults
// =============================================================================

/**
 * ECS launch type for task definitions
 */
export enum EcsLaunchType {
    /** Fargate (serverless) */
    FARGATE = 'FARGATE',
    /** EC2 (self-managed instances) */
    EC2 = 'EC2',
}

// =============================================================================
// S3 Defaults (Global - non-environment-specific)
// =============================================================================

/**
 * S3 incomplete multipart upload expiration in days
 */
export const S3_INCOMPLETE_UPLOAD_EXPIRATION_DAYS = 7;

/**
 * S3 CORS configuration (global defaults)
 */
export const S3_CORS_DEFAULTS = {
    /** Max age for CORS preflight cache in seconds */
    maxAgeSeconds: 3000,
    /** Allowed headers */
    allowedHeaders: ['*'],
} as const;

/**
 * S3 storage class transition delay in days (0 = immediate)
 */
export const S3_STORAGE_TRANSITION_DAYS = 0;

// =============================================================================
// DynamoDB Defaults (Global - non-environment-specific)
// =============================================================================

/** GSI for querying by status/date (articles) or listing entities (email subscriptions) */
export const PORTFOLIO_GSI1_NAME = 'gsi1-status-date';

/** GSI for querying articles by tag */
export const PORTFOLIO_GSI2_NAME = 'gsi2-tag-date';
