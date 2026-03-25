/**
 * @format
 * Golden AMI Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the GoldenAmiStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify AMI properties, security posture, tags,
 * and stack health.
 *
 * Verification Strategy (property-based — tests the artefact, not the build process):
 *   1. Read the AMI ID from SSM (published by Image Builder)
 *   2. Verify AMI exists and is in 'available' state via EC2 DescribeImages
 *   3. Check AMI properties (architecture, EBS, ENA, virtualisation type)
 *   4. Validate security posture (private launch permissions, encrypted snapshots)
 *   5. Verify AMI tags (KubernetesVersion, Purpose, Component)
 *   6. Confirm CloudFormation stack health and downstream SSM readiness
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/golden-ami-stack development
 *
 * @example Local invocation:
 *   just test-golden-ami development
 */

import {
    CloudFormationClient,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
    EC2Client,
    DescribeImagesCommand,
    DescribeImageAttributeCommand,
    DescribeSnapshotsCommand,
} from '@aws-sdk/client-ec2';
import type { Image, BlockDeviceMapping } from '@aws-sdk/client-ec2';
import {
    SSMClient,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import { Environment } from '../../../lib/config';
import { getK8sConfigs } from '../../../lib/config/kubernetes';
import { Project, getProjectConfig } from '../../../lib/config/projects';
import { k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import { stackId, STACK_REGISTRY } from '../../../lib/utilities/naming';

// =============================================================================
// Configuration (config-driven — no hardcoded values)
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const CONFIGS = getK8sConfigs(CDK_ENV);
const _SSM_PREFIX = k8sSsmPrefix(CDK_ENV);

/** Namespace from project config (empty for Kubernetes — stacks have no prefix) */
const KUBERNETES_NAMESPACE = getProjectConfig(Project.KUBERNETES).namespace;

/** Stack name derived from the same utility the factory uses */
const STACK_NAME = stackId(KUBERNETES_NAMESPACE, STACK_REGISTRY.kubernetes.goldenAmi, CDK_ENV);

/** SSM path where Image Builder stores the AMI ID */
const AMI_SSM_PATH = CONFIGS.image.amiSsmPath;

// =============================================================================
// Constants
// =============================================================================

/** Expected AMI architecture */
const EXPECTED_ARCHITECTURE = 'x86_64';

/** Expected virtualisation type */
const EXPECTED_VIRTUALISATION_TYPE = 'hvm';

/** Expected root device type */
const EXPECTED_ROOT_DEVICE_TYPE = 'ebs';

/** Expected root EBS volume type */
const EXPECTED_VOLUME_TYPE = 'gp3';

/** Minimum root volume size in GB (from config) */
const MIN_ROOT_VOLUME_SIZE_GB = CONFIGS.compute.rootVolumeSizeGb;

/** Maximum AMI age in days before considered stale */
const MAX_AMI_AGE_DAYS = 30;

// =============================================================================
// AWS SDK Clients
// =============================================================================

const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

// =============================================================================
// Shared State (populated in beforeAll)
// =============================================================================

let amiId: string;
let image: Image;
let rootBlockDevice: BlockDeviceMapping;
let rootSnapshotId: string;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Safely retrieves a required tag value from the AMI tags.
 *
 * @param tags - Array of EC2 tags
 * @param key - Tag key to search for
 * @returns The tag object
 * @throws If the tag is not found
 */
function requireTag(
    tags: Array<{ Key?: string; Value?: string }>,
    key: string,
): { Key?: string; Value?: string } {
    const tag = tags.find(t => t.Key === key);
    if (!tag) throw new Error(`Missing required AMI tag: ${key}`);
    return tag;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GoldenAmiStack — Post-Deploy Verification', () => {
    // =========================================================================
    // Setup — Load AMI ID from SSM + describe the AMI
    // =========================================================================
    beforeAll(async () => {
        // 1. Resolve AMI ID from SSM
        const { Parameter } = await ssm.send(
            new GetParameterCommand({ Name: AMI_SSM_PATH }),
        );

        if (!Parameter?.Value) {
            console.error(`[FATAL] No AMI ID found at SSM path: ${AMI_SSM_PATH}`);
            throw new Error(`No AMI ID found at ${AMI_SSM_PATH}`);
        }

        amiId = Parameter.Value;
        console.log(`[Pre-Flight] AMI ID from SSM: ${amiId}`);
        console.log(`[Pre-Flight] AMI SSM path: ${AMI_SSM_PATH}`);
        console.log(`[Pre-Flight] Expected stack name: ${STACK_NAME}`);

        // 2. Describe the AMI (shared across all property tests)
        const { Images } = await ec2.send(
            new DescribeImagesCommand({ ImageIds: [amiId] }),
        );

        expect(Images).toBeDefined();
        expect(Images!).toHaveLength(1);
        image = Images![0];

        // 3. Extract root block device mapping
        const rootMapping = (image.BlockDeviceMappings ?? []).find(
            bdm => bdm.DeviceName === image.RootDeviceName,
        );

        if (!rootMapping) {
            throw new Error(
                `Root block device not found for device name: ${image.RootDeviceName ?? 'undefined'}`,
            );
        }
        rootBlockDevice = rootMapping;
        rootSnapshotId = rootBlockDevice.Ebs?.SnapshotId ?? '';

        console.log(`[Pre-Flight] Architecture: ${image.Architecture ?? 'unknown'}`);
        console.log(`[Pre-Flight] Root device: ${image.RootDeviceName ?? 'unknown'}`);
        console.log(`[Pre-Flight] Root snapshot: ${rootSnapshotId}`);
    }, 30_000);

    // =========================================================================
    // Pre-Flight Validation
    // =========================================================================
    describe('Pre-Flight', () => {
        it('should have CDK_ENV set to a valid environment', () => {
            expect(CDK_ENV).toBeDefined();
            expect(['development', 'staging', 'production']).toContain(CDK_ENV);
        });

        it('should have AWS_REGION set', () => {
            expect(REGION).toBeDefined();
        });

        it('should have resolved AMI ID from SSM', () => {
            expect(amiId).toBeDefined();
            expect(amiId).toMatch(/^ami-[a-f0-9]+$/);
        });

        it('should resolve the correct stack name from config', () => {
            console.log(`[Pre-Flight] Stack name: ${STACK_NAME}`);
            expect(STACK_NAME).toBeDefined();
            expect(STACK_NAME).toContain('GoldenAmi');
        });
    });

    // =========================================================================
    // AMI Properties — validates the produced artefact's EC2 properties
    // =========================================================================
    describe('AMI Properties', () => {
        it('should be in available state', () => {
            expect(image.State).toBe('available');
        });

        it(`should have ${EXPECTED_ARCHITECTURE} architecture`, () => {
            expect(image.Architecture).toBe(EXPECTED_ARCHITECTURE);
        });

        it(`should use ${EXPECTED_VIRTUALISATION_TYPE} virtualisation`, () => {
            expect(image.VirtualizationType).toBe(EXPECTED_VIRTUALISATION_TYPE);
        });

        it(`should have ${EXPECTED_ROOT_DEVICE_TYPE} root device type`, () => {
            expect(image.RootDeviceType).toBe(EXPECTED_ROOT_DEVICE_TYPE);
        });

        it('should have ENA support enabled', () => {
            expect(image.EnaSupport).toBe(true);
        });

        it(`should use ${EXPECTED_VOLUME_TYPE} root volume type`, () => {
            expect(rootBlockDevice.Ebs?.VolumeType).toBe(EXPECTED_VOLUME_TYPE);
        });

        it(`should have root volume size >= ${MIN_ROOT_VOLUME_SIZE_GB} GB`, () => {
            expect(rootBlockDevice.Ebs?.VolumeSize).toBeGreaterThanOrEqual(
                MIN_ROOT_VOLUME_SIZE_GB,
            );
        });

        it('should have a valid root snapshot ID', () => {
            expect(rootSnapshotId).toMatch(/^snap-[a-f0-9]+$/);
        });
    });

    // =========================================================================
    // AMI Security — validates launch permissions and encryption
    // =========================================================================
    describe('AMI Security', () => {
        let isPublic: boolean;
        let snapshotEncrypted: boolean;

        // Depends on: amiId and rootSnapshotId from top-level beforeAll
        beforeAll(async () => {
            // 1. Check launch permissions — AMI should be private
            const launchPerms = await ec2.send(
                new DescribeImageAttributeCommand({
                    ImageId: amiId,
                    Attribute: 'launchPermission',
                }),
            );
            const perms = launchPerms.LaunchPermissions ?? [];
            isPublic = perms.some(p => p.Group === 'all');

            // 2. Check root snapshot encryption
            const { Snapshots } = await ec2.send(
                new DescribeSnapshotsCommand({
                    SnapshotIds: [rootSnapshotId],
                }),
            );

            expect(Snapshots).toBeDefined();
            expect(Snapshots!).toHaveLength(1);
            snapshotEncrypted = Snapshots![0].Encrypted ?? false;
        }, 15_000);

        it('should NOT have public launch permissions', () => {
            expect(isPublic).toBe(false);
        });

        it('should have an encrypted root EBS snapshot', () => {
            expect(snapshotEncrypted).toBe(true);
        });
    });

    // =========================================================================
    // AMI Tags — validates infrastructure tagging contract
    // =========================================================================
    describe('AMI Tags', () => {
        let tags: Array<{ Key?: string; Value?: string }>;

        // Depends on: image from top-level beforeAll
        beforeAll(() => {
            tags = image.Tags ?? [];
        });

        it('should have the KubernetesVersion tag', () => {
            const k8sTag = requireTag(tags, 'KubernetesVersion');
            expect(k8sTag.Value).toBe(CONFIGS.cluster.kubernetesVersion);
        });

        it('should have the Purpose tag set to GoldenAMI', () => {
            const purposeTag = requireTag(tags, 'Purpose');
            expect(purposeTag.Value).toBe('GoldenAMI');
        });

        it('should have a description containing the K8s version', () => {
            expect(image.Description ?? '').toContain(
                CONFIGS.cluster.kubernetesVersion,
            );
        });
    });

    // =========================================================================
    // Image Builder Pipeline — validates freshness
    // =========================================================================
    describe('Image Builder Pipeline', () => {
        it('should have been created by Image Builder', () => {
            // Image Builder AMIs follow the CDK naming pattern:
            // {namePrefix}-golden-ami-{buildDate}
            const name = (image.Name ?? '').toLowerCase();
            expect(name).toContain('golden-ami');
        });

        it(`should not be older than ${MAX_AMI_AGE_DAYS} days`, () => {
            const creationDate = image.CreationDate;
            expect(creationDate).toBeDefined();

            const created = new Date(creationDate!);
            const now = new Date();
            const ageInDays =
                (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

            console.log(
                `[Pipeline] AMI age: ${ageInDays.toFixed(1)} days (max: ${MAX_AMI_AGE_DAYS})`,
            );
            expect(ageInDays).toBeLessThanOrEqual(MAX_AMI_AGE_DAYS);
        });
    });

    // =========================================================================
    // AMI Software Components (static analysis of build component YAML)
    // =========================================================================
    describe('AMI Software Components', () => {
        let componentYaml: string;

        // Depends on: CONFIGS populated at module scope
        beforeAll(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildGoldenAmiComponent } = require('../../../lib/constructs/compute/utils/build-golden-ami-component');
            componentYaml = buildGoldenAmiComponent({
                imageConfig: CONFIGS.image,
                clusterConfig: CONFIGS.cluster,
            }) as string;
        });

        it('should NOT use alternatives --set python3 (breaks cloud-init)', () => {
            expect(componentYaml).not.toContain('alternatives --set python3');
        });

        it('should NOT use alternatives --install for python3', () => {
            expect(componentYaml).not.toContain('alternatives --install /usr/bin/python3');
        });

        it('should create a virtualenv at /opt/k8s-venv with Python 3.11', () => {
            expect(componentYaml).toContain('python3.11 -m venv /opt/k8s-venv');
        });

        it('should install pip packages into the virtualenv', () => {
            expect(componentYaml).toContain('/opt/k8s-venv/bin/pip install');
        });

        it('should validate cloud-init is functional in the validate phase', () => {
            expect(componentYaml).toContain('cloud-init status');
        });

        it('should functionally test cfn-signal (not just binary existence)', () => {
            expect(componentYaml).toContain('cfn-signal --version');
        });

        it('should verify system python3 is preserved for cloud-init', () => {
            expect(componentYaml).toContain('SYS_PY_VERSION');
        });

        it('should validate venv Python packages via /opt/k8s-venv/bin/python3', () => {
            expect(componentYaml).toContain('/opt/k8s-venv/bin/python3 -c');
        });
    });

    // =========================================================================
    // CloudFormation Stack
    // =========================================================================
    describe('CloudFormation Stack', () => {
        it('should have the stack in a successful state', async () => {
            const { Stacks } = await cfn.send(
                new DescribeStacksCommand({ StackName: STACK_NAME }),
            );

            expect(Stacks).toBeDefined();
            expect(Stacks!).toHaveLength(1);

            const status = Stacks![0].StackStatus!;
            expect(status).toMatch(/COMPLETE$/);
            expect(status).not.toContain('ROLLBACK');
        });
    });

    // =========================================================================
    // Downstream Readiness
    // =========================================================================
    describe('Downstream Readiness', () => {
        it('should have the AMI ID published to SSM for downstream stacks', async () => {
            const { Parameter } = await ssm.send(
                new GetParameterCommand({ Name: AMI_SSM_PATH }),
            );

            expect(Parameter).toBeDefined();
            expect(Parameter!.Value).toMatch(/^ami-[a-f0-9]+$/);
        });
    });
});
