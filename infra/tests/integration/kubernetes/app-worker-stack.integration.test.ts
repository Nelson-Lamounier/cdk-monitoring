/**
 * @format
 * Kubernetes App Worker Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesAppWorkerStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that the app worker instance is running with the
 * correct security group attachment, expected SG port rules, and disabled
 * Source/Destination Check (required for Calico pod networking).
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the base stack
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Security Group Scope:
 *   The app worker node only attaches the Cluster Base SG. It does NOT
 *   receive the Control Plane, Ingress, or Monitoring SGs — those are
 *   role-specific and attached only to the respective node types.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development --testPathPattern="app-worker-stack"
 */

import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';
import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    CloudFormationClient,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

import { Environment } from '../../../lib/config';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);
const NAME_PREFIX = 'k8s';

// Stack naming convention used by the factory
const APP_WORKER_STACK_NAME = `K8s-AppWorker-${CDK_ENV}`;

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const autoscaling = new AutoScalingClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

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

/**
 * Find the running EC2 instance launched by the app worker ASG.
 * Uses the Name tag `k8s-app-worker` set by AutoScalingGroupConstruct.
 */
async function findAppWorkerInstance(): Promise<{
    instanceId: string;
    securityGroupIds: string[];
    sourceDestCheck: boolean;
}> {
    const { Reservations } = await ec2.send(
        new DescribeInstancesCommand({
            Filters: [
                { Name: 'tag:Name', Values: [`${NAME_PREFIX}-app-worker`] },
                { Name: 'instance-state-name', Values: ['running'] },
            ],
        }),
    );

    const instances = (Reservations ?? []).flatMap(
        (r) => r.Instances ?? [],
    );

    if (instances.length === 0) {
        throw new Error(
            'No running app-worker instance found (tag:Name = k8s-app-worker)',
        );
    }

    const instance = instances[0];
    const sgIds = (instance.SecurityGroups ?? [])
        .map((sg) => sg.GroupId)
        .filter((id): id is string => !!id);

    // Source/Dest check is on the primary network interface
    const sourceDestCheck = instance.SourceDestCheck ?? true;

    return {
        instanceId: instance.InstanceId!,
        securityGroupIds: sgIds,
        sourceDestCheck,
    };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesAppWorkerStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;
    let appWorker: {
        instanceId: string;
        securityGroupIds: string[];
        sourceDestCheck: boolean;
    };

    // Load SSM parameters and find instance ONCE before all tests
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();
        appWorker = await findAppWorkerInstance();
    }, 30_000);

    // =========================================================================
    // EC2 Instance
    // =========================================================================
    describe('EC2 Instance', () => {
        it('should have a running app-worker instance', () => {
            expect(appWorker.instanceId).toBeDefined();
            expect(appWorker.instanceId.startsWith('i-')).toBe(true);
        });

        it('should be launched by an ASG with min=0, max=1, desired=1', async () => {
            const { AutoScalingGroups } = await autoscaling.send(
                new DescribeAutoScalingGroupsCommand({
                    Filters: [
                        {
                            Name: 'tag:Name',
                            Values: [`${NAME_PREFIX}-app-worker`],
                        },
                    ],
                }),
            );

            expect(AutoScalingGroups).toBeDefined();
            expect(AutoScalingGroups!.length).toBeGreaterThanOrEqual(1);

            const asg = AutoScalingGroups![0];
            expect(asg.DesiredCapacity).toBe(1);
            expect(asg.MinSize).toBe(0);
            expect(asg.MaxSize).toBe(1);
        });
    });

    // =========================================================================
    // Source/Destination Check
    //
    // Must be disabled for Kubernetes pod overlay networking (Calico).
    // Pod IPs (e.g. 192.168.x.x) don't match the ENI IP — AWS drops
    // cross-node pod traffic unless source/dest check is disabled.
    // =========================================================================
    describe('Source/Destination Check', () => {
        it('should have Source/Dest Check disabled for Calico networking', () => {
            expect(appWorker.sourceDestCheck).toBe(false);
        });
    });

    // =========================================================================
    // Security Group Attachment
    //
    // The app worker only attaches the Cluster Base SG. It does NOT get
    // control-plane, ingress, or monitoring SGs — those are role-specific.
    // =========================================================================
    describe('Security Group Attachment', () => {
        it('Cluster Base SG should be attached to the app-worker instance', () => {
            const sgId = ssmParams.get(SSM_PATHS.securityGroupId)!;
            expect(sgId).toBeDefined();
            expect(appWorker.securityGroupIds).toContain(sgId);
        });
    });

    // =========================================================================
    // Cluster Base SG — Port Rules
    //
    // Validates key intra-cluster ports from the config-driven rule set.
    // Not exhaustive — spot-checks critical Kubernetes ports that the
    // app worker relies on for cluster communication.
    // =========================================================================
    describe('Cluster Base SG — Port Rules', () => {
        let ingressRules: Array<{
            FromPort?: number;
            ToPort?: number;
            IpProtocol?: string;
        }>;

        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.securityGroupId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            ingressRules = SecurityGroups![0].IpPermissions ?? [];
        });

        it('should allow K8s API port 6443/tcp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 6443 && r.ToPort === 6443 && r.IpProtocol === 'tcp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow kubelet API port 10250/tcp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 10250 && r.ToPort === 10250 && r.IpProtocol === 'tcp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow etcd ports 2379-2380/tcp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 2379 && r.ToPort === 2380 && r.IpProtocol === 'tcp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow VXLAN overlay port 4789/udp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 4789 && r.ToPort === 4789 && r.IpProtocol === 'udp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow Calico BGP port 179/tcp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 179 && r.ToPort === 179 && r.IpProtocol === 'tcp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow NodePort range 30000-32767/tcp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 30000 && r.ToPort === 32767 && r.IpProtocol === 'tcp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow CoreDNS port 53/udp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 53 && r.ToPort === 53 && r.IpProtocol === 'udp',
            );
            expect(rule).toBeDefined();
        });

        it('should allow Calico Typha port 5473/tcp', () => {
            const rule = ingressRules.find(
                (r) => r.FromPort === 5473 && r.ToPort === 5473 && r.IpProtocol === 'tcp',
            );
            expect(rule).toBeDefined();
        });
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================
    describe('CloudFormation Outputs', () => {
        it('should have all expected outputs on the stack', async () => {
            const { Stacks } = await cfn.send(
                new DescribeStacksCommand({ StackName: APP_WORKER_STACK_NAME }),
            );

            expect(Stacks).toHaveLength(1);
            const outputs = Stacks![0].Outputs ?? [];
            const outputKeys = outputs.map((o) => o.OutputKey);

            expect(outputKeys).toContain('WorkerAsgName');
            expect(outputKeys).toContain('WorkerInstanceRoleArn');
        });
    });

    // =========================================================================
    // Downstream Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('SSM parameters required by this stack should be present', () => {
            // The app worker stack consumes these SSM parameters from
            // data + base + control plane stacks
            const requiredPaths = [
                SSM_PATHS.vpcId,
                SSM_PATHS.securityGroupId,
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
