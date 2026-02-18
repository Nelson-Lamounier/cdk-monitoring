/**
 * @format
 * NextJS Networking Stack
 *
 * Consolidated networking resources for the Next.js application.
 * This stack combines ALB and Task Security Group.
 *
 * Domain: Networking Layer (rarely changes)
 *
 * Resources:
 * 1. ALB Security Group - Ingress from CloudFront IPs (or internet if unrestricted)
 * 2. Application Load Balancer - Internet-facing ALB
 * 3. Target Group - For ECS service registration
 * 4. Listeners - HTTPS with certificate + HTTP→HTTPS redirect
 * 5. Task Security Group - For ECS task ENIs (awsvpc)
 * 6. WAF Web ACL association (optional, when albWebAclArn provided)
 *
 * @example
 * ```typescript
 * const networkingStack = new NextJsNetworkingStack(app, 'NextJS-NetworkingStack-dev', {
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     vpc: sharedVpc,
 *     certificateArn: acmStack.certificateArn, // Optional for HTTPS
 * });
 * ```
 */

import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { LambdaFunctionConstruct } from '../../../common/compute';
import {
    ApplicationLoadBalancerConstruct,
} from '../../../common/networking/elb/application-load-balancer';
import {
    AcmCertificateDnsValidationConstruct,
} from '../../../common/security/acm-certificate';
import {
    BaseSecurityGroupConstruct,
    NextJsTaskSecurityGroupConstruct,
} from '../../../common/security/security-group';
import { Environment } from '../../../config';
import { getNextJsConfigs } from '../../../config/nextjs';
import { nextjsSsmPaths } from '../../../config/ssm-paths';

// =============================================================================
// STACK PROPS
// =============================================================================

/**
 * Props for NextJsNetworkingStack
 */
export interface NextJsNetworkingStackProps extends cdk.StackProps {
    /** Target environment */
    readonly targetEnvironment: Environment;

    /**
     * VPC for networking resources.
     * Provide either `vpc` (direct reference) or `vpcName` (synth-time lookup).
     * Using `vpcName` avoids cross-stack CloudFormation exports.
     */
    readonly vpc?: ec2.IVpc;

    /**
     * VPC Name tag for synth-time lookup via Vpc.fromLookup().
     * When provided, the stack resolves the VPC internally — no cross-stack exports.
     * Mutually exclusive with `vpc` (vpcName takes precedence).
     * @example 'shared-vpc-development'
     */
    readonly vpcName?: string;

    /** ACM certificate for HTTPS (required for HTTPS listener) */
    readonly certificate?: acm.ICertificate;

    /** ACM certificate ARN (alternative to certificate prop) */
    readonly certificateArn?: string;

    /** Domain name for Route 53 alias (optional) */
    readonly domainName?: string;

    // Cross-account certificate creation (alternative to certificate/certificateArn)
    /** Route 53 Hosted Zone ID for DNS validation (in root account) */
    readonly hostedZoneId?: string;

    /** Cross-account IAM role ARN to assume for Route 53 access */
    readonly crossAccountRoleArn?: string;

    /** Override deletion protection from config */
    readonly deletionProtection?: boolean;

    /** Override access logs from config */
    readonly accessLogsEnabled?: boolean;

    /** Health check path for target group @default '/api/health' */
    readonly healthCheckPath?: string;

    /** Container port for target group @default 3000 */
    readonly containerPort?: number;

    /** Database security group for task egress (optional) */
    readonly databaseSecurityGroup?: ec2.ISecurityGroup;

    /** Name prefix @default 'nextjs' */
    readonly namePrefix?: string;

    /**
     * SSM parameter path for the monitoring security group ID.
     * When provided, allows Prometheus to scrape application metrics
     * from task ENIs by adding an ingress rule on the container port.
     * @example '/monitoring-development/security-group/id'
     */
    readonly monitoringSgSsmPath?: string;

    /**
     * Restrict ALB ingress to CloudFront IPs only via the AWS-managed
     * prefix list `com.amazonaws.global.cloudfront.origin-facing`.
     *
     * When true, only CloudFront edge servers can reach the ALB,
     * preventing direct-to-ALB access that bypasses WAF.
     *
     * Requires real AWS account context during `cdk synth` for
     * the prefix list lookup.
     *
     * @default false (unrestricted — for backwards compatibility)
     */
    readonly restrictToCloudFront?: boolean;

    /**
     * WAF Web ACL ARN to associate with the ALB.
     * When provided, a regional WAF is attached to the ALB for
     * defense-in-depth (even if CloudFront WAF is also active).
     * @default undefined (no WAF on ALB)
     */
    readonly albWebAclArn?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * NextJsNetworkingStack - Consolidated networking layer for Next.js application
 *
 * This stack consolidates all networking resources into a single deployment unit:
 *
 * ALB (Internet-facing):
 * - Security group allowing HTTP/HTTPS from internet
 * - HTTPS listener with ACM certificate (when provided)
 * - HTTP → HTTPS redirect (when certificate provided)
 * - Target group for ECS service (IP target type for awsvpc)
 *
 * Task Security Group:
 * - Ingress: Only from ALB security group on app port (3000)
 * - Egress: HTTPS (443) for external APIs, AWS services
 * - Egress: Database port (optional, if databaseSecurityGroup provided)
 *
 * Note: When `restrictToCloudFront` is true, ALB ingress is limited to
 * CloudFront's origin-facing IPs via AWS managed prefix list.
 * This is the recommended configuration for production.
 */
export class NextJsNetworkingStack extends cdk.Stack {
    // ALB (construct kept private — consumers use loadBalancer/albSecurityGroup)
    private readonly albConstruct: ApplicationLoadBalancerConstruct;
    public readonly loadBalancer: elbv2.IApplicationLoadBalancer;
    public readonly albSecurityGroup: ec2.ISecurityGroup;
    public readonly targetGroup: elbv2.ApplicationTargetGroup;
    public readonly httpsListener?: elbv2.ApplicationListener;
    public readonly httpListener: elbv2.ApplicationListener;

    // Task Security Group (construct kept private — consumers use taskSecurityGroup)
    private readonly taskSecurityGroupConstruct: NextJsTaskSecurityGroupConstruct;
    public readonly taskSecurityGroup: ec2.SecurityGroup;

    // Environment
    public readonly targetEnvironment: Environment;

    constructor(scope: Construct, id: string, props: NextJsNetworkingStackProps) {
        super(scope, id, props);

        // Resolve VPC: prefer vpcName (synth-time lookup) over direct vpc reference
        if (!props.vpc && !props.vpcName) {
            throw new Error('NextJsNetworkingStack requires either vpc or vpcName prop');
        }
        const vpc = props.vpcName
            ? ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName: props.vpcName })
            : props.vpc!;

        // ========================================
        // CONFIGURATION
        // ========================================
        this.targetEnvironment = props.targetEnvironment;
        const configs = getNextJsConfigs(props.targetEnvironment);
        const namePrefix = props.namePrefix ?? 'nextjs';
        const ssmPaths = nextjsSsmPaths(props.targetEnvironment, namePrefix);

        const containerPort = props.containerPort ?? 3000;
        const healthCheckPath = props.healthCheckPath ?? '/api/health';
        const deletionProtection = props.deletionProtection ?? configs.alb.deletionProtection;
        const accessLogsEnabled = props.accessLogsEnabled ?? configs.alb.accessLogsEnabled;

        // ========================================
        // ALB SECURITY GROUP
        // ========================================
        const albSgConstruct = new BaseSecurityGroupConstruct(this, 'AlbSecurityGroup', {
            vpc,
            securityGroupName: `${namePrefix}-alb-${props.targetEnvironment}`,
            description: `Security group for ${namePrefix} Application Load Balancer`,
            allowAllOutbound: false, // Least-privilege: only egress to target group
        });

        this.albSecurityGroup = albSgConstruct.securityGroup;

        // Allow inbound HTTP/HTTPS
        if (props.restrictToCloudFront) {
            // Use the AWS-managed CloudFront origin-facing prefix list
            // to restrict ALB ingress to CloudFront IPs only.
            // This prevents direct-to-ALB access that bypasses WAF.
            const cfPrefixList = ec2.PrefixList.fromLookup(this, 'CloudFrontPrefixList', {
                prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
            });
            const cfPeer = ec2.Peer.prefixList(cfPrefixList.prefixListId);

            albSgConstruct.securityGroup.addIngressRule(
                cfPeer,
                ec2.Port.tcp(80),
                'Allow HTTP from CloudFront only',
            );
            albSgConstruct.securityGroup.addIngressRule(
                cfPeer,
                ec2.Port.tcp(443),
                'Allow HTTPS from CloudFront only',
            );
        } else {
            // Fallback: allow from internet (backwards-compatible default)
            // IPv4
            albSgConstruct.securityGroup.addIngressRule(
                ec2.Peer.anyIpv4(),
                ec2.Port.tcp(80),
                'Allow HTTP from internet (CloudFront restriction disabled)',
            );
            albSgConstruct.securityGroup.addIngressRule(
                ec2.Peer.anyIpv4(),
                ec2.Port.tcp(443),
                'Allow HTTPS from internet (CloudFront restriction disabled)',
            );
            // IPv6 — CloudFront enableIpv6 is true, so edge locations may
            // connect over IPv6. Without these rules the SG would reject them.
            albSgConstruct.securityGroup.addIngressRule(
                ec2.Peer.anyIpv6(),
                ec2.Port.tcp(80),
                'Allow HTTP from internet IPv6 (CloudFront restriction disabled)',
            );
            albSgConstruct.securityGroup.addIngressRule(
                ec2.Peer.anyIpv6(),
                ec2.Port.tcp(443),
                'Allow HTTPS from internet IPv6 (CloudFront restriction disabled)',
            );

            if (configs.isProduction) {
                cdk.Annotations.of(this).addWarning(
                    'ALB accepts traffic from the entire internet. ' +
                    'Set restrictToCloudFront=true to limit ingress to CloudFront IPs ' +
                    'and prevent WAF bypass.',
                );
            }
        }

        // Explicit egress: ALB → target group on container port only
        albSgConstruct.securityGroup.addEgressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(containerPort),
            `ALB egress to target group on port ${containerPort}`,
        );

        // ========================================
        // APPLICATION LOAD BALANCER
        // ========================================
        this.albConstruct = new ApplicationLoadBalancerConstruct(this, 'ALB', {
            environment: props.targetEnvironment,
            vpc,
            securityGroup: this.albSecurityGroup,
            loadBalancerName: `${namePrefix}-alb-${props.targetEnvironment}`,
            internetFacing: true,
            deletionProtection,
            accessLogsEnabled,
            namePrefix,
        });

        this.loadBalancer = this.albConstruct.loadBalancer;

        // ========================================
        // TARGET GROUP
        // ========================================
        this.targetGroup = this.albConstruct.createTargetGroup('TargetGroup', {
            targetGroupName: `${namePrefix}-tg-${props.targetEnvironment}`,
            port: containerPort,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP, // For awsvpc network mode
            healthCheckPath,
            deregistrationDelay: cdk.Duration.seconds(
                60,
            ),
        });

        // ========================================
        // LISTENERS
        // ========================================
        // Determine certificate source: passed certificate, ARN, or cross-account creation
        let certificate: acm.ICertificate | undefined = props.certificate
            ?? (props.certificateArn
                ? acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)
                : undefined);

        // Cross-account certificate creation (if no certificate provided but cross-account config is)
        if (!certificate && props.hostedZoneId && props.crossAccountRoleArn && props.domainName) {
            // Create validation Lambda
            const validationLambda = new LambdaFunctionConstruct(this, 'AcmValidationLambda', {
                functionName: `${namePrefix}-alb-acm-validation-${props.targetEnvironment}`,
                description: 'Cross-account ACM certificate validation for ALB HTTPS',
                entry: 'lambda/dns/acm-certificate-dns-validation.ts',
                handler: 'handler',
                timeout: cdk.Duration.minutes(10),
                memorySize: 256,
                namePrefix,
                logRetention: logs.RetentionDays.TWO_WEEKS,
                environment: {
                    AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
                },
            });

            // Create ACM certificate using cross-account DNS validation
            const certificateConstruct = new AcmCertificateDnsValidationConstruct(
                this,
                'AlbCertificate',
                {
                    environment: props.targetEnvironment,
                    domainName: props.domainName,
                    hostedZoneId: props.hostedZoneId,
                    crossAccountRoleArn: props.crossAccountRoleArn,
                    validationFunction: validationLambda.function,
                    logRetention: logs.RetentionDays.TWO_WEEKS,
                    namePrefix: `${namePrefix}-alb`,
                },
            );

            certificate = acm.Certificate.fromCertificateArn(
                this,
                'AlbCertRef',
                certificateConstruct.certificateArn,
            );
        }

        if (certificate) {
            // HTTPS listener with certificate
            this.httpsListener = this.albConstruct.createHttpsListener(
                'HttpsListener',
                this.targetGroup,
                [certificate],
            );

            // HTTP listener forwards to target group (NOT redirect!)
            // CloudFront connects via HTTP to ALB, so redirecting causes infinite loop.
            // User HTTPS is handled at CloudFront edge, not at ALB level.
            this.httpListener = this.albConstruct.createHttpListener(
                'HttpListener',
                this.targetGroup,
            );
        } else {
            // HTTP only (dev without certificate)
            this.httpListener = this.albConstruct.createHttpListener(
                'HttpListener',
                this.targetGroup,
            );

            if (configs.isProduction) {
                cdk.Annotations.of(this).addWarning(
                    'SECURITY WARNING: ALB in production without HTTPS. ' +
                    'Provide a certificate prop for secure traffic.',
                );
            }
        }

        // ========================================
        // TASK SECURITY GROUP
        // ========================================
        this.taskSecurityGroupConstruct = new NextJsTaskSecurityGroupConstruct(
            this,
            'TaskSecurityGroup',
            {
                vpc,
                albSecurityGroup: this.albSecurityGroup,
                environment: props.targetEnvironment,
                namePrefix,
                applicationPort: containerPort,
                databaseSecurityGroup: props.databaseSecurityGroup,
            }
        );

        this.taskSecurityGroup = this.taskSecurityGroupConstruct.securityGroup;

        // ========================================
        // MONITORING SG INGRESS (Prometheus → Task ENI)
        // Allows Prometheus to scrape /api/metrics on container port
        // Required because awsvpc tasks have their own ENI IP
        // Placed here (not in Application stack) to avoid cyclic
        // cross-stack references with the SSM parameter token.
        // ========================================
        if (props.monitoringSgSsmPath) {
            const monitoringSgId = ssm.StringParameter.valueForStringParameter(
                this,
                props.monitoringSgSsmPath,
            );
            const monitoringSg = ec2.SecurityGroup.fromSecurityGroupId(
                this,
                'MonitoringSg',
                monitoringSgId,
            );
            this.taskSecurityGroup.connections.allowFrom(
                monitoringSg,
                ec2.Port.tcp(containerPort),
                'Prometheus metrics scraping from monitoring instance',
            );
        }


        // ========================================
        // STACK OUTPUTS
        // ========================================
        new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
            value: this.loadBalancer.loadBalancerDnsName,
            description: 'ALB DNS name',
            exportName: `${this.stackName}-alb-dns`,
        });

        new cdk.CfnOutput(this, 'LoadBalancerArn', {
            value: this.loadBalancer.loadBalancerArn,
            description: 'ALB ARN',
            exportName: `${this.stackName}-alb-arn`,
        });

        new cdk.CfnOutput(this, 'TargetGroupArn', {
            value: this.targetGroup.targetGroupArn,
            description: 'Target group ARN for ECS service attachment',
            exportName: `${this.stackName}-tg-arn`,
        });

        new cdk.CfnOutput(this, 'AlbSecurityGroupId', {
            value: this.albSecurityGroup.securityGroupId,
            description: 'ALB security group ID',
            exportName: `${this.stackName}-alb-sg-id`,
        });

        new cdk.CfnOutput(this, 'TaskSecurityGroupId', {
            value: this.taskSecurityGroup.securityGroupId,
            description: 'Task security group ID for ECS tasks',
            exportName: `${this.stackName}-task-sg-id`,
        });

        if (this.httpsListener) {
            new cdk.CfnOutput(this, 'HttpsListenerArn', {
                value: this.httpsListener.listenerArn,
                description: 'HTTPS listener ARN',
            });
        }

        // ========================================
        // WAF WEB ACL ASSOCIATION (optional)
        // ========================================
        if (props.albWebAclArn) {
            new wafv2.CfnWebACLAssociation(this, 'AlbWafAssociation', {
                resourceArn: this.loadBalancer.loadBalancerArn,
                webAclArn: props.albWebAclArn,
            });
        }

        // ========================================
        // SSM PARAMETERS (cross-region bridge)
        // ========================================
        new ssm.StringParameter(this, 'SsmAlbDnsName', {
            parameterName: ssmPaths.albDnsName,
            stringValue: this.loadBalancer.loadBalancerDnsName,
            description: 'ALB DNS name for cross-region CloudFront origin',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmTaskSecurityGroupId', {
            parameterName: ssmPaths.taskSecurityGroupId,
            stringValue: this.taskSecurityGroup.securityGroupId,
            description: 'Task security group ID for cross-stack discovery',
            tier: ssm.ParameterTier.STANDARD,
        });

        // ========================================
        // TAGS
        // ========================================
        cdk.Tags.of(this).add('Stack', 'NextJsNetworking');
        cdk.Tags.of(this).add('Layer', 'Networking');
    }
}
