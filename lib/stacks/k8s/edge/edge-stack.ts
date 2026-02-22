/**
 * @format
 * K8s Edge Stack - Monitoring Dashboard CDN and Edge Security
 *
 * Dedicated edge infrastructure for the k8s monitoring stack (Grafana).
 * **MUST be deployed in us-east-1** (CloudFront + WAF requirement).
 *
 * ## Traffic Flow
 * ```
 * User → CloudFront (HTTPS) → Elastic IP (HTTP) → Traefik → Grafana pod
 *        └── Certificate: monitoring.nelsonlamounier.com
 *
 * NOTE: CloudFront→EIP uses HTTP to avoid SSL hostname mismatch.
 *       Traefik's self-signed cert doesn't match our domain certificate.
 * ```
 *
 * ## Resources Created
 * 1. **ACM Certificate** - SSL/TLS with cross-account DNS validation
 * 2. **WAF WebACL** - CloudFront protection with AWS managed rules
 * 3. **CloudFront Distribution** - CDN with single origin (EIP)
 * 4. **DNS Alias Record** - Route 53 A record → CloudFront
 *
 * ## Cross-Region Architecture
 * - Edge Stack: us-east-1 (CloudFront, WAF, ACM edge cert)
 * - Compute Stack: eu-west-1 (EC2 + k3s + Elastic IP)
 *
 * ## Differences from NextJs Edge Stack
 * - Single origin (EIP) instead of multi-origin (ALB + S3)
 * - No additional behaviors (path-based routing)
 * - CachingDisabled policy (Grafana is fully dynamic + authenticated)
 * - Simpler cache/origin request policies
 */

import { NagSuppressions } from 'cdk-nag';

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
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

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Configuration props for K8sEdgeStack.
 *
 * @example
 * ```typescript
 * const edgeStack = new K8sEdgeStack(app, 'Edge', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     domainName: 'monitoring.nelsonlamounier.com',
 *     hostedZoneId: 'Z123ABC',
 *     crossAccountRoleArn: 'arn:aws:iam::ROOT:role/Route53Role',
 *     elasticIpSsmPath: '/k8s/development/elastic-ip',
 *     elasticIpSsmRegion: 'eu-west-1',
 *     env: { region: 'us-east-1' }, // Required!
 * });
 * ```
 */
export interface K8sEdgeStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /** Domain name for monitoring dashboard (e.g., 'monitoring.nelsonlamounier.com') */
    readonly domainName: string;

    /** Route 53 Hosted Zone ID in root account */
    readonly hostedZoneId: string;

    /** Cross-account IAM role ARN for Route 53 DNS validation */
    readonly crossAccountRoleArn: string;

    /**
     * SSM parameter path storing the Elastic IP address.
     * Read cross-region from eu-west-1 → us-east-1.
     */
    readonly elasticIpSsmPath: string;

    /** Region where the Elastic IP SSM parameter lives @default 'eu-west-1' */
    readonly elasticIpSsmRegion?: string;

    /** Name prefix for resource naming @default 'k8s' */
    readonly namePrefix?: string;

    /** WAF rate limit per IP per 5 minutes @default 2000 */
    readonly rateLimitPerIp?: number;

    /** Enable IP reputation list @default true */
    readonly enableIpReputationList?: boolean;

    /** Enable rate limiting @default true */
    readonly enableRateLimiting?: boolean;

    /** Create DNS alias records @default true */
    readonly createDnsRecords?: boolean;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * K8sEdgeStack - Monitoring Edge Infrastructure
 *
 * IMPORTANT: This stack MUST be deployed in us-east-1 because:
 * - CloudFront requires ACM certificates in us-east-1
 * - WAF for CloudFront must have CLOUDFRONT scope (us-east-1)
 *
 * Creates:
 * 1. ACM Certificate with cross-account DNS validation
 * 2. WAF Web ACL with AWS Managed Rules
 * 3. CloudFront Distribution with single EIP origin
 * 4. DNS Alias Record → CloudFront
 */
export class K8sEdgeStack extends cdk.Stack {
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

    constructor(scope: Construct, id: string, props: K8sEdgeStackProps) {
        super(scope, id, {
            ...props,
            description: `Edge infrastructure (ACM + WAF + CloudFront) for ${props.namePrefix ?? 'k8s'} monitoring`,
        });

        this.targetEnvironment = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'k8s';
        const envName = props.targetEnvironment;

        // =====================================================================
        // VALIDATION
        // =====================================================================
        if (props.env?.region && props.env.region !== 'us-east-1') {
            throw new Error(
                `Edge stack MUST be deployed in us-east-1. Got: ${props.env.region}`
            );
        }

        if (this.region !== 'us-east-1') {
            cdk.Annotations.of(this).addError(
                'Edge stack MUST be deployed in us-east-1 region.\n' +
                `Current region: ${this.region}`
            );
        }

        // Soft-fail: use cdk.Annotations.addError() instead of throw.
        // CDK deploy --exclusively still synthesizes ALL stacks, so a throw
        // here would block non-edge deploys when edge env vars are absent.
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
        // ACM CERTIFICATE (Cross-account DNS validation)
        // =====================================================================
        this.validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
            functionName: `${namePrefix}-monitoring-acm-validation-${envName}`,
            description: `ACM certificate DNS validation for ${props.domainName}`,
            entry: 'lambda/dns/acm-certificate-dns-validation.ts',
            handler: 'handler',
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            namePrefix,
            logRetention: logs.RetentionDays.TWO_WEEKS,
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
            namePrefix: `${namePrefix}-monitoring`,
            rateLimitPerIp: props.rateLimitPerIp ?? 2000,
            enableIpReputation: props.enableIpReputationList ?? true,
            enableRateLimiting: props.enableRateLimiting ?? true,
            // No body size exclusion needed — Grafana doesn't send large bodies
            commonRuleExclusions: [],
        });

        this.webAcl = new wafv2.CfnWebACL(this, 'MonitoringWebAcl', {
            name: `${envName}-${namePrefix}-monitoring-waf`,
            description: `WAF for ${namePrefix} monitoring CloudFront - ${envName}`,
            scope: 'CLOUDFRONT',
            defaultAction: { allow: {} },
            rules: wafRules,
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-monitoring-waf`,
                sampledRequestsEnabled: true,
            },
        });

        this.webAclArn = this.webAcl.attrArn;

        // =====================================================================
        // CLOUDFRONT DISTRIBUTION
        // =====================================================================

        // Cross-region SSM read: get EIP address from eu-west-1
        const ssmRegion = props.elasticIpSsmRegion ?? 'eu-west-1';

        const ssmReaderPolicy = cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:aws:ssm:${ssmRegion}:${this.account}:parameter${props.elasticIpSsmPath}`,
                ],
            }),
        ]);

        const elasticIpAddress = this.readSsmParameter(
            'ReadElasticIp', props.elasticIpSsmPath, ssmRegion, ssmReaderPolicy,
        );

        // EIP origin — HTTP to avoid SSL hostname mismatch
        // Grafana runs on port 80 behind Traefik, CloudFront handles TLS at the edge
        const eipOrigin = new origins.HttpOrigin(elasticIpAddress, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            connectionAttempts: 3,
            connectionTimeout: cdk.Duration.seconds(10),
            customHeaders: { 'X-CloudFront-Origin': envName },
        });

        // CachingDisabled — Grafana dashboards are fully dynamic and authenticated
        const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

        // Forward Host header so Traefik routes by hostname
        const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'EipOriginRequestPolicy', {
            originRequestPolicyName: `${envName}-${namePrefix}-monitoring-origin`,
            comment: 'Forward Host header to Traefik for hostname-based routing',
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Host'),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
        });

        // CloudFront Distribution
        this.distribution = new CloudFrontConstruct(this, 'Distribution', {
            environment: props.targetEnvironment,
            projectName: `${namePrefix}-monitoring`,
            defaultOrigin: eipOrigin,
            certificate: this.certificate,
            domainNames: [props.domainName],
            defaultCachePolicy: noCachePolicy,
            defaultOriginRequestPolicy: originRequestPolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            enableLogging: false,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            enableIpv6: true,
            webAclId: this.webAclArn,
        });

        // Suppress CFR3 — logging disabled for personal monitoring dashboard
        NagSuppressions.addResourceSuppressions(
            this.distribution.distribution,
            [
                {
                    id: 'AwsSolutions-CFR3',
                    reason: 'CloudFront logging disabled for monitoring dashboard to reduce costs',
                },
            ],
            true
        );

        // Suppress CFR5 — EIP origin uses HTTP_ONLY protocol
        NagSuppressions.addResourceSuppressions(
            this.distribution.distribution,
            [
                {
                    id: 'AwsSolutions-CFR5',
                    reason: 'EIP origin uses HTTP_ONLY protocol (no SSL). HTTPS is terminated at CloudFront edge.',
                },
            ],
            true
        );

        // =====================================================================
        // DNS ALIAS RECORD (CloudFront → Route 53)
        // =====================================================================
        if (props.createDnsRecords !== false) {
            const dnsAliasLogGroup = new logs.LogGroup(this, 'DnsAliasProviderLogGroup', {
                logGroupName: `/aws/lambda/${namePrefix}-monitoring-dns-alias-${envName}`,
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
                    DomainName: props.domainName,
                    HostedZoneId: props.hostedZoneId,
                    CrossAccountRoleArn: props.crossAccountRoleArn,
                    Environment: envName,
                    CloudFrontDomainName: this.distribution.distribution.distributionDomainName,
                    // Skip certificate creation — just create DNS alias
                    SkipCertificateCreation: 'true',
                },
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            dnsAliasRecord.node.addDependency(this.distribution);

            // Suppress cdk-nag for CDK-managed framework Lambda runtime
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
        }

        // =====================================================================
        // SSM PARAMETERS
        // =====================================================================
        new ssm.StringParameter(this, 'DistributionDomainParameter', {
            parameterName: `/k8s/${envName}/cloudfront/distribution-domain`,
            stringValue: this.distribution.distribution.distributionDomainName,
            description: 'Monitoring CloudFront distribution domain',
            tier: ssm.ParameterTier.STANDARD,
        });

        // Suppress cdk-nag for AwsCustomResource Lambda (SSM cross-region reader)
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
        cdk.Tags.of(this).add('Stack', 'K8sEdge');
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

        if (props.createDnsRecords !== false) {
            cdk.Annotations.of(this).addInfo(
                `DNS alias record created: ${props.domainName} → CloudFront`
            );
        }
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Read an SSM parameter from another region using AwsCustomResource.
     * Returns the parameter value as a string token.
     */
    private readSsmParameter(
        id: string,
        path: string,
        region: string,
        policy: cr.AwsCustomResourcePolicy,
    ): string {
        const reader = new cr.AwsCustomResource(this, id, {
            onUpdate: {
                service: 'SSM',
                action: 'getParameter',
                parameters: { Name: path },
                region,
                physicalResourceId: cr.PhysicalResourceId.of(`${id}-${Date.now()}`),
            },
            policy,
            logRetention: logs.RetentionDays.ONE_WEEK,
        });

        return reader.getResponseField('Parameter.Value');
    }
}
