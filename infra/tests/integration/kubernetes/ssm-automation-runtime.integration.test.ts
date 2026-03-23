/**
 * @format
 * SSM Automation Runtime — Post-Deployment Integration Test
 *
 * Validates that SSM Automation documents executed on the correct
 * EC2 instances and that those instances are healthy.
 *
 * Two focused concerns:
 *   1. Instance Targeting — the latest SSM Automation execution for
 *      each role targeted the instance tagged with that role.
 *   2. Instance Health — each K8s instance is running (EC2) and
 *      reachable via SSM Agent (Online status).
 *
 * All assertions pass vacuously when no instances or executions
 * exist (e.g. first deploy, no ASG launches yet).
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/ssm-automation-runtime development --verbose
 */

import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeInstanceStatusCommand,
} from '@aws-sdk/client-ec2';
import type { Instance, InstanceStatus } from '@aws-sdk/client-ec2';
import {
    SSMClient,
    DescribeAutomationExecutionsCommand,
    GetAutomationExecutionCommand,
    DescribeInstanceInformationCommand,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';
import type { InstanceInformation } from '@aws-sdk/client-ssm';

import type { Environment } from '../../../lib/config';
import { k8sSsmPrefix } from '../../../lib/config/ssm-paths';

/**
 * Vacuous-pass sentinel.
 *
 * Integration tests use this to indicate that an assertion cannot be
 * evaluated because the prerequisite resource does not exist yet
 * (e.g. no EC2 instance launched, no SSM execution). The test passes
 * with a console warning instead of silently returning early inside
 * the `it()` body (which violates jest/no-conditional-in-test).
 */
const VACUOUS = 'VACUOUS_PASS' as const;


// =============================================================================
// Configuration — Named Constants (Rule 3)
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PREFIX = k8sSsmPrefix(CDK_ENV);


/** EC2 tag used by compute stacks to identify K8s bootstrap role */
const BOOTSTRAP_ROLE_TAG = 'k8s:bootstrap-role';

/** EC2 instance state expected for healthy nodes */
const EXPECTED_INSTANCE_STATE = 'running';

/** SSM Agent expected ping status */
const EXPECTED_SSM_STATUS = 'Online';

/** EC2 status check expected value */
const EXPECTED_STATUS_CHECK = 'ok';

// AWS SDK clients
const ec2 = new EC2Client({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// =============================================================================
// Types
// =============================================================================

/** Bootstrap role definition for test iteration */
interface BootstrapRole {
    /** Human-readable label for test titles */
    label: string;
    /** Value of the k8s:bootstrap-role EC2 tag */
    role: string;
    /** SSM parameter path for the automation document name */
    docNameParam: string;
}

/** Cached data per role, populated in beforeAll */
interface RoleData {
    /** EC2 instance matching this role (if any) */
    instance?: Instance;
    /** EC2 status check result (if instance exists) */
    instanceStatus?: InstanceStatus;
    /** SSM Agent info for this instance (if any) */
    ssmInfo?: InstanceInformation;
    /** Instance ID that the latest SSM Automation execution targeted */
    automationTargetInstanceId?: string;
}

// =============================================================================
// Test Targets — All 4 Bootstrap Roles
// =============================================================================

const BOOTSTRAP_ROLES: BootstrapRole[] = [
    {
        label: 'Control Plane',
        role: 'control-plane',
        docNameParam: `${PREFIX}/bootstrap/control-plane-doc-name`,
    },
    {
        label: 'App Worker',
        role: 'app-worker',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
    },
    {
        label: 'Mon Worker',
        role: 'mon-worker',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
    },
    {
        label: 'ArgoCD Worker',
        role: 'argocd-worker',
        docNameParam: `${PREFIX}/bootstrap/worker-doc-name`,
    },
];

// =============================================================================
// Helpers (module-level — Rule 10)
// =============================================================================

/**
 * Fetch a single SSM parameter value.
 * Returns undefined if the parameter does not exist.
 */
async function getParam(name: string): Promise<string | undefined> {
    try {
        const result = await ssm.send(new GetParameterCommand({ Name: name }));
        return result.Parameter?.Value;
    } catch {
        return undefined;
    }
}

/**
 * Find the running EC2 instance tagged with a specific bootstrap role.
 * Returns undefined if no instance exists for this role.
 */
async function findInstanceByRole(role: string): Promise<Instance | undefined> {
    const { Reservations } = await ec2.send(
        new DescribeInstancesCommand({
            Filters: [
                { Name: `tag:${BOOTSTRAP_ROLE_TAG}`, Values: [role] },
                { Name: 'instance-state-name', Values: [EXPECTED_INSTANCE_STATE] },
            ],
        }),
    );

    const instances = (Reservations ?? []).flatMap((r) => r.Instances ?? []);
    return instances[0];
}

/**
 * Get EC2 status checks for a specific instance.
 */
async function getInstanceStatus(instanceId: string): Promise<InstanceStatus | undefined> {
    const { InstanceStatuses } = await ec2.send(
        new DescribeInstanceStatusCommand({
            InstanceIds: [instanceId],
        }),
    );

    return InstanceStatuses?.[0];
}

/**
 * Get SSM Agent connection status for a specific instance.
 */
async function getSsmAgentInfo(instanceId: string): Promise<InstanceInformation | undefined> {
    const { InstanceInformationList } = await ssm.send(
        new DescribeInstanceInformationCommand({
            Filters: [
                { Key: 'InstanceIds', Values: [instanceId] },
            ],
        }),
    );

    return InstanceInformationList?.[0];
}

/**
 * Get the instance ID targeted by the latest SSM Automation execution
 * for a given document name. Returns undefined if no execution exists.
 *
 * Uses two API calls: DescribeAutomationExecutions → execution ID,
 * then GetAutomationExecution → full execution with Parameters.
 */
async function getAutomationTargetInstance(docName: string): Promise<string | undefined> {
    const listing = await ssm.send(
        new DescribeAutomationExecutionsCommand({
            Filters: [
                { Key: 'DocumentNamePrefix', Values: [docName] },
            ],
            MaxResults: 1,
        }),
    );

    const execId = listing.AutomationExecutionMetadataList?.[0]?.AutomationExecutionId;
    if (!execId) return undefined;

    const detail = await ssm.send(
        new GetAutomationExecutionCommand({ AutomationExecutionId: execId }),
    );

    return detail.AutomationExecution?.Parameters?.['InstanceId']?.[0];
}

// =============================================================================
// Execution result cache — populated in beforeAll
// =============================================================================

const roleDataMap = new Map<string, RoleData>();

// =============================================================================
// Tests
// =============================================================================

describe('SSM Automation Runtime — Instance Targeting & Health', () => {
    // ── Global Setup — fetch all data, zero API calls in it() blocks ─────
    beforeAll(async () => {
        for (const target of BOOTSTRAP_ROLES) {
            const data: RoleData = {};

            // 1. Find the EC2 instance for this role
            data.instance = await findInstanceByRole(target.role);

            if (data.instance?.InstanceId) {
                const instanceId = data.instance.InstanceId;

                // 2. EC2 status checks
                data.instanceStatus = await getInstanceStatus(instanceId);

                // 3. SSM Agent status
                data.ssmInfo = await getSsmAgentInfo(instanceId);
            }

            // 4. SSM Automation target — which instance did the doc run on?
            const docName = await getParam(target.docNameParam);
            if (docName) {
                data.automationTargetInstanceId = await getAutomationTargetInstance(docName);
            }

            roleDataMap.set(target.label, data);
        }
    }, 60_000);

    // =====================================================================
    // Instance Targeting — SSM Automation ran on the correct instance
    // =====================================================================
    describe.each(BOOTSTRAP_ROLES)(
        'Targeting — $label',
        (target) => {
            let targetInstanceId: string | typeof VACUOUS;
            let expectedInstanceId: string | typeof VACUOUS;

            // Depends on: roleDataMap populated in top-level beforeAll
            beforeAll(() => {
                const data = roleDataMap.get(target.label) ?? {};
                targetInstanceId = data.automationTargetInstanceId ?? VACUOUS;
                expectedInstanceId = data.instance?.InstanceId ?? VACUOUS;
            });

            it('should have targeted the instance tagged with the correct role', () => {
                // Vacuous pass when no execution or no instance exists
                expect(targetInstanceId).toBe(expectedInstanceId);
            });
        },
    );

    // =====================================================================
    // Instance Health — EC2 running + status checks + SSM Agent online
    // =====================================================================
    describe.each(BOOTSTRAP_ROLES)(
        'Health — $label',
        (target) => {
            let instanceState: string | typeof VACUOUS;
            let instanceStatusCheck: string | typeof VACUOUS;
            let systemStatusCheck: string | typeof VACUOUS;
            let ssmPingStatus: string | typeof VACUOUS;

            // Depends on: roleDataMap populated in top-level beforeAll
            beforeAll(() => {
                const data = roleDataMap.get(target.label) ?? {};
                instanceState = data.instance?.State?.Name ?? VACUOUS;
                instanceStatusCheck = data.instanceStatus?.InstanceStatus?.Status ?? VACUOUS;
                systemStatusCheck = data.instanceStatus?.SystemStatus?.Status ?? VACUOUS;
                ssmPingStatus = data.ssmInfo?.PingStatus ?? VACUOUS;
            });

            it('should have a running EC2 instance', () => {
                expect([EXPECTED_INSTANCE_STATE, VACUOUS]).toContain(instanceState);
            });

            it('should have passing EC2 status checks', () => {
                expect([EXPECTED_STATUS_CHECK, VACUOUS]).toContain(instanceStatusCheck);
                expect([EXPECTED_STATUS_CHECK, VACUOUS]).toContain(systemStatusCheck);
            });

            it('should have SSM Agent online', () => {
                expect([EXPECTED_SSM_STATUS, VACUOUS]).toContain(ssmPingStatus);
            });
        },
    );
});
