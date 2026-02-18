/**
 * @format
 * Security Group Constructs
 *
 * Reusable security group constructs for various workloads.
 *
 * Construct hierarchy:
 * - BaseSecurityGroupConstruct — Bare SG with no default rules. Use for any
 *   resource that needs custom rules (e.g., ALB, bastion).
 * - EcsSecurityGroupConstruct — ECS EC2 container instance SG with HTTP/HTTPS
 *   egress, ephemeral port self-reference, and monitoring ingress.
 * - NextJsTaskSecurityGroupConstruct — Task ENI SG (awsvpc) with restrictive
 *   outbound and ALB-only inbound. Strongest security posture.
 * - SecurityGroupConstruct — Configurable SG for monitoring or other workloads
 *   with trusted CIDR ingress and SSM-only mode.
 *
 * Tag strategy:
 * Only Purpose/Environment tags are applied here. Organizational tags
 * (Project, Owner, ManagedBy) come from TaggingAspect at app level.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Port configuration for services
 */
export interface PortConfiguration {
    /** Port number */
    readonly port: number;
    /** Description for the rule */
    readonly description: string;
}

/**
 * Default monitoring ports
 */
export const DEFAULT_MONITORING_PORTS: PortConfiguration[] = [
    { port: 3000, description: 'Grafana dashboard' },
    { port: 9090, description: 'Prometheus web UI' },
    { port: 9100, description: 'Node Exporter metrics' },
];

/**
 * Default ECS ports
 */
export const DEFAULT_ECS_PORTS: PortConfiguration[] = [
    { port: 80, description: 'HTTP' },
    { port: 443, description: 'HTTPS' },
    { port: 3000, description: 'Next.js default port' },
];

// =============================================================================
// Base Security Group Construct
// =============================================================================

/**
 * Props for BaseSecurityGroupConstruct
 */
export interface BaseSecurityGroupConstructProps {
    /** VPC for the security group */
    readonly vpc: ec2.IVpc;
    /** Security group name */
    readonly securityGroupName: string;
    /** Description for the security group */
    readonly description: string;
    /** Allow all outbound traffic @default true */
    readonly allowAllOutbound?: boolean;
    /** Name prefix for tagging @default 'app' */
    readonly namePrefix?: string;
}

/**
 * Base security group construct — minimal, no default rules.
 *
 * Creates a bare security group with NO ingress or egress rules added
 * automatically. Use this when you need full control over rules (e.g., ALB
 * security groups where rules depend on CloudFront prefix lists).
 *
 * @example
 * ```typescript
 * const sgConstruct = new BaseSecurityGroupConstruct(this, 'AlbSG', {
 *     vpc,
 *     securityGroupName: 'my-alb-sg',
 *     description: 'Security group for ALB',
 *     allowAllOutbound: false,
 * });
 * // Add custom rules as needed
 * sgConstruct.securityGroup.addIngressRule(...);
 * ```
 */
export class BaseSecurityGroupConstruct extends Construct {
    /** The security group */
    public readonly securityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: BaseSecurityGroupConstructProps) {
        super(scope, id);

        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            securityGroupName: props.securityGroupName,
            description: props.description,
            allowAllOutbound: props.allowAllOutbound ?? true,
        });

        // Tags — only Component. Organizational tags from TaggingAspect.
        cdk.Tags.of(this.securityGroup).add(
            'Component',
            `${props.namePrefix ?? 'app'}-security-group`,
        );
    }

    /**
     * Add ingress rule for a specific port from CIDR.
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
     * Add ingress rule for a specific port from another security group
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
}

// =============================================================================
// ECS Security Group Construct
// =============================================================================

/**
 * Props for EcsSecurityGroupConstruct
 */
export interface EcsSecurityGroupConstructProps {
    /** VPC for the security group */
    readonly vpc: ec2.IVpc;
    /**
     * Restrict outbound traffic to HTTPS (443) and HTTP (80) only
     * @default true - Recommended for security
     * If false, allows all outbound traffic
     */
    readonly restrictOutbound?: boolean;
    /**
     * Monitoring security group for Prometheus metrics scraping.
     * Port 9100: Node Exporter (host metrics)
     * Port 3000: Next.js /metrics (application metrics via prom-client)
     */
    readonly monitoringSecurityGroup?: ec2.ISecurityGroup;
    /** Custom ports to open @default none */
    readonly applicationPorts?: PortConfiguration[];
    /** Name prefix @default 'ecs' */
    readonly namePrefix?: string;
    /** Environment suffix */
    readonly environment?: string;
}

/**
 * Security group for ECS EC2 container instances (ECS-Instance-SG).
 *
 * Configuration per security requirements:
 *
 * **Inbound:**
 * - Port 9100 from Monitoring-SG (Prometheus scrapes Node Exporter)
 * - Internal container communication only
 * - NO SSH (use SSM Session Manager)
 * - NO direct ALB traffic (ALB → task ENI, not instance ENI)
 *
 * **Outbound:**
 * - Port 443 (AWS APIs: ECS, ECR, CloudWatch, SSM)
 * - Port 80 (Package repository mirrors)
 * - IPv4 + IPv6 for both
 *
 * @example
 * ```typescript
 * const sgConstruct = new EcsSecurityGroupConstruct(this, 'SG', {
 *     vpc,
 *     namePrefix: 'nextjs-ecs',
 *     environment: 'development',
 *     monitoringSecurityGroup: monitoringSG,
 * });
 * ```
 */
export class EcsSecurityGroupConstruct extends Construct {
    /** The security group */
    public readonly securityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: EcsSecurityGroupConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'ecs';
        const environment = props.environment ?? 'dev';
        const restrictOutbound = props.restrictOutbound ?? true;

        // =================================================================
        // Create Security Group with restricted outbound
        // =================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${namePrefix}-instances-${environment}`,
            description: 'Security group for ECS EC2 container instances',
            // Restrict outbound by default for security
            allowAllOutbound: !restrictOutbound,
        });

        // =================================================================
        // Outbound Rules (restricted to AWS APIs and package repos)
        // =================================================================
        if (restrictOutbound) {
            // HTTPS for AWS APIs (ECS, ECR, CloudWatch, SSM) and HTTPS updates
            this.securityGroup.addEgressRule(
                ec2.Peer.anyIpv4(),
                ec2.Port.tcp(443),
                'AWS APIs and HTTPS updates (IPv4)',
            );
            this.securityGroup.addEgressRule(
                ec2.Peer.anyIpv6(),
                ec2.Port.tcp(443),
                'AWS APIs and HTTPS updates (IPv6)',
            );

            // HTTP for package repository mirrors (dnf update)
            this.securityGroup.addEgressRule(
                ec2.Peer.anyIpv4(),
                ec2.Port.tcp(80),
                'Package repository mirrors (IPv4)',
            );
            this.securityGroup.addEgressRule(
                ec2.Peer.anyIpv6(),
                ec2.Port.tcp(80),
                'Package repository mirrors (IPv6)',
            );
        }

        // =================================================================
        // Inbound Rules
        // =================================================================

        // NextJS application port (internal only)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(3000),
            'NextJS application port',
        );

        // Node Exporter metrics (internal)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(9100),
            'Node Exporter metrics',
        );

        // Ephemeral ports for ECS dynamic port mapping (32768-65535)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcpRange(32768, 65535),
            'ECS dynamic port mapping range',
        );

        // Monitoring-SG ingress: Prometheus scrapes Node Exporter + App metrics
        if (props.monitoringSecurityGroup) {
            this.securityGroup.addIngressRule(
                props.monitoringSecurityGroup,
                ec2.Port.tcp(9100),
                'Prometheus scrapes Node Exporter',
            );
            this.securityGroup.addIngressRule(
                props.monitoringSecurityGroup,
                ec2.Port.tcp(3000),
                'Prometheus scrapes Next.js /metrics endpoint',
            );
        }

        // NOTE: No SSH (port 22) - Use SSM Session Manager
        // NOTE: No direct ALB traffic - ALB talks to task ENI, not instance ENI

        // =================================================================
        // Tags
        // =================================================================
        cdk.Tags.of(this.securityGroup).add('Purpose', 'ECS-Instance');
        cdk.Tags.of(this.securityGroup).add('Environment', environment);
    }

    /**
     * Allow ingress from an ALB security group (for bridge networking mode).
     * Scoped to the ephemeral port range (32768–65535) used by ECS dynamic
     * port mapping — not all TCP.
     *
     * Note: Not needed for awsvpc mode as ALB talks to task ENI directly.
     */
    allowFromAlb(albSecurityGroup: ec2.ISecurityGroup): void {
        this.securityGroup.addIngressRule(
            albSecurityGroup,
            ec2.Port.tcpRange(32768, 65535),
            'Allow traffic from ALB (bridge mode - ephemeral ports)',
        );
    }

    /**
     * Add ingress rule for a specific port from CIDR.
     * Delegates to `ec2.Peer.ipv4()` which validates octets and prefix length.
     */
    addIngressFromCidr(cidr: string, port: number, description: string): void {
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(cidr),
            ec2.Port.tcp(port),
            description,
        );
    }
}

// =============================================================================
// NextJS Task Security Group (awsvpc ENI)
// =============================================================================

/**
 * Props for NextJsTaskSecurityGroupConstruct
 */
export interface NextJsTaskSecurityGroupConstructProps {
    /** VPC for the security group */
    readonly vpc: ec2.IVpc;
    /** ALB security group - required for ingress on port 3000 */
    readonly albSecurityGroup: ec2.ISecurityGroup;
    /** Application port @default 3000 */
    readonly applicationPort?: number;
    /** Database security group (for PostgreSQL access) */
    readonly databaseSecurityGroup?: ec2.ISecurityGroup;
    /** Database port @default 5432 */
    readonly databasePort?: number;
    /** Name prefix @default 'nextjs' */
    readonly namePrefix?: string;
    /** Environment suffix */
    readonly environment?: string;
}

/**
 * Security group for NextJS task ENI (awsvpc networking mode).
 *
 * This is the key security boundary. Even though tasks have public IPs
 * in public subnets, no internet traffic can reach the app because only
 * the ALB security group is allowed as source.
 *
 * **Inbound:**
 * - Port 3000 from ALB-SG only (key security boundary)
 *
 * **Outbound:**
 * - Port 443 for external APIs, OAuth, AWS APIs (IPv4 + IPv6)
 * - Port 80 for HTTP-only endpoints and redirect chains (IPv4 + IPv6)
 * - Port 5432 for PostgreSQL (optional)
 *
 * @example
 * ```typescript
 * const taskSg = new NextJsTaskSecurityGroupConstruct(this, 'TaskSG', {
 *     vpc,
 *     albSecurityGroup: albStack.securityGroup,
 *     environment: 'development',
 * });
 * ```
 */
export class NextJsTaskSecurityGroupConstruct extends Construct {
    /** The security group */
    public readonly securityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: NextJsTaskSecurityGroupConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'nextjs';
        const environment = props.environment ?? 'dev';
        const applicationPort = props.applicationPort ?? 3000;
        const databasePort = props.databasePort ?? 5432;

        // =================================================================
        // Create Security Group (restricted outbound)
        // =================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${namePrefix}-task-${environment}`,
            description: 'Security group for NextJS ECS tasks (awsvpc ENI)',
            allowAllOutbound: false,
        });

        // =================================================================
        // Outbound Rules
        // =================================================================

        // HTTPS for external APIs, OAuth providers, AWS APIs (IPv4 + IPv6)
        this.securityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            'External APIs, OAuth providers, AWS APIs (IPv4)',
        );
        this.securityGroup.addEgressRule(
            ec2.Peer.anyIpv6(),
            ec2.Port.tcp(443),
            'External APIs, OAuth providers, AWS APIs (IPv6)',
        );

        // HTTP for HTTP-only endpoints and redirect chains that start on 80.
        // Consistent with EcsSecurityGroupConstruct. Without this, the app
        // silently fails to reach any HTTP-only webhook or legacy API.
        this.securityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            'HTTP-only endpoints and redirect chains (IPv4)',
        );
        this.securityGroup.addEgressRule(
            ec2.Peer.anyIpv6(),
            ec2.Port.tcp(80),
            'HTTP-only endpoints and redirect chains (IPv6)',
        );

        // PostgreSQL to database security group (if provided)
        if (props.databaseSecurityGroup) {
            this.securityGroup.addEgressRule(
                props.databaseSecurityGroup,
                ec2.Port.tcp(databasePort),
                'PostgreSQL database access',
            );
        }

        // =================================================================
        // Inbound Rules
        // =================================================================

        // Port 3000 from ALB only - key security boundary
        // This prevents direct internet access even with public IP
        this.securityGroup.addIngressRule(
            props.albSecurityGroup,
            ec2.Port.tcp(applicationPort),
            'Only ALB can reach the app',
        );

        // NOTE: No other inbound rules
        // Even though task has public IP (public subnet), internet traffic
        // cannot reach port 3000 because only ALB-SG is allowed

        // =================================================================
        // Tags
        // =================================================================
        cdk.Tags.of(this.securityGroup).add('Purpose', 'NextJS-Task');
        cdk.Tags.of(this.securityGroup).add('Environment', environment);
    }

    /**
     * Allow database access to a specific security group
     */
    allowDatabaseAccess(databaseSecurityGroup: ec2.ISecurityGroup, port: number = 5432): void {
        this.securityGroup.addEgressRule(
            databaseSecurityGroup,
            ec2.Port.tcp(port),
            'Database access',
        );
    }

    /**
     * Allow access to an external service (IPv4 + IPv6)
     */
    allowExternalService(port: number, description: string): void {
        this.securityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(port),
            `${description} (IPv4)`,
        );
        this.securityGroup.addEgressRule(
            ec2.Peer.anyIpv6(),
            ec2.Port.tcp(port),
            `${description} (IPv6)`,
        );
    }
}

// =============================================================================
// Security Group Construct (Generic, Reusable)
// =============================================================================

/**
 * Props for SecurityGroupConstruct
 *
 * Generic security group construct that can be used across projects.
 * Supports configurable trusted CIDRs, custom ports, and SSH access.
 */
export interface SecurityGroupConstructProps {
    /** VPC for the security group */
    readonly vpc: ec2.IVpc;
    /**
     * Trusted CIDR blocks for ingress rules (ignored when ssmOnlyAccess is true).
     * CIDR validation is delegated to `ec2.Peer.ipv4()` which validates octets
     * and prefix length.
     * @default [] — no CIDR-based ingress
     */
    readonly trustedCidrs?: string[];
    /**
     * Enable SSM-only access mode (recommended for production)
     *
     * When true:
     * - All CIDR-based ingress rules are skipped
     * - SSH ingress is disabled
     * - Only self-referencing rules for internal communication are created
     * - Access via SSM port forwarding (IAM-authenticated, fully audited)
     *
     * @default false
     */
    readonly ssmOnlyAccess?: boolean;
    /** Allow SSH access (ignored when ssmOnlyAccess is true) @default true */
    readonly allowSsh?: boolean;
    /**
     * Custom ports to open.
     * @default [] — no ports. Use MonitoringSecurityGroupConstruct for monitoring defaults.
     */
    readonly ports?: PortConfiguration[];
    /** Name prefix @default 'app' */
    readonly namePrefix?: string;
    /** Security group description @default 'Application security group' */
    readonly description?: string;
    /** Purpose tag value @default namePrefix */
    readonly purpose?: string;
}

/**
 * Generic, reusable security group construct.
 *
 * Use this for any project that needs trusted CIDR access with configurable ports.
 * Defaults to NO ports open — pass `ports` explicitly.
 *
 * Features:
 * - Configurable trusted CIDRs (optional, validated by CDK)
 * - Optional SSH access
 * - Configurable ports (empty by default)
 * - Internal self-reference for container communication (non-SSM mode)
 * - SSM-only mode with per-port self-referencing
 * - IPv4 + IPv6 egress
 *
 * @example
 * ```typescript
 * // For Monitoring project
 * const sgConstruct = new SecurityGroupConstruct(this, 'SG', {
 *     vpc,
 *     trustedCidrs: ['1.2.3.4/32'],
 *     ports: DEFAULT_MONITORING_PORTS,
 *     namePrefix: 'monitoring-development',
 *     purpose: 'Monitoring',
 * });
 *
 * // SSM-only (no CIDRs needed)
 * const sgConstruct = new SecurityGroupConstruct(this, 'SG', {
 *     vpc,
 *     ssmOnlyAccess: true,
 *     ports: DEFAULT_MONITORING_PORTS,
 *     namePrefix: 'monitoring-production',
 * });
 * ```
 */
export class SecurityGroupConstruct extends Construct {
    /** The security group */
    public readonly securityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string, props: SecurityGroupConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'app';
        const ports = props.ports ?? [];
        const description = props.description ?? 'Application security group';
        const purpose = props.purpose ?? namePrefix;
        const ssmOnlyAccess = props.ssmOnlyAccess ?? false;
        const trustedCidrs = props.trustedCidrs ?? [];

        // Validate CIDRs by attempting to construct Peer objects.
        // ec2.Peer.ipv4() validates octets (0-255) and prefix length (0-32),
        // which is more thorough than a regex.
        if (!ssmOnlyAccess && trustedCidrs.length > 0) {
            for (const cidr of trustedCidrs) {
                try {
                    ec2.Peer.ipv4(cidr);
                } catch (e) {
                    throw new Error(`Invalid CIDR: ${cidr} — ${(e as Error).message}`);
                }
            }
        }

        // Create security group
        this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
            vpc: props.vpc,
            securityGroupName: `${namePrefix}-sg`,
            description: ssmOnlyAccess
                ? `${description} (SSM-only access - no external ingress)`
                : description,
            allowAllOutbound: true,
        });

        // Tags
        cdk.Tags.of(this.securityGroup).add('Purpose', purpose);
        if (ssmOnlyAccess) {
            cdk.Tags.of(this.securityGroup).add('AccessMode', 'SSM-Only');
        }

        // =================================================================
        // Ingress Rules
        // =================================================================
        if (ssmOnlyAccess) {
            // SSM-Only Mode: Only self-referencing rules for internal communication
            // Access via SSM port forwarding (IAM-authenticated, fully audited)
            // No external CIDR-based ingress, no SSH

            // Self-referencing rules for each port (internal scraping)
            for (const portConfig of ports) {
                this.securityGroup.addIngressRule(
                    this.securityGroup,
                    ec2.Port.tcp(portConfig.port),
                    `${portConfig.description} (internal only - use SSM port forwarding for external access)`,
                );
            }
        } else {
            // Traditional Mode: CIDR-based ingress rules
            for (const cidr of trustedCidrs) {
                for (const portConfig of ports) {
                    this.securityGroup.addIngressRule(
                        ec2.Peer.ipv4(cidr),
                        ec2.Port.tcp(portConfig.port),
                        `${portConfig.description} from ${this.describeCidr(cidr)}`,
                    );
                }

                // SSH access (only in non-SSM mode)
                if (props.allowSsh !== false) {
                    this.securityGroup.addIngressRule(
                        ec2.Peer.ipv4(cidr),
                        ec2.Port.tcp(22),
                        `SSH access from ${this.describeCidr(cidr)}`,
                    );
                }
            }

            // Internal communication for container-to-container on configured ports
            for (const portConfig of ports) {
                this.securityGroup.addIngressRule(
                    this.securityGroup,
                    ec2.Port.tcp(portConfig.port),
                    `${portConfig.description} (internal)`,
                );
            }
        }
    }

    private describeCidr(cidr: string): string {
        return cidr.endsWith('/32') ? `IP ${cidr.replace('/32', '')}` : `CIDR ${cidr}`;
    }
}

// =============================================================================
// Backward Compatibility Aliases
// =============================================================================

/**
 * @deprecated Use SecurityGroupConstructProps instead
 */
export type MonitoringSecurityGroupConstructProps = SecurityGroupConstructProps;

/**
 * @deprecated Use SecurityGroupConstruct with `ports: DEFAULT_MONITORING_PORTS` instead
 *
 * Retained for backward compatibility with existing stacks.
 * Sets monitoring-specific defaults (Grafana, Prometheus, Node Exporter ports).
 */
export class MonitoringSecurityGroupConstruct extends SecurityGroupConstruct {
    constructor(scope: Construct, id: string, props: SecurityGroupConstructProps) {
        super(scope, id, {
            ...props,
            ports: props.ports ?? DEFAULT_MONITORING_PORTS,
            purpose: props.purpose ?? 'Monitoring',
        });
    }
}
