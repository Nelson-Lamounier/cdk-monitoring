/**
 * @format
 * Next.js K8s Compute Stack
 *
 * Creates compute and networking resources for deploying the Next.js
 * application to Kubernetes. This is the K8s migration equivalent of:
 *   - NextJsComputeStack (ECS Cluster + ASG + IAM)
 *   - NextJsNetworkingStack (ALB + Task Security Group)
 *   - NextJsApplicationStack (Task Definition + ECS Service)
 *
 * These three stacks are replaced by a single K8s compute stack that
 * provisions a k3s agent node joining the existing monitoring cluster.
 *
 * Follows the same pattern as K8sComputeStack (monitoring):
 *   - Security Group (HTTP/HTTPS + K8s API from VPC)
 *   - IAM Role (ECR pull, SSM, CloudWatch, DynamoDB, S3)
 *   - Launch Template (Amazon Linux 2023, IMDSv2)
 *   - ASG (min=1, max=1, single AZ, cfn-signal)
 *   - Elastic IP (stable CloudFront origin, replaces ALB)
 *   - S3 Bucket + BucketDeployment (k8s manifests sync)
 *   - SSM Run Command Document (manifest re-deploy without instance replacement)
 *
 * @example
 * ```typescript
 * const k8sComputeStack = new NextJsK8sComputeStack(app, 'NextJS-K8s-Compute-dev', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     k8sConfig: getNextJsK8sConfig(Environment.DEVELOPMENT),
 *     namePrefix: 'nextjs-k8s-development',
 *     ssmPrefix: '/nextjs-k8s/development',
 * });
 * ```
 */

import { NagSuppressions } from 'cdk-nag';

import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import {
    AutoScalingGroupConstruct,
    LaunchTemplateConstruct,
    SsmRunCommandDocument,
    UserDataBuilder,
} from '../../../common/index';
import {
    TRAEFIK_HTTP_PORT,
    TRAEFIK_HTTPS_PORT,
    K3S_API_PORT,
    NODE_EXPORTER_PORT,
} from '../../../config/defaults';
import { Environment } from '../../../config/environments';
import { NextJsK8sConfig } from '../../../config/nextjs/k8s-configurations';

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for NextJsK8sComputeStack
 */
export interface NextJsK8sComputeStackProps extends cdk.StackProps {
    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /** K8s deployment configuration (resolved from config layer) */
    readonly k8sConfig: NextJsK8sConfig;

    /** Name prefix for resources @default 'nextjs-k8s' */
    readonly namePrefix?: string;

    /** SSM parameter prefix for storing cluster info */
    readonly ssmPrefix: string;

    /**
     * VPC Name tag for synth-time lookup via Vpc.fromLookup().
     * @default 'shared-vpc-{environment}'
     */
    readonly vpcName?: string;

    /**
     * SSM paths for DynamoDB table ARN and KMS key ARN.
     * Required for granting the task role read access.
     */
    readonly dynamoTableArns?: string[];

    /**
     * SSM path for DynamoDB KMS key ARN.
     * Required for granting kms:Decrypt to the task role.
     */
    readonly dynamoKmsKeySsmPath?: string;

    /**
     * S3 bucket ARNs to grant read access (e.g., static assets bucket).
     */
    readonly s3ReadBucketArns?: string[];

    /**
     * SSM parameter path wildcard for granting read access.
     * @example '/nextjs/development/*'
     */
    readonly ssmParameterPath?: string;

    /**
     * Secrets Manager path pattern for granting read access.
     * @example 'nextjs/development/*'
     */
    readonly secretsManagerPathPattern?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Next.js K8s Compute Stack.
 *
 * Replaces NextJsComputeStack + NextJsNetworkingStack + NextJsApplicationStack
 * with a single stack that provisions a k3s agent node.
 *
 * The node:
 * - Joins the existing k3s cluster (monitoring) via agent mode
 * - Is labeled `role=application` with a matching taint
 * - Runs the Next.js K8s manifests (Deployment, Service, IngressRoute)
 * - Has an Elastic IP for stable CloudFront origin (replaces ALB)
 *
 * Traffic flow: CloudFront → Elastic IP → Traefik IngressRoute → K8s Service → Pod
 */
export class NextJsK8sComputeStack extends cdk.Stack {
    /** The security group for the k3s application node */
    public readonly securityGroup: ec2.SecurityGroup;

    /** The Auto Scaling Group */
    public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

    /** The IAM role for the k3s application node */
    public readonly instanceRole: iam.IRole;

    /** CloudWatch log group for instance logs */
    public readonly logGroup?: logs.LogGroup;

    /** Elastic IP for stable external access (CloudFront origin) */
    public readonly elasticIp: ec2.CfnEIP;

    constructor(scope: Construct, id: string, props: NextJsK8sComputeStackProps) {
        super(scope, id, props);

        const { k8sConfig, targetEnvironment } = props;
        const namePrefix = props.namePrefix ?? 'nextjs-k8s';

        // =====================================================================
        // VPC Lookup
        // =====================================================================
        const vpcName = props.vpcName ?? `shared-vpc-${targetEnvironment}`;
        const vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcName });

        // =====================================================================
        // Security Group
        // =====================================================================
        this.securityGroup = new ec2.SecurityGroup(this, 'K8sSecurityGroup', {
            vpc,
            description: `Next.js k3s application node security group (${targetEnvironment})`,
            securityGroupName: `${namePrefix}-k3s-app-node`,
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

        // K8s API: Only from VPC CIDR (for SSM port-forwarding / cluster join)
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(K3S_API_PORT),
            'Allow K8s API from VPC (agent join / SSM port-forwarding)',
        );

        // Node Exporter: from VPC for Prometheus scraping
        this.securityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(NODE_EXPORTER_PORT),
            'Allow Node Exporter metrics from VPC',
        );

        // =====================================================================
        // KMS Key for CloudWatch Log Group Encryption
        // =====================================================================
        const logGroupKmsKey = new kms.Key(this, 'LogGroupKey', {
            alias: `${namePrefix}-log-group`,
            description: `KMS key for ${namePrefix} CloudWatch log group encryption`,
            enableKeyRotation: true,
            removalPolicy: k8sConfig.isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        logGroupKmsKey.addToResourcePolicy(new iam.PolicyStatement({
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
        // Launch Template + ASG
        // =====================================================================
        const userData = ec2.UserData.forLinux();

        const launchTemplateConstruct = new LaunchTemplateConstruct(this, 'LaunchTemplate', {
            securityGroup: this.securityGroup,
            instanceType: k8sConfig.instanceType,
            volumeSizeGb: k8sConfig.rootVolumeSizeGb,
            detailedMonitoring: k8sConfig.detailedMonitoring,
            userData,
            namePrefix,
            logGroupKmsKey,
        });

        // Single-node: max=1 (application node, stateless)
        const asgConstruct = new AutoScalingGroupConstruct(this, 'Compute', {
            vpc,
            launchTemplate: launchTemplateConstruct.launchTemplate,
            minCapacity: 1,
            maxCapacity: 1,
            desiredCapacity: 1,
            rollingUpdate: {
                minInstancesInService: 0,
                pauseTimeMinutes: k8sConfig.signalsTimeoutMinutes,
            },
            namePrefix,
            enableTerminationLifecycleHook: true,
            useSignals: k8sConfig.useSignals,
            signalsTimeoutMinutes: k8sConfig.signalsTimeoutMinutes,
            subnetSelection: {
                subnetType: ec2.SubnetType.PUBLIC,
                availabilityZones: [`${this.region}a`],
            },
        });

        // Get ASG logical ID for cfn-signal
        const asgCfnResource = asgConstruct.autoScalingGroup.node.defaultChild as cdk.CfnResource;
        const asgLogicalId = asgCfnResource.logicalId;

        // =====================================================================
        // S3 Access Logs Bucket (AwsSolutions-S1)
        // =====================================================================
        const accessLogsBucket = new s3.Bucket(this, 'K8sScriptsAccessLogsBucket', {
            bucketName: `${namePrefix}-k8s-scripts-logs-${this.account}-${this.region}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: k8sConfig.isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: !k8sConfig.isProduction,
            enforceSSL: true,
            lifecycleRules: [{
                expiration: cdk.Duration.days(90),
            }],
        });

        NagSuppressions.addResourceSuppressions(accessLogsBucket, [
            {
                id: 'AwsSolutions-S1',
                reason: 'Access logs bucket cannot log to itself — this is the terminal logging destination',
            },
        ]);

        // =====================================================================
        // S3 Bucket for K8s Manifests
        // =====================================================================
        const scriptsBucket = new s3.Bucket(this, 'K8sScriptsBucket', {
            bucketName: `${namePrefix}-${targetEnvironment}-k8s-manifests-${this.account}`,
            removalPolicy: k8sConfig.isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: !k8sConfig.isProduction,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: k8sConfig.isProduction,
            serverAccessLogsBucket: accessLogsBucket,
            serverAccessLogsPrefix: 'k8s-manifests-bucket/',
        });

        // Sync Next.js K8s manifests from the root k8s/ directory
        new s3deploy.BucketDeployment(this, 'K8sAppManifestsDeployment', {
            sources: [s3deploy.Source.asset('./k8s')],
            destinationBucket: scriptsBucket,
            destinationKeyPrefix: 'k8s',
            prune: true,
        });

        try {
            NagSuppressions.addResourceSuppressionsByPath(
                this,
                `/${this.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource`,
                [
                    {
                        id: 'AwsSolutions-L1',
                        reason: 'BucketDeployment Lambda runtime is managed by CDK singleton — cannot override',
                    },
                ],
            );
        } catch {
            // Suppression path may not exist in test environments — this is expected
        }

        // =====================================================================
        // SSM Run Command Document (manifest deployment)
        //
        // Enables re-running manifest apply without instance replacement.
        // Triggered by:
        //   - GitHub Actions pipeline (deploy-manifests job)
        //   - Manual: aws ssm send-command --document-name <name> --targets ...
        // =====================================================================
        const manifestDeployDoc = new SsmRunCommandDocument(this, 'ManifestDeployDocument', {
            documentName: `${namePrefix}-deploy-manifests`,
            description: 'Deploy Next.js K8s manifests — re-syncs from S3, applies via kubectl',
            parameters: {
                S3Bucket: {
                    type: 'String',
                    description: 'S3 bucket containing k8s manifests',
                    default: scriptsBucket.bucketName,
                },
                S3KeyPrefix: {
                    type: 'String',
                    description: 'S3 key prefix',
                    default: 'k8s',
                },
                SsmPrefix: {
                    type: 'String',
                    description: 'SSM parameter prefix for secrets',
                    default: props.ssmPrefix,
                },
                Region: {
                    type: 'String',
                    description: 'AWS region',
                    default: this.region,
                },
            },
            steps: [{
                name: 'deployManifests',
                commands: [
                    'export K8S_DIR=/opt/nextjs-k8s',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    'export S3_KEY_PREFIX="{{S3KeyPrefix}}"',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    '',
                    '# Re-sync manifests from S3',
                    'mkdir -p $K8S_DIR',
                    'aws s3 sync s3://$S3_BUCKET/$S3_KEY_PREFIX/ $K8S_DIR/ --region $AWS_REGION',
                    '',
                    '# Apply via kustomize',
                    'k3s kubectl apply -k $K8S_DIR/apps/nextjs/',
                    '',
                    'echo "Next.js manifests applied successfully"',
                ],
                timeoutSeconds: 600,
            }],
        });

        // =====================================================================
        // User Data (k3s agent bootstrap)
        //
        // ORDERING: cfn-signal fires after AWS CLI install (needed for SSM
        // token lookup) but BEFORE dnf update and k3s agent join.
        //
        //   installAwsCli → sendCfnSignal → updateSystem → installK3sAgent
        //                                                → deployNextJsManifests
        // =====================================================================
        userData.addCommands(
            'set -euxo pipefail',
            '',
            'exec > >(tee /var/log/user-data.log) 2>&1',
            'echo "=== Next.js K8s application node user data started at $(date) ==="',
        );

        // Resolve the k3s server EIP from SSM for the agent to join
        const k3sServerSsmPrefix = k8sConfig.k3sServerSsmPrefix;

        new UserDataBuilder(userData, { skipPreamble: true })
            .installAwsCli()
            .sendCfnSignal({
                stackName: this.stackName,
                asgLogicalId,
                region: this.region,
            })
            .updateSystem()
            .installK3sAgent({
                serverUrl: `https://RESOLVE_AT_RUNTIME:6443`,
                tokenSsmPath: `${k3sServerSsmPrefix}/node-token`,
                nodeLabel: k8sConfig.nodeLabel,
                nodeTaint: k8sConfig.nodeTaint,
                region: this.region,
            })
            .addCustomScript(`
# =============================================================================
# Deploy Next.js K8s Manifests (first boot)
# Downloads from S3, applies via kustomize
# =============================================================================

echo "=== Downloading Next.js K8s manifests from S3 ==="
K8S_DIR="/opt/nextjs-k8s"
mkdir -p $K8S_DIR

aws s3 sync s3://${scriptsBucket.bucketName}/k8s/ $K8S_DIR/ --region ${this.region}
echo "Manifests downloaded to $K8S_DIR"

# Wait for kubectl to be available (agent needs to register first)
echo "Waiting for kubectl to be available..."
for i in {1..30}; do
    if k3s kubectl get nodes &>/dev/null; then
        echo "kubectl is available (waited \${i} seconds)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "WARNING: kubectl not available after 30s — manifests will be applied by SSM"
    fi
    sleep 2
done

# Apply the Next.js application manifests
echo "Applying Next.js K8s manifests..."
k3s kubectl apply -k $K8S_DIR/apps/nextjs/ || echo "WARNING: kubectl apply failed — will retry via SSM"

echo "=== Next.js K8s first-boot deployment complete ==="`)
            .addCompletionMarker();

        this.autoScalingGroup = asgConstruct.autoScalingGroup;
        this.instanceRole = launchTemplateConstruct.instanceRole;
        this.logGroup = launchTemplateConstruct.logGroup;

        // Grant S3 read access for manifest download
        scriptsBucket.grantRead(this.instanceRole);

        // =====================================================================
        // IAM Grants
        // =====================================================================

        // ECR pull (for deploying container images to k3s)
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'EcrPull',
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetAuthorizationToken',
            ],
            resources: ['*'],
        }));

        // SSM parameter read/write (k3s agent stores instance info, reads join token)
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmParameterAccess',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:PutParameter',
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:GetParametersByPath',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
                // Read access to k3s server SSM params (join token, server IP)
                `arn:aws:ssm:${this.region}:${this.account}:parameter${k3sServerSsmPrefix}/*`,
            ],
        }));

        // Grant application-level SSM read (for Next.js env vars)
        if (props.ssmParameterPath) {
            this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
                sid: 'SsmNextJsParameterRead',
                effect: iam.Effect.ALLOW,
                actions: [
                    'ssm:GetParameter',
                    'ssm:GetParameters',
                    'ssm:GetParametersByPath',
                ],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmParameterPath}`,
                ],
            }));
        }

        // DynamoDB read access (for SSR queries)
        if (props.dynamoTableArns && props.dynamoTableArns.length > 0) {
            this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
                sid: 'DynamoDbRead',
                effect: iam.Effect.ALLOW,
                actions: [
                    'dynamodb:GetItem',
                    'dynamodb:Query',
                    'dynamodb:Scan',
                    'dynamodb:BatchGetItem',
                ],
                resources: [
                    ...props.dynamoTableArns,
                    ...props.dynamoTableArns.map(arn => `${arn}/index/*`),
                ],
            }));
        }

        // DynamoDB KMS key access (customer-managed key)
        if (props.dynamoKmsKeySsmPath) {
            this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
                sid: 'DynamoKmsDecrypt',
                effect: iam.Effect.ALLOW,
                actions: [
                    'kms:Decrypt',
                    'kms:DescribeKey',
                ],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'kms:ViaService': `dynamodb.${this.region}.amazonaws.com`,
                    },
                },
            }));
        }

        // S3 read access (for static assets bucket)
        if (props.s3ReadBucketArns && props.s3ReadBucketArns.length > 0) {
            this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
                sid: 'S3Read',
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:GetObject',
                    's3:ListBucket',
                ],
                resources: [
                    ...props.s3ReadBucketArns,
                    ...props.s3ReadBucketArns.map(arn => `${arn}/*`),
                ],
            }));
        }

        // Secrets Manager access (for auth-secret, auth-url, etc.)
        if (props.secretsManagerPathPattern) {
            this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
                sid: 'SecretsManagerRead',
                effect: iam.Effect.ALLOW,
                actions: [
                    'secretsmanager:GetSecretValue',
                ],
                resources: [
                    `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.secretsManagerPathPattern}`,
                ],
            }));
        }

        // =====================================================================
        // Elastic IP (stable endpoint for CloudFront origin)
        // =====================================================================
        this.elasticIp = new ec2.CfnEIP(this, 'K8sElasticIp', {
            domain: 'vpc',
            tags: [{
                key: 'Name',
                value: `${namePrefix}-k3s-app-eip`,
            }],
        });

        // =====================================================================
        // SSM Parameters (for cross-stack discovery)
        // =====================================================================
        new ssm.StringParameter(this, 'SecurityGroupIdParam', {
            parameterName: `${props.ssmPrefix}/security-group-id`,
            stringValue: this.securityGroup.securityGroupId,
            description: 'Next.js k3s application node security group ID',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'ElasticIpParam', {
            parameterName: `${props.ssmPrefix}/elastic-ip`,
            stringValue: this.elasticIp.ref,
            description: 'Next.js k3s application node Elastic IP (CloudFront origin)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // Stack Outputs
        // =====================================================================
        new cdk.CfnOutput(this, 'InstanceRoleArn', {
            value: this.instanceRole.roleArn,
            description: 'Next.js k3s application node IAM Role ARN',
        });

        new cdk.CfnOutput(this, 'AutoScalingGroupName', {
            value: this.autoScalingGroup.autoScalingGroupName,
            description: 'Next.js k3s Application Node ASG Name',
        });

        new cdk.CfnOutput(this, 'ElasticIpAddress', {
            value: this.elasticIp.ref,
            description: 'Next.js k3s Elastic IP address (CloudFront origin)',
        });

        new cdk.CfnOutput(this, 'SecurityGroupId', {
            value: this.securityGroup.securityGroupId,
            description: 'Next.js k3s application node security group ID',
        });

        if (this.logGroup) {
            new cdk.CfnOutput(this, 'LogGroupName', {
                value: this.logGroup.logGroupName,
                description: 'CloudWatch Log Group for Next.js k3s node',
            });
        }

        new cdk.CfnOutput(this, 'SsmConnectCommand', {
            value: `aws ssm start-session --target <instance-id> --region ${this.region}`,
            description: 'SSM Session Manager connect command (replace <instance-id>)',
        });

        new cdk.CfnOutput(this, 'ManifestDeployDocumentName', {
            value: manifestDeployDoc.documentName,
            description: 'SSM document name for Next.js manifest deployment',
        });

        new cdk.CfnOutput(this, 'ScriptsBucketName', {
            value: scriptsBucket.bucketName,
            description: 'S3 bucket containing Next.js K8s manifests',
        });
    }
}
