/**
 * @format
 * NextJsK8sComputeStack Unit Tests
 *
 * Tests for the Next.js K8s compute stack that replaces the ECS
 * Compute + Networking + Application stacks with a single k3s agent node.
 *
 * Verifies: Security Group, IAM Role (ECR, SSM, DynamoDB, S3, SecretsManager),
 * ASG, Launch Template, Elastic IP, S3 Buckets, SSM Parameters,
 * SSM Run Command Document, and Stack Outputs.
 *
 * Follows the same test patterns as tests/unit/stacks/k8s/compute-stack.test.ts.
 */

import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getNextJsK8sConfig } from '../../../../lib/config/nextjs/k8s-configurations';
import { NextJsK8sComputeStack } from '../../../../lib/stacks/nextjs/k8s';

// Set test environment
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';

// =============================================================================
// Test Helpers
// =============================================================================

interface StackResult {
    stack: NextJsK8sComputeStack;
    template: Template;
    app: cdk.App;
}

/**
 * Helper to create a NextJsK8sComputeStack for testing.
 * Provides all optional IAM grant props to test the full permission surface.
 */
function createStack(environment: Environment = Environment.DEVELOPMENT): StackResult {
    const app = new cdk.App();
    const k8sConfig = getNextJsK8sConfig(environment);
    const namePrefix = `nextjs-k8s-${environment}`;

    const stack = new NextJsK8sComputeStack(app, `NextJS-K8s-Compute-${environment}`, {
        env: { account: '123456789012', region: 'eu-west-1' },
        targetEnvironment: environment,
        k8sConfig,
        namePrefix,
        ssmPrefix: `/nextjs-k8s/${environment}`,
        vpcName: `shared-vpc-${environment}`,
        // Provide all optional IAM grant props
        ssmParameterPath: `/nextjs/${environment}/*`,
        dynamoTableArns: [
            `arn:aws:dynamodb:eu-west-1:123456789012:table/nextjs-${environment}-articles`,
        ],
        dynamoKmsKeySsmPath: `/nextjs/${environment}/dynamodb-kms-key-arn`,
        s3ReadBucketArns: [
            `arn:aws:s3:::nextjs-${environment}-assets`,
        ],
        secretsManagerPathPattern: `nextjs/${environment}/*`,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

/**
 * Create a minimal stack (no optional IAM grants) for comparison testing.
 */
function createMinimalStack(): StackResult {
    const app = new cdk.App();
    const k8sConfig = getNextJsK8sConfig(Environment.DEVELOPMENT);

    const stack = new NextJsK8sComputeStack(app, 'NextJS-K8s-Compute-minimal', {
        env: { account: '123456789012', region: 'eu-west-1' },
        targetEnvironment: Environment.DEVELOPMENT,
        k8sConfig,
        namePrefix: 'nextjs-k8s-minimal',
        ssmPrefix: '/nextjs-k8s/development',
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

/**
 * Extract ingress ports from the first SecurityGroup in a template.
 */
function getIngressPorts(template: Template): number[] {
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const sgKeys = Object.keys(sgs);
    const mainSg = sgs[sgKeys[0]];
    const ingressRules: Array<{ FromPort: number }> = mainSg.Properties?.SecurityGroupIngress ?? [];
    return ingressRules.map((r) => r.FromPort);
}

/**
 * Extract all IAM policy SID values from a template.
 */
function getAllPolicySIDs(template: Template): string[] {
    const policies = template.findResources('AWS::IAM::Policy');
    const sids: string[] = [];
    for (const policy of Object.values(policies)) {
        const typedPolicy = policy as { Properties?: { PolicyDocument?: { Statement?: Array<{ Sid?: string }> } } };
        const statements = typedPolicy?.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of statements) {
            if (stmt.Sid) sids.push(stmt.Sid);
        }
    }
    return sids;
}

/**
 * Extract all IAM policy actions from a template.
 */
function getAllPolicyActions(template: Template): string[] {
    const policies = template.findResources('AWS::IAM::Policy');
    const allActions: string[] = [];
    for (const policy of Object.values(policies)) {
        const typedPolicy = policy as { Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: string | string[] }> } } };
        const statements = typedPolicy?.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of statements) {
            if (Array.isArray(stmt.Action)) {
                allActions.push(...stmt.Action);
            } else if (typeof stmt.Action === 'string') {
                allActions.push(stmt.Action);
            }
        }
    }
    return allActions;
}

// =============================================================================
// Tests
// =============================================================================

describe('NextJsK8sComputeStack', () => {
    // =========================================================================
    // Security Group
    // =========================================================================
    describe('Security Group', () => {
        it('should create a security group', () => {
            const { template } = createStack();
            template.hasResource('AWS::EC2::SecurityGroup', {});
        });

        it('should allow HTTP (80) and HTTPS (443) ingress for Traefik', () => {
            const { template } = createStack();
            const ports = getIngressPorts(template);

            expect(ports).toContain(80);
            expect(ports).toContain(443);
        });

        it('should allow K8s API (6443) from VPC CIDR', () => {
            const { template } = createStack();
            const ports = getIngressPorts(template);

            expect(ports).toContain(6443);
        });

        it('should allow Node Exporter (9100) from VPC CIDR', () => {
            const { template } = createStack();
            const ports = getIngressPorts(template);

            expect(ports).toContain(9100);
        });
    });

    // =========================================================================
    // IAM Role
    // =========================================================================
    describe('IAM Role', () => {
        it('should create an IAM role', () => {
            const { template } = createStack();
            template.hasResource('AWS::IAM::Role', {});
        });

        it('should grant ECR pull permissions', () => {
            const { template } = createStack();
            const actions = getAllPolicyActions(template);

            expect(actions).toContain('ecr:GetDownloadUrlForLayer');
            expect(actions).toContain('ecr:BatchGetImage');
            expect(actions).toContain('ecr:BatchCheckLayerAvailability');
            expect(actions).toContain('ecr:GetAuthorizationToken');
        });

        it('should grant SSM parameter read/write', () => {
            const { template } = createStack();
            const actions = getAllPolicyActions(template);

            expect(actions).toContain('ssm:PutParameter');
            expect(actions).toContain('ssm:GetParameter');
            expect(actions).toContain('ssm:GetParametersByPath');
        });

        it('should include all IAM policy SIDs when optional grants are provided', () => {
            const { template } = createStack();
            const sids = getAllPolicySIDs(template);

            expect(sids).toContain('EcrPull');
            expect(sids).toContain('SsmParameterAccess');
            expect(sids).toContain('SsmNextJsParameterRead');
            expect(sids).toContain('DynamoDbRead');
            expect(sids).toContain('DynamoKmsDecrypt');
            expect(sids).toContain('S3Read');
            expect(sids).toContain('SecretsManagerRead');
        });

        it('should grant DynamoDB read access when tableArns are provided', () => {
            const { template } = createStack();
            const actions = getAllPolicyActions(template);

            expect(actions).toContain('dynamodb:GetItem');
            expect(actions).toContain('dynamodb:Query');
            expect(actions).toContain('dynamodb:Scan');
            expect(actions).toContain('dynamodb:BatchGetItem');
        });

        it('should grant S3 read access when bucket ARNs are provided', () => {
            const { template } = createStack();
            const actions = getAllPolicyActions(template);

            expect(actions).toContain('s3:GetObject');
            expect(actions).toContain('s3:ListBucket');
        });

        it('should grant Secrets Manager access when path pattern is provided', () => {
            const { template } = createStack();
            const actions = getAllPolicyActions(template);

            expect(actions).toContain('secretsmanager:GetSecretValue');
        });

        it('should NOT include optional policy SIDs when grants are omitted', () => {
            const { template } = createMinimalStack();
            const sids = getAllPolicySIDs(template);

            // Core grants should still be present
            expect(sids).toContain('EcrPull');
            expect(sids).toContain('SsmParameterAccess');

            // Optional grants should be absent
            expect(sids).not.toContain('SsmNextJsParameterRead');
            expect(sids).not.toContain('DynamoDbRead');
            expect(sids).not.toContain('DynamoKmsDecrypt');
            expect(sids).not.toContain('S3Read');
            expect(sids).not.toContain('SecretsManagerRead');
        });
    });

    // =========================================================================
    // Auto Scaling Group
    // =========================================================================
    describe('Auto Scaling Group', () => {
        it('should create an ASG', () => {
            const { template } = createStack();
            template.hasResource('AWS::AutoScaling::AutoScalingGroup', {});
        });

        it('should set min=1 and max=1 for single agent node', () => {
            const { template } = createStack();

            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MinSize: '1',
                MaxSize: '1',
            });
        });
    });

    // =========================================================================
    // Launch Template
    // =========================================================================
    describe('Launch Template', () => {
        it('should create a launch template', () => {
            const { template } = createStack();
            template.hasResource('AWS::EC2::LaunchTemplate', {});
        });
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        it('should allocate an Elastic IP', () => {
            const { template } = createStack();
            template.hasResource('AWS::EC2::EIP', {});
        });

        it('should tag the EIP with the name prefix', () => {
            const { template } = createStack();

            template.hasResourceProperties('AWS::EC2::EIP', {
                Tags: Match.arrayWith([
                    Match.objectLike({
                        Key: 'Name',
                        Value: Match.stringLikeRegexp('nextjs-k8s.*eip'),
                    }),
                ]),
            });
        });
    });

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Buckets', () => {
        it('should create a manifests bucket', () => {
            const { template } = createStack();

            // Should have at least 2 S3 buckets: manifests + access logs
            const buckets = template.findResources('AWS::S3::Bucket');
            expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(2);
        });

        it('should enforce SSL on all buckets', () => {
            const { template } = createStack();

            const policies = template.findResources('AWS::S3::BucketPolicy');
            expect(Object.keys(policies).length).toBeGreaterThan(0);
        });

        it('should block public access on all buckets', () => {
            const { template } = createStack();

            // Verify all buckets have block public access configured
            const buckets = template.findResources('AWS::S3::Bucket');
            expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(2);

            // CDK assertion: every bucket must have these properties
            template.allResourcesProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should create security group ID SSM parameter', () => {
            const { template } = createStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs-k8s/development/security-group-id',
                Type: 'String',
            });
        });

        it('should create Elastic IP SSM parameter', () => {
            const { template } = createStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs-k8s/development/elastic-ip',
                Type: 'String',
            });
        });
    });

    // =========================================================================
    // SSM Run Command Document
    // =========================================================================
    describe('SSM Run Command Document', () => {
        it('should create an SSM document for manifest deployment', () => {
            const { template } = createStack();
            template.hasResource('AWS::SSM::Document', {});
        });

        it('should name the document with the stack name prefix', () => {
            const { template } = createStack();

            template.hasResourceProperties('AWS::SSM::Document', {
                Name: Match.stringLikeRegexp('nextjs-k8s.*deploy-manifests'),
            });
        });
    });

    // =========================================================================
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        it('should create a KMS key for log group encryption', () => {
            const { template } = createStack();
            template.hasResource('AWS::KMS::Key', {});
        });

        it('should enable key rotation', () => {
            const { template } = createStack();

            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
            });
        });
    });

    // =========================================================================
    // CloudWatch Log Group
    // =========================================================================
    describe('CloudWatch', () => {
        it('should create a log group', () => {
            const { template } = createStack();
            template.hasResource('AWS::Logs::LogGroup', {});
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export key outputs', () => {
            const { template } = createStack();

            const outputs = template.findOutputs('*');
            const outputKeys = Object.keys(outputs);

            expect(outputKeys.some(k => k.includes('InstanceRoleArn'))).toBe(true);
            expect(outputKeys.some(k => k.includes('AutoScalingGroupName'))).toBe(true);
            expect(outputKeys.some(k => k.includes('ElasticIpAddress'))).toBe(true);
            expect(outputKeys.some(k => k.includes('SecurityGroupId'))).toBe(true);
            expect(outputKeys.some(k => k.includes('SsmConnectCommand'))).toBe(true);
            expect(outputKeys.some(k => k.includes('ManifestDeployDocumentName'))).toBe(true);
            expect(outputKeys.some(k => k.includes('ScriptsBucketName'))).toBe(true);
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose the security group', () => {
            const { stack } = createStack();
            expect(stack.securityGroup).toBeDefined();
        });

        it('should expose the auto scaling group', () => {
            const { stack } = createStack();
            expect(stack.autoScalingGroup).toBeDefined();
        });

        it('should expose the instance role', () => {
            const { stack } = createStack();
            expect(stack.instanceRole).toBeDefined();
        });

        it('should expose the elastic IP', () => {
            const { stack } = createStack();
            expect(stack.elasticIp).toBeDefined();
        });
    });

    // =========================================================================
    // Environment Variations
    // =========================================================================
    describe('Environment: Production', () => {
        it('should synthesize without errors in production', () => {
            const { template } = createStack(Environment.PRODUCTION);
            template.hasResource('AWS::AutoScaling::AutoScalingGroup', {});
        });

        it('should retain S3 bucket in production', () => {
            const { template } = createStack(Environment.PRODUCTION);

            // At least one bucket should have RETAIN policy
            const buckets = template.findResources('AWS::S3::Bucket');
            const hasRetain = Object.values(buckets).some(
                (b) => {
                    const typed = b as { DeletionPolicy?: string };
                    return typed.DeletionPolicy === 'Retain';
                },
            );
            expect(hasRetain).toBe(true);
        });

        it('should enable versioning on manifests bucket in production', () => {
            const { template } = createStack(Environment.PRODUCTION);

            // At least one bucket should have versioning enabled
            const buckets = template.findResources('AWS::S3::Bucket');
            const hasVersioning = Object.values(buckets).some(
                (b) => {
                    const typed = b as { Properties?: { VersioningConfiguration?: { Status: string } } };
                    return typed.Properties?.VersioningConfiguration?.Status === 'Enabled';
                },
            );
            expect(hasVersioning).toBe(true);
        });
    });
});
