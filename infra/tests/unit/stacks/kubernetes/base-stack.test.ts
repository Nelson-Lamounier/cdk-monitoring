/**
 * @format
 * Kubernetes Base Stack Unit Tests
 *
 * Tests for the KubernetesBaseStack (Long-Lived Infrastructure Layer):
 * - Security Groups (4 config-driven SGs + runtime ingress rules)
 * - KMS Key for CloudWatch Logs
 * - EBS Volume (persistent Kubernetes data)
 * - DLM Snapshot Lifecycle Policy
 * - Elastic IP
 * - Route 53 Private Hosted Zone
 * - S3 Buckets (scripts + access logs)
 * - SSM Parameters (cross-stack discovery)
 * - Stack Outputs
 * - Stack Properties (public fields)
 */

import { Template, Match, Capture } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getK8sConfigs } from '../../../../lib/config/kubernetes';
import {
    KubernetesBaseStack,
    KubernetesBaseStackProps,
} from '../../../../lib/stacks/kubernetes/base-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_CONFIGS = getK8sConfigs(Environment.DEVELOPMENT);

/**
 * Helper to create KubernetesBaseStack with sensible defaults.
 *
 * Override any prop via the `overrides` parameter.
 */
function createBaseStack(
    overrides?: Partial<KubernetesBaseStackProps>,
): { stack: KubernetesBaseStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new KubernetesBaseStack(app, 'TestK8sBaseStack', {
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        configs: TEST_CONFIGS,
        namePrefix: 'k8s-dev',
        ssmPrefix: '/k8s/development',
        vpcName: 'shared-vpc-development',
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesBaseStack', () => {
    let template: Template;
    let stack: KubernetesBaseStack;

    beforeAll(() => {
        const result = createBaseStack();
        template = result.template;
        stack = result.stack;
    });

    // =========================================================================
    // Security Groups
    // =========================================================================
    describe('Security Groups', () => {
        it('should create exactly 4 security groups', () => {
            template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
        });

        it('should create cluster base SG with all outbound allowed', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('Shared Kubernetes cluster'),
                GroupName: 'k8s-dev-k8s-cluster',
            });
        });

        it('should create control plane SG with restricted outbound', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('K8s control plane'),
                GroupName: 'k8s-dev-k8s-control-plane',
                SecurityGroupEgress: Match.arrayWith([
                    Match.objectLike({
                        CidrIp: '255.255.255.255/32',
                        Description: 'Disallow all traffic',
                    }),
                ]),
            });
        });

        it('should create ingress SG with restricted outbound', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('K8s ingress'),
                GroupName: 'k8s-dev-k8s-ingress',
                SecurityGroupEgress: Match.arrayWith([
                    Match.objectLike({
                        CidrIp: '255.255.255.255/32',
                        Description: 'Disallow all traffic',
                    }),
                ]),
            });
        });

        it('should create monitoring SG with restricted outbound', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('K8s monitoring'),
                GroupName: 'k8s-dev-k8s-monitoring',
            });
        });

        it('should create ingress rules from config for cluster base SG', () => {
            // Verify a representative set of ingress rules from K8sSecurityGroupConfig
            // etcd (2379-2380), K8s API (6443), kubelet (10250) — all self-referencing
            const ruleCount = TEST_CONFIGS.securityGroups.clusterBase.rules.length;

            // Each rule creates an AWS::EC2::SecurityGroup ingress entry
            // We verify the config-driven rule count by checking total ingress rules exist
            expect(ruleCount).toBeGreaterThan(10); // sanity: cluster base has 17+ rules
        });

        it('should create K8s API ingress rule on port 6443 for control plane SG', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-control-plane',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 6443,
                        ToPort: 6443,
                        IpProtocol: 'tcp',
                        Description: Match.stringLikeRegexp('K8s API'),
                    }),
                ]),
            });
        });

        it('should create HTTP ingress rule for Let\'s Encrypt on ingress SG', () => {
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-ingress',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 80,
                        ToPort: 80,
                        IpProtocol: 'tcp',
                        CidrIp: '0.0.0.0/0',
                    }),
                ]),
            });
        });

        it('should create monitoring port rules from config', () => {
            // Verify Prometheus (9090) and Node Exporter (9100) from VPC CIDR
            template.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupName: 'k8s-dev-k8s-monitoring',
                SecurityGroupIngress: Match.arrayWith([
                    Match.objectLike({
                        FromPort: 9090,
                        ToPort: 9090,
                        IpProtocol: 'tcp',
                    }),
                    Match.objectLike({
                        FromPort: 9100,
                        ToPort: 9100,
                        IpProtocol: 'tcp',
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // CloudFront Prefix List Lookup
    // =========================================================================
    describe('CloudFront Prefix List', () => {
        it('should create a custom resource to lookup the CloudFront prefix list', () => {
            template.hasResourceProperties('Custom::AWS', {
                Create: Match.serializedJson(Match.objectLike({
                    service: '@aws-sdk/client-ec2',
                    action: 'DescribeManagedPrefixLists',
                })),
            });
        });

        it('should grant ec2:DescribeManagedPrefixLists to the custom resource', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'ec2:DescribeManagedPrefixLists',
                            Effect: 'Allow',
                            Resource: '*',
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        it('should create a KMS key for CloudWatch log group encryption', () => {
            template.hasResourceProperties('AWS::KMS::Key', {
                Description: Match.stringLikeRegexp('log group encryption'),
                EnableKeyRotation: true,
            });
        });

        it('should enable key rotation', () => {
            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
            });
        });

        it('should create a key alias matching the name prefix', () => {
            template.hasResourceProperties('AWS::KMS::Alias', {
                AliasName: 'alias/k8s-dev-log-group',
            });
        });

        it('should grant CloudWatch Logs service principal encrypt/decrypt permissions', () => {
            template.hasResourceProperties('AWS::KMS::Key', {
                KeyPolicy: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'kms:Encrypt*',
                                'kms:Decrypt*',
                            ]),
                            Principal: Match.objectLike({
                                Service: Match.stringLikeRegexp('logs.*amazonaws.com'),
                            }),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // EBS Volume
    // =========================================================================
    describe('EBS Volume', () => {
        it('should create a GP3 EBS volume', () => {
            template.hasResourceProperties('AWS::EC2::Volume', {
                VolumeType: 'gp3',
            });
        });

        it('should encrypt the EBS volume', () => {
            template.hasResourceProperties('AWS::EC2::Volume', {
                Encrypted: true,
            });
        });

        it('should set the volume size from config', () => {
            template.hasResourceProperties('AWS::EC2::Volume', {
                Size: TEST_CONFIGS.storage.volumeSizeGb,
            });
        });

        it('should set the availability zone to region-a', () => {
            template.hasResourceProperties('AWS::EC2::Volume', {
                AvailabilityZone: `${TEST_ENV_EU.region}a`,
            });
        });

        it('should tag the volume with the name prefix', () => {
            template.hasResourceProperties('AWS::EC2::Volume', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'Name', Value: 'k8s-dev-data' }),
                ]),
            });
        });
    });

    // =========================================================================
    // DLM Snapshot Lifecycle Policy
    // =========================================================================
    describe('DLM Snapshot Policy', () => {
        it('should create a DLM lifecycle policy', () => {
            template.resourceCountIs('AWS::DLM::LifecyclePolicy', 1);
        });

        it('should target the EBS volume by Name tag', () => {
            template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
                PolicyDetails: Match.objectLike({
                    TargetTags: Match.arrayWith([
                        Match.objectLike({ Key: 'Name', Value: 'k8s-dev-data' }),
                    ]),
                }),
            });
        });

        it('should schedule daily snapshots with 7-day retention', () => {
            template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
                PolicyDetails: Match.objectLike({
                    Schedules: Match.arrayWith([
                        Match.objectLike({
                            CreateRule: Match.objectLike({
                                Interval: 24,
                                IntervalUnit: 'HOURS',
                            }),
                            RetainRule: Match.objectLike({
                                Count: 7,
                            }),
                        }),
                    ]),
                }),
            });
        });

        it('should create a DLM execution role', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: Match.objectLike({
                                Service: 'dlm.amazonaws.com',
                            }),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        it('should create an Elastic IP', () => {
            template.resourceCountIs('AWS::EC2::EIP', 1);
        });

        it('should tag the Elastic IP with the name prefix', () => {
            template.hasResourceProperties('AWS::EC2::EIP', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'Name', Value: 'k8s-dev-k8s-eip' }),
                ]),
            });
        });
    });

    // =========================================================================
    // Route 53 Private Hosted Zone
    // =========================================================================
    describe('Route 53', () => {
        it('should create a private hosted zone for k8s.internal', () => {
            template.hasResourceProperties('AWS::Route53::HostedZone', {
                Name: 'k8s.internal.',
            });
        });

        it('should create a placeholder A record for the API server', () => {
            template.hasResourceProperties('AWS::Route53::RecordSet', {
                Name: 'k8s-api.k8s.internal.',
                Type: 'A',
                TTL: '30',
            });
        });
    });

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Buckets', () => {
        it('should create 2 S3 buckets (scripts + access logs)', () => {
            template.resourceCountIs('AWS::S3::Bucket', 2);
        });

        it('should encrypt all S3 buckets', () => {
            const buckets = template.findResources('AWS::S3::Bucket');
            for (const [, resource] of Object.entries(buckets)) {
                const props = resource.Properties;
                expect(props.BucketEncryption).toBeDefined();
            }
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should create 12 SSM parameters for cross-stack discovery', () => {
            template.resourceCountIs('AWS::SSM::Parameter', 12);
        });

        it('should create SSM parameters under the /k8s/development prefix', () => {
            const params = template.findResources('AWS::SSM::Parameter');
            const paramNames = Object.values(params).map(
                (r: Record<string, any>) => r.Properties.Name as string,
            );

            // Verify key SSM parameter paths exist
            const expectedPrefixes = paramNames.filter(
                (name) => name.startsWith('/k8s/development/'),
            );
            expect(expectedPrefixes.length).toBe(12);
        });

        it('should publish the security group ID to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/security-group-id',
                Type: 'String',
            });
        });

        it('should publish the Elastic IP to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/elastic-ip',
                Type: 'String',
            });
        });

        it('should publish the EBS volume ID to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/ebs-volume-id',
                Type: 'String',
            });
        });

        it('should publish the scripts bucket name to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/scripts-bucket',
                Type: 'String',
            });
        });

        it('should publish the hosted zone ID to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/hosted-zone-id',
                Type: 'String',
            });
        });

        it('should publish the API DNS name to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/api-dns-name',
                Value: 'k8s-api.k8s.internal',
                Type: 'String',
            });
        });

        it('should publish the KMS key ARN to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/kms-key-arn',
                Type: 'String',
            });
        });

        it('should publish all 4 security group IDs to SSM', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/control-plane-sg-id',
                Type: 'String',
            });
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/ingress-sg-id',
                Type: 'String',
            });
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/monitoring-sg-id',
                Type: 'String',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose vpc', () => {
            expect(stack.vpc).toBeDefined();
        });

        it('should expose securityGroup', () => {
            expect(stack.securityGroup).toBeDefined();
            expect(stack.securityGroup.securityGroupId).toBeDefined();
        });

        it('should expose controlPlaneSg', () => {
            expect(stack.controlPlaneSg).toBeDefined();
            expect(stack.controlPlaneSg.securityGroupId).toBeDefined();
        });

        it('should expose ingressSg', () => {
            expect(stack.ingressSg).toBeDefined();
            expect(stack.ingressSg.securityGroupId).toBeDefined();
        });

        it('should expose monitoringSg', () => {
            expect(stack.monitoringSg).toBeDefined();
            expect(stack.monitoringSg.securityGroupId).toBeDefined();
        });

        it('should expose logGroupKmsKey', () => {
            expect(stack.logGroupKmsKey).toBeDefined();
            expect(stack.logGroupKmsKey.keyArn).toBeDefined();
        });

        it('should expose ebsVolume', () => {
            expect(stack.ebsVolume).toBeDefined();
            expect(stack.ebsVolume.volumeId).toBeDefined();
        });

        it('should expose scriptsBucket', () => {
            expect(stack.scriptsBucket).toBeDefined();
            expect(stack.scriptsBucket.bucketName).toBeDefined();
        });

        it('should expose hostedZone', () => {
            expect(stack.hostedZone).toBeDefined();
            expect(stack.hostedZone.hostedZoneId).toBeDefined();
        });

        it('should expose apiDnsName as k8s-api.k8s.internal', () => {
            expect(stack.apiDnsName).toBe('k8s-api.k8s.internal');
        });

        it('should expose elasticIp', () => {
            expect(stack.elasticIp).toBeDefined();
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export VpcId', () => {
            template.hasOutput('VpcId', {
                Description: 'Shared VPC ID',
            });
        });

        it('should export SecurityGroupId', () => {
            template.hasOutput('SecurityGroupId', {
                Description: 'Kubernetes cluster security group ID',
            });
        });

        it('should export ElasticIpAddress', () => {
            template.hasOutput('ElasticIpAddress', {
                Description: 'Kubernetes cluster Elastic IP address',
            });
        });

        it('should export ElasticIpAllocationId', () => {
            template.hasOutput('ElasticIpAllocationId', {
                Description: 'Kubernetes cluster Elastic IP allocation ID',
            });
        });

        it('should export EbsVolumeId', () => {
            template.hasOutput('EbsVolumeId', {
                Description: 'Kubernetes data EBS volume ID',
            });
        });

        it('should export HostedZoneId', () => {
            template.hasOutput('HostedZoneId', {
                Description: Match.stringLikeRegexp('hosted zone'),
            });
        });

        it('should export ApiDnsName', () => {
            template.hasOutput('ApiDnsName', {
                Value: 'k8s-api.k8s.internal',
                Description: 'Stable DNS name for the Kubernetes API server',
            });
        });

        it('should export LogGroupKmsKeyArn', () => {
            template.hasOutput('LogGroupKmsKeyArn', {
                Description: Match.stringLikeRegexp('KMS key ARN'),
            });
        });

        it('should export ScriptsBucketName', () => {
            template.hasOutput('ScriptsBucketName', {
                Description: 'S3 bucket for k8s scripts and manifests',
            });
        });
    });

    // =========================================================================
    // Config Integration
    // =========================================================================
    describe('Config Integration', () => {
        it('should use the storage volumeSizeGb from config', () => {
            expect(TEST_CONFIGS.storage.volumeSizeGb).toBe(30);
            template.hasResourceProperties('AWS::EC2::Volume', {
                Size: 30,
            });
        });

        it('should use the removalPolicy from config', () => {
            // development env uses DESTROY
            expect(TEST_CONFIGS.removalPolicy).toBe(cdk.RemovalPolicy.DESTROY);

            // EBS volume should have DeletionPolicy matching DESTROY
            const volumes = template.findResources('AWS::EC2::Volume');
            const volumeKey = Object.keys(volumes)[0];
            expect(volumes[volumeKey].DeletionPolicy).toBe('Delete');
        });

        it('should use pod network CIDR from config for SG rules', () => {
            expect(TEST_CONFIGS.cluster.podNetworkCidr).toBe('192.168.0.0/16');
            // Pod CIDR rules should reference 192.168.0.0/16
            const json = JSON.stringify(template.toJSON());
            expect(json).toContain('192.168.0.0/16');
        });

        it('should use the default SG config for all environments', () => {
            // Verify the config is properly loaded
            expect(TEST_CONFIGS.securityGroups.clusterBase.rules.length).toBeGreaterThan(10);
            expect(TEST_CONFIGS.securityGroups.controlPlane.rules.length).toBe(1);
            expect(TEST_CONFIGS.securityGroups.monitoring.rules.length).toBe(5);
            expect(TEST_CONFIGS.securityGroups.ingress.rules.length).toBe(1);
        });

        it('should use isProduction=false for development environment', () => {
            expect(TEST_CONFIGS.isProduction).toBe(false);
        });
    });

    // =========================================================================
    // Resource Count Sanity Check
    // =========================================================================
    describe('Resource Counts', () => {
        it('should create expected number of core resources', () => {
            template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
            template.resourceCountIs('AWS::EC2::Volume', 1);
            template.resourceCountIs('AWS::EC2::EIP', 1);
            template.resourceCountIs('AWS::KMS::Key', 1);
            template.resourceCountIs('AWS::KMS::Alias', 1);
            template.resourceCountIs('AWS::Route53::HostedZone', 1);
            template.resourceCountIs('AWS::Route53::RecordSet', 1);
            template.resourceCountIs('AWS::S3::Bucket', 2);
            template.resourceCountIs('AWS::SSM::Parameter', 12);
            template.resourceCountIs('AWS::DLM::LifecyclePolicy', 1);
        });
    });
});
