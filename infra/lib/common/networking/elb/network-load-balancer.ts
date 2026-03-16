/**
 * @format
 * Network Load Balancer Construct
 *
 * Reusable construct for creating a Network Load Balancer with optional
 * Elastic IP attachment via SubnetMapping.
 *
 * Blueprint Pattern:
 * - Stack passes VPC, AZ, and optional EIP allocation ID
 * - Construct handles NLB creation, target groups, listeners, and EIP binding
 *
 * Features:
 * - TCP passthrough (Layer 4) — preserves client source IPs
 * - EIP attachment via L1 SubnetMapping escape hatch
 * - Single-AZ deployment for cost-optimised solo-developer setups
 * - Configurable health checks and deregistration delay
 * - Helper methods for creating target groups and TCP listeners
 * - NLB security group configuration (inbound + outbound rules)
 * - cdk-nag access log suppression for development environments
 *
 * Tag strategy:
 * - Organisational tags (Environment, Project, Owner, ManagedBy) are applied
 *   by TaggingAspect at the app level — NOT duplicated here.
 * - Only construct-specific tags are applied: `Component: NLB` and `Name`.
 *
 * Output strategy:
 * - Constructs expose public properties; consuming stacks decide what to
 *   export via CfnOutput. This avoids duplicate outputs and unwanted
 *   cross-stack coupling.
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// Props
// =============================================================================

/**
 * TCP target group options for {@link NetworkLoadBalancerConstruct.createTargetGroup}.
 *
 * Note: `vpc` is not required — the construct uses the VPC from its own props.
 */
export interface NlbTargetGroupOptions {
    /** Name for the target group (must be ≤32 characters) */
    readonly targetGroupName: string;

    /** Target port (e.g. 80, 443) */
    readonly port: number;

    /** Target type @default INSTANCE */
    readonly targetType?: elbv2.TargetType;

    /** Port used for health checks @default same as `port` */
    readonly healthCheckPort?: number;

    /** Health check interval @default 30 seconds */
    readonly healthCheckInterval?: cdk.Duration;

    /** Healthy threshold count @default 3 */
    readonly healthyThresholdCount?: number;

    /** Unhealthy threshold count @default 3 */
    readonly unhealthyThresholdCount?: number;

    /** Deregistration delay @default 30 seconds */
    readonly deregistrationDelay?: cdk.Duration;
}

/**
 * Props for {@link NetworkLoadBalancerConstruct}.
 */
export interface NetworkLoadBalancerConstructProps {
    /** VPC for the load balancer */
    readonly vpc: ec2.IVpc;

    /**
     * Load balancer name.
     * Must be 32 characters or fewer (AWS NLB naming limit).
     */
    readonly loadBalancerName: string;

    /** Internet-facing or internal @default true */
    readonly internetFacing?: boolean;

    /**
     * Availability Zone for NLB placement (e.g. 'eu-west-1a').
     *
     * When provided, the NLB is placed in a single AZ for cost optimisation.
     * The construct will find the public (or private) subnet in that AZ.
     * When combined with `eipAllocationId`, the EIP is attached via SubnetMapping.
     */
    readonly availabilityZone?: string;

    /**
     * EIP allocation ID to attach to the NLB via SubnetMapping.
     *
     * Requires `availabilityZone` to be set.
     * The NLB will use this EIP as its public IP — the same IP that was
     * previously assigned directly to instances.
     */
    readonly eipAllocationId?: string;

    /** Enable cross-zone load balancing @default false */
    readonly crossZoneEnabled?: boolean;

    /** Enable deletion protection @default false */
    readonly deletionProtection?: boolean;

    /**
     * Suppress cdk-nag AwsSolutions-ELB2 (access logs).
     *
     * NLB access logs incur S3 storage cost. For solo-developer or
     * development environments, this can be safely suppressed.
     * @default true
     */
    readonly suppressAccessLogNag?: boolean;
}

// =============================================================================
// Construct
// =============================================================================

/**
 * Network Load Balancer Construct.
 *
 * Creates a TCP-mode NLB with optional EIP attachment and helper methods
 * for creating target groups and listeners.
 *
 * Exposes `loadBalancer`, `loadBalancerArn`, and `dnsName` as public properties.
 * Does NOT create CfnOutput — that is the consuming stack's responsibility.
 *
 * @example
 * ```typescript
 * const nlb = new NetworkLoadBalancerConstruct(this, 'Nlb', {
 *     vpc,
 *     loadBalancerName: 'k8s-nlb',
 *     availabilityZone: 'eu-west-1a',
 *     eipAllocationId: eip.attrAllocationId,
 * });
 *
 * const httpTg = nlb.createTargetGroup('HttpTg', {
 *     targetGroupName: 'k8s-http',
 *     port: 80,
 * });
 *
 * nlb.addTcpListener('HttpListener', 80, httpTg);
 *
 * // Register ASGs (in downstream stacks)
 * asg.attachToNetworkTargetGroup(httpTg);
 * ```
 */
export class NetworkLoadBalancerConstruct extends Construct {
    /** The Network Load Balancer */
    public readonly loadBalancer: elbv2.NetworkLoadBalancer;

    /**
     * The NLB security group (auto-created by CDK).
     *
     * Exposed so consuming stacks can reference it in other SG rules
     * or for diagnostic purposes.
     */
    public readonly securityGroup: ec2.ISecurityGroup;

    /** VPC reference (stored for use by helper methods) */
    private readonly vpc: ec2.IVpc;

    constructor(scope: Construct, id: string, props: NetworkLoadBalancerConstructProps) {
        super(scope, id);

        // ========================================
        // VALIDATION
        // ========================================
        if (props.loadBalancerName.length > 32) {
            throw new Error(
                `NLB name '${props.loadBalancerName}' exceeds the 32-character AWS limit ` +
                `(${props.loadBalancerName.length} chars). Shorten the name.`,
            );
        }

        if (props.eipAllocationId && !props.availabilityZone) {
            throw new Error(
                'eipAllocationId requires availabilityZone to be set. ' +
                'The NLB must be placed in a specific AZ to attach the EIP.',
            );
        }

        // ========================================
        // CONFIGURATION
        // ========================================
        this.vpc = props.vpc;
        const internetFacing = props.internetFacing ?? true;
        const crossZoneEnabled = props.crossZoneEnabled ?? false;
        const deletionProtection = props.deletionProtection ?? false;

        // ========================================
        // NLB SECURITY GROUP
        //
        // Explicit SG for the NLB. Without this, CDK auto-creates a
        // default SG that blocks all traffic (no inbound, "disallow all"
        // outbound) — causing health checks and forwarding to fail.
        //
        // Rules are added later via configureSecurityGroup().
        // ========================================
        this.securityGroup = new ec2.SecurityGroup(this, 'NlbSecurityGroup', {
            vpc: props.vpc,
            description: `Security group for NLB ${props.loadBalancerName}`,
            allowAllOutbound: false,
        });

        // ========================================
        // NETWORK LOAD BALANCER
        // ========================================
        this.loadBalancer = new elbv2.NetworkLoadBalancer(this, 'NLB', {
            vpc: props.vpc,
            internetFacing,
            loadBalancerName: props.loadBalancerName,
            crossZoneEnabled,
            deletionProtection,
            securityGroups: [this.securityGroup],
        });

        // ========================================
        // EIP ATTACHMENT via L1 SubnetMapping
        //
        // The L2 NetworkLoadBalancer doesn't support EIP natively.
        // We drop to the L1 CfnLoadBalancer to set subnetMappings
        // with an allocation ID, binding the EIP to the NLB.
        // ========================================
        if (props.availabilityZone) {
            const cfnNlb = this.loadBalancer.node.defaultChild as elbv2.CfnLoadBalancer;
            cfnNlb.subnets = undefined; // Remove auto-assigned subnets

            const subnetPool = internetFacing
                ? props.vpc.publicSubnets
                : props.vpc.privateSubnets;

            const targetSubnet = subnetPool.find(
                (s) => s.availabilityZone === props.availabilityZone,
            );
            if (!targetSubnet) {
                const subnetType = internetFacing ? 'public' : 'private';
                throw new Error(
                    `No ${subnetType} subnet found in ${props.availabilityZone}. ` +
                    'NLB requires a subnet in the specified AZ.',
                );
            }

            const subnetMapping: elbv2.CfnLoadBalancer.SubnetMappingProperty = {
                subnetId: targetSubnet.subnetId,
                ...(props.eipAllocationId && { allocationId: props.eipAllocationId }),
            };

            cfnNlb.subnetMappings = [subnetMapping];
        }

        // ========================================
        // CDK NAG SUPPRESSIONS
        // ========================================
        if (props.suppressAccessLogNag ?? true) {
            NagSuppressions.addResourceSuppressions(this.loadBalancer, [{
                id: 'AwsSolutions-ELB2',
                reason: 'NLB access logs not required — CloudFront access logs provide ' +
                    'edge-level visibility; NLB is internal routing only.',
            }]);
        }
    }

    // =========================================================================
    // PUBLIC ACCESSORS
    // =========================================================================

    /**
     * Get the load balancer ARN.
     */
    public get loadBalancerArn(): string {
        return this.loadBalancer.loadBalancerArn;
    }

    /**
     * Get the load balancer DNS name.
     */
    public get dnsName(): string {
        return this.loadBalancer.loadBalancerDnsName;
    }

    // =========================================================================
    // SECURITY GROUP CONFIGURATION
    // =========================================================================

    /**
     * Configure the NLB security group with proper inbound and outbound rules.
     *
     * CDK auto-creates a default SG on NLBs with no inbound rules and a
     * "disallow all" outbound. This method opens the SG so the NLB can:
     *
     * **Inbound** (from the internet → NLB):
     * - Accepts traffic on listener ports from `0.0.0.0/0` and `::/0`.
     * - This is safe because the NLB is Layer 4 (TCP passthrough) — it does
     *   NOT terminate TLS or inspect traffic. Fine-grained IP filtering is
     *   enforced by the instance-level Ingress SG.
     *
     * **Outbound** (NLB → targets):
     * - Forwards traffic on target ports to the VPC CIDR.
     * - Health check traffic also uses these outbound rules.
     *
     * @param ports - Listener/target ports to allow (e.g. `[80, 443]`)
     *
     * @example
     * ```typescript
     * nlb.configureSecurityGroup([80, 443]);
     * ```
     */
    public configureSecurityGroup(ports: number[]): void {
        const vpcCidr = this.vpc.vpcCidrBlock;

        for (const port of ports) {
            // Inbound: internet → NLB (IPv4 + IPv6)
            this.securityGroup.addIngressRule(
                ec2.Peer.anyIpv4(),
                ec2.Port.tcp(port),
                `TCP/${port} inbound from internet (IPv4)`,
            );
            this.securityGroup.addIngressRule(
                ec2.Peer.anyIpv6(),
                ec2.Port.tcp(port),
                `TCP/${port} inbound from internet (IPv6)`,
            );

            // Outbound: NLB → targets (health checks + forwarding)
            this.securityGroup.addEgressRule(
                ec2.Peer.ipv4(vpcCidr),
                ec2.Port.tcp(port),
                `TCP/${port} to targets (VPC CIDR)`,
            );
        }
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /**
     * Create a TCP target group with standardised health check.
     * Uses the VPC from the construct's own props — no need to pass it again.
     *
     * @param id - CDK construct ID
     * @param options - Target group configuration
     * @returns The created {@link elbv2.NetworkTargetGroup}
     *
     * @example
     * ```typescript
     * const httpTg = nlb.createTargetGroup('HttpTg', {
     *     targetGroupName: 'k8s-http',
     *     port: 80,
     * });
     * ```
     */
    public createTargetGroup(
        id: string,
        options: NlbTargetGroupOptions,
    ): elbv2.NetworkTargetGroup {
        return new elbv2.NetworkTargetGroup(this, id, {
            vpc: this.vpc,
            targetGroupName: options.targetGroupName,
            port: options.port,
            protocol: elbv2.Protocol.TCP,
            targetType: options.targetType ?? elbv2.TargetType.INSTANCE,
            healthCheck: {
                protocol: elbv2.Protocol.TCP,
                port: String(options.healthCheckPort ?? options.port),
                interval: options.healthCheckInterval ?? cdk.Duration.seconds(30),
                healthyThresholdCount: options.healthyThresholdCount ?? 3,
                unhealthyThresholdCount: options.unhealthyThresholdCount ?? 3,
            },
            deregistrationDelay: options.deregistrationDelay ?? cdk.Duration.seconds(30),
        });
    }

    /**
     * Add a TCP listener forwarding to a target group.
     *
     * @param id - CDK construct ID
     * @param port - Listener port (e.g. 80, 443)
     * @param targetGroup - Target group to forward traffic to
     * @returns The created {@link elbv2.NetworkListener}
     *
     * @example
     * ```typescript
     * nlb.addTcpListener('HttpListener', 80, httpTargetGroup);
     * ```
     */
    public addTcpListener(
        id: string,
        port: number,
        targetGroup: elbv2.NetworkTargetGroup,
    ): elbv2.NetworkListener {
        return this.loadBalancer.addListener(id, {
            port,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [targetGroup],
        });
    }
}
