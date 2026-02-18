/**
 * @format
 * Application Load Balancer Construct
 *
 * Reusable construct for creating an Application Load Balancer.
 *
 * Blueprint Pattern:
 * - Stack creates security group and passes it as prop
 * - Construct handles ALB creation and configuration
 *
 * Features:
 * - Security best practices (drop invalid headers, desync mitigation)
 * - Configurable access logging with lifecycle management
 * - Production environment warnings
 * - Helper methods for listeners, target groups, and routing rules
 *
 * Tag strategy:
 * - Organizational tags (Environment, Project, Owner, ManagedBy) are applied
 *   by TaggingAspect at the app level — NOT duplicated here.
 * - Only construct-specific tags are applied: `Component: ALB` and `Name`.
 *
 * Output strategy:
 * - Constructs expose public properties; consuming stacks decide what to
 *   export via CfnOutput. This avoids duplicate outputs and unwanted
 *   cross-stack coupling.
 */

import { NagSuppressions } from 'cdk-nag';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    Environment,
} from '../../../config';

// =============================================================================
// Props
// =============================================================================

/**
 * Target group options for createTargetGroup.
 *
 * Note: `vpc` is not required — the construct uses the VPC from its own props.
 */
export interface TargetGroupOptions {
    readonly targetGroupName: string;
    readonly port: number;
    readonly protocol?: elbv2.ApplicationProtocol;
    readonly targetType: elbv2.TargetType;
    readonly healthCheckPath?: string;
    readonly deregistrationDelay?: cdk.Duration;
}

/**
 * Props for ApplicationLoadBalancerConstruct
 */
export interface ApplicationLoadBalancerConstructProps {
    /** Target environment */
    readonly environment: Environment;

    /** VPC for the load balancer */
    readonly vpc: ec2.IVpc;

    /** Security group for the load balancer (from stack) */
    readonly securityGroup: ec2.ISecurityGroup;

    /**
     * Load balancer name.
     * Must be 32 characters or fewer (AWS ALB naming limit).
     */
    readonly loadBalancerName: string;

    /** Internet-facing or internal @default true */
    readonly internetFacing?: boolean;

    /** Enable deletion protection @default false (true recommended for prod) */
    readonly deletionProtection?: boolean;

    /** Enable access logs @default false (true recommended for prod) */
    readonly accessLogsEnabled?: boolean;

    /** S3 bucket for access logs (created if not provided when enabled) */
    readonly accessLogBucket?: s3.IBucket;

    /** Access log prefix @default 'alb-logs' */
    readonly accessLogPrefix?: string;

    /** VPC subnet selection @default PUBLIC for internet-facing, PRIVATE for internal */
    readonly vpcSubnets?: ec2.SubnetSelection;

    /** Idle timeout @default 60 seconds */
    readonly idleTimeout?: cdk.Duration;

    /** Enable HTTP/2 @default true */
    readonly http2Enabled?: boolean;

    /** Drop invalid header fields @default true */
    readonly dropInvalidHeaderFields?: boolean;

    /** Resource name prefix @default 'alb' */
    readonly namePrefix?: string;
}

// =============================================================================
// Construct
// =============================================================================

/**
 * Application Load Balancer Construct.
 *
 * Creates an ALB with security best practices and helper methods
 * for common configurations.
 *
 * Exposes `loadBalancer`, `loadBalancerArn`, `dnsName`, `securityGroup`,
 * and `accessLogBucket` as public properties. Does NOT create CfnOutput —
 * that is the consuming stack's responsibility.
 *
 * @example
 * ```typescript
 * // Stack creates security group
 * const albSg = new BaseSecurityGroupConstruct(this, 'AlbSg', {
 *     vpc, securityGroupName: 'alb-sg', description: 'ALB security group'
 * });
 *
 * // Stack passes security group to construct
 * const alb = new ApplicationLoadBalancerConstruct(this, 'ALB', {
 *     environment: Environment.PRODUCTION,
 *     vpc,
 *     securityGroup: albSg.securityGroup,
 *     loadBalancerName: 'web-alb',
 *     internetFacing: true,
 *     deletionProtection: true,
 *     accessLogsEnabled: true,
 * });
 *
 * // Create target group (uses VPC from construct props)
 * const tg = alb.createTargetGroup('Tg', {
 *     targetGroupName: 'web-tg',
 *     port: 3000,
 *     targetType: elbv2.TargetType.IP,
 * });
 * ```
 */
export class ApplicationLoadBalancerConstruct extends Construct {
    /** The Application Load Balancer */
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

    /** The security group (passed from stack) */
    public readonly securityGroup: ec2.ISecurityGroup;

    /** Access log bucket (if enabled) */
    public readonly accessLogBucket?: s3.IBucket;

    /** Target environment */
    public readonly environment: Environment;

    /** VPC reference (stored for use by helper methods) */
    private readonly vpc: ec2.IVpc;

    constructor(scope: Construct, id: string, props: ApplicationLoadBalancerConstructProps) {
        super(scope, id);

        // ========================================
        // VALIDATION
        //
        // Required props (vpc, securityGroup, loadBalancerName) are enforced
        // by TypeScript at compile time. Runtime validation focuses on
        // constraints the type system can't express.
        // ========================================
        if (props.loadBalancerName.length > 32) {
            throw new Error(
                `ALB name '${props.loadBalancerName}' exceeds the 32-character AWS limit ` +
                `(${props.loadBalancerName.length} chars). Shorten the name.`,
            );
        }

        // ========================================
        // CONFIGURATION
        // ========================================
        this.environment = props.environment;
        this.securityGroup = props.securityGroup;
        this.vpc = props.vpc;

        const internetFacing = props.internetFacing ?? true;
        const deletionProtection = props.deletionProtection ?? false;
        const accessLogsEnabled = props.accessLogsEnabled ?? false;
        const idleTimeout = props.idleTimeout
            ?? cdk.Duration.seconds(60);

        const isProduction = props.environment === Environment.PRODUCTION;
        const removeOnDelete = !isProduction;

        // ========================================
        // PRODUCTION WARNINGS
        // ========================================
        if (isProduction && !deletionProtection) {
            cdk.Annotations.of(this).addWarning(
                'SECURITY WARNING: Deletion protection is disabled in production. ' +
                'Consider enabling deletionProtection: true',
            );
        }

        if (isProduction && !accessLogsEnabled) {
            cdk.Annotations.of(this).addWarning(
                'SECURITY WARNING: Access logs are disabled in production. ' +
                'Consider enabling accessLogsEnabled: true',
            );
        }

        // ========================================
        // ACCESS LOG BUCKET
        //
        // ALB access logs are append-only — versioning is disabled because
        // log files are never overwritten or deleted until the lifecycle
        // rule expires them. This avoids doubling storage cost.
        //
        // autoDeleteObjects is omitted to avoid the hidden Lambda + IAM
        // resources it creates. The lifecycle rule handles retention.
        // ========================================
        if (accessLogsEnabled && !props.accessLogBucket) {
            const stack = cdk.Stack.of(this);
            const retentionDays = {
                development: 7,
                staging: 30,
                production: 90,
            }[props.environment] ?? 7;

            this.accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
                bucketName: `${props.loadBalancerName}-logs-${stack.account}`,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
                versioned: false,
                removalPolicy: removeOnDelete
                    ? cdk.RemovalPolicy.DESTROY
                    : cdk.RemovalPolicy.RETAIN,
                lifecycleRules: [
                    {
                        id: 'ExpireLogs',
                        enabled: true,
                        expiration: cdk.Duration.days(retentionDays),
                        transitions: [
                            {
                                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                                transitionAfter: cdk.Duration.days(
                                    30,
                                ),
                            },
                        ],
                    },
                ],
            });

            NagSuppressions.addResourceSuppressions(
                this.accessLogBucket,
                [
                    {
                        id: 'AwsSolutions-S1',
                        reason: 'This is a logging bucket — should not have server access logs',
                    },
                ],
                true,
            );
        } else if (accessLogsEnabled && props.accessLogBucket) {
            this.accessLogBucket = props.accessLogBucket;
        }

        // ========================================
        // SUBNET SELECTION
        // ========================================
        const vpcSubnets = props.vpcSubnets ?? (
            internetFacing
                ? { subnetType: ec2.SubnetType.PUBLIC }
                : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
        );

        // ========================================
        // APPLICATION LOAD BALANCER
        // ========================================
        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            vpc: props.vpc,
            loadBalancerName: props.loadBalancerName,
            internetFacing,
            securityGroup: this.securityGroup,
            vpcSubnets,
            deletionProtection,
            idleTimeout,
            http2Enabled: props.http2Enabled ?? true,
            dropInvalidHeaderFields: props.dropInvalidHeaderFields ?? true,
            desyncMitigationMode: elbv2.DesyncMitigationMode.DEFENSIVE,
        });

        // ========================================
        // ACCESS LOGS
        // ========================================
        if (accessLogsEnabled && this.accessLogBucket) {
            this.loadBalancer.logAccessLogs(
                this.accessLogBucket,
                props.accessLogPrefix ?? 'alb-logs',
            );
        }

        // ========================================
        // COMPONENT-SPECIFIC TAGS
        // (Environment/Project/ManagedBy via TaggingAspect)
        // ========================================
        cdk.Tags.of(this.loadBalancer).add('Component', 'ALB');
        cdk.Tags.of(this.loadBalancer).add('Name', props.loadBalancerName);

        // ========================================
        // CDK NAG SUPPRESSIONS
        // ========================================
        if (internetFacing) {
            NagSuppressions.addResourceSuppressions(
                this.securityGroup,
                [
                    {
                        id: 'AwsSolutions-EC23',
                        reason: 'Internet-facing ALB requires 0.0.0.0/0 ingress for HTTP/HTTPS',
                    },
                ],
                true,
            );
        }

        if (!accessLogsEnabled) {
            NagSuppressions.addResourceSuppressions(
                this.loadBalancer,
                [
                    {
                        id: 'AwsSolutions-ELB2',
                        reason: 'Access logs intentionally disabled for this environment',
                    },
                ],
                true,
            );
        }
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /**
     * Get the load balancer ARN
     */
    public get loadBalancerArn(): string {
        return this.loadBalancer.loadBalancerArn;
    }

    /**
     * Get the load balancer DNS name
     */
    public get dnsName(): string {
        return this.loadBalancer.loadBalancerDnsName;
    }

    /**
     * Create HTTP to HTTPS redirect listener.
     *
     * **WARNING: CloudFront compatibility** — Do NOT use this method when the ALB
     * sits behind CloudFront configured with HTTP-only origin protocol. CloudFront
     * connects to the ALB via HTTP; adding an HTTP→HTTPS redirect will cause an
     * infinite redirect loop. Use `createHttpListener` instead and let CloudFront
     * handle viewer-facing HTTPS via its own viewer protocol policy.
     *
     * @example
     * ```typescript
     * // Direct internet-facing ALB (no CloudFront in front)
     * alb.addHttpToHttpsRedirect();
     * ```
     */
    public addHttpToHttpsRedirect(): elbv2.ApplicationListener {
        return this.loadBalancer.addListener('HttpRedirect', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.redirect({
                protocol: 'HTTPS',
                port: '443',
                permanent: true,
            }),
        });
    }

    /**
     * Create a target group with standardized health check.
     * Uses the VPC from the construct's own props — no need to pass it again.
     *
     * @example
     * ```typescript
     * const tg = alb.createTargetGroup('WebTg', {
     *     targetGroupName: 'web-tg',
     *     port: 3000,
     *     targetType: elbv2.TargetType.IP,
     *     healthCheckPath: '/api/health',
     * });
     * ```
     */
    public createTargetGroup(
        id: string,
        options: TargetGroupOptions,
    ): elbv2.ApplicationTargetGroup {
        return new elbv2.ApplicationTargetGroup(this, id, {
            vpc: this.vpc,
            targetGroupName: options.targetGroupName,
            port: options.port,
            protocol: options.protocol ?? elbv2.ApplicationProtocol.HTTP,
            targetType: options.targetType,
            healthCheck: {
                path: options.healthCheckPath ?? '/',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                protocol: elbv2.Protocol.HTTP,
            },
            deregistrationDelay: options.deregistrationDelay
                ?? cdk.Duration.seconds(60),
        });
    }

    /**
     * Create HTTP listener with fixed 503 response.
     * Useful as a placeholder listener before target groups are attached.
     *
     * @example
     * ```typescript
     * const httpListener = alb.createHttpListenerWithFixedResponse('Http503');
     * // Later: add target group rules to the listener
     * ```
     */
    public createHttpListenerWithFixedResponse(id: string): elbv2.ApplicationListener {
        return this.loadBalancer.addListener(id, {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.fixedResponse(503, {
                contentType: 'text/plain',
                messageBody: 'Service Unavailable',
            }),
        });
    }

    /**
     * Create HTTPS listener with fixed 503 response.
     * Useful as a placeholder listener before target groups are attached.
     *
     * @example
     * ```typescript
     * const httpsListener = alb.createHttpsListenerWithFixedResponse('Https503', [cert]);
     * // Later: add target group rules to the listener
     * ```
     */
    public createHttpsListenerWithFixedResponse(
        id: string,
        certificates: elbv2.IListenerCertificate[],
    ): elbv2.ApplicationListener {
        return this.loadBalancer.addListener(id, {
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates,
            defaultAction: elbv2.ListenerAction.fixedResponse(503, {
                contentType: 'text/plain',
                messageBody: 'Service Unavailable',
            }),
        });
    }

    /**
     * Create HTTP listener forwarding to target group.
     *
     * @example
     * ```typescript
     * // Behind CloudFront: use HTTP listener (CloudFront terminates TLS)
     * const listener = alb.createHttpListener('Http', targetGroup);
     * ```
     */
    public createHttpListener(
        id: string,
        targetGroup: elbv2.ApplicationTargetGroup,
    ): elbv2.ApplicationListener {
        return this.loadBalancer.addListener(id, {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.forward([targetGroup]),
        });
    }

    /**
     * Create HTTPS listener forwarding to target group.
     *
     * @example
     * ```typescript
     * const listener = alb.createHttpsListener('Https', targetGroup, [cert]);
     * ```
     */
    public createHttpsListener(
        id: string,
        targetGroup: elbv2.ApplicationTargetGroup,
        certificates: elbv2.IListenerCertificate[],
    ): elbv2.ApplicationListener {
        return this.loadBalancer.addListener(id, {
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates,
            defaultAction: elbv2.ListenerAction.forward([targetGroup]),
        });
    }

    /**
     * Add path-based routing rule to a listener.
     *
     * @example
     * ```typescript
     * alb.addPathBasedRule(listener, 'ApiRoute', {
     *     pathPattern: '/api/*',
     *     targetGroup: apiTargetGroup,
     *     priority: 100,
     * });
     * ```
     */
    public addPathBasedRule(
        listener: elbv2.ApplicationListener,
        id: string,
        options: {
            pathPattern: string;
            targetGroup: elbv2.ApplicationTargetGroup;
            priority: number;
        },
    ): elbv2.ApplicationListenerRule {
        return new elbv2.ApplicationListenerRule(this, id, {
            listener,
            priority: options.priority,
            conditions: [elbv2.ListenerCondition.pathPatterns([options.pathPattern])],
            action: elbv2.ListenerAction.forward([options.targetGroup]),
        });
    }

    /**
     * Add host-based routing rule to a listener.
     *
     * @example
     * ```typescript
     * alb.addHostBasedRule(listener, 'ApiHost', {
     *     hostHeader: 'api.example.com',
     *     targetGroup: apiTargetGroup,
     *     priority: 200,
     * });
     * ```
     */
    public addHostBasedRule(
        listener: elbv2.ApplicationListener,
        id: string,
        options: {
            hostHeader: string;
            targetGroup: elbv2.ApplicationTargetGroup;
            priority: number;
        },
    ): elbv2.ApplicationListenerRule {
        return new elbv2.ApplicationListenerRule(this, id, {
            listener,
            priority: options.priority,
            conditions: [elbv2.ListenerCondition.hostHeaders([options.hostHeader])],
            action: elbv2.ListenerAction.forward([options.targetGroup]),
        });
    }
}

// =============================================================================
// Backward Compatibility
// =============================================================================

/**
 * @deprecated Use ApplicationLoadBalancerConstruct instead
 */
export { ApplicationLoadBalancerConstruct as AlbConstruct };
