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
 * SSM lookup of `/shared/${env}/admin-allowlist-cidrs`). Adding /
 * removing IPs is a one-line SSM update + redeploy of THIS stack only.
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
     * SSM StringList path holding allowlisted IPv4 CIDRs (one per entry,
     * e.g. `203.0.113.42/32`). Empty/missing list disables allowlist
     * enforcement — admin/ops Hosts become reachable from anywhere
     * (subject to managed rules). Maintain manually; ESO sync is out of
     * scope for V1.
     */
    readonly allowlistCidrsSsmPath: string;
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

        // Synth-time SSM lookup. The list is comma-separated by AWS for
        // StringList parameters; split + trim + filter empties.
        const raw = ssm.StringParameter.valueFromLookup(this, props.allowlistCidrsSsmPath);
        const allowlistedIpv4 = raw && !raw.startsWith('dummy-value-for-')
            ? raw.split(',').map((s) => s.trim()).filter(Boolean)
            : [];

        const waf = new EksPublicWafConstruct(this, 'PublicWaf', {
            envName,
            namePrefix,
            allowlistedIpv4,
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
