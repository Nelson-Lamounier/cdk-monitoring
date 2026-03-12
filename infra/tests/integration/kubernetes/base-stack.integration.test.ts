/**
 * @format
 * Kubernetes Base Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesBaseStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that all resources exist, are correctly
 * configured, and the environment is ready for downstream stacks
 * (GoldenAMI, Compute, AppIam, Api, Edge).
 *
 * SSM-Anchored Strategy:
 *   1. Read all 12 SSM parameters published by the base stack
 *   2. Use those values to verify the actual AWS resources
 *   This guarantees we're testing the SAME resources the stack created.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development
 */

import {
    SSMClient,
    GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';
import {
    EC2Client,
    DescribeVpcsCommand,
    DescribeSecurityGroupsCommand,
    DescribeVolumesCommand,
    DescribeAddressesCommand,
} from '@aws-sdk/client-ec2';
import {
    KMSClient,
    DescribeKeyCommand,
    GetKeyRotationStatusCommand,
} from '@aws-sdk/client-kms';
import {
    S3Client,
    HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
    Route53Client,
    GetHostedZoneCommand,
    ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';

import { Environment } from '../../../lib/config';
import { getK8sConfigs } from '../../../lib/config/kubernetes';
import { k8sSsmPaths, k8sSsmPrefix } from '../../../lib/config/ssm-paths';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const CONFIGS = getK8sConfigs(CDK_ENV);
const SSM_PATHS = k8sSsmPaths(CDK_ENV);
const PREFIX = k8sSsmPrefix(CDK_ENV);

// AWS SDK clients (shared across tests)
const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const kms = new KMSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const route53 = new Route53Client({ region: REGION });

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
// Tests
// =============================================================================

describe('KubernetesBaseStack — Post-Deploy Verification', () => {
    let ssmParams: Map<string, string>;

    // Load SSM parameters ONCE before all tests
    beforeAll(async () => {
        ssmParams = await loadSsmParameters();
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        const expectedPaths = [
            'vpcId',
            'elasticIp',
            'elasticIpAllocationId',
            'securityGroupId',
            'controlPlaneSgId',
            'ingressSgId',
            'monitoringSgId',
            'ebsVolumeId',
            'scriptsBucket',
            'hostedZoneId',
            'apiDnsName',
            'kmsKeyArn',
        ] as const;

        it('should have all 12 SSM parameters published', () => {
            expect(ssmParams.size).toBeGreaterThanOrEqual(expectedPaths.length);
        });

        it.each(expectedPaths)(
            'should have a non-empty value for %s',
            (key) => {
                const path = SSM_PATHS[key];
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.length).toBeGreaterThan(0);
            },
        );

        it('should store k8s-api.k8s.internal as the API DNS name', () => {
            expect(ssmParams.get(SSM_PATHS.apiDnsName)).toBe(
                'k8s-api.k8s.internal',
            );
        });
    });

    // =========================================================================
    // VPC
    // =========================================================================
    describe('VPC', () => {
        it('should exist and be in available state', async () => {
            const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

            const { Vpcs } = await ec2.send(
                new DescribeVpcsCommand({ VpcIds: [vpcId] }),
            );

            expect(Vpcs).toHaveLength(1);
            expect(Vpcs![0].State).toBe('available');
        });
    });

    // =========================================================================
    // Security Groups (×4)
    // =========================================================================
    describe('Security Groups', () => {
        const sgKeys = [
            { key: 'securityGroupId', label: 'Cluster Base' },
            { key: 'controlPlaneSgId', label: 'Control Plane' },
            { key: 'ingressSgId', label: 'Ingress' },
            { key: 'monitoringSgId', label: 'Monitoring' },
        ] as const;

        it.each(sgKeys)(
            '$label SG should exist and be attached to the VPC',
            async ({ key }) => {
                const sgId = ssmParams.get(SSM_PATHS[key])!;
                const vpcId = ssmParams.get(SSM_PATHS.vpcId)!;

                const { SecurityGroups } = await ec2.send(
                    new DescribeSecurityGroupsCommand({
                        GroupIds: [sgId],
                    }),
                );

                expect(SecurityGroups).toHaveLength(1);
                expect(SecurityGroups![0].VpcId).toBe(vpcId);
            },
        );

        it('Ingress SG should have HTTP port 80 open', async () => {
            const sgId = ssmParams.get(SSM_PATHS.ingressSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            const ingress = SecurityGroups![0].IpPermissions ?? [];
            const httpRule = ingress.find(
                (r) => r.FromPort === 80 && r.ToPort === 80 && r.IpProtocol === 'tcp',
            );

            expect(httpRule).toBeDefined();
        });

        it('Control Plane SG should have K8s API port 6443 open', async () => {
            const sgId = ssmParams.get(SSM_PATHS.controlPlaneSgId)!;

            const { SecurityGroups } = await ec2.send(
                new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }),
            );

            const ingress = SecurityGroups![0].IpPermissions ?? [];
            const apiRule = ingress.find(
                (r) => r.FromPort === 6443 && r.ToPort === 6443 && r.IpProtocol === 'tcp',
            );

            expect(apiRule).toBeDefined();
        });
    });

    // =========================================================================
    // EBS Volume
    // =========================================================================
    describe('EBS Volume', () => {
        it('should exist, be encrypted, and use GP3', async () => {
            const volumeId = ssmParams.get(SSM_PATHS.ebsVolumeId)!;

            const { Volumes } = await ec2.send(
                new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
            );

            expect(Volumes).toHaveLength(1);
            const vol = Volumes![0];
            expect(vol.Encrypted).toBe(true);
            expect(vol.VolumeType).toBe('gp3');
            expect(vol.Size).toBe(CONFIGS.storage.volumeSizeGb);
        });

        it('should be in the correct availability zone', async () => {
            const volumeId = ssmParams.get(SSM_PATHS.ebsVolumeId)!;

            const { Volumes } = await ec2.send(
                new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
            );

            expect(Volumes![0].AvailabilityZone).toBe(`${REGION}a`);
        });
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    describe('Elastic IP', () => {
        it('should exist as a VPC allocation', async () => {
            const allocationId = ssmParams.get(SSM_PATHS.elasticIpAllocationId)!;

            const { Addresses } = await ec2.send(
                new DescribeAddressesCommand({
                    AllocationIds: [allocationId],
                }),
            );

            expect(Addresses).toHaveLength(1);
            expect(Addresses![0].Domain).toBe('vpc');
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
    // KMS Key
    // =========================================================================
    describe('KMS Key', () => {
        it('should exist and be enabled', async () => {
            const keyArn = ssmParams.get(SSM_PATHS.kmsKeyArn)!;

            const { KeyMetadata } = await kms.send(
                new DescribeKeyCommand({ KeyId: keyArn }),
            );

            expect(KeyMetadata).toBeDefined();
            expect(KeyMetadata!.Enabled).toBe(true);
            expect(KeyMetadata!.KeyState).toBe('Enabled');
        });

        it('should have key rotation enabled', async () => {
            const keyArn = ssmParams.get(SSM_PATHS.kmsKeyArn)!;

            const { KeyRotationEnabled } = await kms.send(
                new GetKeyRotationStatusCommand({ KeyId: keyArn }),
            );

            expect(KeyRotationEnabled).toBe(true);
        });
    });

    // =========================================================================
    // S3 Scripts Bucket
    // =========================================================================
    describe('S3 Scripts Bucket', () => {
        it('should exist and be accessible', async () => {
            const bucketName = ssmParams.get(SSM_PATHS.scriptsBucket)!;

            // HeadBucket returns 200 if the bucket exists and the caller has access
            await expect(
                s3.send(new HeadBucketCommand({ Bucket: bucketName })),
            ).resolves.toBeDefined();
        });
    });

    // =========================================================================
    // Route 53 Private Hosted Zone
    // =========================================================================
    describe('Route 53', () => {
        it('should have a private hosted zone for k8s.internal', async () => {
            const hostedZoneId = ssmParams.get(SSM_PATHS.hostedZoneId)!;

            const { HostedZone } = await route53.send(
                new GetHostedZoneCommand({
                    Id: hostedZoneId,
                }),
            );

            expect(HostedZone?.Name).toBe('k8s.internal.');
            expect(HostedZone?.Config?.PrivateZone).toBe(true);
        });

        it('should have an A record for k8s-api.k8s.internal', async () => {
            const hostedZoneId = ssmParams.get(SSM_PATHS.hostedZoneId)!;

            const { ResourceRecordSets } = await route53.send(
                new ListResourceRecordSetsCommand({
                    HostedZoneId: hostedZoneId,
                    StartRecordName: 'k8s-api.k8s.internal',
                    StartRecordType: 'A',
                    MaxItems: 1,
                }),
            );

            const aRecord = ResourceRecordSets?.find(
                (r) => r.Name === 'k8s-api.k8s.internal.' && r.Type === 'A',
            );

            expect(aRecord).toBeDefined();
            expect(aRecord!.TTL).toBe(30);
        });
    });

    // =========================================================================
    // Readiness Gate
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('all resources required by Compute stack should be discoverable via SSM', () => {
            // Compute stack needs: VPC, SG, EBS, KMS, Scripts Bucket, Hosted Zone
            const requiredKeys = [
                SSM_PATHS.vpcId,
                SSM_PATHS.securityGroupId,
                SSM_PATHS.controlPlaneSgId,
                SSM_PATHS.ingressSgId,
                SSM_PATHS.monitoringSgId,
                SSM_PATHS.ebsVolumeId,
                SSM_PATHS.kmsKeyArn,
                SSM_PATHS.scriptsBucket,
                SSM_PATHS.hostedZoneId,
                SSM_PATHS.elasticIp,
                SSM_PATHS.elasticIpAllocationId,
            ];

            for (const path of requiredKeys) {
                const value = ssmParams.get(path);
                expect(value).toBeDefined();
                expect(value!.trim().length).toBeGreaterThan(0);
            }
        });
    });
});
