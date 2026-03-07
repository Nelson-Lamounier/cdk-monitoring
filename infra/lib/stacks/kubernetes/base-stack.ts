/**
 * @format
 * Kubernetes Base Stack — Long-Lived Infrastructure
 *
 * Contains the rarely-changing "base" infrastructure for the Kubernetes
 * cluster. Decoupled from the compute/runtime layer so that changes to
 * AMIs, manifests, boot scripts, or SSM documents do NOT trigger a
 * CloudFormation update on these resources.
 *
 * Resources Created:
 *   - VPC Lookup (Shared VPC from deploy-shared workflow)
 *   - Security Groups (role-specific: cluster-base, control-plane, ingress, monitoring)
 *   - KMS Key (CloudWatch log group encryption)
 *   - EBS Volume (persistent storage for Kubernetes data + PVCs)
 *   - Elastic IP (shared by Next.js CloudFront and SSM access)
 *   - S3 Bucket (k8s scripts & manifests — synced by CI pipeline)
 *   - SSM Parameters (cross-stack discovery: SG ID, EIP, scripts-bucket)
 *
 * Lifecycle: Only re-deployed when hardware specs, networking rules,
 * or storage configuration changes. Typically stable for weeks/months.
 *
 * @example
 * ```typescript
 * const baseStack = new KubernetesBaseStack(app, 'K8s-Base-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     configs: getK8sConfigs(Environment.DEVELOPMENT),
 *     namePrefix: 'k8s-development',
 *     ssmPrefix: '/k8s/development',
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

import { S3BucketConstruct } from '../../common/storage';
import {
    K8S_API_PORT,
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
    PROMETHEUS_PORT,
    NODE_EXPORTER_PORT,
    LOKI_NODEPORT,
    TEMPO_NODEPORT,
} from '../../config/defaults';
import { Environment } from '../../config/environments';
import { K8sConfigs } from '../../config/kubernetes';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for KubernetesBaseStack.
 *
 * Minimal configuration for the long-lived infrastructure layer.
 * Does NOT include any application-tier or runtime configuration.
 */
export interface KubernetesBaseStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** k8s project configuration (resolved from config layer) */
    readonly configs: K8sConfigs;

    /** Name prefix for resources @default 'k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for storing cluster info */
    readonly ssmPrefix: string;

    /**
     * VPC Name tag for synth-time lookup via Vpc.fromLookup().
     * @default 'shared-vpc-{environment}'
     */
    readonly vpcName?: string;

    /**
     * Admin IPv4 CIDR for direct access to Traefik (ops services).
     * Sourced from ALLOW_IPV4 env var. Added to the ingress SG
     * alongside the CloudFront managed prefix list.
     * @example '203.0.113.42/32'
     */
    readonly allowedIpv4?: string;

    /**
     * Admin IPv6 CIDR for direct access to Traefik (ops services).
     * Sourced from ALLOW_IPV6 env var.
     * @example '2a02:8084::/128'
     */
    readonly allowedIpv6?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Kubernetes Base Stack — Long-Lived Infrastructure.
 *
 * Contains VPC lookup, Security Group, KMS Key, EBS Volume, Elastic IP,
 * S3 scripts bucket, and SSM discovery parameters. These resources rarely
 * change and are decoupled from the runtime compute stack.
 */
export class KubernetesBaseStack extends cdk.Stack {
    /** The looked-up VPC */
    public readonly vpc: ec2.IVpc;

    /**
     * Base security group — intra-cluster communication (all nodes).
     * Explicit port rules for kubeadm: etcd, kubelet, VXLAN, Calico BGP, NodePorts.
     * Backward-compatible: this was previously the single shared SG.
     */
    public readonly securityGroup: ec2.SecurityGroup;

    /** Control plane SG — K8s API server access from VPC (SSM port-forwarding) */
    public readonly controlPlaneSg: ec2.SecurityGroup;

    /** Ingress SG — Traefik HTTP/HTTPS from anywhere (CloudFront + ops) */
    public readonly ingressSg: ec2.SecurityGroup;

    /** Monitoring SG — Prometheus, Node Exporter, Loki, Tempo from VPC */
    public readonly monitoringSg: ec2.SecurityGroup;

    /** KMS key for CloudWatch log group encryption */
    public readonly logGroupKmsKey: kms.Key;

    /** EBS volume for persistent Kubernetes data */
    public readonly ebsVolume: ec2.Volume;

    /** S3 bucket for k8s scripts and manifests */
    public readonly scriptsBucket: s3.IBucket;

    /** Elastic IP for stable external access */
    public readonly elasticIp: ec2.CfnEIP;

    constructor(scope: Construct, id: string, props: KubernetesBaseStackProps) {
        super(scope, id, props);

        const { configs, targetEnvironment } = props;
        const namePrefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // VPC Lookup
        // =====================================================================
        const vpcName = props.vpcName ?? `shared-vpc-${targetEnvironment}`;
        this.vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName });

        // =====================================================================
        // Security Group 1/4: Cluster Base (all nodes)
        //
        // Explicit intra-cluster port rules — replaces the previous protocol
        // "-1" (all traffic) self-referencing rule for least-privilege.
        // =====================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'K8sSecurityGroup', {
            vpc: this.vpc,
            description: `Shared Kubernetes cluster security group (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k8s-cluster`,
            allowAllOutbound: true,
        });

        // etcd client + peer communication (control plane)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcpRange(2379, 2380),
            'etcd client and peer (intra-cluster)',
        );
        // K8s API server (intra-cluster — kubelet → API)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(K8S_API_PORT),
            'K8s API server (intra-cluster)',
        );
        // kubelet API
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(10250),
            'kubelet API (intra-cluster)',
        );
        // kube-controller-manager
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(10257),
            'kube-controller-manager (intra-cluster)',
        );
        // kube-scheduler
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(10259),
            'kube-scheduler (intra-cluster)',
        );
        // VXLAN overlay networking
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.udp(4789),
            'VXLAN overlay networking (intra-cluster)',
        );
        // Calico BGP peering
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(179),
            'Calico BGP peering (intra-cluster)',
        );
        // NodePort services (K8s default range)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcpRange(30000, 32767),
            'NodePort services (intra-cluster)',
        );
        // CoreDNS (TCP + UDP)
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.tcp(53),
            'CoreDNS TCP (intra-cluster)',
        );
        this.securityGroup.addIngressRule(
            this.securityGroup,
            ec2.Port.udp(53),
            'CoreDNS UDP (intra-cluster)',
        );

        // =====================================================================
        // Security Group 2/4: Control Plane (control plane node only)
        // =====================================================================
        this.controlPlaneSg = new ec2.SecurityGroup(this, 'K8sControlPlaneSg', {
            vpc: this.vpc,
            description: `K8s control plane SG - API server access (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k8s-control-plane`,
            allowAllOutbound: false, // Outbound handled by base SG
        });

        // K8s API: Only from VPC CIDR (for SSM port-forwarding access)
        this.controlPlaneSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(K8S_API_PORT),
            'K8s API from VPC (SSM port-forwarding)',
        );

        // =====================================================================
        // Security Group 3/4: Ingress (monitoring worker only — Traefik)
        //
        // Defense in depth: SG allows CloudFront IPs (for public site) +
        // admin IPs (for ops services). Traefik IPAllowList middleware
        // provides the second layer of admin access control.
        // =====================================================================
        this.ingressSg = new ec2.SecurityGroup(this, 'K8sIngressSg', {
            vpc: this.vpc,
            description: `K8s ingress SG - Traefik HTTP/HTTPS (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k8s-ingress`,
            allowAllOutbound: false, // Outbound handled by base SG
        });

        // CloudFront origin-facing IPs (managed by AWS, auto-updated)
        // Required because CloudFront connects to the EIP origin using
        // AWS-owned IPs that change without notice.
        const cfPrefixListLookup = new cr.AwsCustomResource(
            this,
            'CloudFrontPrefixListLookup',
            {
                onCreate: {
                    service: '@aws-sdk/client-ec2',
                    action: 'DescribeManagedPrefixLists',
                    parameters: {
                        Filters: [{
                            Name: 'prefix-list-name',
                            Values: ['com.amazonaws.global.cloudfront.origin-facing'],
                        }],
                    },
                    physicalResourceId:
                        cr.PhysicalResourceId.of('cf-prefix-list-lookup'),
                },
                policy: cr.AwsCustomResourcePolicy.fromStatements([
                    new iam.PolicyStatement({
                        actions: ['ec2:DescribeManagedPrefixLists'],
                        resources: ['*'],
                    }),
                ]),
            },
        );
        const cfPrefixListId = cfPrefixListLookup.getResponseField(
            'PrefixLists.0.PrefixListId',
        );

        // Suppress CDK Nag: the AwsCustomResource creates a shared singleton
        // Lambda at the stack root (AWS679f53fac002430cb0da5b7982bd2287).
        // Its runtime is managed by CDK internals — we cannot control it.
        // The function only runs once at deploy time to look up the prefix list ID.
        NagSuppressions.addResourceSuppressionsByPath(this,
            `/${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
            [{
                id: 'AwsSolutions-L1',
                reason: 'AwsCustomResource singleton Lambda runtime is managed by CDK — deploy-time only, reads prefix list ID',
            }],
        );
        NagSuppressions.addResourceSuppressions(cfPrefixListLookup, [{
            id: 'AwsSolutions-IAM5',
            reason: 'ec2:DescribeManagedPrefixLists requires wildcard resource — read-only API call',
        }], true);

        // CloudFront → Traefik (HTTP origin pull only)
        // CloudFront terminates TLS at the edge and connects to the origin
        // over HTTP (port 80). Only port 80 uses the CF prefix list to stay
        // within the SG rule limit (~60 CF CIDRs count individually).
        this.ingressSg.addIngressRule(
            ec2.Peer.prefixList(cfPrefixListId),
            ec2.Port.tcp(TRAEFIK_HTTP_PORT),
            'HTTP from CloudFront origin-facing IPs',
        );

        // Admin IP → Traefik (direct ops access: Grafana, ArgoCD, Prometheus)
        if (props.allowedIpv4) {
            this.ingressSg.addIngressRule(
                ec2.Peer.ipv4(props.allowedIpv4),
                ec2.Port.tcp(TRAEFIK_HTTP_PORT),
                'HTTP from admin IPv4 (ops services)',
            );
            this.ingressSg.addIngressRule(
                ec2.Peer.ipv4(props.allowedIpv4),
                ec2.Port.tcp(TRAEFIK_HTTPS_PORT),
                'HTTPS from admin IPv4 (ops services)',
            );
        }
        if (props.allowedIpv6) {
            this.ingressSg.addIngressRule(
                ec2.Peer.ipv6(props.allowedIpv6),
                ec2.Port.tcp(TRAEFIK_HTTP_PORT),
                'HTTP from admin IPv6 (ops services)',
            );
            this.ingressSg.addIngressRule(
                ec2.Peer.ipv6(props.allowedIpv6),
                ec2.Port.tcp(TRAEFIK_HTTPS_PORT),
                'HTTPS from admin IPv6 (ops services)',
            );
        }

        // =====================================================================
        // Security Group 4/4: Monitoring (monitoring worker only)
        // =====================================================================
        this.monitoringSg = new ec2.SecurityGroup(this, 'K8sMonitoringSg', {
            vpc: this.vpc,
            description: `K8s monitoring SG - Prometheus/Loki/Tempo (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k8s-monitoring`,
            allowAllOutbound: false, // Outbound handled by base SG
        });

        this.monitoringSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(PROMETHEUS_PORT),
            'Prometheus metrics from VPC',
        );
        this.monitoringSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(NODE_EXPORTER_PORT),
            'Node Exporter metrics from VPC',
        );
        this.monitoringSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(LOKI_NODEPORT),
            'Loki push API from VPC (cross-stack log shipping)',
        );
        this.monitoringSg.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(TEMPO_NODEPORT),
            'Tempo OTLP gRPC from VPC (cross-stack trace shipping)',
        );

        // =====================================================================
        // KMS Key for CloudWatch Log Group Encryption
        // =====================================================================
        this.logGroupKmsKey = new kms.Key(this, 'LogGroupKey', {
            alias: `${namePrefix}-log-group`,
            description: `KMS key for ${namePrefix} CloudWatch log group encryption`,
            enableKeyRotation: true,
            removalPolicy: configs.removalPolicy,
        });

        this.logGroupKmsKey.addToResourcePolicy(new iam.PolicyStatement({
            actions: [
                'kms:Encrypt*',
                'kms:Decrypt*',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
                'kms:Describe*',
            ],
            principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
            resources: ['*'],
            conditions: {
                ArnLike: {
                    'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:/ec2/${namePrefix}*`,
                },
            },
        }));

        // =====================================================================
        // EBS Volume (persistent storage for Kubernetes data)
        // =====================================================================
        this.ebsVolume = new ec2.Volume(this, 'K8sDataVolume', {
            availabilityZone: `${this.region}a`,
            size: cdk.Size.gibibytes(configs.storage.volumeSizeGb),
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            removalPolicy: configs.removalPolicy,
            volumeName: `${namePrefix}-data`,
        });

        // =====================================================================
        // EBS Snapshot Lifecycle Policy (DLM)
        //
        // Automated daily snapshots with 7-day retention. Critical insurance
        // for single-node cluster: protects against etcd corruption, EBS
        // failure, and accidental data loss.
        // Cost: ~$0.05/GB/mo incremental → < $0.50/mo for 30 GB volume.
        // =====================================================================
        const dlmRole = new iam.Role(this, 'DlmLifecycleRole', {
            assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole'),
            ],
        });

        new dlm.CfnLifecyclePolicy(this, 'EbsSnapshotPolicy', {
            description: `Daily EBS snapshots for ${namePrefix} Kubernetes data volume`,
            state: 'ENABLED',
            executionRoleArn: dlmRole.roleArn,
            policyDetails: {
                resourceTypes: ['VOLUME'],
                targetTags: [{
                    key: 'Name',
                    value: `${namePrefix}-data`,
                }],
                schedules: [{
                    name: `${namePrefix}-daily-snapshot`,
                    createRule: {
                        interval: 24,
                        intervalUnit: 'HOURS',
                        times: ['03:00'],  // UTC — low-traffic window
                    },
                    retainRule: {
                        count: 7,  // Keep 7 days of daily snapshots
                    },
                    tagsToAdd: [{
                        key: 'CreatedBy',
                        value: 'DLM',
                    }, {
                        key: 'Environment',
                        value: targetEnvironment,
                    }],
                    copyTags: true,
                }],
            },
        });

        // =====================================================================
        // Elastic IP (shared endpoint for Next.js CloudFront + SSM access)
        // =====================================================================
        this.elasticIp = new ec2.CfnEIP(this, 'K8sElasticIp', {
            domain: 'vpc',
            tags: [{
                key: 'Name',
                value: `${namePrefix}-k8s-eip`,
            }],
        });

        // =====================================================================
        // S3 Access Logs Bucket (AwsSolutions-S1)
        // =====================================================================
        const accessLogsBucketConstruct = new S3BucketConstruct(this, 'K8sScriptsAccessLogsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${namePrefix}-k8s-scripts-logs-${this.account}-${this.region}`,
                purpose: 'k8s-scripts-access-logs',
                encryption: s3.BucketEncryption.S3_MANAGED,
                removalPolicy: configs.removalPolicy,
                autoDeleteObjects: !configs.isProduction,
                lifecycleRules: [{
                    expiration: cdk.Duration.days(90),
                }],
            },
        });

        NagSuppressions.addResourceSuppressions(accessLogsBucketConstruct.bucket, [{
            id: 'AwsSolutions-S1',
            reason: 'Access logs bucket cannot log to itself — this is the terminal logging destination',
        }]);

        // =====================================================================
        // S3 Bucket for K8s Scripts & Manifests
        //
        // Created in BaseStack so that the CI sync job can seed boot scripts
        // BEFORE the Compute stack launches EC2 instances (Day-1 safety).
        // =====================================================================
        const scriptsBucketConstruct = new S3BucketConstruct(this, 'K8sScriptsBucket', {
            environment: targetEnvironment,
            config: {
                bucketName: `${namePrefix}-k8s-scripts-${this.account}`,
                purpose: 'k8s-scripts-and-manifests',
                versioned: configs.isProduction,
                removalPolicy: configs.removalPolicy,
                autoDeleteObjects: !configs.isProduction,
                accessLogsBucket: accessLogsBucketConstruct.bucket,
                accessLogsPrefix: 'k8s-scripts-bucket/',
            },
        });
        this.scriptsBucket = scriptsBucketConstruct.bucket;

        // =====================================================================
        // SSM Parameters (for cross-project discovery)
        // =====================================================================
        new ssm.StringParameter(this, 'SecurityGroupIdParam', {
            parameterName: `${props.ssmPrefix}/security-group-id`,
            stringValue: this.securityGroup.securityGroupId,
            description: 'Kubernetes cluster security group ID',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ElasticIpParam', {
            parameterName: `${props.ssmPrefix}/elastic-ip`,
            stringValue: this.elasticIp.ref,
            description: 'Kubernetes cluster Elastic IP address (used by Edge stack as CloudFront origin)',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ScriptsBucketParam', {
            parameterName: `${props.ssmPrefix}/scripts-bucket`,
            stringValue: this.scriptsBucket.bucketName,
            description: 'S3 bucket for k8s scripts and manifests (used by CI for aws s3 sync)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // Tags
        // =====================================================================
        cdk.Tags.of(this).add('Stack', 'KubernetesBase');
        cdk.Tags.of(this).add('Layer', 'Base');

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: 'Shared VPC ID',
        });

        new cdk.CfnOutput(this, 'SecurityGroupId', {
            value: this.securityGroup.securityGroupId,
            description: 'Kubernetes cluster security group ID',
        });

        new cdk.CfnOutput(this, 'ElasticIpAddress', {
            value: this.elasticIp.ref,
            description: 'Kubernetes cluster Elastic IP address',
        });

        new cdk.CfnOutput(this, 'EbsVolumeId', {
            value: this.ebsVolume.volumeId,
            description: 'Kubernetes data EBS volume ID',
        });

        new cdk.CfnOutput(this, 'LogGroupKmsKeyArn', {
            value: this.logGroupKmsKey.keyArn,
            description: 'KMS key ARN for CloudWatch log group encryption',
        });

        new cdk.CfnOutput(this, 'ScriptsBucketName', {
            value: this.scriptsBucket.bucketName,
            description: 'S3 bucket for k8s scripts and manifests',
        });
    }
}
