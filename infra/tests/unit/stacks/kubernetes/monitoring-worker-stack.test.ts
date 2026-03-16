/**
 * @format
 * Kubernetes Monitoring Worker Stack Unit Tests
 *
 * Tests for the KubernetesMonitoringWorkerStack:
 * - Launch Template creation
 * - Spot Instance configuration (L1 escape hatch)
 * - Auto Scaling Group (min=0, max=1)
 * - SNS Topic for monitoring alerts
 * - User Data (slim bootstrap stub, 16 KB limit)
 * - IAM Policies (SSM, KMS, S3, CloudWatch read-only, STS cross-account)
 * - NLB Target Group registration
 * - Stack Outputs
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getK8sConfigs } from '../../../../lib/config/kubernetes';
import type { MonitoringWorkerConfig } from '../../../../lib/config/kubernetes';
import {
    KubernetesMonitoringWorkerStack,
    KubernetesMonitoringWorkerStackProps,
} from '../../../../lib/stacks/kubernetes/monitoring-worker-stack';
import {
    TEST_ENV_EU,
    TEST_VPC_CONTEXT_KEY,
    TEST_VPC_CONTEXT,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_CONFIGS = getK8sConfigs(Environment.DEVELOPMENT);

/** AWS CloudFormation maximum user data size in bytes */
const CF_USER_DATA_MAX_BYTES = 16_384;

/** Cross-account DNS role ARN for testing */
const TEST_CROSS_ACCOUNT_DNS_ROLE_ARN = 'arn:aws:iam::999999999999:role/Route53DnsValidationRole';

/** Test notification email */
const TEST_NOTIFICATION_EMAIL = 'test@example.com';

/**
 * Extract the concatenated UserData string from a synthesised template.
 *
 * CloudFormation UserData is rendered as `Fn::Base64( Fn::Join('', [...]) )`.
 * This helper flattens the join array, keeping string literals and replacing
 * CloudFormation intrinsics (Ref, Fn::GetAtt, etc.) with short placeholders
 * so we can inspect the shell content and estimate byte size.
 */
function extractUserDataParts(template: Template): string[] {
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate');
    const ltResource = Object.values(launchTemplates)[0] as {
        Properties?: {
            LaunchTemplateData?: {
                UserData?: { 'Fn::Base64'?: { 'Fn::Join'?: [string, unknown[]] } };
            };
        };
    };

    const joinArgs = ltResource?.Properties?.LaunchTemplateData?.UserData?.['Fn::Base64']?.['Fn::Join'];
    if (!joinArgs || !Array.isArray(joinArgs[1])) {
        throw new Error('Could not find UserData Fn::Join in LaunchTemplate');
    }

    return joinArgs[1].map((part: unknown) => {
        if (typeof part === 'string') return part;
        return '<CFN_TOKEN>';
    });
}

/**
 * Helper to create KubernetesMonitoringWorkerStack with sensible defaults.
 *
 * Override any prop via the `overrides` parameter.
 */
function createMonitoringWorkerStack(
    overrides?: Partial<Omit<KubernetesMonitoringWorkerStackProps, 'vpcId'>> & { vpcId?: string },
): { stack: KubernetesMonitoringWorkerStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    // Provide VPC context so Vpc.fromLookup() resolves with eu-west-1 AZs
    app.node.setContext(TEST_VPC_CONTEXT_KEY, TEST_VPC_CONTEXT);

    const stack = new KubernetesMonitoringWorkerStack(app, 'TestMonitoringWorkerStack', {
        vpcId: 'vpc-12345',
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        monitoringWorkerConfig: TEST_CONFIGS.monitoringWorker,
        controlPlaneSsmPrefix: '/k8s/development',
        namePrefix: 'k8s-dev',
        notificationEmail: TEST_NOTIFICATION_EMAIL,
        crossAccountDnsRoleArn: TEST_CROSS_ACCOUNT_DNS_ROLE_ARN,
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesMonitoringWorkerStack', () => {

    // =========================================================================
    // Launch Template
    // =========================================================================
    describe('Launch Template', () => {
        const { template } = createMonitoringWorkerStack();

        it('should create a launch template', () => {
            template.resourceCountIs('AWS::EC2::LaunchTemplate', 1);
        });
    });

    // =========================================================================
    // Spot Instance Configuration
    //
    // The stack uses an L1 escape hatch (CfnLaunchTemplate.addPropertyOverride)
    // to set InstanceMarketOptions.MarketType = 'spot' when the config flag
    // useSpotInstances is true.
    // =========================================================================
    describe('Spot Instance Configuration', () => {
        describe('when useSpotInstances is true (default)', () => {
            const { template } = createMonitoringWorkerStack();

            it('should set InstanceMarketOptions.MarketType to spot', () => {
                template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                    LaunchTemplateData: Match.objectLike({
                        InstanceMarketOptions: {
                            MarketType: 'spot',
                            SpotOptions: {
                                SpotInstanceType: 'one-time',
                            },
                        },
                    }),
                });
            });
        });

        describe('when useSpotInstances is false', () => {
            const disabledSpotConfig: MonitoringWorkerConfig = {
                ...TEST_CONFIGS.monitoringWorker,
                useSpotInstances: false,
            };
            const { template } = createMonitoringWorkerStack({
                monitoringWorkerConfig: disabledSpotConfig,
            });

            it('should NOT set InstanceMarketOptions', () => {
                template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
                    LaunchTemplateData: Match.objectLike({
                        InstanceMarketOptions: Match.absent(),
                    }),
                });
            });
        });
    });

    // =========================================================================
    // Auto Scaling Group
    // =========================================================================
    describe('Auto Scaling Group', () => {
        const { template } = createMonitoringWorkerStack();

        it('should create an ASG', () => {
            template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        it('should enforce maxCapacity=1 (single-node EBS constraint)', () => {
            template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                MaxSize: '1',
            });
        });
    });

    // =========================================================================
    // SNS Topic — Monitoring Alerts
    // =========================================================================
    describe('SNS Monitoring Alerts', () => {
        const { template } = createMonitoringWorkerStack();

        it('should create at least one SNS topic for alerts', () => {
            const topics = template.findResources('AWS::SNS::Topic');
            expect(Object.keys(topics).length).toBeGreaterThanOrEqual(1);
        });

        it('should create an email subscription when notificationEmail is provided', () => {
            template.hasResourceProperties('AWS::SNS::Subscription', {
                Protocol: 'email',
                Endpoint: TEST_NOTIFICATION_EMAIL,
            });
        });
    });

    // =========================================================================
    // User Data — slim bootstrap stub (16 KB limit enforcement)
    // =========================================================================
    describe('User Data', () => {
        const { template } = createMonitoringWorkerStack();
        const userDataParts = extractUserDataParts(template);
        const userDataContent = userDataParts.join('');

        // Helpers — predicate logic lives outside it() to avoid jest/no-conditional-in-test
        const stringParts = userDataParts.filter((p): p is string => typeof p === 'string');
        const containsPattern = (pattern: string): boolean =>
            stringParts.some((p) => p.includes(pattern));

        it('should stay under the CloudFormation 16 KB user data limit', () => {
            const sizeBytes = Buffer.byteLength(userDataContent, 'utf-8');
            expect(sizeBytes).toBeLessThan(CF_USER_DATA_MAX_BYTES);
        });

        describe('CDK token env var exports', () => {
            const requiredExports = [
                'STACK_NAME',
                'ASG_LOGICAL_ID',
                'AWS_REGION',
                'SSM_PREFIX',
                'NODE_LABEL',
                'S3_BUCKET',
                'LOG_GROUP_NAME',
            ];

            it.each(requiredExports)('should export %s', (envVar) => {
                expect(containsPattern(`export ${envVar}=`)).toBe(true);
            });
        });

        it('should publish instance ID to SSM for pipeline SSM trigger', () => {
            expect(containsPattern('ssm put-parameter')).toBe(true);
            expect(containsPattern('bootstrap/mon-worker-instance-id')).toBe(true);
        });

        it('should send cfn-signal immediately for infrastructure readiness', () => {
            expect(containsPattern('cfn-signal --success true')).toBe(true);
        });

        // Ensure no heavy inline bootstrap commands
        const heavyPatterns = [
            'kubeadm init',
            'kubeadm join',
            'docker pull',
            'containerd config',
            'kubectl apply',
            'calicoctl',
            'dnf install',
            'dnf update',
        ];

        it.each(heavyPatterns)(
            'should NOT contain heavy inline command: %s',
            (pattern) => {
                expect(containsPattern(pattern)).toBe(false);
            },
        );
    });

    // =========================================================================
    // IAM Configuration
    // =========================================================================
    describe('IAM Configuration', () => {
        const { template } = createMonitoringWorkerStack();

        it('should create at least one IAM role', () => {
            const roles = template.findResources('AWS::IAM::Role');
            expect(Object.keys(roles).length).toBeGreaterThanOrEqual(1);
        });

        it('should create an IAM instance profile', () => {
            const profiles = template.findResources('AWS::IAM::InstanceProfile');
            expect(Object.keys(profiles).length).toBeGreaterThanOrEqual(1);
        });

        it('should grant SSM GetParameter for join token discovery', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'ReadK8sJoinParams',
                            Action: 'ssm:GetParameter',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant KMS Decrypt for SecureString join token', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'DecryptJoinToken',
                            Action: 'kms:Decrypt',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant CloudWatch read-only for Grafana dashboards', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'CloudWatchGrafanaReadOnly',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('should grant sts:AssumeRole for cross-account DNS role', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'AssumeRoute53DnsRole',
                            Action: 'sts:AssumeRole',
                            Effect: 'Allow',
                            Resource: TEST_CROSS_ACCOUNT_DNS_ROLE_ARN,
                        }),
                    ]),
                }),
            });
        });

        describe('when crossAccountDnsRoleArn is NOT provided', () => {
            const { template: noDnsTemplate } = createMonitoringWorkerStack({
                crossAccountDnsRoleArn: undefined,
            });

            it('should NOT grant sts:AssumeRole', () => {
                const policies = noDnsTemplate.findResources('AWS::IAM::Policy');
                const hasAssumeRoute53 = Object.values(policies).some((resource) => {
                    const statements = (resource as {
                        Properties?: { PolicyDocument?: { Statement?: Array<{ Sid?: string }> } };
                    }).Properties?.PolicyDocument?.Statement;
                    return statements?.some((s) => s.Sid === 'AssumeRoute53DnsRole');
                });
                expect(hasAssumeRoute53).toBe(false);
            });
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        const { template } = createMonitoringWorkerStack();

        it('should export MonitoringWorkerAsgName', () => {
            template.hasOutput('MonitoringWorkerAsgName', {
                Description: 'Monitoring worker node ASG name',
            });
        });

        it('should export MonitoringWorkerInstanceRoleArn', () => {
            template.hasOutput('MonitoringWorkerInstanceRoleArn', {
                Description: 'Monitoring worker node IAM role ARN',
            });
        });

        it('should export MonitoringAlertsTopicArn', () => {
            template.hasOutput('MonitoringAlertsTopicArn', {
                Description: 'SNS topic ARN for Grafana monitoring alerts',
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const { template } = createMonitoringWorkerStack();

        it('should create SSM parameter for monitoring alerts topic ARN', () => {
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Description: Match.stringLikeRegexp('SNS topic ARN.*Grafana'),
            });
        });
    });
});
