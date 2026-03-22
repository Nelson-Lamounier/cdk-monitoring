/** @format */

/**
 * Shared WAF Rule Builder
 *
 * Centralised WAF rule configuration consumed by both the CloudFront
 * edge stack (CLOUDFRONT scope) and the API Gateway regional stack
 * (REGIONAL scope). Changes here propagate to both stacks automatically.
 */

import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

// =============================================================================
// TYPES
// =============================================================================

export interface WafRuleOptions {
    /** Environment name for metric naming */
    readonly envName: string;
    /** Name prefix for metric naming */
    readonly namePrefix: string;
    /** Rate limit per IP per 5 minutes @default 5000 */
    readonly rateLimitPerIp?: number;
    /** Enable IP reputation list rule @default true */
    readonly enableIpReputation?: boolean;
    /** Enable rate-based rule @default true */
    readonly enableRateLimiting?: boolean;
    /**
     * Excluded rules from the Common Rule Set.
     * @default ['SizeRestrictions_BODY'] (CloudFront needs large bodies for ISR)
     */
    readonly commonRuleExclusions?: string[];
}

// =============================================================================
// BUILDER
// =============================================================================

/**
 * Builds a standard WAF rule set with AWS Managed Rules.
 *
 * Rules:
 * 1. AWSManagedRulesCommonRuleSet (SQLi, XSS) — always enabled
 * 2. AWSManagedRulesKnownBadInputsRuleSet (Log4j, etc.) — always enabled
 * 3. AWSManagedRulesAmazonIpReputationList — optional
 * 4. Rate-based rule (DDoS protection) — optional
 */
export function buildWafRules(opts: WafRuleOptions): wafv2.CfnWebACL.RuleProperty[] {
    const {
        envName,
        namePrefix,
        rateLimitPerIp = 5000,
        enableIpReputation = true,
        enableRateLimiting = true,
        commonRuleExclusions = ['SizeRestrictions_BODY'],
    } = opts;

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
        // Rule 1: AWS Common Rule Set (SQLi, XSS)
        {
            name: 'AWSManagedRulesCommonRuleSet',
            priority: 1,
            overrideAction: { none: {} },
            statement: {
                managedRuleGroupStatement: {
                    vendorName: 'AWS',
                    name: 'AWSManagedRulesCommonRuleSet',
                    ...(commonRuleExclusions.length > 0 && {
                        excludedRules: commonRuleExclusions.map(name => ({ name })),
                    }),
                },
            },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-common-rules`,
                sampledRequestsEnabled: true,
            },
        },
        // Rule 2: Known Bad Inputs (Log4j, etc.)
        {
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
            priority: 2,
            overrideAction: { none: {} },
            statement: {
                managedRuleGroupStatement: {
                    vendorName: 'AWS',
                    name: 'AWSManagedRulesKnownBadInputsRuleSet',
                },
            },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-bad-inputs`,
                sampledRequestsEnabled: true,
            },
        },
    ];

    // Rule 3: IP Reputation List (optional)
    if (enableIpReputation) {
        rules.push({
            name: 'AWSManagedRulesAmazonIpReputationList',
            priority: 3,
            overrideAction: { none: {} },
            statement: {
                managedRuleGroupStatement: {
                    vendorName: 'AWS',
                    name: 'AWSManagedRulesAmazonIpReputationList',
                },
            },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-ip-reputation`,
                sampledRequestsEnabled: true,
            },
        });
    }

    // Rule 4: Rate-based rule (DDoS protection)
    if (enableRateLimiting) {
        rules.push({
            name: 'RateLimitRule',
            priority: 4,
            action: { block: {} },
            statement: {
                rateBasedStatement: {
                    limit: rateLimitPerIp,
                    aggregateKeyType: 'IP',
                },
            },
            visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${envName}-${namePrefix}-rate-limit`,
                sampledRequestsEnabled: true,
            },
        });
    }

    return rules;
}
