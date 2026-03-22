/**
 * @format
 * Kubernetes Monitoring Worker Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesMonitoringWorkerStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that the monitoring worker node is running with the
 * correct security group attachment, expected SG port rules, SNS alerting topic,
 * and CloudFormation outputs.
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the base + monitoring worker stacks
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Security Groups Verified:
 *   - Cluster Base SG  (intra-cluster communication)
 *   - Ingress SG       (Traefik HTTP/HTTPS)
 *   - Monitoring SG    (Prometheus, Node Exporter, Loki, Tempo)
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development --testPathPattern="monitoring-worker-stack"
 */

import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    CloudFormationClient,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import type { Instance } from '@aws-sdk/client-ec2';
import {
    SNSClient,
    GetTopicAttributesCommand,
} from '@aws-sdk/client-sns';
import {
    SSMClient,
    GetParametersByPathCommand,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import { Environment } from '../../../lib/config';
import { Project, getProjectConfig } from '../../../lib/config/projects';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import { stackId, STACK_REGISTRY, flatName } from '../../../lib/utilities/naming';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
// Config reference (used for future assertions on instance type / volume size)
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);

/** Resource name prefix — matches factory: flatName('k8s', '', CDK_ENV) → e.g. 'k8s-dev' */
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

/** Stack name derived from the same utility the factory uses */
const KUBERNETES_NAMESPACE = getProjectConfig(Project.KUBERNETES).namespace;
const MONITORING_WORKER_STACK_NAME = stackId(KUBERNETES_NAMESPACE, STACK_REGISTRY.kubernetes.monitoringWorker, CDK_ENV);

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const autoscaling = new AutoScalingClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });
const sns = new SNSClient({ region: REGION });

// =============================================================================
// SSM Parameter Cache
// =============================================================================

/**
 * Load all SSM parameters under the k8s prefix in one paginated call.
 * Returns a Map<path, value> for fast lookup.
 */
async function loadSsmParameters(): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await ssm.send(
            new GetParametersByPathCommand({
                Path: PREFIX,
                Recursive: true,
                WithDecryption: true,
                NextToken: nextToken,
            }),
        );

        for (const param of response.Parameters ?? []) {
            if (param.Name && param.Value) {
                params.set(param.Name, param.Value);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return params;
}

// =============================================================================
// Helpers
// =============================================================================

/** Security group ingress rule shape from AWS SDK DescribeSecurityGroups */
interface IpPermission {
    FromPort?: number;
    ToPort?: number;
    IpProtocol?: string;
    IpRanges?: Array<{ CidrIp?: string }>;
    PrefixListIds?: Array<{ PrefixListId?: string }>;
}

/**
 * Find an ingress rule matching a port range and protocol.
 *
 * Extracted to module level so the predicate logic (&&) does not
 * appear inside it() blocks (jest/no-conditional-in-test).
 */
function findRule(
    rules: IpPermission[],
    fromPort: number,
    toPort: number,
    protocol: string,
): IpPermission | undefined {
    return rules.find(
        (r) => r.FromPort === fromPort && r.ToPort === toPort && r.IpProtocol === protocol,
    );
}

/**
 * Check whether an EC2 instance is a Spot instance.
 * Extracted to module level to avoid conditional logic inside it() blocks.
 */
function isSpotInstance(instance: Instance): boolean {
    return instance.InstanceLifecycle === 'spot';
}

/**
 * Find the running EC2 instance launched by the monitoring worker ASG.
 * Uses the Name tag `k8s-dev-mon-worker` set by AutoScalingGroupConstruct.
 *
 * Retries up to 5 times with 15s backoff because the ASG instance may
 * still be transitioning to 'running' when this test starts right after
 * the CloudFormation deploy completes.
 */
async function findMonitoringWorkerInstance(): Promise<{
    instance: Instance;
    securityGroupIds: string[];
}> {
    const maxAttempts = 5;
    const backoffMs = 15_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { Reservations } = await ec2.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:Name', Values: [`${NAME_PREFIX}-mon-worker`] },
                    { Name: 'instance-state-name', Values: ['running'] },
                ],
            }),
        );

        const instances = (Reservations ?? []).flatMap(
            (r) => r.Instances ?? [],
        );

        if (instances.length > 0) {
            const instance = instances[0];
            const sgIds = (instance.SecurityGroups ?? [])
                .map((sg) => sg.GroupId)
                .filter((id): id is string => !!id);

            return {
                instance,
                securityGroupIds: sgIds,
            };
        }

        if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }

    throw new Error(
        `No running monitoring-worker instance found after ${maxAttempts} attempts (tag:Name = ${NAME_PREFIX}-mon-worker)`,
    );
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesMonitoringWorkerStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;
    let monWorker: { instance: Instance; securityGroupIds: string[] };

    // Load SSM parameters and find instance ONCE before all tests
    // Extended timeout to accommodate instance launch retries (up to ~75s)
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();
        monWorker = await findMonitoringWorkerInstance();
    }, 120_000);

    // =========================================================================
    // EC2 Instance
    // =========================================================================
    describe('EC2 Instance', () => {
        it('should have a running monitoring-worker instance', () => {
            expect(monWorker.instance.InstanceId).toBeDefined();
            expect(monWorker.instance.InstanceId!.startsWith('i-')).toBe(true);
        });

        it('should be a Spot instance', () => {
            expect(isSpotInstance(monWorker.instance)).toBe(true);
        });

        it('should have an ASG with min=0, max=1, desired=1', async () => {
            const { AutoScalingGroups } = await autoscaling.send(
                new DescribeAutoScalingGroupsCommand({
                    Filters: [
                        {
                            Name: 'tag:Name',
                            Values: [`${NAME_PREFIX}-mon-worker`],
                        },
                    ],
                }),
            );

            expect(AutoScalingGroups).toBeDefined();
            expect(AutoScalingGroups!.length).toBeGreaterThanOrEqual(1);

            const asg = AutoScalingGroups![0];
            expect(asg.MinSize).toBe(0);
            expect(asg.MaxSize).toBe(1);
            expect(asg.DesiredCapacity).toBe(1);
        });
    });

    // =========================================================================
    // Security Group Attachment
    //
    // The monitoring worker should have 3 SGs attached:
    //   1. Cluster Base SG — intra-cluster communication
    //   2. Ingress SG     — Traefik HTTP/HTTPS
    //   3. Monitoring SG  — Prometheus, Loki, Tempo, Node Exporter
    // =========================================================================
    describe('Security Group Attachment', () => {
        const sgKeys = [
            { key: 'securityGroupId', label: 'Cluster Base' },
            { key: 'ingressSgId', label: 'Ingress' },
            { key: 'monitoringSgId', label: 'Monitoring' },
        ] as const;

        it.each(sgKeys)(
            'should have $label SG attached to the monitoring-worker instance',
            ({ key }) => {
                const sgId = ssmParams.get(SSM_PATHS[key])!;
                expect(sgId).toBeDefined();
                expect(monWorker.securityGroupIds).toContain(sgId);
            },
        );
    });

    // =========================================================================
    // Monitoring SG — Port Rules
    //
    // Validates the monitoring-specific ports from the config-driven rule set.
    // These ports are critical for cross-stack observability:
    //   - Prometheus scraping (9090)
    //   - Node Exporter metrics (9100)
    //   - Loki push API (30100)
    //   - Tempo OTLP gRPC (30417)
    // =========================================================================
    describe('Monitoring SG — Port Rules', () => {
        let ingressRules: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.monitoringSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            ingressRules = SecurityGroups![0].IpPermissions ?? [];
        });

        it('should allow Prometheus port 9090/tcp', () => {
            expect(findRule(ingressRules, 9090, 9090, 'tcp')).toBeDefined();
        });

        it('should allow Node Exporter port 9100/tcp', () => {
            expect(findRule(ingressRules, 9100, 9100, 'tcp')).toBeDefined();
        });

        it('should allow Loki push API port 30100/tcp', () => {
            expect(findRule(ingressRules, 30100, 30100, 'tcp')).toBeDefined();
        });

        it('should allow Tempo OTLP gRPC port 30417/tcp', () => {
            expect(findRule(ingressRules, 30417, 30417, 'tcp')).toBeDefined();
        });
    });

    // =========================================================================
    // Cluster Base SG — Port Rules (spot-checks)
    //
    // Validates key intra-cluster ports from the config-driven rule set.
    // Not exhaustive — spot-checks critical Kubernetes ports.
    // =========================================================================
    describe('Cluster Base SG — Port Rules', () => {
        let ingressRules: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.securityGroupId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            ingressRules = SecurityGroups![0].IpPermissions ?? [];
        });

        it('should allow K8s API port 6443/tcp', () => {
            expect(findRule(ingressRules, 6443, 6443, 'tcp')).toBeDefined();
        });

        it('should allow kubelet API port 10250/tcp', () => {
            expect(findRule(ingressRules, 10250, 10250, 'tcp')).toBeDefined();
        });

        it('should allow VXLAN overlay port 4789/udp', () => {
            expect(findRule(ingressRules, 4789, 4789, 'udp')).toBeDefined();
        });

        it('should allow CoreDNS port 53/udp', () => {
            expect(findRule(ingressRules, 53, 53, 'udp')).toBeDefined();
        });
    });

    // =========================================================================
    // SNS Topic — Monitoring Alerts
    //
    // Grafana's unified alerting publishes to this SNS topic.
    // The topic ARN is discoverable via SSM for ArgoCD bootstrap patching.
    // =========================================================================
    describe('SNS Monitoring Alerts Topic', () => {
        let alertsTopicArn: string;

        beforeAll(async () => {
            // The monitoring worker stack publishes this SSM parameter
            const ssmPath = `${PREFIX}/monitoring/alerts-topic-arn`;
            const { Parameter } = await ssm.send(
                new GetParameterCommand({ Name: ssmPath }),
            );
            alertsTopicArn = Parameter?.Value ?? '';
        });

        it('should have the alerts topic ARN published to SSM', () => {
            expect(alertsTopicArn).toBeDefined();
            expect(alertsTopicArn.length).toBeGreaterThan(0);
            expect(alertsTopicArn).toMatch(/^arn:aws:sns:/);
        });

        it('should have the SNS topic with KMS encryption enabled', async () => {
            const { Attributes } = await sns.send(
                new GetTopicAttributesCommand({ TopicArn: alertsTopicArn }),
            );

            expect(Attributes).toBeDefined();
            // KMS master key ID is set when encryption is enabled
            expect(Attributes!['KmsMasterKeyId']).toBeDefined();
            expect(Attributes!['KmsMasterKeyId']!.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================
    describe('CloudFormation Outputs', () => {
        let outputKeys: (string | undefined)[];

        // Depends on: MONITORING_WORKER_STACK_NAME constant
        beforeAll(async () => {
            const { Stacks } = await cfn.send(
                new DescribeStacksCommand({ StackName: MONITORING_WORKER_STACK_NAME }),
            );

            expect(Stacks).toHaveLength(1);
            const outputs = Stacks![0].Outputs ?? [];
            outputKeys = outputs.map((o) => o.OutputKey);
        });

        it('should export MonitoringWorkerAsgName', () => {
            expect(outputKeys).toContain('MonitoringWorkerAsgName');
        });

        it('should export MonitoringWorkerInstanceRoleArn', () => {
            expect(outputKeys).toContain('MonitoringWorkerInstanceRoleArn');
        });

        it('should export MonitoringAlertsTopicArn', () => {
            expect(outputKeys).toContain('MonitoringAlertsTopicArn');
        });
    });

    // =========================================================================
    // Downstream Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('should have all SSM parameters required by downstream stacks discoverable', () => {
            // AppIam and Edge stacks need: VPC, SGs, KMS, Scripts Bucket
            const requiredPaths = [
                SSM_PATHS.vpcId,
                SSM_PATHS.securityGroupId,
                SSM_PATHS.ingressSgId,
                SSM_PATHS.monitoringSgId,
                SSM_PATHS.kmsKeyArn,
                SSM_PATHS.scriptsBucket,
            ];

            for (const path of requiredPaths) {
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.trim().length).toBeGreaterThan(0);
            }
        });
    });
});
