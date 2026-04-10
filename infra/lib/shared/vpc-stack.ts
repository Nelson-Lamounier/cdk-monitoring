/**
 * @format
 * Shared VPC Stack
 *
 * Provides shared networking infrastructure used by all projects.
 * Stack name: {Namespace}-VpcStack-{environment} (e.g., Monitoring-VpcStack-dev)
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../config/environments';

/**
 * Flow log configuration
 */
export interface FlowLogConfig {
    readonly logGroupName?: string;
    readonly retentionDays?: logs.RetentionDays;
    readonly encryptionKey?: kms.IKey;
    readonly createEncryptionKey?: boolean;
}

/**
 * Gateway Endpoint configuration
 */
export interface GatewayEndpointConfig {
    readonly enableS3Endpoint?: boolean;
    readonly enableDynamoDbEndpoint?: boolean;
}

/**
 * Props for SharedVpcStack
 */
export interface SharedVpcStackProps extends cdk.StackProps {
    /** Target environment (renamed to avoid CDK Stack.environment conflict) */
    readonly targetEnvironment: Environment;
    /** CIDR block for the VPC */
    readonly cidr?: string;
    /** Maximum number of Availability Zones */
    readonly maxAzs?: number;
    /** Flow log configuration */
    readonly flowLogConfig?: FlowLogConfig;
    /** Gateway Endpoint configuration */
    readonly gatewayEndpoints?: GatewayEndpointConfig;
    /** ECR repository name @default 'nextjs-frontend' */
    readonly ecrRepositoryName?: string;
    /** Enable ECR repository creation @default true */
    readonly createEcrRepository?: boolean;
    /** Admin ECR repository name @default 'start-admin' */
    readonly adminEcrRepositoryName?: string;
    /** Enable admin ECR repository creation @default true */
    readonly createAdminEcrRepository?: boolean;
    /** public-api BFF ECR repository name @default 'public-api' */
    readonly publicApiEcrRepositoryName?: string;
    /** Enable public-api ECR repository creation @default true */
    readonly createPublicApiEcrRepository?: boolean;
    /** admin-api BFF ECR repository name @default 'admin-api' */
    readonly adminApiEcrRepositoryName?: string;
    /** Enable admin-api ECR repository creation @default true */
    readonly createAdminApiEcrRepository?: boolean;
}


/**
 * Shared VPC Stack - one per environment, used by all projects.
 *
 * @example
 * ```typescript
 * const vpc = new SharedVpcStack(app, 'Shared-VpcStack-dev', {
 *     environment: Environment.DEVELOPMENT,
 * });
 * ```
 */
export class SharedVpcStack extends cdk.Stack {
    /** The VPC created by this stack */
    public readonly vpc: ec2.Vpc;
    /** The target environment (dev, staging, prod) */
    public readonly targetEnvironment: Environment;
    /** KMS key for flow log encryption */
    public readonly flowLogEncryptionKey?: kms.IKey;
    /** CloudWatch log group for flow logs */
    public readonly flowLogGroup?: logs.ILogGroup;
    /** S3 Gateway Endpoint */
    public readonly s3Endpoint?: ec2.GatewayVpcEndpoint;
    /** DynamoDB Gateway Endpoint */
    public readonly dynamoDbEndpoint?: ec2.GatewayVpcEndpoint;
    /** ECR Repository for container images (nextjs-frontend) */
    public readonly ecrRepository?: ecr.Repository;
    /** ECR Repository for admin container images (start-admin) */
    public readonly adminEcrRepository?: ecr.Repository;
    /** ECR Repository for the public-api BFF */
    public readonly publicApiEcrRepository?: ecr.Repository;
    /** ECR Repository for the admin-api BFF */
    public readonly adminApiEcrRepository?: ecr.Repository;

    constructor(scope: Construct, id: string, props: SharedVpcStackProps) {
        super(scope, id, props);

        this.targetEnvironment = props.targetEnvironment;

        // Create VPC with public subnets only (cost-optimized)
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            vpcName: `shared-vpc-${props.targetEnvironment}`,
            ipAddresses: ec2.IpAddresses.cidr(props.cidr ?? '10.0.0.0/16'),
            maxAzs: props.maxAzs ?? 2,
            natGateways: 0,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
        });

        // Configure Gateway Endpoints (free)
        this.configureGatewayEndpoints(props.gatewayEndpoints);

        // Configure Flow Logs if enabled
        if (props.flowLogConfig) {
            this.configureFlowLogs(props.flowLogConfig);
        }

        // =====================================================================
        // ECR Repository - Shared container registry for all applications
        // Decoupled from application stacks; applications discover via SSM/tags
        // =====================================================================
        if (props.createEcrRepository !== false) {
            const repoName = props.ecrRepositoryName ?? 'nextjs-frontend';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.ecrRepository = new ecr.Repository(this, 'EcrRepository', {
                repositoryName: repoName,
                imageScanOnPush: true,
                // MUTABLE for all environments (Option B: Service-Only deployment)
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });




            // SSM Parameters for ECR discovery
            const ecrSsmPrefix = `/shared/ecr/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmEcrRepositoryUri', {
                parameterName: `${ecrSsmPrefix}/repository-uri`,
                stringValue: this.ecrRepository.repositoryUri,
                description: `Shared ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmEcrRepositoryArn', {
                parameterName: `${ecrSsmPrefix}/repository-arn`,
                stringValue: this.ecrRepository.repositoryArn,
                description: `Shared ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmEcrRepositoryName', {
                parameterName: `${ecrSsmPrefix}/repository-name`,
                stringValue: this.ecrRepository.repositoryName,
                description: `Shared ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // ECR Outputs
            new cdk.CfnOutput(this, 'EcrRepositoryUri', {
                value: this.ecrRepository.repositoryUri,
                description: 'ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'EcrRepositoryArn', {
                value: this.ecrRepository.repositoryArn,
                description: 'ECR Repository ARN',
            });

            new cdk.CfnOutput(this, 'DockerLoginCommand', {
                value: `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
                description: 'Docker login command for ECR',
            });
        }

        // =====================================================================
        // ECR Repository (Admin) — Separate container registry for start-admin
        // Uses the same lifecycle rules and encryption as the frontend repo.
        // SSM params stored under /shared/ecr-admin/{env}/ for CI discovery.
        // =====================================================================
        if (props.createAdminEcrRepository !== false) {
            const adminRepoName = props.adminEcrRepositoryName ?? 'start-admin';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.adminEcrRepository = new ecr.Repository(this, 'AdminEcrRepository', {
                repositoryName: adminRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for admin ECR discovery
            const adminEcrSsmPrefix = `/shared/ecr-admin/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmAdminEcrRepositoryUri', {
                parameterName: `${adminEcrSsmPrefix}/repository-uri`,
                stringValue: this.adminEcrRepository.repositoryUri,
                description: `Admin ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminEcrRepositoryArn', {
                parameterName: `${adminEcrSsmPrefix}/repository-arn`,
                stringValue: this.adminEcrRepository.repositoryArn,
                description: `Admin ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminEcrRepositoryName', {
                parameterName: `${adminEcrSsmPrefix}/repository-name`,
                stringValue: this.adminEcrRepository.repositoryName,
                description: `Admin ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // Admin ECR Outputs
            new cdk.CfnOutput(this, 'AdminEcrRepositoryUri', {
                value: this.adminEcrRepository.repositoryUri,
                description: 'Admin ECR Repository URI for docker push/pull (start-admin)',
            });

            new cdk.CfnOutput(this, 'AdminEcrRepositoryArn', {
                value: this.adminEcrRepository.repositoryArn,
                description: 'Admin ECR Repository ARN (start-admin)',
            });
        }

        // =====================================================================
        // ECR Repository (public-api) — BFF for portfolio visitors
        // Read-only API: GET /articles, GET /articles/:slug, GET /health
        // SSM params stored under /shared/ecr-public-api/{env}/ for CI discovery.
        // =====================================================================
        if (props.createPublicApiEcrRepository !== false) {
            const publicApiRepoName = props.publicApiEcrRepositoryName ?? 'public-api';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.publicApiEcrRepository = new ecr.Repository(this, 'PublicApiEcrRepository', {
                repositoryName: publicApiRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for public-api ECR discovery
            const publicApiEcrSsmPrefix = `/shared/ecr-public-api/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmPublicApiEcrRepositoryUri', {
                parameterName: `${publicApiEcrSsmPrefix}/repository-uri`,
                stringValue: this.publicApiEcrRepository.repositoryUri,
                description: `public-api BFF ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmPublicApiEcrRepositoryArn', {
                parameterName: `${publicApiEcrSsmPrefix}/repository-arn`,
                stringValue: this.publicApiEcrRepository.repositoryArn,
                description: `public-api BFF ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmPublicApiEcrRepositoryName', {
                parameterName: `${publicApiEcrSsmPrefix}/repository-name`,
                stringValue: this.publicApiEcrRepository.repositoryName,
                description: `public-api BFF ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // public-api ECR Outputs
            new cdk.CfnOutput(this, 'PublicApiEcrRepositoryUri', {
                value: this.publicApiEcrRepository.repositoryUri,
                description: 'public-api BFF ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'PublicApiEcrRepositoryArn', {
                value: this.publicApiEcrRepository.repositoryArn,
                description: 'public-api BFF ECR Repository ARN',
            });
        }

        // =====================================================================
        // ECR Repository (admin-api) — BFF for authenticated admin operations
        // Write-heavy: publish articles, presign S3 uploads, trigger Lambdas.
        // Protected by Cognito JWT; IngressRoute priority 200 (/api/admin/*).
        // SSM params stored under /shared/ecr-admin-api/{env}/ for CI discovery.
        // =====================================================================
        if (props.createAdminApiEcrRepository !== false) {
            const adminApiRepoName = props.adminApiEcrRepositoryName ?? 'admin-api';
            const isProduction = props.targetEnvironment === Environment.PRODUCTION;

            this.adminApiEcrRepository = new ecr.Repository(this, 'AdminApiEcrRepository', {
                repositoryName: adminApiRepoName,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.MUTABLE,
                encryption: ecr.RepositoryEncryption.AES_256,
                removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
                lifecycleRules: [
                    {
                        rulePriority: 1,
                        description: 'Remove untagged images after 30 days',
                        tagStatus: ecr.TagStatus.UNTAGGED,
                        maxImageAge: cdk.Duration.days(30),
                    },
                    {
                        rulePriority: 2,
                        description: 'Keep only 50 most recent tagged images',
                        tagStatus: ecr.TagStatus.ANY,
                        maxImageCount: 50,
                    },
                ],
            });

            // SSM Parameters for admin-api ECR discovery
            const adminApiEcrSsmPrefix = `/shared/ecr-admin-api/${props.targetEnvironment}`;

            new ssm.StringParameter(this, 'SsmAdminApiEcrRepositoryUri', {
                parameterName: `${adminApiEcrSsmPrefix}/repository-uri`,
                stringValue: this.adminApiEcrRepository.repositoryUri,
                description: `admin-api BFF ECR repository URI for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminApiEcrRepositoryArn', {
                parameterName: `${adminApiEcrSsmPrefix}/repository-arn`,
                stringValue: this.adminApiEcrRepository.repositoryArn,
                description: `admin-api BFF ECR repository ARN for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            new ssm.StringParameter(this, 'SsmAdminApiEcrRepositoryName', {
                parameterName: `${adminApiEcrSsmPrefix}/repository-name`,
                stringValue: this.adminApiEcrRepository.repositoryName,
                description: `admin-api BFF ECR repository name for ${props.targetEnvironment}`,
                tier: ssm.ParameterTier.STANDARD,
            });

            // admin-api ECR Outputs
            new cdk.CfnOutput(this, 'AdminApiEcrRepositoryUri', {
                value: this.adminApiEcrRepository.repositoryUri,
                description: 'admin-api BFF ECR Repository URI for docker push/pull',
            });

            new cdk.CfnOutput(this, 'AdminApiEcrRepositoryArn', {
                value: this.adminApiEcrRepository.repositoryArn,
                description: 'admin-api BFF ECR Repository ARN (Cognito-protected)',
            });
        }

        // =====================================================================
        // SSM Parameters for cross-project VPC sharing
        // Using SSM instead of CloudFormation exports to decouple stacks.
        // Consuming stacks use Vpc.fromLookup() with tags - no CF dependencies.
        // =====================================================================
        const ssmPrefix = `/shared/vpc/${props.targetEnvironment}`;

        new ssm.StringParameter(this, 'SsmVpcId', {
            parameterName: `${ssmPrefix}/vpc-id`,
            stringValue: this.vpc.vpcId,
            description: `Shared VPC ID for ${props.targetEnvironment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmVpcCidr', {
            parameterName: `${ssmPrefix}/vpc-cidr`,
            stringValue: this.vpc.vpcCidrBlock,
            description: `Shared VPC CIDR for ${props.targetEnvironment}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // Store subnet IDs in SSM
        const publicSubnets = this.vpc.publicSubnets;
        publicSubnets.forEach((subnet, idx) => {
            new ssm.StringParameter(this, `SsmPublicSubnet${idx + 1}`, {
                parameterName: `${ssmPrefix}/public-subnet-${idx + 1}-id`,
                stringValue: subnet.subnetId,
                description: `Public Subnet ${idx + 1} ID`,
                tier: ssm.ParameterTier.STANDARD,
            });
        });

        new ssm.StringParameter(this, 'SsmPublicSubnetIds', {
            parameterName: `${ssmPrefix}/public-subnet-ids`,
            stringValue: publicSubnets.map(s => s.subnetId).join(','),
            description: 'All public subnet IDs (comma-separated)',
            tier: ssm.ParameterTier.STANDARD,
        });

        new ssm.StringParameter(this, 'SsmAvailabilityZones', {
            parameterName: `${ssmPrefix}/availability-zones`,
            stringValue: publicSubnets.map(s => s.availabilityZone).join(','),
            description: 'Availability zones (comma-separated)',
            tier: ssm.ParameterTier.STANDARD,
        });

        // =====================================================================
        // Stack outputs (for visibility only - NO exportName to avoid coupling)
        // =====================================================================
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpc.vpcId,
            description: 'Shared VPC ID (also in SSM: ' + ssmPrefix + '/vpc-id)',
        });

        new cdk.CfnOutput(this, 'VpcCidr', {
            value: this.vpc.vpcCidrBlock,
            description: 'Shared VPC CIDR',
        });

        new cdk.CfnOutput(this, 'PublicSubnetIds', {
            value: publicSubnets.map(s => s.subnetId).join(','),
            description: 'All public subnet IDs (comma-separated)',
        });

        new cdk.CfnOutput(this, 'AvailabilityZones', {
            value: publicSubnets.map(s => s.availabilityZone).join(','),
            description: 'Availability zones (comma-separated)',
        });

        new cdk.CfnOutput(this, 'VpcLookupName', {
            value: `shared-vpc-${props.targetEnvironment}`,
            description: 'Use this Name tag with Vpc.fromLookup() to reference this VPC',
        });
    }

    private configureGatewayEndpoints(config?: GatewayEndpointConfig): void {
        const enableS3 = config?.enableS3Endpoint !== false;
        const enableDynamoDb = config?.enableDynamoDbEndpoint !== false;

        if (enableS3) {
            (this as { s3Endpoint?: ec2.GatewayVpcEndpoint }).s3Endpoint =
                this.vpc.addGatewayEndpoint('S3Endpoint', {
                    service: ec2.GatewayVpcEndpointAwsService.S3,
                    subnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
                });
        }

        if (enableDynamoDb) {
            (this as { dynamoDbEndpoint?: ec2.GatewayVpcEndpoint }).dynamoDbEndpoint =
                this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
                    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
                    subnets: [{ subnetType: ec2.SubnetType.PUBLIC }],
                });
        }
    }

    private configureFlowLogs(config: FlowLogConfig): void {
        if (config.encryptionKey) {
            (this as { flowLogEncryptionKey?: kms.IKey }).flowLogEncryptionKey = config.encryptionKey;
        } else if (config.createEncryptionKey !== false) {
            (this as { flowLogEncryptionKey?: kms.IKey }).flowLogEncryptionKey = new kms.Key(this, 'FlowLogKey', {
                alias: `vpc-flow-logs-${this.targetEnvironment}`,
                description: 'KMS key for VPC Flow Logs encryption',
                enableKeyRotation: true,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
            });

            this.flowLogEncryptionKey!.addToResourcePolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
                actions: [
                    'kms:Encrypt*',
                    'kms:Decrypt*',
                    'kms:ReEncrypt*',
                    'kms:GenerateDataKey*',
                    'kms:Describe*',
                ],
                resources: ['*'],
                conditions: {
                    ArnLike: {
                        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
                    },
                },
            }));
        }

        const logGroup = new logs.LogGroup(this, 'FlowLogGroup', {
            logGroupName: config.logGroupName ?? `/vpc/shared-${this.environment}/flow-logs`,
            retention: config.retentionDays ?? logs.RetentionDays.ONE_MONTH,
            encryptionKey: this.flowLogEncryptionKey,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        (this as { flowLogGroup?: logs.ILogGroup }).flowLogGroup = logGroup;

        this.vpc.addFlowLog('FlowLog', {
            trafficType: ec2.FlowLogTrafficType.ALL,
            destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup),
        });
    }
}
