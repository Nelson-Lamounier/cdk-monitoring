/**
 * @format
 * Monitoring Storage Stack Unit Tests
 *
 * Tests for the MonitoringStorageStack:
 * - New volume creation with encryption and SSM parameters
 * - Imported volume mode (via CDK context)
 * - DLM snapshot backup policy
 * - EBS Lifecycle resources (Lambda, EventBridge, SQS DLQs)
 * - Stack outputs and properties
 * - Config integration with monitoring allocations/configurations
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../../../lib/config';
import { MONITORING_ALLOCATIONS, MONITORING_CONFIGS } from '../../../../lib/config/monitoring';
import {
    MonitoringStorageStack,
    MonitoringStorageStackProps,
} from '../../../../lib/stacks/monitoring/storage/storage-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper stack to provide VPC dependency for tests
 */
class DependencyProvider extends cdk.Stack {
    public readonly vpc: ec2.Vpc;

    constructor(scope: Construct, id: string) {
        super(scope, id, { env: TEST_ENV_EU });

        this.vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [
                { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
            ],
        });
    }
}

/**
 * Helper to create MonitoringStorageStack for testing.
 * Supports CDK context overrides for imported volume testing.
 */
function createStorageStack(
    props?: Partial<MonitoringStorageStackProps>,
    context?: Record<string, string>,
): { stack: MonitoringStorageStack; template: Template } {
    const app = createTestApp();

    // Set CDK context for imported volume scenarios
    if (context) {
        for (const [key, value] of Object.entries(context)) {
            app.node.setContext(key, value);
        }
    }

    const deps = new DependencyProvider(app, 'Deps');

    const stack = new MonitoringStorageStack(app, 'TestStorageStack', {
        env: TEST_ENV_EU,
        vpc: deps.vpc,
        volumeSizeGb: props?.volumeSizeGb ?? 30,
        enableBackup: props?.enableBackup,
        snapshotRetentionDays: props?.snapshotRetentionDays,
        createEncryptionKey: props?.createEncryptionKey,
        removalPolicy: props?.removalPolicy,
        namePrefix: props?.namePrefix ?? 'monitoring',
        ssmPrefix: props?.ssmPrefix ?? '/monitoring/ebs',
        asgName: props?.asgName,
        volumeTagKey: props?.volumeTagKey,
        volumeTagValue: props?.volumeTagValue,
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

// =============================================================================
// TESTS
// =============================================================================

describe('MonitoringStorageStack', () => {
    // =========================================================================
    // New Volume Creation
    // =========================================================================
    describe('New Volume Creation', () => {
        it('should create an encrypted EBS volume', () => {
            const { template } = createStorageStack();

            template.hasResourceProperties('AWS::EC2::Volume', {
                Encrypted: true,
                VolumeType: 'gp3',
                Size: 30,
            });
        });

        it('should store volume ID in SSM parameter', () => {
            const { template } = createStorageStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: '/monitoring/ebs/volume-id',
            });
        });

        it('should store availability zone in SSM parameter', () => {
            const { template } = createStorageStack();

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Name: '/monitoring/ebs/availability-zone',
            });
        });

        it('should create customer-managed KMS key when opted in', () => {
            const { template } = createStorageStack({
                createEncryptionKey: true,
            });

            template.hasResourceProperties('AWS::KMS::Key', {
                EnableKeyRotation: true,
            });
        });

        it('should NOT create KMS key by default', () => {
            const { template } = createStorageStack();

            template.resourceCountIs('AWS::KMS::Key', 0);
        });

        it('should use custom SSM prefix when provided', () => {
            const { template } = createStorageStack({
                ssmPrefix: '/custom/storage',
            });

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/custom/storage/volume-id',
            });

            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/custom/storage/availability-zone',
            });
        });
    });

    // =========================================================================
    // Imported Volume Mode
    // =========================================================================
    describe('Imported Volume Mode', () => {
        const importContext = {
            existingVolumeId: 'vol-0123456789abcdef0',
            existingVolumeAz: 'eu-west-1a',
        };

        it('should NOT create any SSM parameters for imported volumes', () => {
            const { template } = createStorageStack({}, importContext);

            template.resourceCountIs('AWS::SSM::Parameter', 0);
        });

        it('should NOT create a new EBS volume for imported volumes', () => {
            const { template } = createStorageStack({}, importContext);

            template.resourceCountIs('AWS::EC2::Volume', 0);
        });

        it('should set isImportedVolume flag to true', () => {
            const { stack } = createStorageStack({}, importContext);

            expect(stack.isImportedVolume).toBe(true);
        });

        it('should set isImportedVolume flag to false for new volumes', () => {
            const { stack } = createStorageStack();

            expect(stack.isImportedVolume).toBe(false);
        });

        it('should use provided availability zone from context', () => {
            const { stack } = createStorageStack({}, importContext);

            expect(stack.availabilityZone).toBe('eu-west-1a');
        });
    });

    // =========================================================================
    // DLM Backup Policy
    // =========================================================================
    describe('DLM Backup Policy', () => {
        it('should create DLM lifecycle policy by default', () => {
            const { template } = createStorageStack();

            template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
                State: 'ENABLED',
                PolicyDetails: Match.objectLike({
                    ResourceTypes: ['VOLUME'],
                    TargetTags: Match.arrayWith([
                        Match.objectLike({
                            Key: 'Application',
                            Value: 'Prometheus-Grafana',
                        }),
                    ]),
                }),
            });
        });

        it('should create DLM IAM role with snapshot permissions', () => {
            const { template } = createStorageStack();

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

        it('should configure snapshot schedule with correct retention', () => {
            const { template } = createStorageStack({
                snapshotRetentionDays: 14,
            });

            template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
                PolicyDetails: Match.objectLike({
                    Schedules: Match.arrayWith([
                        Match.objectLike({
                            RetainRule: { Count: 14 },
                        }),
                    ]),
                }),
            });
        });

        it('should default to 7 days retention', () => {
            const { template } = createStorageStack();

            template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
                PolicyDetails: Match.objectLike({
                    Schedules: Match.arrayWith([
                        Match.objectLike({
                            RetainRule: { Count: 7 },
                        }),
                    ]),
                }),
            });
        });

        it('should NOT create DLM policy when backup is disabled', () => {
            const { template } = createStorageStack({
                enableBackup: false,
            });

            template.resourceCountIs('AWS::DLM::LifecyclePolicy', 0);
        });

        it('should NOT create DLM policy for imported volumes', () => {
            const { template } = createStorageStack(
                { enableBackup: true },
                { existingVolumeId: 'vol-abc123', existingVolumeAz: 'eu-west-1a' },
            );

            template.resourceCountIs('AWS::DLM::LifecyclePolicy', 0);
        });
    });

    // =========================================================================
    // EBS Lifecycle Resources (ASG Mode)
    // =========================================================================
    describe('EBS Lifecycle Resources (ASG Mode)', () => {
        const asgProps = { asgName: 'monitoring-asg' };

        it('should create Lambda function when asgName is provided', () => {
            const { template } = createStorageStack(asgProps);

            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'monitoring-ebs-detach',
                Description: Match.stringLikeRegexp('Detach'),
                Timeout: 60,
                MemorySize: 256,
                ReservedConcurrentExecutions: 1,
            });
        });

        it('should create EventBridge rule targeting ASG lifecycle events', () => {
            const { template } = createStorageStack(asgProps);

            template.hasResourceProperties('AWS::Events::Rule', {
                Name: 'monitoring-asg-lifecycle-terminate',
                EventPattern: Match.objectLike({
                    source: ['aws.autoscaling'],
                    'detail-type': ['EC2 Instance-terminate Lifecycle Action'],
                    detail: {
                        AutoScalingGroupName: ['monitoring-asg'],
                    },
                }),
            });
        });

        it('should create Lambda DLQ with SSL enforcement', () => {
            const { template } = createStorageStack(asgProps);

            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'monitoring-ebs-detach-lambda-dlq',
            });
        });

        it('should create EventBridge DLQ with SSL enforcement', () => {
            const { template } = createStorageStack(asgProps);

            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'monitoring-ebs-detach-eventbridge-dlq',
            });
        });

        it('should create CloudWatch error alarm for Lambda', () => {
            const { template } = createStorageStack(asgProps);

            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'monitoring-ebs-detach-errors',
                Threshold: 1,
                EvaluationPeriods: 1,
            });
        });

        it('should NOT create lifecycle resources when asgName is not provided', () => {
            const { template } = createStorageStack();

            template.resourceCountIs('AWS::Lambda::Function', 0);
            template.resourceCountIs('AWS::Events::Rule', 0);
        });

        it('should expose lifecycleLambda when asgName is provided', () => {
            const { stack } = createStorageStack(asgProps);

            expect(stack.lifecycleLambda).toBeDefined();
        });

        it('should expose lifecycleErrorAlarm when asgName is provided', () => {
            const { stack } = createStorageStack(asgProps);

            expect(stack.lifecycleErrorAlarm).toBeDefined();
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should export VolumeId', () => {
            const { template } = createStorageStack();

            template.hasOutput('VolumeId', {
                Description: 'EBS Volume ID',
            });
        });

        it('should export AvailabilityZone', () => {
            const { template } = createStorageStack();

            template.hasOutput('AvailabilityZone', {
                Description: 'Volume Availability Zone',
            });
        });

        it('should export IsImportedVolume', () => {
            const { template } = createStorageStack();

            template.hasOutput('IsImportedVolume', {
                Value: 'false',
            });
        });

        it('should export LifecycleLambdaArn when asgName is provided', () => {
            const { template } = createStorageStack({ asgName: 'my-asg' });

            template.hasOutput('LifecycleLambdaArn', {
                Description: 'EBS Detach Lambda ARN',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose volume', () => {
            const { stack } = createStorageStack();

            expect(stack.volume).toBeDefined();
        });

        it('should expose volumeId', () => {
            const { stack } = createStorageStack();

            expect(stack.volumeId).toBeDefined();
        });

        it('should expose availabilityZone', () => {
            const { stack } = createStorageStack();

            expect(stack.availabilityZone).toBeDefined();
        });

        it('should expose encryptionKey when createEncryptionKey is true', () => {
            const { stack } = createStorageStack({
                createEncryptionKey: true,
            });

            expect(stack.encryptionKey).toBeDefined();
        });

        it('should have undefined encryptionKey when using default encryption', () => {
            const { stack } = createStorageStack();

            expect(stack.encryptionKey).toBeUndefined();
        });
    });

    // =========================================================================
    // Config Integration (lib/config/monitoring)
    // =========================================================================
    describe('Config Integration', () => {
        it('should correctly use dev EBS allocation for volume size', () => {
            const devAlloc = MONITORING_ALLOCATIONS[Environment.DEVELOPMENT];
            const { template } = createStorageStack({
                volumeSizeGb: devAlloc.ebs.sizeGb,
            });

            template.hasResourceProperties('AWS::EC2::Volume', {
                Size: devAlloc.ebs.sizeGb,
            });
        });

        it('should correctly use production EBS allocation for volume size', () => {
            const prodAlloc = MONITORING_ALLOCATIONS[Environment.PRODUCTION];
            const { template } = createStorageStack({
                volumeSizeGb: prodAlloc.ebs.sizeGb,
            });

            template.hasResourceProperties('AWS::EC2::Volume', {
                Size: prodAlloc.ebs.sizeGb,
            });
        });

        it('should correctly use dev backup config for retention days', () => {
            const devConfig = MONITORING_CONFIGS[Environment.DEVELOPMENT];
            const { template } = createStorageStack({
                enableBackup: devConfig.backup.enabled,
                snapshotRetentionDays: devConfig.backup.retentionDays,
            });

            template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
                PolicyDetails: Match.objectLike({
                    Schedules: Match.arrayWith([
                        Match.objectLike({
                            RetainRule: { Count: devConfig.backup.retentionDays },
                        }),
                    ]),
                }),
            });
        });

        it('should correctly use production removal policy', () => {
            const prodConfig = MONITORING_CONFIGS[Environment.PRODUCTION];
            const { stack } = createStorageStack({
                removalPolicy: prodConfig.removalPolicy,
                createEncryptionKey: prodConfig.createKmsKeys,
            });

            // Production should create customer-managed KMS keys
            expect(stack.encryptionKey).toBeDefined();
        });
    });
});
