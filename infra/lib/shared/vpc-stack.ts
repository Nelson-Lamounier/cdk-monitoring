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
    /** ECR Repository for container images */
    public readonly ecrRepository?: ecr.Repository;

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

            // Resource tags for discovery
            cdk.Tags.of(this.ecrRepository).add('Environment', props.targetEnvironment);
            cdk.Tags.of(this.ecrRepository).add('SharedResource', 'true');
            cdk.Tags.of(this.ecrRepository).add('Application', 'NextJS');
            cdk.Tags.of(this.ecrRepository).add('ManagedBy', 'CDK');

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
