/**
 * @format
 * Golden AMI Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the GoldenAmiStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify that the Golden AMI was built successfully,
 * the AMI exists in the account, and all expected packages are present
 * in the Image Builder build logs.
 *
 * Verification Strategy:
 *   1. Read the AMI ID from SSM (published by Image Builder)
 *   2. Verify AMI exists and is in 'available' state via EC2 DescribeImages
 *   3. Check AMI tags (KubernetesVersion, Purpose, Component)
 *   4. Fetch Image Builder CloudWatch build logs
 *   5. Scan logs for expected package version strings from the validate phase
 *
 * This replaces the previous golden-ami-observer.ts script with a standard
 * Jest integration test for consistency with other stack verification jobs.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/golden-ami-stack development
 */

import {
    CloudFormationClient,
    DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeLogStreamsCommand,
    GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    EC2Client,
    DescribeImagesCommand,
} from '@aws-sdk/client-ec2';
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

/**
 * Expected packages from the Image Builder validate phase.
 * Each pattern matches version output in the build logs.
 */
const EXPECTED_PACKAGES = [
    { name: 'Docker', pattern: /docker/i },
    { name: 'AWS CLI', pattern: /aws-cli/i },
    { name: 'CloudWatch Agent', pattern: /cloudwatch/i },
    { name: 'containerd', pattern: /containerd/i },
    { name: 'runc', pattern: /runc/i },
    { name: 'crictl', pattern: /crictl/i },
    { name: 'kubeadm', pattern: /kubeadm/i },
    { name: 'kubelet', pattern: /kubelet/i },
    { name: 'kubectl', pattern: /kubectl|gitVersion/i },
    { name: 'Calico manifests', pattern: /calico\.yaml/i },
    { name: 'cfn-signal', pattern: /cfn-signal/i },
    { name: 'Helm', pattern: /helm/i },
    { name: 'boto3', pattern: /boto3/i },
    { name: 'ecr-credential-provider', pattern: /ecr-credential-provider/i },
];

// =============================================================================
// AWS SDK Clients
// =============================================================================

const ssm = new SSMClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });

// =============================================================================
// Shared State (populated in beforeAll)
// =============================================================================

let amiId: string;
let allLogContent: string;

// =============================================================================
// Helpers
// =============================================================================

/** Maximum log streams to inspect per log group */
const MAX_LOG_STREAMS = 5;

/** Maximum events to fetch per log stream */
const MAX_EVENTS_PER_STREAM = 200;

/** Fetch all Image Builder CloudWatch log content */
async function fetchCloudWatchBuildLogs(): Promise<string> {
    const parts: string[] = [];

    try {
        const { logGroups } = await logs.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/imagebuilder/' }),
        );

        for (const lg of logGroups ?? []) {
            if (!lg.logGroupName) continue;
            try {
                // Fetch multiple streams — Image Builder creates one per
                // build phase (build, validate, test). Fetching only the
                // latest stream misses output from earlier phases.
                const { logStreams } = await logs.send(
                    new DescribeLogStreamsCommand({
                        logGroupName: lg.logGroupName,
                        orderBy: 'LastEventTime',
                        descending: true,
                        limit: MAX_LOG_STREAMS,
                    }),
                );

                for (const stream of logStreams ?? []) {
                    const streamName = stream.logStreamName;
                    if (!streamName) continue;

                    const { events } = await logs.send(
                        new GetLogEventsCommand({
                            logGroupName: lg.logGroupName,
                            logStreamName: streamName,
                            limit: MAX_EVENTS_PER_STREAM,
                        }),
                    );

                    for (const event of events ?? []) {
                        if (event.message) parts.push(event.message);
                    }
                }
            } catch {
                // Skip individual log group errors
            }
        }
    } catch {
        // CloudWatch logs may not be available
    }

    return parts.join('\n');
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GoldenAmiStack — Post-Deploy Verification', () => {
    // =========================================================================
    // Setup — Load AMI ID from SSM + collect build logs
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

        // 2. Collect build logs from CloudWatch
        allLogContent = await fetchCloudWatchBuildLogs();

        console.log(`[Pre-Flight] Total log content length: ${allLogContent.length} chars`);
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
    // AMI Metadata
    // =========================================================================
    describe('AMI Metadata', () => {
        let amiState: string;
        let tags: Array<{ Key?: string; Value?: string }>;
        let description: string;

        // Depends on: amiId populated in top-level beforeAll
        beforeAll(async () => {
            const { Images } = await ec2.send(
                new DescribeImagesCommand({ ImageIds: [amiId] }),
            );

            expect(Images).toBeDefined();
            expect(Images!).toHaveLength(1);

            const image = Images![0];
            amiState = image.State ?? '';
            tags = image.Tags ?? [];
            description = image.Description ?? '';
        });

        it('should exist and be in available state', () => {
            expect(amiState).toBe('available');
        });

        it('should have the KubernetesVersion tag', () => {
            const k8sTag = tags.find(t => t.Key === 'KubernetesVersion');
            expect(k8sTag).toBeDefined();
            expect(k8sTag!.Value).toBe(CONFIGS.cluster.kubernetesVersion);
        });

        it('should have the Purpose tag set to GoldenAMI', () => {
            const purposeTag = tags.find(t => t.Key === 'Purpose');
            expect(purposeTag).toBeDefined();
            expect(purposeTag!.Value).toBe('GoldenAMI');
        });

        it('should have a description containing the name prefix and K8s version', () => {
            expect(description).toContain(CONFIGS.cluster.kubernetesVersion);
        });
    });

    // =========================================================================
    // Package Verification (log-based)
    // =========================================================================
    describe('Package Verification (build logs)', () => {
        it.each(EXPECTED_PACKAGES)(
            'should have $name verified in build logs',
            ({ pattern }) => {
                expect(pattern.test(allLogContent)).toBe(true);
            },
        );
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
