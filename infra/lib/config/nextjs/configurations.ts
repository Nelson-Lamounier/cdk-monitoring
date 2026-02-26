/**
 * @format
 * NextJS Project - Resource Configurations
 *
 * Centralized resource configurations (throttles, timeouts, CORS) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getNextJsConfigs } from '../../config/nextjs';
 * const configs = getNextJsConfigs(Environment.PRODUCTION);
 * const throttle = configs.apiGateway.throttle; // { rateLimit: 1000, burstLimit: 2000 }
 * ```
 */

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

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
 * API Gateway throttling configuration
 */
export interface ThrottleConfig {
    readonly rateLimit: number;
    readonly burstLimit: number;
}

/**
 * CORS configuration
 */
export interface CorsConfig {
    readonly allowOrigins: readonly string[];
    readonly allowMethods: readonly string[];
    readonly allowHeaders: readonly string[];
    readonly allowCredentials: boolean;
    readonly maxAge: cdk.Duration;
}

/**
 * API Gateway configuration
 */
export interface ApiGatewayConfig {
    readonly throttle: ThrottleConfig;
    readonly stageName: string;
    readonly enableTracing: boolean;
    readonly enableDetailedMetrics: boolean;
    /** Enable KMS encryption for access logs */
    readonly enableLogEncryption: boolean;
}

/**
 * Lambda configuration
 */
export interface LambdaConfig {
    readonly timeout: cdk.Duration;
    readonly logLevel: string;
    readonly logRetention: logs.RetentionDays;
}

/**
 * DLQ configuration
 */
export interface DlqConfig {
    readonly retentionPeriod: cdk.Duration;
}

/**
 * ALB configuration
 */
export interface AlbConfig {
    readonly deletionProtection: boolean;
    readonly accessLogsEnabled: boolean;
}

/**
 * S3 configuration
 */
export interface S3Config {
    readonly versionExpirationDays: number;
    readonly enableIntelligentTiering: boolean;
    readonly corsOrigins: readonly string[];
}

/**
 * CloudFront cache TTL configuration
 */
export interface CacheTtlConfig {
    readonly default: cdk.Duration;
    readonly max: cdk.Duration;
    readonly min: cdk.Duration;
}

/**
 * CloudFront origin timeout configuration
 */
export interface OriginTimeoutConfig {
    readonly connectionAttempts: number;
    readonly connectionTimeout: cdk.Duration;
    readonly readTimeout: cdk.Duration;
    readonly keepaliveTimeout: cdk.Duration;
}

/**
 * CloudFront configuration
 */
export interface CloudFrontConfig {
    readonly priceClass: cloudfront.PriceClass;
    readonly minimumProtocolVersion: cloudfront.SecurityPolicyProtocol;
    readonly httpVersion: cloudfront.HttpVersion;
    readonly loggingEnabled: boolean;
    readonly staticAssetsTtl: CacheTtlConfig;
    readonly dynamicContentTtl: CacheTtlConfig;
    readonly noCacheTtl: CacheTtlConfig;
    readonly albOriginTimeouts: OriginTimeoutConfig;
    readonly errorResponseTtl: cdk.Duration;
    readonly cacheHeaders: {
        readonly dynamic: readonly string[];
        readonly api: readonly string[];
    };
    readonly originRequestHeaders: readonly string[];
}

/**
 * ECS deployment strategy configuration
 */
export interface DeploymentConfig {
    /** Minimum healthy percent during deployments */
    readonly minHealthyPercent: number;
    /** Maximum healthy percent during deployments */
    readonly maxHealthyPercent: number;
}

/**
 * Container health check timing configuration
 */
export interface HealthCheckConfig {
    /** Interval between health checks in seconds */
    readonly intervalSeconds: number;
    /** Timeout for each health check in seconds */
    readonly timeoutSeconds: number;
    /** Number of consecutive failures before marking unhealthy */
    readonly retries: number;
    /** Grace period before health checks begin in seconds */
    readonly startPeriodSeconds: number;
}

/**
 * CloudWatch alarm threshold configuration
 */
export interface AlarmsConfig {
    /** Enable alarms */
    readonly enabled: boolean;
    /** CPU utilization threshold (0-100) */
    readonly cpuThreshold: number;
    /** Memory utilization threshold (0-100) */
    readonly memoryThreshold: number;
}

/**
 * ECS Task Definition configuration
 */
export interface EcsTaskConfig {
    /** Log retention days */
    readonly logRetention: logs.RetentionDays;
    /** Enable KMS encryption for logs */
    readonly enableLogEncryption: boolean;
    /** Enable init process for zombie reaping (HIGH-5) */
    readonly initProcessEnabled: boolean;
    /** Drop all Linux capabilities (HIGH-4) */
    readonly dropAllCapabilities: boolean;
    /** Use removal policy RETAIN for logs */
    readonly retainLogs: boolean;
    /** Enable deployment circuit breaker with automatic rollback */
    readonly enableCircuitBreaker: boolean;
    /** Deployment strategy (min/max healthy percent) */
    readonly deployment: DeploymentConfig;
    /** Container health check timing */
    readonly healthCheck: HealthCheckConfig;
    /** CloudWatch alarm thresholds */
    readonly alarms: AlarmsConfig;
}

/**
 * Complete resource configurations for NextJS project
 */
export interface NextJsConfigs {
    // =========================================================================
    // Synth-time context — Edge/CloudFront
    // =========================================================================

    /** Domain name for CloudFront distribution */
    readonly domainName?: string;
    /** Route53 Hosted Zone ID for DNS validation and alias records */
    readonly hostedZoneId?: string;
    /** Cross-account IAM role ARN for Route53 access */
    readonly crossAccountRoleArn?: string;

    // =========================================================================
    // Synth-time context — Email/Secrets
    // =========================================================================

    /** Notification email for contact form submissions */
    readonly notificationEmail?: string;
    /** SES sender email address */
    readonly sesFromEmail?: string;
    /** Verification secret for email verification */
    readonly verificationSecret?: string;
    /** Base URL for email verification links */
    readonly verificationBaseUrl?: string;

    // =========================================================================
    // Resource behavior (policies, throttles, timeouts)
    // =========================================================================

    readonly apiGateway: ApiGatewayConfig;
    readonly lambda: LambdaConfig;
    readonly dlq: DlqConfig;
    readonly alb: AlbConfig;
    readonly s3: S3Config;
    readonly cors: CorsConfig;
    readonly cloudfront: CloudFrontConfig;
    readonly ecsTask: EcsTaskConfig;
    readonly isProduction: boolean;
    readonly removalPolicy: cdk.RemovalPolicy;
}

// =============================================================================
// CLOUDFRONT SHARED CONSTANTS
// =============================================================================

/**
 * CloudFront path patterns for Next.js
 */
export const CLOUDFRONT_PATH_PATTERNS = {
    nextjs: {
        static: '/_next/static/*',
        data: '/_next/data/*',
    },
    assets: {
        images: '/images/*',
        public: '/public/*',
    },
    api: '/api/*',
} as const;

/**
 * CloudFront error responses
 */
export const CLOUDFRONT_ERROR_RESPONSES = [
    { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html' },
    { httpStatus: 500, responseHttpStatus: 500, responsePagePath: '/500.html' },
] as const;

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * NextJS resource configurations by environment
 */
export const NEXTJS_CONFIGS: Record<Environment, NextJsConfigs> = {
    [Environment.DEVELOPMENT]: {
        // Synth-time context — Edge (env var > hardcoded default)
        domainName: fromEnv('DOMAIN_NAME') ?? 'dev.nelsonlamounier.com',
        hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
        crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),

        // Synth-time context — Email (env var at synth time)
        notificationEmail: fromEnv('NOTIFICATION_EMAIL'),
        sesFromEmail: fromEnv('SES_FROM_EMAIL'),
        verificationSecret: fromEnv('VERIFICATION_SECRET'),
        verificationBaseUrl: fromEnv('VERIFICATION_BASE_URL'),

        // Resource behavior
        apiGateway: {
            throttle: { rateLimit: 100, burstLimit: 200 },
            stageName: 'api',
            enableTracing: true,
            enableDetailedMetrics: false,
            enableLogEncryption: false,  // KMS encryption disabled in dev (cost)
        },
        lambda: {
            timeout: cdk.Duration.seconds(30),
            logLevel: 'DEBUG',
            logRetention: logs.RetentionDays.ONE_MONTH,  // Increased from ONE_WEEK
        },
        dlq: {
            retentionPeriod: cdk.Duration.days(7),
        },
        alb: {
            deletionProtection: false,
            accessLogsEnabled: false,
        },
        s3: {
            versionExpirationDays: 7,
            enableIntelligentTiering: false,
            // Removed wildcard - use specific preview URLs
            corsOrigins: ['http://localhost:3000'],
        },
        cors: {
            // Removed wildcard - use specific preview URLs or configure dynamically
            allowOrigins: ['http://localhost:3000'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
            allowCredentials: true,
            maxAge: cdk.Duration.hours(1),
        },
        cloudfront: {
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/Canada/Europe only
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            loggingEnabled: false,
            staticAssetsTtl: { default: cdk.Duration.days(365), max: cdk.Duration.days(365), min: cdk.Duration.days(1) },
            dynamicContentTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(300), min: cdk.Duration.seconds(0) },
            noCacheTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(0), min: cdk.Duration.seconds(0) },
            albOriginTimeouts: { connectionAttempts: 3, connectionTimeout: cdk.Duration.seconds(10), readTimeout: cdk.Duration.seconds(30), keepaliveTimeout: cdk.Duration.seconds(5) },
            errorResponseTtl: cdk.Duration.seconds(60),
            cacheHeaders: { dynamic: ['Accept', 'Accept-Language'], api: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type'] },
            originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-Desktop-Viewer', 'User-Agent'],
        },
        ecsTask: {
            logRetention: logs.RetentionDays.ONE_MONTH,
            enableLogEncryption: false,  // KMS disabled in dev for cost
            initProcessEnabled: true,    // Always enable for proper signal handling
            dropAllCapabilities: true,   // Always drop caps
            retainLogs: false,           // Can destroy in dev
            enableCircuitBreaker: false,  // Disabled in dev for faster iteration
            deployment: {
                minHealthyPercent: 0,    // t3.small ENI constraints — brief downtime ok
                maxHealthyPercent: 100,
            },
            healthCheck: {
                intervalSeconds: 30,
                timeoutSeconds: 5,
                retries: 3,
                startPeriodSeconds: 60,
            },
            alarms: {
                enabled: true,
                cpuThreshold: 80,
                memoryThreshold: 80,
            },
        },
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.STAGING]: {
        // Synth-time context — Edge (env var > hardcoded default)
        domainName: fromEnv('DOMAIN_NAME') ?? 'staging.nelsonlamounier.com',
        hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
        crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),

        // Synth-time context — Email (env var at synth time)
        notificationEmail: fromEnv('NOTIFICATION_EMAIL'),
        sesFromEmail: fromEnv('SES_FROM_EMAIL'),
        verificationSecret: fromEnv('VERIFICATION_SECRET'),
        verificationBaseUrl: fromEnv('VERIFICATION_BASE_URL'),

        // Resource behavior
        apiGateway: {
            throttle: { rateLimit: 500, burstLimit: 1000 },
            stageName: 'api',
            enableTracing: true,
            enableDetailedMetrics: true,
            enableLogEncryption: true,
        },
        lambda: {
            timeout: cdk.Duration.seconds(30),
            logLevel: 'INFO',
            logRetention: logs.RetentionDays.THREE_MONTHS,
        },
        dlq: {
            retentionPeriod: cdk.Duration.days(14),
        },
        alb: {
            deletionProtection: false,
            accessLogsEnabled: true,
        },
        s3: {
            versionExpirationDays: 30,
            enableIntelligentTiering: false,
            corsOrigins: ['https://staging.nelsonlamounier.com'],
        },
        cors: {
            allowOrigins: ['https://staging.nelsonlamounier.com'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
            allowCredentials: true,
            maxAge: cdk.Duration.hours(1),
        },
        cloudfront: {
            priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // US/Canada/Europe/Asia
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            loggingEnabled: true,
            staticAssetsTtl: { default: cdk.Duration.days(365), max: cdk.Duration.days(365), min: cdk.Duration.days(1) },
            dynamicContentTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(300), min: cdk.Duration.seconds(0) },
            noCacheTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(0), min: cdk.Duration.seconds(0) },
            albOriginTimeouts: { connectionAttempts: 3, connectionTimeout: cdk.Duration.seconds(10), readTimeout: cdk.Duration.seconds(30), keepaliveTimeout: cdk.Duration.seconds(5) },
            errorResponseTtl: cdk.Duration.seconds(60),
            cacheHeaders: { dynamic: ['Accept', 'Accept-Language'], api: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type'] },
            originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-Desktop-Viewer', 'User-Agent'],
        },
        ecsTask: {
            logRetention: logs.RetentionDays.THREE_MONTHS,
            enableLogEncryption: true,   // KMS enabled
            initProcessEnabled: true,    // Always enable for proper signal handling
            dropAllCapabilities: true,   // Always drop caps
            retainLogs: true,            // Retain logs for staging
            enableCircuitBreaker: true,  // Catch bad deploys before prod
            deployment: {
                minHealthyPercent: 50,   // Keep tasks running during rolling deploy
                maxHealthyPercent: 100,
            },
            healthCheck: {
                intervalSeconds: 30,
                timeoutSeconds: 5,
                retries: 3,
                startPeriodSeconds: 90,  // Slightly more time for staging
            },
            alarms: {
                enabled: true,
                cpuThreshold: 80,
                memoryThreshold: 80,
            },
        },
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
    },

    [Environment.PRODUCTION]: {
        // Synth-time context — Edge (env var > hardcoded default)
        domainName: fromEnv('DOMAIN_NAME') ?? 'nelsonlamounier.com',
        hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
        crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),

        // Synth-time context — Email (env var at synth time)
        notificationEmail: fromEnv('NOTIFICATION_EMAIL'),
        sesFromEmail: fromEnv('SES_FROM_EMAIL'),
        verificationSecret: fromEnv('VERIFICATION_SECRET'),
        verificationBaseUrl: fromEnv('VERIFICATION_BASE_URL'),

        // Resource behavior
        apiGateway: {
            throttle: { rateLimit: 1000, burstLimit: 2000 },
            stageName: 'api',
            enableTracing: true,
            enableDetailedMetrics: true,
            enableLogEncryption: true,
        },
        lambda: {
            timeout: cdk.Duration.seconds(30),
            logLevel: 'INFO',
            logRetention: logs.RetentionDays.ONE_YEAR,  // Increased for compliance
        },
        dlq: {
            retentionPeriod: cdk.Duration.days(14),
        },
        alb: {
            deletionProtection: true,
            accessLogsEnabled: true,
        },
        s3: {
            versionExpirationDays: 90,
            enableIntelligentTiering: true,
            corsOrigins: ['https://nelsonlamounier.com'],
        },
        cors: {
            allowOrigins: ['https://nelsonlamounier.com'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
            allowCredentials: true,
            maxAge: cdk.Duration.hours(1),
        },
        cloudfront: {
            priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, // Global
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            loggingEnabled: true,
            staticAssetsTtl: { default: cdk.Duration.days(365), max: cdk.Duration.days(365), min: cdk.Duration.days(1) },
            dynamicContentTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(300), min: cdk.Duration.seconds(0) },
            noCacheTtl: { default: cdk.Duration.seconds(0), max: cdk.Duration.seconds(0), min: cdk.Duration.seconds(0) },
            albOriginTimeouts: { connectionAttempts: 3, connectionTimeout: cdk.Duration.seconds(10), readTimeout: cdk.Duration.seconds(30), keepaliveTimeout: cdk.Duration.seconds(5) },
            errorResponseTtl: cdk.Duration.seconds(60),
            cacheHeaders: { dynamic: ['Accept', 'Accept-Language'], api: ['Accept', 'Accept-Language', 'Authorization', 'Content-Type'] },
            originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', 'CloudFront-Is-Mobile-Viewer', 'CloudFront-Is-Desktop-Viewer', 'User-Agent'],
        },
        ecsTask: {
            logRetention: logs.RetentionDays.ONE_YEAR,  // Compliance requirement
            enableLogEncryption: true,   // KMS enabled
            initProcessEnabled: true,    // Always enable for proper signal handling
            dropAllCapabilities: true,   // Always drop caps
            retainLogs: true,            // Never delete prod logs
            enableCircuitBreaker: true,  // Mandatory safety net in production
            deployment: {
                minHealthyPercent: 50,   // Zero-downtime rolling deployments
                maxHealthyPercent: 100,
            },
            healthCheck: {
                intervalSeconds: 30,
                timeoutSeconds: 5,
                retries: 3,
                startPeriodSeconds: 120, // More time for prod startup
            },
            alarms: {
                enabled: true,
                cpuThreshold: 80,
                memoryThreshold: 80,
            },
        },
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get NextJS configurations for an environment
 */
export function getNextJsConfigs(env: Environment): NextJsConfigs {
    return NEXTJS_CONFIGS[env];
}

/**
 * Get CloudFront log prefix for an environment
 */
export function getCloudFrontLogPrefix(envName: string): string {
    return `cloudfront-${envName}`;
}
