/**
 * @format
 * EKS ALB Certificates Stack — eu-west-1 ACM wildcards for the public ALB.
 *
 * Provisions one wildcard certificate per apex domain (Plan 5b § 0.2). The
 * AWS Load Balancer Controller attaches all of them to the shared ALB and
 * serves the right cert per Host via SNI.
 *
 *   `*.nelsonlamounier.com` (+ apex)
 *   `*.tucaken.io`          (+ apex)
 *   `*.tucaken.com`         (+ apex)
 *
 * Hosted zones live in mgmt-account (`Org-DnsRole-management` deploys the
 * `Route53DnsValidationRole` they're scoped to). DNS-01 validation
 * therefore goes through the cross-account validation Lambda already used
 * by the legacy CloudFront edge stacks.
 *
 * The stack lives in eu-west-1 because ALB requires certs in its own
 * region; the us-east-1 CloudFront edge certs are unrelated and not
 * affected by this stack.
 *
 * @see docs/superpowers/plans/2026-05-06-eks-migration-05b-alb-acm-externaldns.md § 1 Phase 2.
 */
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { LambdaFunctionConstruct } from '../../constructs/compute/constructs/lambda-function';
import { AcmCertificateDnsValidationConstruct } from '../../constructs/security/acm-certificate';

export interface EksAlbCertsStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly nelsonlamounierHostedZoneId: string;
    readonly tucakenIoHostedZoneId: string;
    readonly tucakenComHostedZoneId: string;
    /**
     * Cross-account role with `route53:ChangeResourceRecordSets` on the 3
     * hosted zones above (mgmt-account `Route53DnsValidationRole`). The
     * validation Lambda assumes this role to write `_acme-challenge.*`
     * CNAMEs during cert issuance and renewal.
     */
    readonly crossAccountRoleArn: string;
    readonly ssmPrefix: string;
    readonly namePrefix?: string;
}

/**
 * Per-cert config, internal to the stack. Order is intentional: the SSM
 * parameter names (`alb-cert-arns/nelsonlamounier`, `tucaken-io`,
 * `tucaken-com`) are documented in the spec and must stay stable since
 * workload Helm charts will reference them.
 */
interface CertSpec {
    readonly id: string;
    readonly domain: string;
    readonly hostedZoneId: string;
    readonly ssmKey: string;
}

export class EksAlbCertsStack extends cdk.Stack {
    public readonly certArns: Record<string, string> = {};

    constructor(scope: Construct, id: string, props: EksAlbCertsStackProps) {
        super(scope, id, props);

        const namePrefix = props.namePrefix ?? 'eks-alb';
        const envName = props.targetEnvironment;

        // One Lambda services every cert's custom-resource lifecycle (the
        // construct routes by domain inside the handler).
        const validationLambda = new LambdaFunctionConstruct(this, 'ValidationLambda', {
            functionName: `${namePrefix}-acm-dns-validation-${envName}`,
            description: 'ACM certificate DNS validation for ALB wildcards',
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

        const certs: readonly CertSpec[] = [
            {
                id: 'NelsonlamounierCert',
                domain: 'nelsonlamounier.com',
                hostedZoneId: props.nelsonlamounierHostedZoneId,
                ssmKey: 'nelsonlamounier',
            },
            {
                id: 'TucakenIoCert',
                domain: 'tucaken.io',
                hostedZoneId: props.tucakenIoHostedZoneId,
                ssmKey: 'tucaken-io',
            },
            {
                id: 'TucakenComCert',
                domain: 'tucaken.com',
                hostedZoneId: props.tucakenComHostedZoneId,
                ssmKey: 'tucaken-com',
            },
        ];

        for (const cert of certs) {
            const construct = new AcmCertificateDnsValidationConstruct(this, cert.id, {
                environment: envName,
                domainName: cert.domain,
                subjectAlternativeNames: [`*.${cert.domain}`],
                hostedZoneId: cert.hostedZoneId,
                crossAccountRoleArn: props.crossAccountRoleArn,
                validationFunction: validationLambda.function,
                namePrefix: `${namePrefix}-${cert.ssmKey}`,
                forceUpdate: process.env.GITHUB_SHA ?? new Date().toISOString(),
            });

            this.certArns[cert.ssmKey] = construct.certificateArn;

            new ssm.StringParameter(this, `${cert.id}ArnSsm`, {
                parameterName: `${props.ssmPrefix}/eks/alb-cert-arns/${cert.ssmKey}`,
                stringValue: construct.certificateArn,
                description: `ALB wildcard cert ARN for ${cert.domain} (CFN-managed)`,
            });
        }
    }
}
