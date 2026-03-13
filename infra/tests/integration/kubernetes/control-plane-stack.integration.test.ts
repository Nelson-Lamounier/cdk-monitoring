/**
 * @format
 * Kubernetes Control Plane Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesControlPlaneStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that the control plane instance is running with the
 * correct EIP association, security group attachment, and expected SG port rules.
 *
 * SSM-Anchored Strategy:
 *   1. Read all SSM parameters published by the base + control plane stacks
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development --testPathPattern="control-plane-stack"
 */

import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';
import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeAddressesCommand,
    DescribeSecurityGroupsCommand,
    DescribeImagesCommand,
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
import { getK8sConfigs } from '../../../lib/config/kubernetes';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import { stackId, STACK_REGISTRY, flatName } from '../../../lib/utilities/naming';
import { Project, getProjectConfig } from '../../../lib/config/projects';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const CONFIGS = getK8sConfigs(CDK_ENV);
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);
/** Resource name prefix — matches factory: flatName('k8s', '', CDK_ENV) → e.g. 'k8s-dev' */
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

/** Stack name derived from the same utility the factory uses */
const KUBERNETES_NAMESPACE = getProjectConfig(Project.KUBERNETES).namespace;
const CONTROLPLANE_STACK_NAME = stackId(KUBERNETES_NAMESPACE, STACK_REGISTRY.kubernetes.controlPlane, CDK_ENV);

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
 * Find the running EC2 instance launched by the control plane ASG.
 * Uses the Name tag `k8s-control-plane` set by AutoScalingGroupConstruct.
 *
 * Retries up to 5 times with 15s backoff because the ASG instance may
 * still be transitioning to 'running' when this test starts right after
 * the CloudFormation deploy completes.
 */
async function findControlPlaneInstance(): Promise<{
    instanceId: string;
    imageId: string;
    securityGroupIds: string[];
}> {
    const maxAttempts = 5;
    const backoffMs = 15_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { Reservations } = await ec2.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:Name', Values: [`${NAME_PREFIX}-control-plane`] },
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
                instanceId: instance.InstanceId!,
                imageId: instance.ImageId!,
                securityGroupIds: sgIds,
            };
        }

        if (attempt < maxAttempts) {
            console.log(
                `[Retry ${attempt}/${maxAttempts}] No running control-plane instance yet — retrying in ${backoffMs / 1000}s`,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }

    throw new Error(
        `No running control-plane instance found after ${maxAttempts} attempts (tag:Name = ${NAME_PREFIX}-control-plane)`,
    );
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesControlPlaneStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;
    let controlPlane: { instanceId: string; imageId: string; securityGroupIds: string[] };

    // Load SSM parameters and find instance ONCE before all tests
    // Extended timeout to accommodate instance launch retries (up to ~75s)
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();
        controlPlane = await findControlPlaneInstance();
    }, 120_000);

    // =========================================================================
    // EC2 Instance
    // =========================================================================
    describe('EC2 Instance', () => {
        it('should have a running control-plane instance', () => {
            expect(controlPlane.instanceId).toBeDefined();
            expect(controlPlane.instanceId.startsWith('i-')).toBe(true);
        });

        it('should be launched by an ASG with desired capacity 1', async () => {
            // Find ASG by tag
            const { AutoScalingGroups } = await autoscaling.send(
                new DescribeAutoScalingGroupsCommand({
                    Filters: [
                        {
                            Name: 'tag:Name',
                            Values: [`${NAME_PREFIX}-control-plane`],
                        },
                    ],
                }),
            );

            expect(AutoScalingGroups).toBeDefined();
            expect(AutoScalingGroups!.length).toBeGreaterThanOrEqual(1);

            const asg = AutoScalingGroups![0];
            expect(asg.DesiredCapacity).toBe(1);
            expect(asg.MinSize).toBe(1);
            expect(asg.MaxSize).toBe(1);
        });
    });

    // =========================================================================
    // Golden AMI Verification
    //
    // Ensures the instance was launched with the latest Golden AMI stored in
    // SSM at /k8s/<env>/golden-ami/latest.  Also validates AMI tags.
    // =========================================================================
    describe('Golden AMI', () => {
        it('should use the latest Golden AMI from SSM', () => {
            const expectedAmi = ssmParams.get(CONFIGS.image.amiSsmPath);
            expect(expectedAmi).toBeDefined();
            expect(controlPlane.imageId).toBe(expectedAmi);
        });

        it('AMI should have Purpose=GoldenAMI tag', async () => {
            const { Images } = await ec2.send(
                new DescribeImagesCommand({
                    ImageIds: [controlPlane.imageId],
                }),
            );

            expect(Images).toHaveLength(1);

            const tags = Images![0].Tags ?? [];
            const purposeTag = tags.find((t) => t.Key === 'Purpose');
            expect(purposeTag).toBeDefined();
            expect(purposeTag!.Value).toBe('GoldenAMI');
        });

        it('AMI should be in available state', async () => {
            const { Images } = await ec2.send(
                new DescribeImagesCommand({
                    ImageIds: [controlPlane.imageId],
                }),
            );

            expect(Images).toHaveLength(1);
            expect(Images![0].State).toBe('available');
        });
    });

    // =========================================================================
    // Elastic IP Association
    // =========================================================================
    describe('Elastic IP', () => {
        it('should have the EIP associated to the control-plane instance', async () => {
            const allocationId = ssmParams.get(SSM_PATHS.elasticIpAllocationId)!;
            expect(allocationId).toBeDefined();

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );

            expect(Addresses).toHaveLength(1);
            expect(Addresses![0].InstanceId).toBe(controlPlane.instanceId);
        });

        it('should have a public IP matching the SSM parameter', async () => {
            const allocationId = ssmParams.get(SSM_PATHS.elasticIpAllocationId)!;
            const expectedIp = ssmParams.get(SSM_PATHS.elasticIp)!;

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );

            expect(Addresses![0].PublicIp).toBe(expectedIp);
        });
    });

    // =========================================================================
    // Security Group Attachment
    // =========================================================================
    describe('Security Group Attachment', () => {
        const sgKeys = [
            { key: 'securityGroupId', label: 'Cluster Base' },
            { key: 'controlPlaneSgId', label: 'Control Plane' },
            { key: 'ingressSgId', label: 'Ingress' },
        ] as const;

        it.each(sgKeys)(
            '$label SG should be attached to the control-plane instance',
            ({ key }) => {
                const sgId = ssmParams.get(SSM_PATHS[key])!;
                expect(sgId).toBeDefined();
                expect(controlPlane.securityGroupIds).toContain(sgId);
            },
        );
    });

    // =========================================================================
    // Security Group Port Rules — Cluster Base SG
    //
    // Validates key intra-cluster ports from the config-driven rule set.
    // Not exhaustive — spot-checks critical Kubernetes ports.
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
    });

    // =========================================================================
    // Control Plane SG — Port Rules
    // =========================================================================
    describe('Control Plane SG — Port Rules', () => {
        it('should allow K8s API port 6443/tcp from VPC CIDR', async () => {
            const sgId = ssmParams.get(SSM_PATHS.controlPlaneSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            const ingress = SecurityGroups![0].IpPermissions ?? [];
            const apiRule = ingress.find(
                (r) => r.FromPort === 6443 && r.ToPort === 6443 && r.IpProtocol === 'tcp',
            );

            expect(apiRule).toBeDefined();
            // Should have at least one IPv4 range (the VPC CIDR)
            expect(apiRule!.IpRanges!.length).toBeGreaterThanOrEqual(1);
        });
    });

    // =========================================================================
    // Ingress SG — Port Rules
    // =========================================================================
    describe('Ingress SG — Port Rules', () => {
        let ingressRules: Array<{
            FromPort?: number;
            ToPort?: number;
            IpProtocol?: string;
            IpRanges?: Array<{ CidrIp?: string }>;
        }>;

        beforeAll(async () => {
            const sgId = ssmParams.get(SSM_PATHS.ingressSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            ingressRules = SecurityGroups![0].IpPermissions ?? [];
        });

        it('should allow HTTP port 80/tcp', () => {
            const httpRule = ingressRules.find(
                (r) => r.FromPort === 80 && r.ToPort === 80 && r.IpProtocol === 'tcp',
            );
            expect(httpRule).toBeDefined();
        });

        it('should allow HTTP from 0.0.0.0/0 (LetsEncrypt + CloudFront)', () => {
            const httpRule = ingressRules.find(
                (r) => r.FromPort === 80 && r.ToPort === 80 && r.IpProtocol === 'tcp',
            );

            const anyIpv4 = httpRule?.IpRanges?.find(
                (range) => range.CidrIp === '0.0.0.0/0',
            );
            expect(anyIpv4).toBeDefined();
        });
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================
    describe('CloudFormation Outputs', () => {
        it('should have all expected outputs on the stack', async () => {
            const { Stacks } = await cfn.send(
                new DescribeStacksCommand({ StackName: CONTROLPLANE_STACK_NAME }),
            );

            expect(Stacks).toHaveLength(1);
            const outputs = Stacks![0].Outputs ?? [];
            const outputKeys = outputs.map((o) => o.OutputKey);

            expect(outputKeys).toContain('InstanceRoleArn');
            expect(outputKeys).toContain('AutoScalingGroupName');
            expect(outputKeys).toContain('ScriptsBucketName');
            expect(outputKeys).toContain('SsmDocumentName');
            expect(outputKeys).toContain('SsmAssociationName');
        });
    });

    // =========================================================================
    // Downstream Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('all SSM parameters required by downstream stacks should be discoverable', () => {
            // Worker stacks and AppIam need: VPC, SGs, KMS, EBS, Scripts Bucket
            // These are published by base stack but consumed through the same prefix
            const requiredPaths = [
                SSM_PATHS.vpcId,
                SSM_PATHS.securityGroupId,
                SSM_PATHS.controlPlaneSgId,
                SSM_PATHS.ingressSgId,
                SSM_PATHS.elasticIp,
                SSM_PATHS.elasticIpAllocationId,
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
