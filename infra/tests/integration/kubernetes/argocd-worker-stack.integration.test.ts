/**
 * @format
 * Kubernetes ArgoCD Worker Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesArgocdWorkerStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that the ArgoCD worker Spot instance is running
 * with the correct security group attachment, NLB target group registration,
 * Spot market type, and CloudFormation outputs.
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the base + worker stacks
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Security Groups Verified:
 *   - Cluster Base SG  (intra-cluster communication)
 *   - Ingress SG       (NLB → Traefik HTTP/HTTPS)
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development --testPathPattern="argocd-worker-stack"
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
    ElasticLoadBalancingV2Client,
    DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
    SSMClient,
    GetParametersByPathCommand,
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
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);

/** Resource name prefix — matches factory: flatName('k8s', '', CDK_ENV) → e.g. 'k8s-dev' */
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

/** Stack name derived from the same utility the factory uses */
const KUBERNETES_NAMESPACE = getProjectConfig(Project.KUBERNETES).namespace;
const ARGOCD_WORKER_STACK_NAME = stackId(
    KUBERNETES_NAMESPACE,
    STACK_REGISTRY.kubernetes.argocdWorker,
    CDK_ENV,
);

// AWS SDK clients (shared across tests)
const ssmClient = new SSMClient({ region: REGION });
const ec2Client = new EC2Client({ region: REGION });
const autoscalingClient = new AutoScalingClient({ region: REGION });
const cfnClient = new CloudFormationClient({ region: REGION });
const elbv2Client = new ElasticLoadBalancingV2Client({ region: REGION });

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
        const response = await ssmClient.send(
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
 * Safely require a value from the SSM parameter map.
 * Throws a descriptive error if the parameter is missing.
 */
function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}

/**
 * Check whether an EC2 instance is a Spot instance.
 * Extracted to module level to avoid conditional logic inside it() blocks.
 */
function isSpotInstance(instance: Instance): boolean {
    return instance.InstanceLifecycle === 'spot';
}

/**
 * Extract target IDs from an ELBv2 TargetHealthDescriptions response.
 * Extracted to module level to avoid conditional filter logic inside it() blocks
 * (jest/no-conditional-in-test).
 */
function extractTargetIds(
    descriptions: Array<{ Target?: { Id?: string } }>,
): string[] {
    return descriptions
        .map((t) => t.Target?.Id)
        .filter((id): id is string => !!id);
}

/**
 * Poll DescribeTargetHealth until the expected instance appears in the
 * NLB target group.
 *
 * After a Spot instance replacement or stack redeployment, the ASG needs
 * time to register the new instance with the NLB. This helper retries
 * with a configurable backoff to accommodate the propagation delay.
 *
 * @param client     - ELBv2 client
 * @param tgArn      - Target group ARN to poll
 * @param expectedId - Instance ID that must appear in the targets
 * @param maxAttempts - Maximum number of polling attempts
 * @param backoffMs  - Milliseconds to wait between attempts
 * @returns The final list of target IDs (including the expected one)
 * @throws If the expected instance never appears after all attempts
 */
async function waitForTargetRegistration(
    client: ElasticLoadBalancingV2Client,
    tgArn: string,
    expectedId: string,
    maxAttempts: number,
    backoffMs: number,
): Promise<string[]> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { TargetHealthDescriptions } = await client.send(
            new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }),
        );

        const targetIds = extractTargetIds(TargetHealthDescriptions ?? []);

        if (targetIds.includes(expectedId)) {
            return targetIds;
        }

        if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }

    // Final attempt failed — return whatever targets exist so the assertion
    // produces a clear diff showing which targets ARE registered
    const { TargetHealthDescriptions } = await client.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }),
    );
    return extractTargetIds(TargetHealthDescriptions ?? []);
}

/**
 * Find the running EC2 instance launched by the ArgoCD worker ASG.
 * Uses the Name tag `k8s-dev-argocd-worker` set by AutoScalingGroupConstruct.
 *
 * Retries up to 5 times with 15s backoff because the ASG instance may
 * still be transitioning to 'running' when this test starts right after
 * the CloudFormation deploy completes.
 */
async function findArgocdWorkerInstance(): Promise<{
    instance: Instance;
    securityGroupIds: string[];
}> {
    const maxAttempts = 5;
    const backoffMs = 15_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { Reservations } = await ec2Client.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:Name', Values: [`${NAME_PREFIX}-argocd-worker`] },
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
        `No running argocd-worker instance found after ${maxAttempts} attempts (tag:Name = ${NAME_PREFIX}-argocd-worker)`,
    );
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesArgocdWorkerStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;
    let argocdWorker: { instance: Instance; securityGroupIds: string[] };

    // Load SSM parameters and find instance ONCE before all tests
    // Extended timeout to accommodate instance launch retries (up to ~75s)
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();
        argocdWorker = await findArgocdWorkerInstance();
    }, 120_000);

    // =========================================================================
    // EC2 Instance
    // =========================================================================
    describe('EC2 Instance', () => {
        it('should have a running argocd-worker instance', () => {
            expect(argocdWorker.instance.InstanceId).toBeDefined();
            expect(argocdWorker.instance.InstanceId!.startsWith('i-')).toBe(true);
        });

        it('should be a Spot instance', () => {
            expect(isSpotInstance(argocdWorker.instance)).toBe(true);
        });

        it('should have Source/Dest Check disabled for Calico networking', () => {
            expect(argocdWorker.instance.SourceDestCheck).toBe(false);
        });

        it('should have an ASG with min=0, max=1, desired=1', async () => {
            const { AutoScalingGroups } = await autoscalingClient.send(
                new DescribeAutoScalingGroupsCommand({
                    Filters: [
                        {
                            Name: 'tag:Name',
                            Values: [`${NAME_PREFIX}-argocd-worker`],
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
    // The ArgoCD worker should have 2 SGs attached:
    //   1. Cluster Base SG — intra-cluster communication
    //   2. Ingress SG      — NLB → Traefik HTTP/HTTPS
    // =========================================================================
    describe('Security Group Attachment', () => {
        it('should have Cluster Base SG attached', () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.securityGroupId);
            expect(argocdWorker.securityGroupIds).toContain(sgId);
        });

        it('should have Ingress SG attached', () => {
            const ingressSgId = requireParam(ssmParams, SSM_PATHS.ingressSgId);
            expect(argocdWorker.securityGroupIds).toContain(ingressSgId);
        });
    });

    // =========================================================================
    // NLB Target Group Registration
    //
    // The ArgoCD worker ASG must be registered with the NLB HTTP and HTTPS
    // target groups so NLB can route traffic directly to Traefik on this node.
    //
    // After a Spot instance replacement or stack redeployment, the ASG needs
    // time to register the new instance with the NLB. We poll DescribeTargetHealth
    // until the expected instance appears (up to ~2.5 min).
    // =========================================================================
    describe('NLB Target Group Registration', () => {
        let httpTgArn: string;
        let httpsTgArn: string;

        /** Max attempts for NLB target registration polling */
        const NLB_MAX_ATTEMPTS = 10;
        /** Backoff between NLB polling attempts in milliseconds */
        const NLB_BACKOFF_MS = 15_000;

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(() => {
            httpTgArn = requireParam(ssmParams, SSM_PATHS.nlbHttpTargetGroupArn);
            httpsTgArn = requireParam(ssmParams, SSM_PATHS.nlbHttpsTargetGroupArn);
        });

        it('should be registered with the HTTP target group', async () => {
            const expectedId = argocdWorker.instance.InstanceId!;
            const targetIds = await waitForTargetRegistration(
                elbv2Client,
                httpTgArn,
                expectedId,
                NLB_MAX_ATTEMPTS,
                NLB_BACKOFF_MS,
            );

            expect(targetIds).toContain(expectedId);
        }, 180_000);

        it('should be registered with the HTTPS target group', async () => {
            const expectedId = argocdWorker.instance.InstanceId!;
            const targetIds = await waitForTargetRegistration(
                elbv2Client,
                httpsTgArn,
                expectedId,
                NLB_MAX_ATTEMPTS,
                NLB_BACKOFF_MS,
            );

            expect(targetIds).toContain(expectedId);
        }, 180_000);
    });

    // =========================================================================
    // Cluster Base SG — Port Rules (spot-checks)
    //
    // Validates key intra-cluster ports. Not exhaustive — spot-checks
    // critical Kubernetes ports for cluster communication.
    // =========================================================================
    describe('Cluster Base SG — Port Rules', () => {
        let ingressRules: IpPermission[];

        // Depends on: ssmParams populated in top-level beforeAll
        beforeAll(async () => {
            const sgId = requireParam(ssmParams, SSM_PATHS.securityGroupId);

            const { SecurityGroups } = await ec2Client.send(
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
    // CloudFormation Outputs
    // =========================================================================
    describe('CloudFormation Outputs', () => {
        let outputKeys: (string | undefined)[];

        // Depends on: ARGOCD_WORKER_STACK_NAME constant
        beforeAll(async () => {
            const { Stacks } = await cfnClient.send(
                new DescribeStacksCommand({ StackName: ARGOCD_WORKER_STACK_NAME }),
            );

            expect(Stacks).toHaveLength(1);
            const outputs = Stacks![0].Outputs ?? [];
            outputKeys = outputs.map((o) => o.OutputKey);
        });

        it('should export ArgocdWorkerAsgName', () => {
            expect(outputKeys).toContain('ArgocdWorkerAsgName');
        });

        it('should export ArgocdWorkerInstanceRoleArn', () => {
            expect(outputKeys).toContain('ArgocdWorkerInstanceRoleArn');
        });
    });

    // =========================================================================
    // Downstream Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('should have all SSM parameters required by this stack present', () => {
            // The ArgoCD worker stack consumes these SSM parameters from
            // data + base + control plane stacks
            const requiredPaths = [
                SSM_PATHS.vpcId,
                SSM_PATHS.securityGroupId,
                SSM_PATHS.ingressSgId,
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
