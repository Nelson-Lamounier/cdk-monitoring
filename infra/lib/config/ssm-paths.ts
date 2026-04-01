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

import { Environment, shortEnv } from './environments';

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
        /** CloudFront distribution ID (for cache invalidation) */
        readonly distributionId: string;
    };

    // --- Authentication (Cognito + NextAuth.js) ---
    readonly auth: {
        /** Cognito User Pool ID */
        readonly cognitoUserPoolId: string;
        /** Cognito User Pool Client ID */
        readonly cognitoClientId: string;
        /** Cognito OIDC Issuer URL */
        readonly cognitoIssuerUrl: string;
        /** Cognito Hosted UI domain */
        readonly cognitoDomain: string;
        /** NextAuth.js JWT signing secret */
        readonly nextauthSecret: string;
        /** NextAuth.js base URL (e.g., https://nelsonlamounier.com) */
        readonly nextauthUrl: string;
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
            distributionId: `${prefix}/cloudfront/distribution-id`,
        },

        // Authentication (Cognito + NextAuth.js)
        auth: {
            cognitoUserPoolId: `${prefix}/auth/cognito-user-pool-id`,
            cognitoClientId: `${prefix}/auth/cognito-client-id`,
            cognitoIssuerUrl: `${prefix}/auth/cognito-issuer-url`,
            cognitoDomain: `${prefix}/auth/cognito-domain`,
            nextauthSecret: `${prefix}/auth/nextauth-secret`,
            nextauthUrl: `${prefix}/auth/nextauth-url`,
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
// ADMIN SSM PATHS (account-level operational settings)
// =============================================================================

/**
 * SSM parameter paths for admin-level operational settings.
 *
 * These are account-level parameters (not project-scoped) that control
 * operational access like admin IP allowlists.
 */
export interface AdminSsmPaths {
    /** Comma-separated admin IP CIDRs (both IPv4 and IPv6 supported) */
    readonly allowedIps: string;
}

/**
 * Get admin SSM parameter paths.
 *
 * Admin IPs are stored as a single comma-separated parameter.
 * IPv4 and IPv6 can be mixed — the consumer auto-detects by checking
 * for `:` (IPv6) vs `.` (IPv4).
 *
 * Seed with:
 * ```bash
 * aws ssm put-parameter \
 *   --name "/admin/allowed-ips" \
 *   --value "203.0.113.42/32,2001:db8::/128" \
 *   --type String
 * ```
 */
export function adminSsmPaths(): AdminSsmPaths {
    return {
        allowedIps: '/admin/allowed-ips',
    };
}

// =============================================================================
// K8S (kubeadm) SSM PATHS
// =============================================================================

/** k8s SSM prefix: /k8s/{environment} */
export function k8sSsmPrefix(environment: Environment): string {
    return `/k8s/${environment}`;
}

/**
 * SSM parameter paths for the kubeadm Kubernetes cluster.
 *
 * Complete set of paths published by KubernetesBaseStack.
 * Consumer stacks use these for cross-stack discovery without
 * CloudFormation exports.
 */
export interface K8sSsmPaths {
    /** The prefix itself: /k8s/{environment} */
    readonly prefix: string;

    // --- Networking ---
    /** Shared VPC ID */
    readonly vpcId: string;
    /** Elastic IP address (CloudFront origin) */
    readonly elasticIp: string;
    /** EIP allocation ID (for automatic association during bootstrap) */
    readonly elasticIpAllocationId: string;

    // --- Security Groups ---
    /** Cluster base security group ID (intra-cluster communication) */
    readonly securityGroupId: string;
    /** Control plane security group ID (API server access) */
    readonly controlPlaneSgId: string;
    /** Ingress security group ID (Traefik HTTP/HTTPS) */
    readonly ingressSgId: string;
    /** Monitoring security group ID (Prometheus/Loki/Tempo) */
    readonly monitoringSgId: string;

    // --- Storage ---
    /** S3 bucket name for k8s scripts and manifests */
    readonly scriptsBucket: string;

    // --- DNS ---
    /** Route 53 private hosted zone ID */
    readonly hostedZoneId: string;
    /** Stable DNS name for the K8s API server */
    readonly apiDnsName: string;

    // --- Encryption ---
    /** KMS key ARN for CloudWatch log group encryption */
    readonly kmsKeyArn: string;

    // --- NLB (Network Load Balancer) ---
    /** NLB full name (for CloudWatch metrics) */
    readonly nlbFullName: string;
    /** NLB HTTP (port 80) target group ARN */
    readonly nlbHttpTargetGroupArn: string;
    /** NLB HTTPS (port 443) target group ARN */
    readonly nlbHttpsTargetGroupArn: string;

    // --- Compute (published by ControlPlane stack at runtime) ---
    /** Kubernetes node EC2 instance ID */
    readonly instanceId: string;

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

        // Networking
        vpcId: `${prefix}/vpc-id`,
        elasticIp: `${prefix}/elastic-ip`,
        elasticIpAllocationId: `${prefix}/elastic-ip-allocation-id`,

        // Security Groups
        securityGroupId: `${prefix}/security-group-id`,
        controlPlaneSgId: `${prefix}/control-plane-sg-id`,
        ingressSgId: `${prefix}/ingress-sg-id`,
        monitoringSgId: `${prefix}/monitoring-sg-id`,

        // Storage
        scriptsBucket: `${prefix}/scripts-bucket`,

        // DNS
        hostedZoneId: `${prefix}/hosted-zone-id`,
        apiDnsName: `${prefix}/api-dns-name`,

        // Encryption
        kmsKeyArn: `${prefix}/kms-key-arn`,

        // NLB
        nlbFullName: `${prefix}/nlb-full-name`,
        nlbHttpTargetGroupArn: `${prefix}/nlb-http-target-group-arn`,
        nlbHttpsTargetGroupArn: `${prefix}/nlb-https-target-group-arn`,

        // Compute (published by ControlPlane stack)
        instanceId: `${prefix}/instance-id`,

        // IAM
        wildcard: `${prefix}/*`,
    };
}

// =============================================================================
// BEDROCK SSM PATHS
// =============================================================================

/**
 * Bedrock SSM prefix: /bedrock-{env}
 *
 * Uses the `flatName` convention (e.g. `bedrock-dev`) to match
 * the `namePrefix` used by the Bedrock stacks when publishing
 * SSM parameters. This aligns with `flatName('bedrock', '', environment)`.
 */
export function bedrockSsmPrefix(environment: Environment): string {
    return `/bedrock-${shortEnv(environment)}`;
}

/**
 * SSM parameter paths for the Bedrock Agent stack.
 */
export interface BedrockSsmPaths {
    /** The prefix itself: /bedrock-{env} */
    readonly prefix: string;
    /** Bedrock Agent ID */
    readonly agentId: string;
    /** Bedrock Agent ARN */
    readonly agentArn: string;
    /** Bedrock Agent Alias ID */
    readonly agentAliasId: string;
    /** API Gateway URL */
    readonly apiUrl: string;
    /** S3 data bucket name (for Knowledge Base documents) */
    readonly dataBucketName: string;
    /** S3 assets bucket name (for draft uploads and published articles) */
    readonly assetsBucketName: string;
    /** AI Content DynamoDB table name (articles, metadata) */
    readonly contentTableName: string;
    /** AI Content DynamoDB table ARN */
    readonly contentTableArn: string;
    /**
     * Shared secret for on-demand ISR cache revalidation.
     *
     * Used by the Publisher Lambda to call POST /api/revalidate on the
     * Next.js pod after publishing an article, triggering immediate
     * cache purge for the articles listing and detail pages.
     *
     * @remarks
     * Created manually via CLI (not CDK-managed):
     * ```bash
     * aws ssm put-parameter \
     *   --name "/bedrock-dev/revalidation-secret" \
     *   --value "$(openssl rand -base64 32)" \
     *   --type SecureString
     * ```
     */
    readonly revalidationSecret: string;
    /** Wildcard path for IAM: /bedrock-{env}/* */
    readonly wildcard: string;
}

/**
 * Get Bedrock SSM parameter paths for a given environment.
 */
export function bedrockSsmPaths(environment: Environment): BedrockSsmPaths {
    const prefix = bedrockSsmPrefix(environment);

    return {
        prefix,
        agentId: `${prefix}/agent-id`,
        agentArn: `${prefix}/agent-arn`,
        agentAliasId: `${prefix}/agent-alias-id`,
        apiUrl: `${prefix}/api-url`,
        dataBucketName: `${prefix}/data-bucket-name`,
        assetsBucketName: `${prefix}/assets-bucket-name`,
        contentTableName: `${prefix}/content-table-name`,
        contentTableArn: `${prefix}/content-table-arn`,
        revalidationSecret: `${prefix}/revalidation-secret`,
        wildcard: `${prefix}/*`,
    };
}

// =============================================================================
// SELF-HEALING SSM PATHS
// =============================================================================

/**
 * Self-Healing SSM prefix: /self-healing-{env}/
 *
 * Uses the `flatName` convention (e.g. `self-healing-dev`) to match
 * the `namePrefix` used by the Gateway and Agent stacks when publishing
 * SSM parameters.
 */
export function selfHealingSsmPrefix(environment: Environment): string {
    return `/self-healing-${shortEnv(environment)}`;
}

/**
 * SSM parameter paths for the Self-Healing pipeline.
 *
 * Published by GatewayStack and AgentStack for cross-stack discovery.
 */
export interface SelfHealingSsmPaths {
    /** The prefix itself: /self-healing-{env} */
    readonly prefix: string;

    // --- Gateway (published by GatewayStack) ---
    /** AgentCore Gateway endpoint URL */
    readonly gatewayUrl: string;
    /** AgentCore Gateway ID */
    readonly gatewayId: string;

    // --- Agent (published by AgentStack) ---
    /** Strands Agent Lambda function ARN */
    readonly agentLambdaArn: string;
    /** Strands Agent Lambda function name */
    readonly agentLambdaName: string;
    /** Agent Dead Letter Queue URL */
    readonly agentDlqUrl: string;

    /** Wildcard path for IAM: /self-healing-{env}/* */
    readonly wildcard: string;
}

/**
 * Get Self-Healing SSM parameter paths for a given environment.
 */
export function selfHealingSsmPaths(environment: Environment): SelfHealingSsmPaths {
    const prefix = selfHealingSsmPrefix(environment);

    return {
        prefix,
        gatewayUrl: `${prefix}/gateway-url`,
        gatewayId: `${prefix}/gateway-id`,
        agentLambdaArn: `${prefix}/agent-lambda-arn`,
        agentLambdaName: `${prefix}/agent-lambda-name`,
        agentDlqUrl: `${prefix}/agent-dlq-url`,
        wildcard: `${prefix}/*`,
    };
}

