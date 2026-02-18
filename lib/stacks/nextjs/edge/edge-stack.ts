/**
 * @format
 * NextJS Edge Stack - Global CDN and Edge Security
 *
 * Consolidated edge infrastructure for the Next.js application.
 * **MUST be deployed in us-east-1** (CloudFront + WAF requirement).
 *
 * ## Traffic Flow
 * ```
 * User → CloudFront (HTTPS) → ALB (HTTP) → ECS Task
 *        └── Certificate: dev.nelsonlamounier.com
 *
 * NOTE: CloudFront→ALB uses HTTP to avoid SSL hostname mismatch.
 *       ALB's AWS DNS (*.elb.amazonaws.com) doesn't match our certificate.
 * ```
 *
 * ## Resources Created
 * 1. **ACM Certificate** - SSL/TLS with cross-account DNS validation
 * 2. **WAF WebACL** - CloudFront protection with AWS managed rules
 * 3. **CloudFront Distribution** - CDN with multi-origin routing
 * 4. **DNS Alias Record** - Route 53 A record → CloudFront
 *
 * ## Cross-Region Architecture
 * - Edge Stack: us-east-1 (CloudFront, WAF, ACM edge cert)
 * - Networking Stack: eu-west-1 (ALB, ACM ALB cert)
 * - Application Stack: eu-west-1 (ECS, S3)
 *
 * @see troubleshooting-guide.md for 502/504 debugging
 */

import { NagSuppressions } from 'cdk-nag';

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { LambdaFunctionConstruct } from '../../../common/compute';
import { CloudFrontConstruct } from '../../../common/networking/cloudfront';
import { AcmCertificateDnsValidationConstruct } from '../../../common/security/acm-certificate';
import { buildWafRules } from '../../../common/security/waf-rules';
import { Environment } from '../../../config/environments';
import {
    getNextJsConfigs,
    getCloudFrontLogPrefix,
    CLOUDFRONT_PATH_PATTERNS,
    CLOUDFRONT_ERROR_RESPONSES,
} from '../../../config/nextjs';
import { nextjsSsmPaths } from '../../../config/ssm-paths';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Configuration props for NextJsEdgeStack.
 *
 * @example
 * ```typescript
 * const edgeStack = new NextJsEdgeStack(app, 'Edge', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     domainName: 'dev.example.com',
 *     hostedZoneId: 'Z123ABC',
 *     crossAccountRoleArn: 'arn:aws:iam::ROOT:role/Route53Role',
 *     albDnsSsmPath: '/nextjs/development/alb-dns-name',
 *     assetsBucketSsmPath: '/nextjs/development/assets-bucket-name',
 *     env: { region: 'us-east-1' }, // Required!
 * });
 * ```
 */
export interface NextJsEdgeStackProps extends cdk.StackProps {
    // =========================================================================
    // Required Props
    // =========================================================================

    /** Target deployment environment (development/staging/production) */
    readonly targetEnvironment: Environment;

    /** Primary domain for SSL certificate (e.g., `dev.example.com`) */
    readonly domainName: string;

    /** Route 53 Hosted Zone ID in root account for DNS validation */
    readonly hostedZoneId: string;

    /** IAM role ARN in root account for cross-account Route 53 access */
    readonly crossAccountRoleArn: string;

    /** SSM parameter path for ALB DNS name (read cross-region) */
    readonly albDnsSsmPath: string;

    /** Region where the ALB DNS SSM parameter is stored @default 'eu-west-1' */
    readonly albDnsSsmRegion?: string;

    /** SSM parameter path for S3 assets bucket name (read cross-region) */
    readonly assetsBucketSsmPath: string;

    /** Region where the assets bucket SSM parameter is stored @default 'eu-west-1' */
    readonly assetsBucketSsmRegion?: string;

    // =========================================================================
    // Optional Props
    // =========================================================================

    /** Additional domains for certificate SANs (e.g., `['www.example.com']`) */
    readonly subjectAlternativeNames?: string[];


    /** WAF rate limit per IP per 5 minutes @default 5000 */
    readonly rateLimitPerIp?: number;

    /** Enable AWS IP reputation list in WAF @default true */
    readonly enableIpReputationList?: boolean;

    /** Enable WAF rate limiting @default true */
    readonly enableRateLimiting?: boolean;

    /** Enable CloudFront access logging @default from config */
    readonly enableLogging?: boolean;

    /** Create Route 53 alias A record for CloudFront @default true */
    readonly createDnsRecords?: boolean;

    /** Resource name prefix @default 'nextjs' */
    readonly namePrefix?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * NextJsEdgeStack - Consolidated edge infrastructure
 *
 * IMPORTANT: This stack MUST be deployed in us-east-1 because:
 * - CloudFront requires ACM certificates in us-east-1
 * - WAF for CloudFront must have CLOUDFRONT scope (us-east-1)
 *
 * Creates:
 * 1. ACM Certificate with cross-account DNS validation
 * 2. WAF Web ACL with AWS Managed Rules
 * 3. CloudFront Distribution with multi-origin routing
 */
export class NextJsEdgeStack extends cdk.Stack {
    // ACM Certificate
    public readonly certificateArn: string;
    public readonly certificate: acm.ICertificate;
    public readonly validationLambda: LambdaFunctionConstruct;

    // WAF
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly webAclArn: string;

    // CloudFront
    public readonly distribution: CloudFrontConstruct;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NextJsEdgeStackProps) {
        super(scope, id, {
            ...props,
            description: `Edge infrastructure (ACM + WAF + CloudFront) for ${props.namePrefix ?? 'nextjs'}`,
        });

        this.targetEnvironment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'nextjs';
        const envName = props.targetEnvironment;

        // =====================================================================
        // VALIDATION
        // =====================================================================
        // Guard 1: Hard throw when env.region is explicitly set to a wrong value.
        // This catches misconfiguration before synthesis proceeds.
        if (props.env?.region && props.env.region !== 'us-east-1') {
            throw new Error(
                `Edge stack MUST be deployed in us-east-1. Got: ${props.env.region}`
            );
        }
        // Guard 2: Synth-time annotation for when this.region is a token (env.region not set).
        // addError fails synth, but the comparison may be skipped if region is unresolved.
        if (this.region !== 'us-east-1') {
            cdk.Annotations.of(this).addError(
                'Edge stack MUST be deployed in us-east-1 region.\n' +
                `Current region: ${this.region}`
            );
        }

        // Soft-fail: use cdk.Annotations.addError() instead of throw.
        // CDK deploy --exclusively still synthesizes ALL stacks, so a throw
        // here would block non-edge deploys when edge env vars are absent.
        // addError() prevents this stack from deploying but lets synth complete.
        if (!props.domainName) {
            cdk.Annotations.of(this).addError('domainName is required for Edge stack deployment');
        }

        if (!props.hostedZoneId) {
            cdk.Annotations.of(this).addError('hostedZoneId is required for Edge stack deployment');
        }

        if (!props.crossAccountRoleArn) {
            cdk.Annotations.of(this).addError('crossAccountRoleArn is required for cross-account DNS');
        }

        // =====================================================================
        // CONFIGURATION
        // =====================================================================
        const configs = getNextJsConfigs(props.targetEnvironment);
        const cfConfig = configs.cloudfront;
        const logPrefix = getCloudFrontLogPrefix(envName);
        const allDomains = [props.domainName, ...(props.subjectAlternativeNames ?? [])];
        const loggingEnabled = props.enableLogging ?? cfConfig.loggingEnabled;

        // =====================================================================
        // ACM CERTIFICATE (Cross-account DNS validation)
        // =====================================================================
        this.validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
            functionName: `${namePrefix}-acm-dns-validation-${envName}`,
            description: `ACM certificate DNS validation for ${props.domainName}`,
            entry: 'lambda/dns/acm-certificate-dns-validation.ts',
            handler: 'handler',
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            namePrefix,
            logRetention: logs.RetentionDays.TWO_WEEKS,  // 14-day retention for logs
            environment: {
                AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
            },
        });


        const certificateConstruct = new AcmCertificateDnsValidationConstruct(
            this,
            'Certificate',
            {
                environment: envName,
                domainName: props.domainName,
                subjectAlternativeNames: props.subjectAlternativeNames,
                hostedZoneId: props.hostedZoneId,
                crossAccountRoleArn: props.crossAccountRoleArn,
                validationFunction: this.validationLambda.function,
                namePrefix,
            }
        );

        this.certificateArn = certificateConstruct.certificateArn;
        this.certificate = acm.Certificate.fromCertificateArn(
            this,
            'ImportedCertificate',
            this.certificateArn
        );

        // =====================================================================
        // WAF WEB ACL
        // =====================================================================
        const wafRules = buildWafRules({
            envName,
            namePrefix,
            rateLimitPerIp: props.rateLimitPerIp ?? 5000,
            enableIpReputation: props.enableIpReputationList ?? true,
            enableRateLimiting: props.enableRateLimiting ?? true,
        });

        this.webAcl = new wafv2.CfnWebACL(this, 'CloudFrontWebAcl', {
            name: `${envName}-${namePrefix}-cloudfront-waf`,
            description: `WAF for ${namePrefix} CloudFront distribution - ${envName}`,
            scope: 'CLOUDFRONT',
            defaultAction: { allow: {} },
            rules: wafRules,
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-cloudfront-waf`,
                sampledRequestsEnabled: true,
            },
        });

        this.webAclArn = this.webAcl.attrArn;

        // =====================================================================
        // CLOUDFRONT DISTRIBUTION
        // =====================================================================

        // =================================================================
        // CROSS-REGION SSM READERS
        // Read values from eu-west-1 SSM into us-east-1 via AwsCustomResource
        // =================================================================
        const ssmRegion = props.albDnsSsmRegion ?? 'eu-west-1';

        const ssmParameterArns = [
            `arn:aws:ssm:${ssmRegion}:${this.account}:parameter${props.albDnsSsmPath}`,
            `arn:aws:ssm:${props.assetsBucketSsmRegion ?? ssmRegion}:${this.account}:parameter${props.assetsBucketSsmPath}`,
        ];
        const ssmReaderPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: ssmParameterArns,
            }),
        ]);

        // Read ALB DNS name
        const albDnsName = this.readSsmParameter(
            'ReadAlbDnsName', props.albDnsSsmPath, ssmRegion, ssmReaderPolicy,
        );

        // Read S3 bucket name
        const bucketName = this.readSsmParameter(
            'ReadAssetsBucketName', props.assetsBucketSsmPath,
            props.assetsBucketSsmRegion ?? ssmRegion, ssmReaderPolicy,
        );
        const bucketRegion = props.assetsBucketSsmRegion ?? ssmRegion;

        // Import bucket with SSM-resolved name
        const staticAssetsBucket = s3.Bucket.fromBucketAttributes(
            this,
            'ImportedAssetsBucket',
            {
                bucketArn: `arn:aws:s3:::${bucketName}`,
                bucketName: bucketName,
                region: bucketRegion,
                bucketRegionalDomainName: `${bucketName}.s3.${bucketRegion}.amazonaws.com`,
            }
        );

        // Use S3BucketOrigin with imported bucket (replaces deprecated S3Origin)
        const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket);

        // ALB origin - Use HTTP for CloudFront → ALB (within AWS infrastructure)
        const albOrigin = new origins.HttpOrigin(albDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            connectionAttempts: cfConfig.albOriginTimeouts.connectionAttempts,
            connectionTimeout: cfConfig.albOriginTimeouts.connectionTimeout,
            readTimeout: cfConfig.albOriginTimeouts.readTimeout,
            keepaliveTimeout: cfConfig.albOriginTimeouts.keepaliveTimeout,
            customHeaders: { 'X-CloudFront-Origin': envName },
        });

        // Cache Policies
        const staticAssetsCachePolicy = new cloudfront.CachePolicy(this, 'StaticAssetsCachePolicy', {
            cachePolicyName: `${envName}-${namePrefix}-static-assets`,
            comment: 'Cache policy for immutable static assets (1 year TTL)',
            defaultTtl: cfConfig.staticAssetsTtl.default,
            maxTtl: cfConfig.staticAssetsTtl.max,
            minTtl: cfConfig.staticAssetsTtl.min,
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        const dynamicContentCachePolicy = new cloudfront.CachePolicy(this, 'DynamicContentCachePolicy', {
            cachePolicyName: `${envName}-${namePrefix}-dynamic-content`,
            comment: 'Cache policy for ISR pages with revalidation',
            defaultTtl: cfConfig.dynamicContentTtl.default,
            maxTtl: cfConfig.dynamicContentTtl.max,
            minTtl: cfConfig.dynamicContentTtl.min,
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList(...cfConfig.cacheHeaders.dynamic),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
        });

        // Use CloudFront's managed CachingDisabled policy for API routes
        // Custom policies with TTL=0 have restrictions on header/cookie/query behaviors
        const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

        // Origin Request Policy
        const albOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'AlbOriginRequestPolicy', {
            originRequestPolicyName: `${envName}-${namePrefix}-alb-origin`,
            comment: 'Forward necessary headers to ALB origin',
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...cfConfig.originRequestHeaders),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        });

        // CloudFront Distribution
        this.distribution = new CloudFrontConstruct(this, 'Distribution', {
            environment: props.targetEnvironment,
            projectName: namePrefix,
            defaultOrigin: albOrigin,
            certificate: this.certificate,
            domainNames: allDomains,
            minimumProtocolVersion: cfConfig.minimumProtocolVersion,
            defaultCachePolicy: dynamicContentCachePolicy,
            defaultOriginRequestPolicy: albOriginRequestPolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            additionalBehaviors: [
                // Next.js static assets
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.nextjs.static,
                    origin: s3Origin,
                    cachePolicy: staticAssetsCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Next.js build assets (immutable)',
                },
                // Next.js data files
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.nextjs.data,
                    origin: s3Origin,
                    cachePolicy: dynamicContentCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Next.js ISR data files',
                },
                // Images
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.assets.images,
                    origin: s3Origin,
                    cachePolicy: staticAssetsCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    compress: true,
                    description: 'Article images and media',
                },
                // API routes
                {
                    pathPattern: CLOUDFRONT_PATH_PATTERNS.api,
                    origin: albOrigin,
                    cachePolicy: noCachePolicy,
                    originRequestPolicy: albOriginRequestPolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    compress: false,
                    description: 'NextJS API routes (no caching)',
                },
            ],
            errorResponses: CLOUDFRONT_ERROR_RESPONSES.map((err) => ({
                ...err,
                ttl: cfConfig.errorResponseTtl,
            })),
            enableLogging: loggingEnabled,
            logPrefix,
            priceClass: cfConfig.priceClass,
            httpVersion: cfConfig.httpVersion,
            enableIpv6: true,
            webAclId: this.webAclArn,
        });

        // Suppress CFR3 when logging is explicitly disabled (non-production)
        if (!loggingEnabled) {
            NagSuppressions.addResourceSuppressions(
                this.distribution.distribution,
                [
                    {
                        id: 'AwsSolutions-CFR3',
                        reason: 'CloudFront logging disabled for development/non-production environment to reduce costs',
                    },
                ],
                true
            );
        }

        // Suppress CFR5: ALB origin uses HTTP_ONLY protocol, SSL version is not applicable
        NagSuppressions.addResourceSuppressions(
            this.distribution.distribution,
            [
                {
                    id: 'AwsSolutions-CFR5',
                    reason: 'ALB origin uses HTTP_ONLY protocol (no SSL). HTTPS is terminated at CloudFront edge.',
                },
            ],
            true
        );

        // =====================================================================
        // DNS ALIAS RECORD (CloudFront -> Route 53)
        // =====================================================================
        // Reuses the certificate validation Lambda for DNS alias creation.
        // The Lambda handles both modes via SkipCertificateCreation flag.
        // NOTE: This creates coupling — changes to the Lambda's certificate
        //       logic could break DNS alias creation. Acceptable for a single-
        //       purpose portfolio project; in production, split into two
        //       Lambdas with shared Route 53 utility code.
        const dnsAliasLogGroup = new logs.LogGroup(this, 'DnsAliasProviderLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-dns-alias-provider-${envName}`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const dnsAliasProvider = new cr.Provider(this, 'DnsAliasProvider', {
            onEventHandler: this.validationLambda.function,
            logGroup: dnsAliasLogGroup,
        });

        const dnsAliasRecord = new cdk.CustomResource(this, 'DnsAliasRecord', {
            serviceToken: dnsAliasProvider.serviceToken,
            properties: {
                // These properties make the Lambda create ONLY the DNS alias (no certificate)
                DomainName: props.domainName,
                HostedZoneId: props.hostedZoneId,
                CrossAccountRoleArn: props.crossAccountRoleArn,
                Environment: envName,
                CloudFrontDomainName: this.distribution.distribution.distributionDomainName,
                // Skip certificate creation - just create DNS alias
                SkipCertificateCreation: 'true',
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Ensure DNS record is created after CloudFront distribution
        dnsAliasRecord.node.addDependency(this.distribution);

        // Suppress cdk-nag warning for CDK-managed framework Lambda runtime
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/DnsAliasProvider/framework-onEvent/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Framework Lambda runtime is managed by CDK cr.Provider and cannot be configured',
                },
            ],
        );

        // =====================================================================
        // SSM PARAMETERS
        // =====================================================================
        const ssmPaths = nextjsSsmPaths(envName, namePrefix);

        new ssm.StringParameter(this, 'CertificateArnParameter', {
            parameterName: ssmPaths.acmCertificateArn,
            stringValue: this.certificateArn,
            description: `ACM Certificate ARN for ${props.domainName}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'WebAclArnParameter', {
            parameterName: ssmPaths.cloudfront.wafArn,
            stringValue: this.webAclArn,
            description: `CloudFront WAF Web ACL ARN`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'DistributionDomainParameter', {
            parameterName: ssmPaths.cloudfront.distributionDomain,
            stringValue: this.distribution.distribution.distributionDomainName,
            description: 'CloudFront distribution domain for DNS alias records',
            tier: ssm.ParameterTier.STANDARD,
        });

        // Suppress cdk-nag for AwsCustomResource Lambda (SSM cross-region readers)
        NagSuppressions.addResourceSuppressionsByPath(
            this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [
                {
                    id: 'AwsSolutions-L1',
                    reason: 'Lambda runtime is managed by CDK AwsCustomResource and cannot be configured',
                },
            ],
        );

        // =====================================================================
        // TAGS
        // =====================================================================
        cdk.Tags.of(this).add('Stack', 'NextJsEdge');
        cdk.Tags.of(this).add('Layer', 'Edge');

        // =====================================================================
        // OUTPUTS
        // =====================================================================
        new cdk.CfnOutput(this, 'CertificateArn', {
            value: this.certificateArn,
            description: 'ACM Certificate ARN',
            exportName: `${this.stackName}-cert-arn`,
        });

        new cdk.CfnOutput(this, 'WebAclArn', {
            value: this.webAclArn,
            description: 'WAF Web ACL ARN',
            exportName: `${this.stackName}-waf-arn`,
        });

        new cdk.CfnOutput(this, 'DistributionId', {
            value: this.distribution.distributionId,
            description: 'CloudFront Distribution ID',
            exportName: `${this.stackName}-dist-id`,
        });

        new cdk.CfnOutput(this, 'DistributionDomainName', {
            value: this.distribution.domainName,
            description: 'CloudFront Distribution domain name',
            exportName: `${this.stackName}-dist-domain`,
        });

        // DNS note
        if (props.createDnsRecords !== false) {
            cdk.Annotations.of(this).addInfo(
                `DNS alias records for ${allDomains.join(', ')} need to be created in Route53 ` +
                `(hosted zone: ${props.hostedZoneId}). Use crossAccountRoleArn to create them via Lambda.`
            );
        }
    }


    /**
     * Get cache invalidation command for CI/CD
     */
    public getCacheInvalidationCommand(paths: string[] = ['/*']): string {
        return (
            `aws cloudfront create-invalidation ` +
            `--distribution-id ${this.distribution.distributionId} ` +
            `--paths ${paths.join(' ')}`
        );
    }
    /**
     * Reads an SSM parameter from a remote region via AwsCustomResource.
     * Centralises the repeated boilerplate for cross-region SSM reads.
     *
     * NOTE: No onDelete handler — these are read-only resources. onUpdate
     * re-reads on every deploy, which is intentional since the backing SSM
     * values (ALB DNS, bucket name) can change between deployments.
     */
    private readSsmParameter(
        id: string,
        parameterPath: string,
        region: string,
        policy: cr.AwsCustomResourcePolicy,
    ): string {
        const reader = new cr.AwsCustomResource(this, id, {
            onCreate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: parameterPath },
                region,
                physicalResourceId: cr.PhysicalResourceId.of(`read-${parameterPath}`),
            },
            onUpdate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: parameterPath },
                region,
                physicalResourceId: cr.PhysicalResourceId.of(`read-${parameterPath}`),
            },
            policy,
        });
        return reader.getResponseField('Parameter.Value');
    }
}
