/**
 * @format
 * EKS Public WAF Stack — REGIONAL WebACL for the shared ALB.
 *
 * Provisions the host-scoped WAF defined in `EksPublicWafConstruct` and
 * publishes its ARN to SSM at `${ssmPrefix}/eks/waf-acl-arn`. Workload
 * Ingresses set `alb.ingress.kubernetes.io/wafv2-acl-arn: <arn>` to
 * attach the WebACL to the shared ALB. Plan 5b § 0.4.
 *
 * Allowlist CIDRs come from the operator at deploy time (synth-time
 * SSM lookup of two existing String parameters that already store the
 * operator's home IP — `/k8s/${env}/monitoring/allow-ipv4` and
 * `/k8s/${env}/monitoring/allow-ipv6` — historically used by the
 * kubeadm monitoring IngressRoute middleware. Same value, same purpose,
 * different consumer. Adding / removing IPs is a one-line SSM update
 * + redeploy of THIS stack only.
 *
 * Lives in eu-west-1 because REGIONAL WebACLs must share a region with
 * the ALB they attach to.
 */
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';
import { EksPublicWafConstruct } from '../../constructs/security/eks-public-waf';

export interface EksPublicWafStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    /**
     * SSM String path holding the comma-separated IPv4 allowlist CIDRs
     * (e.g. `203.0.113.42/32`). Empty/missing → IPv4 allowlist disabled.
     * Maintain manually; ESO sync is out of scope for V1.
     */
    readonly allowlistIpv4SsmPath: string;
    /**
     * Optional SSM String path holding the comma-separated IPv6
     * allowlist CIDRs. Omit when no IPv6 entry is needed.
     */
    readonly allowlistIpv6SsmPath?: string;
    /** Hosts gated by the IP allowlist (e.g. admin.* and ops.*). */
    readonly allowlistedHosts: readonly string[];
    /** Hosts to rate limit (e.g. api.*). */
    readonly rateLimitedHosts: readonly string[];
    readonly rateLimitPerIp?: number;
    readonly ssmPrefix: string;
    readonly namePrefix?: string;
}

export class EksPublicWafStack extends cdk.Stack {
    public readonly webAclArn: string;

    constructor(scope: Construct, id: string, props: EksPublicWafStackProps) {
        super(scope, id, props);

        const namePrefix = props.namePrefix ?? 'eks-public';
        const envName = props.targetEnvironment;

        // Synth-time SSM lookups. Each parameter holds a comma-separated
        // CIDR list; an unset parameter (or CDK's first-synth
        // `dummy-value-for-` placeholder) is treated as empty.
        const splitCidrs = (raw: string | undefined): string[] =>
            raw && !raw.startsWith('dummy-value-for-')
                ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                : [];

        const allowlistedIpv4 = splitCidrs(
            ssm.StringParameter.valueFromLookup(this, props.allowlistIpv4SsmPath),
        );
        const allowlistedIpv6 = props.allowlistIpv6SsmPath
            ? splitCidrs(ssm.StringParameter.valueFromLookup(this, props.allowlistIpv6SsmPath))
            : [];

        const waf = new EksPublicWafConstruct(this, 'PublicWaf', {
            envName,
            namePrefix,
            allowlistedIpv4,
            allowlistedIpv6,
            allowlistedHosts: props.allowlistedHosts,
            rateLimitedHosts: props.rateLimitedHosts,
            rateLimitPerIp: props.rateLimitPerIp,
        });

        this.webAclArn = waf.webAclArn;

        new ssm.StringParameter(this, 'WebAclArnSsm', {
            parameterName: `${props.ssmPrefix}/eks/waf-acl-arn`,
            stringValue: this.webAclArn,
            description: 'REGIONAL WAFv2 WebACL ARN attached to the shared EKS ALB',
        });
    }
}
