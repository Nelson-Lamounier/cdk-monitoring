/** @format */

/**
 * CloudFront Construct
 *
 * Reusable CloudFront distribution construct with configurable origins and cache behaviors.
 * Configuration is externalized — no hard-coded values.
 *
 * Features:
 * - Multiple origin support (ALB, S3, custom origins)
 * - Flexible cache policies for static and dynamic content
 * - Custom error responses
 * - Security headers (HSTS, X-Frame-Options, etc.)
 * - Optional access logging with lifecycle management
 * - Optional WAF integration
 *
 * Tag strategy:
 * - Organizational tags (Environment, Project, Owner, ManagedBy) are applied by
 *   TaggingAspect at app level — NOT duplicated here.
 * - Only the construct-specific `Component: CloudFront` tag is applied here.
 *
 * Output strategy:
 * - Constructs expose public properties; consuming stacks decide what to export
 *   via CfnOutput. This avoids export name collisions when multiple distributions
 *   exist in one stack, and prevents unwanted cross-stack coupling in non-production.
 *
 * Cache policy expectations:
 * - Callers MUST provide a `defaultCachePolicy` appropriate for their origin.
 *   If omitted, CDK uses CachingOptimized which may not suit all workloads.
 * - For Next.js with ISR: use a policy that respects Cache-Control headers from
 *   the origin (short default TTL, honour origin max-age).
 * - For static assets: use a long-TTL policy (e.g. CachingOptimized).
 *
 * @example
 * ```typescript
 * const distribution = new CloudFrontConstruct(this, 'Distribution', {
 *     environment: Environment.PRODUCTION,
 *     projectName: 'webapp',
 *     defaultOrigin: albOrigin,
 *     defaultCachePolicy: dynamicCachePolicy,
 *     certificate: certificate,
 *     domainNames: ['portfolio.example.com'],
 * });
 *
 * // Access properties — consuming stack creates CfnOutput as needed
 * distribution.distributionId;
 * distribution.domainName;
 * distribution.distributionArn;
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as cdk from 'aws-cdk-lib';

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { getNextJsConfigs } from '../../config/nextjs';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Additional behavior configuration
 */
export interface AdditionalBehaviorConfig {
    readonly pathPattern: string;
    readonly origin: cloudfront.IOrigin;
    readonly cachePolicy?: cloudfront.ICachePolicy;
    readonly originRequestPolicy?: cloudfront.IOriginRequestPolicy;
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
    readonly viewerProtocolPolicy?: cloudfront.ViewerProtocolPolicy;
    readonly allowedMethods?: cloudfront.AllowedMethods;
    readonly compress?: boolean;
    readonly description?: string;
}

/**
 * Error response configuration
 */
export interface ErrorResponseConfig {
    readonly httpStatus: number;
    readonly responseHttpStatus?: number;
    readonly responsePagePath?: string;
    readonly ttl?: cdk.Duration;
}

/**
 * Props for CloudFrontConstruct
 */
export interface CloudFrontConstructProps {
    /** Target environment — drives config from centralized lib/config/nextjs */
    readonly environment: Environment;

    /** Project name for resource naming */
    readonly projectName: string;

    /** Default origin (ALB, S3, or custom) */
    readonly defaultOrigin: cloudfront.IOrigin;

    /** Optional comment for the distribution */
    readonly comment?: string;

    /** Additional cache behaviors for specific path patterns */
    readonly additionalBehaviors?: AdditionalBehaviorConfig[];

    /** ACM certificate for custom domains (must be in us-east-1) */
    readonly certificate?: acm.ICertificate;

    /** Custom domain names for the distribution */
    readonly domainNames?: string[];

    /** Override minimum TLS protocol version from config */
    readonly minimumProtocolVersion?: cloudfront.SecurityPolicyProtocol;

    /**
     * Default cache policy.
     *
     * For Next.js with ISR: use a policy with short default TTL that respects
     * Cache-Control headers from the origin.
     * For static-only origins: CachingOptimized works well.
     *
     * If omitted, CDK uses CachingOptimized which may not suit dynamic content.
     */
    readonly defaultCachePolicy?: cloudfront.ICachePolicy;

    /** Default origin request policy */
    readonly defaultOriginRequestPolicy?: cloudfront.IOriginRequestPolicy;

    /** Default response headers policy */
    readonly defaultResponseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

    /** Enable compression @default true */
    readonly enableCompression?: boolean;

    /** HTTP version @default from config */
    readonly httpVersion?: cloudfront.HttpVersion;

    /** Enable IPv6 @default true */
    readonly enableIpv6?: boolean;

    /** Viewer protocol policy @default REDIRECT_TO_HTTPS */
    readonly viewerProtocolPolicy?: cloudfront.ViewerProtocolPolicy;

    /** Allowed methods @default GET_HEAD_OPTIONS */
    readonly allowedMethods?: cloudfront.AllowedMethods;

    /** Custom error responses */
    readonly errorResponses?: ErrorResponseConfig[];

    /** Enable access logging @default from config */
    readonly enableLogging?: boolean;

    /** Log bucket (if logging enabled, will create one if not provided) */
    readonly logBucket?: s3.IBucket;

    /** Log prefix @default 'cloudfront' */
    readonly logPrefix?: string;

    /** Include cookies in logs @default false */
    readonly logIncludeCookies?: boolean;

    /** WAF Web ACL ID (for WAF protection) */
    readonly webAclId?: string;

    /** Geo restriction */
    readonly geoRestriction?: cloudfront.GeoRestriction;

    /** Override price class from config */
    readonly priceClass?: cloudfront.PriceClass;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * CloudFront distribution construct.
 *
 * Features:
 * - Configurable cache behaviors
 * - Security headers policy
 * - Optional access logging with lifecycle management
 * - Optional WAF integration
 *
 * Exposes `distribution`, `distributionId`, `domainName`, `distributionArn`,
 * and `logBucket` as public properties. Does NOT create CfnOutput — that is
 * the consuming stack's responsibility.
 */
export class CloudFrontConstruct extends Construct {
    public readonly distribution: cloudfront.Distribution;
    public readonly logBucket?: s3.IBucket;

    constructor(scope: Construct, id: string, props: CloudFrontConstructProps) {
        super(scope, id);

        // =====================================================================
        // CONFIGURATION (from centralized config)
        // =====================================================================
        const configs = getNextJsConfigs(props.environment);
        const cfConfig = configs.cloudfront;
        const { environment, projectName } = props;

        // =====================================================================
        // VALIDATION
        //
        // defaultOrigin is non-optional so TypeScript enforces it at compile
        // time. The certificate/domain cross-dependency below cannot be
        // expressed in the type system, so runtime validation is needed.
        // =====================================================================
        if (props.domainNames && props.domainNames.length > 0 && !props.certificate) {
            throw new Error(
                'ACM certificate is required when using custom domain names.\n\n' +
                'Create a certificate in us-east-1 region and pass it to props.',
            );
        }

        // =====================================================================
        // EXTRACT PROPS WITH DEFAULTS
        // =====================================================================
        const {
            defaultOrigin,
            comment,
            additionalBehaviors = [],
            certificate,
            domainNames = [],
            minimumProtocolVersion = cfConfig.minimumProtocolVersion,
            defaultCachePolicy,
            defaultOriginRequestPolicy,
            defaultResponseHeadersPolicy,
            enableCompression = true,
            httpVersion = cfConfig.httpVersion,
            enableIpv6 = true,
            viewerProtocolPolicy = cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods = cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            errorResponses = [],
            enableLogging = cfConfig.loggingEnabled,
            logBucket: providedLogBucket,
            logPrefix = 'cloudfront',
            logIncludeCookies = false,
            webAclId,
            geoRestriction,
        } = props;

        const priceClass = props.priceClass ?? cfConfig.priceClass;

        // =====================================================================
        // PRODUCTION WARNINGS
        // =====================================================================
        if (configs.isProduction && !enableLogging) {
            cdk.Annotations.of(this).addWarning(
                'SECURITY WARNING: Access logging is disabled in production environment.',
            );
        }

        if (configs.isProduction && !webAclId) {
            cdk.Annotations.of(this).addInfo(
                'INFO: No WAF Web ACL configured for production CloudFront distribution.',
            );
        }

        // =====================================================================
        // CREATE LOG BUCKET (if needed)
        //
        // CloudFront access logs are append-only — versioning is disabled
        // because log files are never overwritten or deleted until the
        // lifecycle rule expires them. This avoids doubling storage cost.
        //
        // autoDeleteObjects is omitted to avoid the hidden Lambda + IAM
        // resources it creates. The 90-day lifecycle rule handles retention;
        // non-empty bucket deletion in non-prod can be handled manually.
        // =====================================================================
        if (enableLogging && !providedLogBucket) {
            const stack = cdk.Stack.of(this);
            const accountId = stack.account || cdk.Aws.ACCOUNT_ID;
            const distributionName = `${environment}-${projectName}-cloudfront`;

            this.logBucket = new s3.Bucket(this, 'LogBucket', {
                bucketName: `${distributionName}-logs-${accountId}`,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
                versioned: false,
                removalPolicy: configs.removalPolicy,
                lifecycleRules: [
                    {
                        id: 'DeleteOldLogs',
                        enabled: true,
                        expiration: cdk.Duration.days(90),
                        transitions: [
                            {
                                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                                transitionAfter: cdk.Duration.days(30),
                            },
                        ],
                    },
                ],
                objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
            });

            NagSuppressions.addResourceSuppressions(
                this.logBucket,
                [
                    {
                        id: 'AwsSolutions-S1',
                        reason: 'This is a logging bucket — should not have server access logs',
                    },
                ],
                true,
            );
        } else if (enableLogging && providedLogBucket) {
            this.logBucket = providedLogBucket;
        }

        // =====================================================================
        // CREATE RESPONSE HEADERS POLICY
        //
        // override: false means if the origin already sets these headers,
        // CloudFront preserves the origin's values. This is the safe choice
        // for a reusable construct — it avoids silently overwriting headers
        // that the application intentionally sets (e.g. frame-ancestors for
        // embedding). For portfolios where you control the origin, override:
        // true would be more defensive, but it couples the CDN config to the
        // application's header strategy.
        // =====================================================================
        const responseHeadersPolicy =
            defaultResponseHeadersPolicy ??
            new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
                responseHeadersPolicyName: `${environment}-${projectName}-security-headers`,
                comment: 'Security headers for enhanced protection',
                securityHeadersBehavior: {
                    strictTransportSecurity: {
                        accessControlMaxAge: cdk.Duration.seconds(31536000),
                        includeSubdomains: true,
                        preload: true,
                        override: false, // Preserve origin HSTS if set
                    },
                    contentTypeOptions: { override: false }, // Preserve origin X-Content-Type-Options
                    frameOptions: {
                        frameOption: cloudfront.HeadersFrameOption.DENY,
                        override: false, // Preserve origin X-Frame-Options (e.g. frame-ancestors)
                    },
                    xssProtection: {
                        protection: true,
                        modeBlock: true,
                        override: false, // Preserve origin X-XSS-Protection
                    },
                    referrerPolicy: {
                        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
                        override: false, // Preserve origin Referrer-Policy
                    },
                },
            });

        // =====================================================================
        // BUILD ADDITIONAL BEHAVIORS
        // =====================================================================
        const behaviors: Record<string, cloudfront.BehaviorOptions> = {};

        for (const behaviorConfig of additionalBehaviors) {
            behaviors[behaviorConfig.pathPattern] = {
                origin: behaviorConfig.origin,
                cachePolicy: behaviorConfig.cachePolicy,
                originRequestPolicy: behaviorConfig.originRequestPolicy,
                responseHeadersPolicy: behaviorConfig.responseHeadersPolicy ?? responseHeadersPolicy,
                viewerProtocolPolicy: behaviorConfig.viewerProtocolPolicy ?? cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: behaviorConfig.allowedMethods ?? cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                compress: behaviorConfig.compress ?? enableCompression,
            };
        }

        // =====================================================================
        // BUILD ERROR RESPONSES
        // =====================================================================
        const errorResponseConfigs: cloudfront.ErrorResponse[] = errorResponses.map((err) => ({
            httpStatus: err.httpStatus,
            responseHttpStatus: err.responseHttpStatus,
            responsePagePath: err.responsePagePath,
            ttl: err.ttl,
        }));

        // =====================================================================
        // CREATE CLOUDFRONT DISTRIBUTION
        // =====================================================================
        const distributionComment =
            comment ?? `CloudFront distribution for ${projectName} - ${environment}`;

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: distributionComment,
            defaultBehavior: {
                origin: defaultOrigin,
                cachePolicy: defaultCachePolicy,
                originRequestPolicy: defaultOriginRequestPolicy,
                responseHeadersPolicy: responseHeadersPolicy,
                viewerProtocolPolicy,
                allowedMethods,
                compress: enableCompression,
            },
            additionalBehaviors: Object.keys(behaviors).length > 0 ? behaviors : undefined,
            certificate: certificate,
            domainNames: domainNames.length > 0 ? domainNames : undefined,
            minimumProtocolVersion,
            sslSupportMethod: certificate ? cloudfront.SSLMethod.SNI : undefined,
            priceClass,
            httpVersion,
            enableIpv6,
            errorResponses: errorResponseConfigs.length > 0 ? errorResponseConfigs : undefined,
            enableLogging,
            logBucket: this.logBucket,
            logFilePrefix: enableLogging ? logPrefix : undefined,
            logIncludesCookies: enableLogging ? logIncludeCookies : undefined,
            webAclId,
            geoRestriction,
        });

        // =====================================================================
        // TAGGING
        //
        // Organizational tags (Environment, Project, Owner, ManagedBy) are
        // applied by TaggingAspect at the app level — not duplicated here.
        // Only the construct-specific Component tag is added.
        // =====================================================================
        cdk.Tags.of(this.distribution).add('Component', 'CloudFront');

        // =====================================================================
        // CDK NAG SUPPRESSIONS
        // =====================================================================
        if (!configs.isProduction && !webAclId) {
            NagSuppressions.addResourceSuppressions(
                this.distribution,
                [
                    {
                        id: 'AwsSolutions-CFR4',
                        reason: 'WAF not required for non-production environments',
                    },
                ],
                true,
            );
        }
    }

    /** Get the CloudFront distribution ID */
    public get distributionId(): string {
        return this.distribution.distributionId;
    }

    /** Get the CloudFront distribution domain name */
    public get domainName(): string {
        return this.distribution.distributionDomainName;
    }

    /**
     * Get the CloudFront distribution ARN.
     * Uses cdk.Arn.format() for partition-awareness (handles aws-cn, aws-us-gov).
     * Region is empty because CloudFront is a global service.
     */
    public get distributionArn(): string {
        return cdk.Arn.format(
            {
                service: 'cloudfront',
                region: '',
                resource: 'distribution',
                resourceName: this.distribution.distributionId,
            },
            cdk.Stack.of(this),
        );
    }
}
