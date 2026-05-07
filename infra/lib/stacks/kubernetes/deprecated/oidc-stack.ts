/**
 * @format
 * Kubernetes OIDC Stack — IRSA prerequisites
 *
 * Provisions the AWS-side infrastructure that lets a self-hosted kubeadm
 * cluster mint OIDC tokens that AWS STS will accept for
 * sts:AssumeRoleWithWebIdentity. Specifically:
 *
 *   1. Private S3 bucket — hosts the cluster's OIDC discovery document
 *      (/.well-known/openid-configuration) and JWKS (/keys). The
 *      kubernetes-bootstrap control-plane script generates and uploads
 *      these documents from /etc/kubernetes/pki/sa.pub on first cluster
 *      formation; this stack only creates the empty bucket and grants the
 *      control-plane node IAM role write access.
 *
 *   2. CloudFront distribution — serves the bucket contents over HTTPS at
 *      a stable, publicly resolvable URL. AWS STS fetches the discovery
 *      doc + JWKS from this distribution to verify pod-issued JWTs. Uses
 *      Origin Access Control (OAC) so the bucket itself stays private.
 *
 *   3. ACM certificate (us-east-1, cross-account DNS validation) — exact
 *      mirror of the tucaken-edge pattern. The hosted zone for
 *      nelsonlamounier.com lives in the root account; this stack runs in
 *      the cluster's dev/prod account and assumes a cross-account role to
 *      write the validation TXT records.
 *
 *   4. Route 53 A-alias `oidc.nelsonlamounier.com` → CloudFront — same
 *      cross-account custom-resource pattern as tucaken-edge.
 *
 *   5. IAM OpenIdConnectProvider — the AWS-side trust anchor. The issuer
 *      URL is environment-scoped via path
 *      (`https://oidc.nelsonlamounier.com/k8s-{shortEnv}`) so a single
 *      CloudFront distribution can host every cluster's OIDC docs.
 *
 *   6. SSM parameter exports for the kubernetes-bootstrap repo:
 *        /k8s/{env}/oidc/issuer-url
 *        /k8s/{env}/oidc/provider-arn
 *        /k8s/{env}/oidc/jwks-bucket-name
 *        /k8s/{env}/oidc/jwks-bucket-arn
 *
 * Soft-fail behaviour:
 *   When the cross-account hosted zone or role ARN aren't configured, the
 *   stack annotates a warning and skips the cert/DNS/CloudFront pieces
 *   rather than failing synth. This keeps CI synth green for environments
 *   that haven't opted into IRSA yet.
 *
 * Sequencing:
 *   This stack is the prerequisite for everything in the IRSA rollout.
 *   It must deploy before the kubernetes-bootstrap control-plane bootstrap
 *   runs (Phase 1 publishes JWKS into the bucket created here).
 */

import { NagSuppressions } from 'cdk-nag';

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { Environment, shortEnv } from '../../../config/environments';
import { LambdaFunctionConstruct } from '../../../constructs/compute';
import { AcmCertificateDnsValidationConstruct } from '../../../constructs/security/acm-certificate';
import { S3BucketConstruct } from '../../../constructs/storage';

// =============================================================================
// PROPS
// =============================================================================

export interface KubernetesOidcStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /**
     * Public domain that hosts the OIDC discovery endpoint.
     * One CloudFront distribution serves every cluster; the env-scoped path
     * (`/k8s-{shortEnv}`) keeps issuer URLs unique.
     * @example 'oidc.nelsonlamounier.com'
     */
    readonly oidcDomain: string;

    /**
     * Route 53 hosted zone ID (in the root account) for `oidcDomain`'s parent.
     * Used for both ACM DNS validation and the A-alias record.
     */
    readonly hostedZoneId: string;

    /**
     * Cross-account IAM role ARN that grants Route 53 ChangeResourceRecordSets
     * on the hosted zone. Same role used by the portfolio + tucaken edge stacks.
     */
    readonly crossAccountRoleArn: string;

    /**
     * Control-plane node IAM role ARN. Granted s3:PutObject on the OIDC bucket
     * so the bootstrap script can publish the discovery doc + JWKS.
     *
     * Optional — when omitted, the stack creates the bucket without write
     * access; bootstrap must be granted manually post-deploy. The standard
     * factory wiring passes this from the control-plane stack output.
     */
    readonly controlPlaneNodeRoleArn?: string;

    /**
     * STS endpoint scope used as the OIDC `aud` claim. Regional endpoints
     * (`sts.eu-west-1.amazonaws.com`) are auditable per region and reachable
     * via VPC endpoints; the global `sts.amazonaws.com` is the historical
     * default.
     * @default 'sts.eu-west-1.amazonaws.com'
     */
    readonly stsAudience?: string;

    /** Resource-name prefix @default 'k8s' */
    readonly namePrefix?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * @deprecated Replaced by EksPodIdentityStack on 2026-05-07.
 * @see docs/superpowers/specs/2026-05-05-eks-migration-design.md
 *
 * Original purpose: S3 + CloudFront + OIDC provider for IRSA on self-hosted kubeadm cluster.
 * Why deprecated:
 *   - EKS uses Pod Identity (EksPodIdentityStack) — no public OIDC endpoint needed
 *   - IRSA replaced cluster-wide with CfnPodIdentityAssociation per service account
 *
 * Why kept: Reference implementation. Do not delete.
 *
 * @destroyOrder
 *   1. Remove all serviceAccountAnnotations referencing this OIDC issuer
 *   2. cdk destroy Kubernetes-Oidc-<env>
 *
 * Do not import or instantiate.
 */
export class Deprecated_KubernetesOidcStack extends cdk.Stack {
    public readonly issuerUrl: string;
    public readonly oidcProviderArn: string | undefined;
    public readonly jwksBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: KubernetesOidcStackProps) {
        super(scope, id, {
            ...props,
            description: `Kubernetes OIDC infrastructure (S3 + CloudFront + IAM provider) — ${props.targetEnvironment}`,
        });

        const envName = props.targetEnvironment;
        const namePrefix = props.namePrefix ?? 'k8s';
        const stsAudience = props.stsAudience ?? 'sts.eu-west-1.amazonaws.com';

        // ---------------------------------------------------------------------
        // VALIDATION
        // ---------------------------------------------------------------------
        if (props.env?.region && props.env.region !== 'us-east-1') {
            throw new Error(
                `OIDC stack MUST be deployed in us-east-1 (CloudFront constraint). Got: ${props.env.region}`,
            );
        }
        if (this.region !== 'us-east-1') {
            cdk.Annotations.of(this).addError(
                `OIDC stack MUST be deployed in us-east-1. Current: ${this.region}`,
            );
        }

        // Issuer URL is path-scoped so a single CloudFront serves every env.
        // Example: https://oidc.nelsonlamounier.com/k8s-dev
        const issuerPath = `/${namePrefix}-${shortEnv(envName)}`;
        this.issuerUrl = `https://${props.oidcDomain}${issuerPath}`;

        // ---------------------------------------------------------------------
        // S3 BUCKET — JWKS hosting
        //
        // Private. Block all public access. KMS-managed encryption. Versioned
        // so a botched JWKS upload can be rolled back. The bootstrap script
        // writes two keys under `${issuerPath}/`:
        //   .well-known/openid-configuration
        //   keys
        // ---------------------------------------------------------------------
        const jwksBucketConstruct = new S3BucketConstruct(this, 'JwksBucket', {
            environment: envName,
            namePrefix,
            config: {
                bucketName: `${namePrefix}-${envName}-oidc-${this.account}-${this.region}`,
                purpose: 'OIDC discovery documents + JWKS',
                versioned: true,
            },
        });
        const jwksBucket = jwksBucketConstruct.bucket;
        this.jwksBucket = jwksBucket;

        // JWKS bucket serves static, non-sensitive discovery docs. Access
        // logging would require a separate log bucket in the same region,
        // adding cost and operational overhead for no security benefit.
        NagSuppressions.addResourceSuppressions(
            jwksBucketConstruct,
            [{ id: 'AwsSolutions-S1', reason: 'JWKS bucket holds public OIDC discovery docs — access logs add cost without value.' }],
            true,
        );

        // Grant the control-plane node IAM role write access — bootstrap
        // publishes the discovery doc + JWKS during cluster formation.
        if (props.controlPlaneNodeRoleArn) {
            jwksBucket.addToResourcePolicy(new iam.PolicyStatement({
                sid: 'AllowControlPlaneBootstrapWrites',
                effect: iam.Effect.ALLOW,
                principals: [new iam.ArnPrincipal(props.controlPlaneNodeRoleArn)],
                actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
                resources: [`${jwksBucket.bucketArn}${issuerPath}/*`],
            }));
        }

        // ---------------------------------------------------------------------
        // SOFT-FAIL: skip cert/CloudFront/DNS/IAM provider when cross-account
        // wiring is incomplete. The bucket above still gets created so partial
        // synth runs work; downstream phases will surface the missing config.
        // ---------------------------------------------------------------------
        if (!props.hostedZoneId || !props.crossAccountRoleArn || !props.oidcDomain) {
            cdk.Annotations.of(this).addWarning(
                'OIDC stack: hostedZoneId / crossAccountRoleArn / oidcDomain missing — ' +
                'skipping ACM cert, CloudFront, Route 53 alias, and IAM OIDC provider.',
            );
            this.oidcProviderArn = undefined;
            this.publishSsm(envName, namePrefix, jwksBucket, undefined);
            return;
        }

        // ---------------------------------------------------------------------
        // VALIDATION LAMBDA — re-uses the existing ACM DNS handler
        // ---------------------------------------------------------------------
        const validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
            functionName: `${namePrefix}-oidc-acm-dns-validation-${envName}`,
            description: `ACM DNS validation for OIDC distribution (${envName})`,
            entry: 'lambda/dns/acm-certificate-dns-validation.ts',
            handler: 'handler',
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            namePrefix,
            logRetention: logs.RetentionDays.TWO_WEEKS,
            environment: { AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1' },
        });

        // ---------------------------------------------------------------------
        // ACM CERTIFICATE — cross-account DNS validation
        //
        // One cert covers every env's path-scoped issuer because path doesn't
        // affect TLS. SAN list is empty — only the apex `oidcDomain` matters.
        // ---------------------------------------------------------------------
        const certConstruct = new AcmCertificateDnsValidationConstruct(
            this,
            'OidcCertificate',
            {
                environment: envName,
                domainName: props.oidcDomain,
                hostedZoneId: props.hostedZoneId,
                crossAccountRoleArn: props.crossAccountRoleArn,
                validationFunction: validationLambda.function,
                namePrefix: `${namePrefix}-oidc`,
                forceUpdate: process.env.GITHUB_SHA ?? new Date().toISOString(),
            },
        );
        const certificate = acm.Certificate.fromCertificateArn(
            this, 'ImportedOidcCertificate', certConstruct.certificateArn,
        );

        // ---------------------------------------------------------------------
        // CLOUDFRONT — Origin Access Control + S3 origin
        //
        // OAC (the modern replacement for OAI) signs requests so the bucket
        // can stay private. Caching is liberal — discovery docs + JWKS are
        // small static files that change at most on key rotation; STS itself
        // caches them for 24h, so even a long edge TTL is fine.
        // ---------------------------------------------------------------------
        const oac = new cloudfront.S3OriginAccessControl(this, 'OriginAccessControl', {
            originAccessControlName: `${namePrefix}-oidc-${envName}-oac`,
            description: 'OAC for OIDC discovery bucket',
        });

        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `OIDC discovery distribution (${envName})`,
            certificate,
            domainNames: [props.oidcDomain],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: cloudfront.HttpVersion.HTTP2,
            enableIpv6: true,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(jwksBucket, {
                    originAccessControl: oac,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                compress: true,
            },
        });

        // ---------------------------------------------------------------------
        // ROUTE 53 A-ALIAS — cross-account custom resource
        //
        // Mirrors tucaken-edge: the validation Lambda's DNS-alias mode writes
        // an Alias record into the root-account hosted zone via the same
        // assumed cross-account role.
        // ---------------------------------------------------------------------
        const dnsAliasLogGroup = new logs.LogGroup(this, 'DnsAliasProviderLogGroup', {
            logGroupName: `/aws/lambda/${namePrefix}-oidc-dns-alias-provider-${envName}`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: envName === Environment.DEVELOPMENT
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        const dnsAliasProvider = new cr.Provider(this, 'DnsAliasProvider', {
            onEventHandler: validationLambda.function,
            logGroup: dnsAliasLogGroup,
        });

        const dnsAliasRecord = new cdk.CustomResource(this, 'OidcDnsAlias', {
            serviceToken: dnsAliasProvider.serviceToken,
            properties: {
                DomainName: props.oidcDomain,
                HostedZoneId: props.hostedZoneId,
                CrossAccountRoleArn: props.crossAccountRoleArn,
                Environment: envName,
                CloudFrontDomainName: distribution.distributionDomainName,
                SkipCertificateCreation: 'true',
            },
            removalPolicy: envName === Environment.DEVELOPMENT
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });
        dnsAliasRecord.node.addDependency(distribution);

        // ---------------------------------------------------------------------
        // IAM OIDC PROVIDER — AWS-side trust anchor
        //
        // STS uses `Url` (verbatim) to fetch the discovery doc, follows
        // jwks_uri, validates JWT signatures against the JWKS keys, and
        // matches `aud` claim against `ClientIdList`.
        //
        // ThumbprintList: ACM-issued CloudFront certs use the AWS-managed
        // intermediate CA. The thumbprint below is the SHA-1 of the
        // Amazon Root CA 1 cert that chains under most Amazon-issued certs.
        // For maximum forward-compat, we list both Amazon Root CA 1 and the
        // SHA-2 root that newer Amazon certs may chain against.
        // ---------------------------------------------------------------------
        const oidcProvider = new iam.OpenIdConnectProvider(this, 'OidcProvider', {
            url: this.issuerUrl,
            clientIds: [stsAudience],
            // CloudFront certs chain under Amazon Root CAs; CDK accepts SHA-1
            // thumbprints. Listing both Amazon Root CA 1 and the newer Starfield
            // covers ACM-issued certs across regions and rotation windows.
            thumbprints: [
                '06b25927c42a721631c1efd9431e648fa62e1e39', // Amazon Root CA 1
                '7e740a9f0e1f51b5f8c8055a7c22a39e25e4f1a0', // Starfield Class 2 CA (Amazon's older chain)
            ],
        });
        this.oidcProviderArn = oidcProvider.openIdConnectProviderArn;

        // ---------------------------------------------------------------------
        // SSM PARAMETERS
        // ---------------------------------------------------------------------
        this.publishSsm(envName, namePrefix, jwksBucket, oidcProvider);

        // ---------------------------------------------------------------------
        // CFN OUTPUTS — operator visibility
        // ---------------------------------------------------------------------
        new cdk.CfnOutput(this, 'OidcIssuerUrl', {
            value: this.issuerUrl,
            description: 'kube-apiserver --service-account-issuer value',
        });
        new cdk.CfnOutput(this, 'OidcProviderArnOutput', {
            value: oidcProvider.openIdConnectProviderArn,
            description: 'IAM OpenIdConnectProvider ARN — used in role trust policies',
        });
        new cdk.CfnOutput(this, 'OidcBucketName', {
            value: jwksBucket.bucketName,
            description: 'S3 bucket where bootstrap publishes openid-configuration + JWKS',
        });

        // ---------------------------------------------------------------------
        // CDK NAG SUPPRESSIONS
        // ---------------------------------------------------------------------
        NagSuppressions.addResourceSuppressions(
            distribution,
            [
                {
                    id: 'AwsSolutions-CFR1',
                    reason: 'OIDC discovery must be globally reachable — Geo restrictions break IRSA for workloads in any AWS region.',
                },
                {
                    id: 'AwsSolutions-CFR2',
                    reason: 'OIDC discovery is static public data; WAF adds cost without meaningful security benefit.',
                },
                {
                    id: 'AwsSolutions-CFR3',
                    reason: 'OIDC discovery is public, low-traffic, static. Logging adds cost without value.',
                },
            ],
            true,
        );

        // cr.Provider creates a framework-onEvent Lambda internally; its
        // runtime is CDK-managed and cannot be set from user code.
        NagSuppressions.addResourceSuppressions(
            dnsAliasProvider,
            [{
                id: 'AwsSolutions-L1',
                reason: 'CDK custom resource framework Lambda — runtime version is managed by CDK, not configurable by user code.',
            }],
            true,
        );
    }

    private publishSsm(
        envName: Environment,
        namePrefix: string,
        bucket: s3.IBucket,
        provider: iam.IOpenIdConnectProvider | undefined,
    ): void {
        const prefix = `/${namePrefix}/${envName}/oidc`;

        new ssm.StringParameter(this, 'OidcIssuerUrlParam', {
            parameterName: `${prefix}/issuer-url`,
            stringValue: this.issuerUrl,
            description: 'OIDC issuer URL — kube-apiserver --service-account-issuer',
        });

        new ssm.StringParameter(this, 'OidcBucketNameParam', {
            parameterName: `${prefix}/jwks-bucket-name`,
            stringValue: bucket.bucketName,
            description: 'S3 bucket for openid-configuration + JWKS',
        });

        new ssm.StringParameter(this, 'OidcBucketArnParam', {
            parameterName: `${prefix}/jwks-bucket-arn`,
            stringValue: bucket.bucketArn,
            description: 'S3 bucket ARN — for IAM scoping',
        });

        if (provider) {
            new ssm.StringParameter(this, 'OidcProviderArnParam', {
                parameterName: `${prefix}/provider-arn`,
                stringValue: provider.openIdConnectProviderArn,
                description: 'IAM OpenIdConnectProvider ARN — used in role trust policies',
            });
        }
    }
}
