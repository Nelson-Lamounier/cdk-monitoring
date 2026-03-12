/**
 * @format
 * Security Group Construct — Unified, Dynamic
 *
 * Single reusable construct for creating security groups with config-driven
 * rules. Supports any workload type — K8s, ECS, NextJS, or custom.
 *
 * Features:
 * - Declarative rules with typed source discriminators (self, cidr, ipv6, prefixList, SG, anyIpv4/v6)
 * - Both ingress and egress rule support
 * - TCP/UDP protocol support with single port or port range
 * - Static adapter for K8s config integration (`fromK8sRules`)
 * - Imperative `addIngressFromCidr` / `addIngressFromSecurityGroup` helpers
 *
 * Tag strategy:
 * Only Purpose/Environment tags applied here. Organizational tags
 * (Project, Owner, ManagedBy) come from TaggingAspect at app level.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { Construct } from 'constructs';

import type { K8sPortRule } from '../../config/kubernetes';

// =============================================================================
// RULE TYPES
// =============================================================================

/**
 * Source type for a security group rule.
 *
 * Discriminated union — the `type` field determines which additional
 * properties are available:
 * - `self`          → self-referencing (intra-group)
 * - `cidr`          → specific IPv4 CIDR block
 * - `ipv6Cidr`      → specific IPv6 CIDR block
 * - `prefixList`    → AWS managed prefix list (e.g., CloudFront)
 * - `securityGroup` → another security group
 * - `anyIpv4`       → 0.0.0.0/0
 * - `anyIpv6`       → ::/0
 */
export type SecurityGroupRuleSource =
    | { readonly type: 'self' }
    | { readonly type: 'cidr'; readonly cidr: string }
    | { readonly type: 'ipv6Cidr'; readonly cidr: string }
    | { readonly type: 'prefixList'; readonly prefixListId: string }
    | { readonly type: 'securityGroup'; readonly securityGroup: ec2.ISecurityGroup }
    | { readonly type: 'anyIpv4' }
    | { readonly type: 'anyIpv6' };

/**
 * A single declarative rule for a security group.
 *
 * Supports ingress and egress, TCP and UDP, single port and port ranges.
 *
 * @example
 * ```typescript
 * // Inbound HTTPS from a specific CIDR
 * { port: 443, protocol: 'tcp', source: { type: 'cidr', cidr: '10.0.0.0/8' },
 *   direction: 'ingress', description: 'HTTPS from VPC' }
 *
 * // Outbound HTTPS to anywhere
 * { port: 443, protocol: 'tcp', source: { type: 'anyIpv4' },
 *   direction: 'egress', description: 'AWS APIs (IPv4)' }
 *
 * // Inbound port range (self-referencing)
 * { port: 30000, endPort: 32767, protocol: 'tcp', source: { type: 'self' },
 *   direction: 'ingress', description: 'NodePort services' }
 * ```
 */
export interface SecurityGroupRule {
    /** Start port (single port when endPort is omitted) */
    readonly port: number;
    /** End port for a range — creates `tcpRange(port, endPort)` */
    readonly endPort?: number;
    /** Transport protocol */
    readonly protocol: 'tcp' | 'udp';
    /** Source/destination peer */
    readonly source: SecurityGroupRuleSource;
    /** Rule direction */
    readonly direction: 'ingress' | 'egress';
    /** Human-readable description for the SG rule */
    readonly description: string;
}

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for SecurityGroupConstruct.
 *
 * Accepts a flat list of declarative rules that are applied at construction
 * time. Additional rules can be added imperatively after construction.
 */
export interface SecurityGroupConstructProps {
    /** VPC for the security group */
    readonly vpc: ec2.IVpc;
    /** Security group name */
    readonly securityGroupName: string;
    /** Description for the security group */
    readonly description: string;
    /**
     * Allow all outbound traffic.
     * Set to false for least-privilege egress (then add explicit egress rules).
     * @default true
     */
    readonly allowAllOutbound?: boolean;
    /**
     * Declarative rules to apply at construction time.
     * For `source.type: 'self'`, the security group self-references automatically.
     * @default [] — no rules applied; add imperatively via helper methods
     */
    readonly rules?: SecurityGroupRule[];
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Unified, dynamic security group construct.
 *
 * Creates a security group and applies declarative rules from the `rules`
 * prop. Supports all CDK peer types via a typed source discriminator.
 *
 * @example
 * ```typescript
 * // Config-driven K8s security group
 * const clusterSg = new SecurityGroupConstruct(this, 'ClusterBaseSg', {
 *     vpc,
 *     securityGroupName: 'k8s-cluster',
 *     description: 'K8s intra-cluster communication',
 *     rules: SecurityGroupConstruct.fromK8sRules(
 *         configs.securityGroups.clusterBase.rules, vpc, podCidr,
 *     ),
 * });
 *
 * // Imperative ALB security group
 * const albSg = new SecurityGroupConstruct(this, 'AlbSg', {
 *     vpc,
 *     securityGroupName: 'alb-sg',
 *     description: 'ALB security group',
 *     allowAllOutbound: false,
 * });
 * albSg.addIngressFromCidr('10.0.0.0/8', 443, 'HTTPS from VPC');
 *
 * // ECS task with explicit egress rules
 * const taskSg = new SecurityGroupConstruct(this, 'TaskSg', {
 *     vpc,
 *     securityGroupName: 'nextjs-task',
 *     description: 'Next.js ECS task (awsvpc)',
 *     allowAllOutbound: false,
 *     rules: [
 *         { port: 3000, protocol: 'tcp', source: { type: 'securityGroup', securityGroup: albSg.securityGroup },
 *           direction: 'ingress', description: 'App port from ALB' },
 *         { port: 443, protocol: 'tcp', source: { type: 'anyIpv4' },
 *           direction: 'egress', description: 'AWS APIs (IPv4)' },
 *     ],
 * });
 * ```
 */
export class SecurityGroupConstruct extends Construct {
    /** The underlying CDK security group */
    public readonly securityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: SecurityGroupConstructProps) {
        super(scope, id);

        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            securityGroupName: props.securityGroupName,
            description: props.description,
            allowAllOutbound: props.allowAllOutbound ?? true,
        });

        // Apply declarative rules
        for (const rule of props.rules ?? []) {
            const peer = this._resolvePeer(rule.source);
            const port = SecurityGroupConstruct._resolvePort(rule);

            if (rule.direction === 'ingress') {
                this.securityGroup.addIngressRule(peer, port, rule.description);
            } else {
                this.securityGroup.addEgressRule(peer, port, rule.description);
            }
        }
    }

    // =========================================================================
    // STATIC HELPERS
    // =========================================================================

    /**
     * Convert K8s config port rules to generic SecurityGroupRules.
     *
     * Maps `K8sPortRule.source` discriminators to `SecurityGroupRuleSource`:
     * - `'self'`    → `{ type: 'self' }`
     * - `'vpcCidr'` → `{ type: 'cidr', cidr: vpc.vpcCidrBlock }`
     * - `'podCidr'` → `{ type: 'cidr', cidr: podNetworkCidr }`
     *
     * @param rules     K8s port rules from the config layer
     * @param vpc       VPC for resolving vpcCidr source
     * @param podCidr   Pod network CIDR for resolving podCidr source
     * @returns Generic SecurityGroupRule[] array
     */
    static fromK8sRules(
        rules: K8sPortRule[],
        vpc: ec2.IVpc,
        podCidr: string,
    ): SecurityGroupRule[] {
        return rules.map((rule) => ({
            port: rule.port,
            endPort: rule.endPort,
            protocol: rule.protocol,
            direction: 'ingress' as const,
            description: rule.description,
            source: SecurityGroupConstruct._mapK8sSource(rule.source, vpc, podCidr),
        }));
    }

    // =========================================================================
    // IMPERATIVE HELPERS
    // =========================================================================

    /**
     * Add an ingress rule for a specific port from an IPv4 CIDR.
     * Delegates to `ec2.Peer.ipv4()` which validates octets and prefix length.
     */
    addIngressFromCidr(cidr: string, port: number, description: string): void {
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(cidr),
            ec2.Port.tcp(port),
            description,
        );
    }

    /**
     * Add an ingress rule for a specific port from another security group.
     */
    addIngressFromSecurityGroup(
        sourceSecurityGroup: ec2.ISecurityGroup,
        port: number,
        description: string,
    ): void {
        this.securityGroup.addIngressRule(
            sourceSecurityGroup,
            ec2.Port.tcp(port),
            description,
        );
    }

    // =========================================================================
    // PRIVATE
    // =========================================================================

    /**
     * Resolve a `SecurityGroupRuleSource` union to a CDK `IPeer`.
     */
    private _resolvePeer(source: SecurityGroupRuleSource): ec2.IPeer {
        switch (source.type) {
            case 'self':
                return this.securityGroup;
            case 'cidr':
                return ec2.Peer.ipv4(source.cidr);
            case 'ipv6Cidr':
                return ec2.Peer.ipv6(source.cidr);
            case 'prefixList':
                return ec2.Peer.prefixList(source.prefixListId);
            case 'securityGroup':
                return source.securityGroup;
            case 'anyIpv4':
                return ec2.Peer.anyIpv4();
            case 'anyIpv6':
                return ec2.Peer.anyIpv6();
        }
    }

    /**
     * Resolve a rule to a CDK `Port`, handling single port vs range
     * and TCP vs UDP.
     */
    private static _resolvePort(rule: Pick<SecurityGroupRule, 'port' | 'endPort' | 'protocol'>): ec2.Port {
        if (rule.endPort !== undefined) {
            return rule.protocol === 'tcp'
                ? ec2.Port.tcpRange(rule.port, rule.endPort)
                : ec2.Port.udpRange(rule.port, rule.endPort);
        }
        return rule.protocol === 'tcp'
            ? ec2.Port.tcp(rule.port)
            : ec2.Port.udp(rule.port);
    }

    /**
     * Map a K8s source discriminator to a generic SecurityGroupRuleSource.
     */
    private static _mapK8sSource(
        source: K8sPortRule['source'],
        vpc: ec2.IVpc,
        podCidr: string,
    ): SecurityGroupRuleSource {
        switch (source) {
            case 'self':
                return { type: 'self' };
            case 'vpcCidr':
                return { type: 'cidr', cidr: vpc.vpcCidrBlock };
            case 'podCidr':
                return { type: 'cidr', cidr: podCidr };
            case 'anyIpv4':
                return { type: 'anyIpv4' };
        }
    }
}
