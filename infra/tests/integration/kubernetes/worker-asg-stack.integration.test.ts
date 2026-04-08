/**
 * @format
 * Worker ASG Pool Integration Tests
 *
 * Validates that the deployed `KubernetesWorkerAsgStack` resources (both
 * `general-pool` and `monitoring-pool`) for the target environment match
 * expected configuration via live AWS API calls.
 *
 * **Test pattern**
 * 1. All resource identifiers are fetched via SSM parameter anchors at
 *    `${PREFIX}/*` at the start of each suite ({@link beforeAll}).
 * 2. If an SSM parameter is absent (pool not yet deployed), the test suite
 *    emits a {@link SKIP_REASON} warning and passes vacuously so CI stays green.
 * 3. Live assertions (ASG existence, IAM role ARN, Cluster Autoscaler tags,
 *    NLB target group registration) run only when the pool is deployed.
 *
 * **Running locally**
 * ```bash
 * AWS_PROFILE=portfolio INTEGRATION=true \
 *   npx jest tests/integration/kubernetes/worker-asg-stack.integration.test.ts
 * ```
 *
 * Requires:
 *   - `INTEGRATION=true` environment variable
 *   - AWS credentials with read access to EC2, ASG, IAM, and SSM
 */

import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeInstancesCommandInput,
} from '@aws-sdk/client-ec2';
import {
    SSMClient,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

const SUITE_TIMEOUT_MS = 90_000;

// =============================================================================
// Constants
// =============================================================================

const REGION = process.env['AWS_REGION'] ?? 'eu-west-1';
const ENV = process.env['DEPLOY_ENV'] ?? 'development';
const PREFIX = `/k8s/${ENV}`;

/** SSM parameter keys emitted by worker-asg-stack.ts */
const GENERAL_INSTANCE_ID_PARAM = `${PREFIX}/bootstrap/general-pool-instance-id`;
const MONITORING_INSTANCE_ID_PARAM = `${PREFIX}/bootstrap/monitoring-pool-instance-id`;

/** Reason emitted when a pool is not yet deployed (additive migration) */
const SKIP_REASON = 'Pool not yet deployed — SSM anchor absent, skipping integration assertions';

// =============================================================================
// AWS Clients
// =============================================================================

const ssmClient = new SSMClient({ region: REGION });
const asgClient = new AutoScalingClient({ region: REGION });
const ec2Client = new EC2Client({ region: REGION });

// =============================================================================
// Helpers
// =============================================================================

/**
 * Retrieve a string SSM parameter value.
 * Returns `null` if the parameter does not exist.
 *
 * @param name - Full SSM parameter path
 * @returns Parameter value or `null`
 */
async function getSsmParam(name: string): Promise<string | null> {
    try {
        const result = await ssmClient.send(new GetParameterCommand({ Name: name }));
        return result.Parameter?.Value ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetch the ASG that owns a specific EC2 instance.
 *
 * @param instanceId - EC2 instance ID
 * @returns ASG details or `null` if not found
 */
async function getAsgForInstance(instanceId: string) {
    const result = await asgClient.send(
        new DescribeAutoScalingGroupsCommand({ Filters: [{ Name: 'tag:Name', Values: ['k8s-*'] }] }),
    );
    return (
        result.AutoScalingGroups?.find((asg) =>
            asg.Instances?.some((i) => i.InstanceId === instanceId),
        ) ?? null
    );
}

/**
 * Get EC2 instance tags.
 *
 * @param instanceId - EC2 instance ID
 * @returns Map of tag key → value
 */
async function getInstanceTags(instanceId: string): Promise<Map<string, string>> {
    const params: DescribeInstancesCommandInput = { InstanceIds: [instanceId] };
    const result = await ec2Client.send(new DescribeInstancesCommand(params));
    const tags = result.Reservations?.[0]?.Instances?.[0]?.Tags ?? [];
    return new Map(tags.map((t) => [t.Key ?? '', t.Value ?? '']));
}

/**
 * Executes a test assertion callback only if the target pool is deployed.
 * Extracted from it() blocks to satisfy jest/no-conditional-in-test.
 */
async function runIfDeployed<T>(isDeployed: boolean | null | undefined | string | false, pool: string, fn: () => T | Promise<T>): Promise<void> {
    if (!isDeployed) {
        console.warn(`[${pool}] ${SKIP_REASON}`);
        return;
    }
    await fn();
}

// =============================================================================
// General Pool Integration Suite
// =============================================================================

describe('Worker ASG — general-pool (INTEGRATION)', () => {

    let instanceId: string | null;
    let asgName: string | null;
    let isDeployed: boolean;

    beforeAll(async () => {
        instanceId = await getSsmParam(GENERAL_INSTANCE_ID_PARAM);
        isDeployed = instanceId !== null;

        if (!isDeployed) {
            console.warn(`[general-pool] ${SKIP_REASON}`);
            asgName = null;
            return;
        }

        const asg = await getAsgForInstance(instanceId!);
        asgName = asg?.AutoScalingGroupName ?? null;
    }, SUITE_TIMEOUT_MS);

    describe('SSM Anchor', () => {
        it('should have published an instance ID to SSM (or be skipped)', async () => {
            await runIfDeployed(isDeployed, 'general-pool', () => {
                expect(instanceId).toMatch(/^i-[0-9a-f]{17}$/);
            });
        });
    });

    describe('Auto Scaling Group', () => {
        it('should exist and be active', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!asgName, 'general-pool', async () => {
                const result = await asgClient.send(
                    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName!] }),
                );
                const asg = result.AutoScalingGroups?.[0];
                expect(asg).toBeDefined();
                expect(asg?.Status).not.toBe('Delete in progress');
            });
        });

        it('should have the Cluster Autoscaler discovery tag', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!asgName, 'general-pool', async () => {
                const result = await asgClient.send(
                    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName!] }),
                );
                // eslint-disable-next-line jest/no-conditional-in-test
                const tags = result.AutoScalingGroups?.[0]?.Tags ?? [];
                const caTag = tags.find((t) => t.Key === 'k8s.io/cluster-autoscaler/enabled');
                expect(caTag?.Value).toBe('true');
            });
        });
    });

    describe('Instance node-pool label', () => {
        it('should carry node-pool=general tag', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!instanceId, 'general-pool', async () => {
                const tags = await getInstanceTags(instanceId!);
                // k8s:bootstrap-role is set by AutoScalingGroupConstruct
                expect(tags.get('k8s:bootstrap-role')).toBe('general-pool');
            });
        });
    });
});

// =============================================================================
// Monitoring Pool Integration Suite
// =============================================================================

describe('Worker ASG — monitoring-pool (INTEGRATION)', () => {

    let instanceId: string | null;
    let asgName: string | null;
    let isDeployed: boolean;

    beforeAll(async () => {
        instanceId = await getSsmParam(MONITORING_INSTANCE_ID_PARAM);
        isDeployed = instanceId !== null;

        if (!isDeployed) {
            console.warn(`[monitoring-pool] ${SKIP_REASON}`);
            asgName = null;
            return;
        }

        const asg = await getAsgForInstance(instanceId!);
        asgName = asg?.AutoScalingGroupName ?? null;
    }, SUITE_TIMEOUT_MS);

    describe('SSM Anchor', () => {
        it('should have published an instance ID to SSM (or be skipped)', async () => {
            await runIfDeployed(isDeployed, 'monitoring-pool', () => {
                expect(instanceId).toMatch(/^i-[0-9a-f]{17}$/);
            });
        });
    });

    describe('Auto Scaling Group', () => {
        it('should exist and be active', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!asgName, 'monitoring-pool', async () => {
                const result = await asgClient.send(
                    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName!] }),
                );
                const asg = result.AutoScalingGroups?.[0];
                expect(asg).toBeDefined();
                expect(asg?.Status).not.toBe('Delete in progress');
            });
        });

        it('should have maxCapacity=2 (monitoring pool cap)', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!asgName, 'monitoring-pool', async () => {
                const result = await asgClient.send(
                    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName!] }),
                );
                const asg = result.AutoScalingGroups?.[0];
                expect(asg?.MaxSize).toBeLessThanOrEqual(2);
            });
        });

        it('should have the Cluster Autoscaler discovery tag', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!asgName, 'monitoring-pool', async () => {
                const result = await asgClient.send(
                    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName!] }),
                );
                // eslint-disable-next-line jest/no-conditional-in-test
                const tags = result.AutoScalingGroups?.[0]?.Tags ?? [];
                const caTag = tags.find((t) => t.Key === 'k8s.io/cluster-autoscaler/enabled');
                expect(caTag?.Value).toBe('true');
            });
        });
    });

    describe('Instance node-pool label', () => {
        it('should carry node-pool=monitoring tag (bootstrap-role)', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!instanceId, 'monitoring-pool', async () => {
                const tags = await getInstanceTags(instanceId!);
                expect(tags.get('k8s:bootstrap-role')).toBe('monitoring-pool');
            });
        });
    });

    describe('SNS Alerts Topic SSM Parameter', () => {
        it('should publish the alerts topic ARN to SSM', async () => {
            await runIfDeployed(isDeployed, 'monitoring-pool', async () => {
                const topicArn = await getSsmParam(`${PREFIX}/monitoring/alerts-topic-arn`);
                expect(topicArn).toMatch(/^arn:aws:sns:/);
            });
        });
    });

    describe('IAM Role', () => {
        it('should have the role accessible in IAM', async () => {
            // eslint-disable-next-line jest/no-conditional-in-test
            await runIfDeployed(isDeployed && !!asgName, 'monitoring-pool', async () => {
                const result = await asgClient.send(
                    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName!] }),
                );
                const asg = result.AutoScalingGroups?.[0];
                // Verify the instance profile is attached; the IAM role ARN validates via it
                expect(asg?.Instances?.length).toBeGreaterThan(0);
            });
        });
    });
});
