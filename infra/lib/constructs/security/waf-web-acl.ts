/**
 * @format
 * WAF Web ACL Construct
 *
 * Reusable construct that creates a WAF WebACL with:
 *   - AWS Managed Rules (via `buildWafRules()`)
 *   - Optional IP allowlist for pre-launch access restriction
 *
 * Supports both CLOUDFRONT and REGIONAL scopes.
 *
 * @example
 * ```typescript
 * const waf = new WafWebAclConstruct(this, 'Waf', {
 *     envName: 'development',
 *     namePrefix: 'k8s',
 *     scope: 'CLOUDFRONT',
 *     restrictAccess: true,
 *     allowedIps: ['203.0.113.42/32'],
 * });
 * ```
 */

import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

import { Construct } from 'constructs';

import { buildWafRules } from './waf-rules';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for the WAF WebACL construct.
 */
export interface WafWebAclProps {
    /** Environment name for metric naming */
    readonly envName: string;

    /** Resource name prefix */
    readonly namePrefix: string;

    /** WAF scope — CLOUDFRONT (us-east-1 only) or REGIONAL */
    readonly scope: 'CLOUDFRONT' | 'REGIONAL';

    /** Rate limit per IP per 5 minutes @default 5000 */
    readonly rateLimitPerIp?: number;

    /** Enable AWS IP reputation list @default true */
    readonly enableIpReputation?: boolean;

    /** Enable rate limiting @default true */
    readonly enableRateLimiting?: boolean;

    /**
     * Whether to restrict access to allowlisted IPs only.
     * When true, only IPs in allowedIps/allowedIpv6s can reach the site.
     * @default false
     */
    readonly restrictAccess?: boolean;

    /**
     * IPv4 addresses allowed when restrictAccess is enabled.
     * CIDR notation (e.g., `['203.0.113.42/32']`).
     * @default []
     */
    readonly allowedIps?: string[];

    /**
     * IPv6 addresses allowed when restrictAccess is enabled.
     * CIDR notation (e.g., `['2a02:8084::/32']`).
     * @default []
     */
    readonly allowedIpv6s?: string[];
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * WAF WebACL construct — managed rules + optional IP allowlist.
 *
 * ## Access Restriction
 *
 * When `restrictAccess` is true AND at least one IP is provided:
 * - Default action is BLOCK (deny all)
 * - AllowListedIPs rule (priority 0) allows listed IPs through
 * - Managed rules still apply (XSS, SQLi, rate limiting)
 *
 * When `restrictAccess` is false (default):
 * - Default action is ALLOW
 * - Only managed rules can block traffic
 */
export class WafWebAclConstruct extends Construct {
    /** The WAF WebACL L1 resource */
    public readonly webAcl: wafv2.CfnWebACL;

    /** The WebACL ARN */
    public readonly webAclArn: string;

    constructor(scope: Construct, id: string, props: WafWebAclProps) {
        super(scope, id);

        const { envName, namePrefix } = props;
        const restrictAccess = props.restrictAccess ?? false;
        const allowedIps = props.allowedIps ?? [];
        const allowedIpv6s = props.allowedIpv6s ?? [];
        const hasAllowlist = allowedIps.length > 0 || allowedIpv6s.length > 0;

        // Build managed rules
        const wafRules = buildWafRules({
            envName,
            namePrefix,
            rateLimitPerIp: props.rateLimitPerIp ?? 5000,
            enableIpReputation: props.enableIpReputation ?? true,
            enableRateLimiting: props.enableRateLimiting ?? true,
        });

        // =====================================================================
        // IP Allowlist — Pre-launch access restriction
        // =====================================================================

        if (restrictAccess && hasAllowlist) {
            const ipSetStatements: wafv2.CfnWebACL.StatementProperty[] = [];

            if (allowedIps.length > 0) {
                const ipv4Set = new wafv2.CfnIPSet(this, 'AllowedIpv4Set', {
                    description: `IPv4 addresses allowed during pre-launch restricted access (${namePrefix})`,
                    scope: props.scope,
                    ipAddressVersion: 'IPV4',
                    addresses: allowedIps,
                });
                ipSetStatements.push({
                    ipSetReferenceStatement: { arn: ipv4Set.attrArn },
                });
            }

            if (allowedIpv6s.length > 0) {
                const ipv6Set = new wafv2.CfnIPSet(this, 'AllowedIpv6Set', {
                    description: `IPv6 addresses allowed during pre-launch restricted access (${namePrefix})`,
                    scope: props.scope,
                    ipAddressVersion: 'IPV6',
                    addresses: allowedIpv6s,
                });
                ipSetStatements.push({
                    ipSetReferenceStatement: { arn: ipv6Set.attrArn },
                });
            }

            // Single IP set → direct reference; dual → OR statement
            const allowStatement: wafv2.CfnWebACL.StatementProperty =
                ipSetStatements.length === 1
                    ? ipSetStatements[0]
                    : { orStatement: { statements: ipSetStatements } };

            // Insert as highest-priority rule (priority 0)
            wafRules.unshift({
                name: 'AllowListedIPs',
                priority: 0,
                action: { allow: {} },
                statement: allowStatement,
                visibilityConfig: {
                    cloudWatchMetricsEnabled: true,
                    metricName: `${envName}-${namePrefix}-allowed-ips`,
                    sampledRequestsEnabled: true,
                },
            });
        }

        // =====================================================================
        // WebACL
        // =====================================================================

        this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
            description: `WAF for ${namePrefix} CloudFront distribution - ${envName}`,
            scope: props.scope,
            defaultAction: restrictAccess && hasAllowlist
                ? { block: {} }
                : { allow: {} },
            rules: wafRules,
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-cloudfront-waf`,
                sampledRequestsEnabled: true,
            },
        });

        this.webAclArn = this.webAcl.attrArn;
    }
}
