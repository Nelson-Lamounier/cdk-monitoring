/**
 * @format
 * Centralized SSM Parameter Path Patterns
 *
 * Single source of truth for all SSM parameter paths used across stacks.
 * Eliminates scattered inline string concatenation and naming convention mismatches.
 *
 * Path Conventions:
 * - Next.js app resources:   /{namePrefix}/{environment}/...
 * - Shared ECR:              /shared/ecr/{environment}/...
 * - Shared VPC:              /shared/vpc/{environment}/...
 * - Monitoring:              /monitoring-{environment}/...
 * - Monitoring EBS:          /monitoring/ebs/...
 *
 * @example
 * ```typescript
 * import { nextjsSsmPaths, sharedEcrPaths } from '../../config/ssm-paths';
 *
 * const paths = nextjsSsmPaths('development');
 * paths.ecs.serviceName  // → '/nextjs/development/ecs/service-name'
 * paths.dynamodbTableName // → '/nextjs/development/dynamodb-table-name'
 *
 * const ecr = sharedEcrPaths('development');
 * ecr.repositoryArn      // → '/shared/ecr/development/repository-arn'
 * ```
 */

import { Environment } from './environments';

// =============================================================================
// PREFIX BUILDERS
// =============================================================================

/** Default name prefix for Next.js project */
const DEFAULT_NAME_PREFIX = 'nextjs';

/**
 * Next.js app-level SSM prefix: /{namePrefix}/{environment}
 */
export function nextjsSsmPrefix(
    environment: Environment,
    namePrefix: string = DEFAULT_NAME_PREFIX,
): string {
    return `/${namePrefix}/${environment}`;
}

/**
 * Shared ECR SSM prefix: /shared/ecr/{environment}
 */
export function sharedEcrPrefix(environment: Environment): string {
    return `/shared/ecr/${environment}`;
}

/**
 * Shared VPC SSM prefix: /shared/vpc/{environment}
 */
export function sharedVpcPrefix(environment: Environment): string {
    return `/shared/vpc/${environment}`;
}

/**
 * Monitoring stack SSM prefix: /monitoring-{environment}
 */
export function monitoringSsmPrefix(environment: Environment): string {
    return `/monitoring-${environment}`;
}

// =============================================================================
// NEXT.JS SSM PATHS
// =============================================================================

/**
 * All SSM parameter paths for the Next.js application stacks.
 */
export interface NextjsSsmPaths {
    /** The prefix itself: /{namePrefix}/{environment} */
    readonly prefix: string;

    // --- Data Stack resources ---
    /** DynamoDB table name parameter */
    readonly dynamodbTableName: string;
    /** DynamoDB KMS key ARN (customer-managed, production only) */
    readonly dynamodbKmsKeyArn: string;
    /** S3 assets bucket name parameter */
    readonly assetsBucketName: string;
    /** API Gateway URL parameter */
    readonly apiGatewayUrl: string;
    /** AWS region parameter */
    readonly awsRegion: string;
    /** ALB DNS name parameter */
    readonly albDnsName: string;
    /** Task security group ID parameter */
    readonly taskSecurityGroupId: string;

    // --- ECS (from Compute & Application stacks) ---
    readonly ecs: {
        /** ECS cluster name */
        readonly clusterName: string;
        /** ECS cluster ARN */
        readonly clusterArn: string;
        /** ECS service name */
        readonly serviceName: string;
        /** ECS service ARN */
        readonly serviceArn: string;
    };

    // --- Cloud Map (from Compute Stack) ---
    readonly cloudmap: {
        /** Cloud Map namespace name */
        readonly namespaceName: string;
    };

    // --- Edge / CloudFront (from Edge Stack) ---
    readonly acmCertificateArn: string;
    readonly cloudfront: {
        /** WAF Web ACL ARN */
        readonly wafArn: string;
        /** CloudFront distribution domain name */
        readonly distributionDomain: string;
    };

    // --- Wildcard for IAM policy grants ---
    /** Wildcard path for IAM: /{namePrefix}/{environment}/* */
    readonly wildcard: string;
}

/**
 * Get all Next.js SSM parameter paths for a given environment.
 *
 * @param environment - Target deployment environment
 * @param namePrefix - Project name prefix (default: 'nextjs')
 */
export function nextjsSsmPaths(
    environment: Environment,
    namePrefix: string = DEFAULT_NAME_PREFIX,
): NextjsSsmPaths {
    const prefix = nextjsSsmPrefix(environment, namePrefix);

    return {
        prefix,

        // Data Stack resources
        dynamodbTableName: `${prefix}/dynamodb-table-name`,
        dynamodbKmsKeyArn: `${prefix}/dynamodb-kms-key-arn`,
        assetsBucketName: `${prefix}/assets-bucket-name`,
        apiGatewayUrl: `${prefix}/api-gateway-url`,
        awsRegion: `${prefix}/aws-region`,
        albDnsName: `${prefix}/alb-dns-name`,
        taskSecurityGroupId: `${prefix}/task-security-group-id`,

        // ECS
        ecs: {
            clusterName: `${prefix}/ecs/cluster-name`,
            clusterArn: `${prefix}/ecs/cluster-arn`,
            serviceName: `${prefix}/ecs/service-name`,
            serviceArn: `${prefix}/ecs/service-arn`,
        },

        // Cloud Map
        cloudmap: {
            namespaceName: `${prefix}/cloudmap/namespace-name`,
        },

        // Edge / CloudFront
        acmCertificateArn: `${prefix}/acm-certificate-arn`,
        cloudfront: {
            wafArn: `${prefix}/cloudfront/waf-arn`,
            distributionDomain: `${prefix}/cloudfront/distribution-domain`,
        },

        // Wildcard
        wildcard: `${prefix}/*`,
    };
}

// =============================================================================
// SHARED ECR SSM PATHS
// =============================================================================

/**
 * SSM parameter paths for the shared ECR repository.
 */
export interface SharedEcrSsmPaths {
    /** The prefix itself: /shared/ecr/{environment} */
    readonly prefix: string;
    /** ECR repository URI */
    readonly repositoryUri: string;
    /** ECR repository ARN */
    readonly repositoryArn: string;
    /** ECR repository name */
    readonly repositoryName: string;
}

/**
 * Get shared ECR SSM parameter paths for a given environment.
 */
export function sharedEcrPaths(environment: Environment): SharedEcrSsmPaths {
    const prefix = sharedEcrPrefix(environment);

    return {
        prefix,
        repositoryUri: `${prefix}/repository-uri`,
        repositoryArn: `${prefix}/repository-arn`,
        repositoryName: `${prefix}/repository-name`,
    };
}

// =============================================================================
// SHARED VPC SSM PATHS (for future migration of vpc-stack.ts)
// =============================================================================

/**
 * SSM parameter paths for the shared VPC.
 */
export interface SharedVpcSsmPaths {
    /** The prefix itself: /shared/vpc/{environment} */
    readonly prefix: string;
    /** VPC ID */
    readonly vpcId: string;
    /** VPC CIDR block */
    readonly vpcCidr: string;
    /** All public subnet IDs (comma-separated) */
    readonly publicSubnetIds: string;
    /** Availability zones (comma-separated) */
    readonly availabilityZones: string;
}

/**
 * Get shared VPC SSM parameter paths for a given environment.
 */
export function sharedVpcPaths(environment: Environment): SharedVpcSsmPaths {
    const prefix = sharedVpcPrefix(environment);

    return {
        prefix,
        vpcId: `${prefix}/vpc-id`,
        vpcCidr: `${prefix}/vpc-cidr`,
        publicSubnetIds: `${prefix}/public-subnet-ids`,
        availabilityZones: `${prefix}/availability-zones`,
    };
}

// =============================================================================
// MONITORING SSM PATHS (for future migration of monitoring stacks)
// =============================================================================

/**
 * SSM parameter paths for the monitoring stack.
 */
export interface MonitoringSsmPaths {
    /** The prefix itself: /monitoring-{environment} */
    readonly prefix: string;
    /** Monitoring instance security group ID */
    readonly securityGroupId: string;
    /** Loki push endpoint */
    readonly lokiEndpoint: string;
    /** Tempo OTLP endpoint */
    readonly tempoEndpoint: string;
}

/**
 * Get monitoring SSM parameter paths for a given environment.
 */
export function monitoringSsmPaths(environment: Environment): MonitoringSsmPaths {
    const prefix = monitoringSsmPrefix(environment);

    return {
        prefix,
        securityGroupId: `${prefix}/security-group/id`,
        lokiEndpoint: `${prefix}/loki/endpoint`,
        tempoEndpoint: `${prefix}/tempo/endpoint`,
    };
}

// =============================================================================
// K8S (k3s) SSM PATHS
// =============================================================================

/** k8s SSM prefix: /k8s/{environment} */
export function k8sSsmPrefix(environment: Environment): string {
    return `/k8s/${environment}`;
}

/**
 * SSM parameter paths for the k3s Kubernetes cluster.
 */
export interface K8sSsmPaths {
    /** The prefix itself: /k8s/{environment} */
    readonly prefix: string;
    /** k3s node EC2 instance ID */
    readonly instanceId: string;
    /** Elastic IP address for stable CloudFront origin */
    readonly elasticIp: string;
    /** Security group ID for the k3s node */
    readonly securityGroupId: string;

    /** Wildcard path for IAM: /k8s/{environment}/* */
    readonly wildcard: string;
}

/**
 * Get k8s SSM parameter paths for a given environment.
 */
export function k8sSsmPaths(environment: Environment): K8sSsmPaths {
    const prefix = k8sSsmPrefix(environment);

    return {
        prefix,
        instanceId: `${prefix}/instance-id`,
        elasticIp: `${prefix}/elastic-ip`,
        securityGroupId: `${prefix}/security-group-id`,
        wildcard: `${prefix}/*`,
    };
}

