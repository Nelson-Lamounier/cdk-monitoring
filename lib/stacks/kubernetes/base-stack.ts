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
 *   - Security Group (unified: HTTP/HTTPS, K8s API, monitoring ports)
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

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    K8S_API_PORT,
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
    PROMETHEUS_PORT,
    NODE_EXPORTER_PORT,
    LOKI_NODEPORT,
    TEMPO_NODEPORT,
} from '../../config/defaults';
import { S3BucketConstruct } from '../../common/storage';
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

    /** The security group for the Kubernetes cluster */
    public readonly securityGroup: ec2.SecurityGroup;

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
        // Security Group (unified — superset of monitoring + application ports)
        // =====================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'K8sSecurityGroup', {
            vpc: this.vpc,
            description: `Shared Kubernetes cluster security group (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k8s-cluster`,
            allowAllOutbound: true,
        });

        // Traefik Ingress: HTTP/HTTPS from anywhere (CloudFront → Traefik)
        this.securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(TRAEFIK_HTTP_PORT),
            'Allow HTTP traffic (Traefik Ingress)',
        );
        this.securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(TRAEFIK_HTTPS_PORT),
            'Allow HTTPS traffic (Traefik Ingress)',
        );

        // K8s API: Only from VPC CIDR (for SSM port-forwarding access)
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(K8S_API_PORT),
            'Allow K8s API from VPC (SSM port-forwarding)',
        );

        // Monitoring ports from VPC: Prometheus and Node Exporter
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(PROMETHEUS_PORT),
            'Allow Prometheus metrics from VPC',
        );
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(NODE_EXPORTER_PORT),
            'Allow Node Exporter metrics from VPC',
        );

        // Loki/Tempo NodePorts: accessible from VPC (ECS tasks → k8s monitoring)
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(LOKI_NODEPORT),
            'Allow Loki push API from VPC (cross-stack log shipping)',
        );
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
            ec2.Port.tcp(TEMPO_NODEPORT),
            'Allow Tempo OTLP gRPC from VPC (cross-stack trace shipping)',
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
                    'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:/ec2/${namePrefix}/*`,
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
