/**
 * @format
 * SSM Automation Runtime — Post-Deployment Integration Test
 *
 * Runs AFTER SSM Automation documents and the Step Functions orchestrator
 * have been deployed and bootstrap automations have completed. Calls real
 * AWS APIs to verify that each automation execution finished successfully.
 *
 * Architecture (post–Step Functions migration):
 *   EventBridge → Step Functions → SSM Automation (per-role documents)
 *
 * Test Strategy:
 *   1. Verify the Step Functions state machine exists and has recent executions
 *   2. Read SSM parameters for automation document names
 *   3. Query DescribeAutomationExecutions for the most recent execution
 *   4. Verify status and document name pattern
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/ssm-automation-runtime development --verbose
 */

import {
    SSMClient,
    GetParameterCommand,
    DescribeAutomationExecutionsCommand,
} from '@aws-sdk/client-ssm';

import {
    SFNClient,
    ListStateMachinesCommand,
    ListExecutionsCommand,
} from '@aws-sdk/client-sfn';

import type { AutomationExecutionMetadata } from '@aws-sdk/client-ssm';
import type { ExecutionListItem } from '@aws-sdk/client-sfn';

import { Environment } from '../../../lib/config';
import { k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import { flatName } from '../../../lib/utilities/naming';

// =============================================================================
// Configuration — Named Constants (Rule 3)
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PREFIX = k8sSsmPrefix(CDK_ENV);
/** Resource name prefix — e.g. 'k8s-dev' */
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

/** Step Functions state machine name as defined in ssm-automation-stack.ts */
const STATE_MACHINE_NAME = `${NAME_PREFIX}-bootstrap-orchestrator`;

/** Successful SSM Automation terminal statuses */
const SSM_SUCCESS_STATUSES = ['Success'];

/** Step Functions successful terminal statuses */
const SFN_SUCCESS_STATUSES = ['SUCCEEDED'];

// AWS SDK clients
const ssm = new SSMClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });

// =============================================================================
// Types
// =============================================================================

interface AutomationTestTarget {
    /** Descriptive label for test titles */
    label: string;
    /** SSM parameter path containing the document name */
    docNameParam: string;
    /** Expected k8s:bootstrap-role tag value used for targeting */
    expectedTargetTagValue: string;
}

// =============================================================================
// Test Targets — Bootstrap Automations (all 4 roles)
// =============================================================================

/**
 * Each target maps to one SSM Automation document. The test queries the most
 * recent execution of each document and validates metadata fields.
 */
const AUTOMATION_TARGETS: AutomationTestTarget[] = [
    {
        label: 'Control Plane Bootstrap',
        docNameParam: `${PREFIX}/bootstrap/control-plane-doc-name`,
        expectedTargetTagValue: 'control-plane',
    },
    {
        label: 'App Worker Bootstrap',
        docNameParam: `${PREFIX}/bootstrap/app-worker-doc-name`,
        expectedTargetTagValue: 'app-worker',
    },
    {
        label: 'Mon Worker Bootstrap',
        docNameParam: `${PREFIX}/bootstrap/mon-worker-doc-name`,
        expectedTargetTagValue: 'mon-worker',
    },
    {
        label: 'ArgoCD Worker Bootstrap',
        docNameParam: `${PREFIX}/bootstrap/argocd-worker-doc-name`,
        expectedTargetTagValue: 'argocd-worker',
    },
];

// =============================================================================
// Helpers
// =============================================================================

/** Fetch a single SSM parameter value. Throws if not found. */
async function getParam(name: string): Promise<string> {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    const value = result.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter not found: ${name}`);
    return value;
}

/**
 * Require a value from a Map or throw with a descriptive message.
 * Replaces unsafe non-null assertions (Rule 2).
 */
function requireResult<T>(map: Map<string, T>, key: string): T {
    const value = map.get(key);
    if (!value) throw new Error(`Missing expected result for: ${key}`);
    return value;
}

// =============================================================================
// Execution result caches — populated in beforeAll
// =============================================================================

interface SsmExecutionResult {
    status: string;
    documentName: string;
}

const ssmResults = new Map<string, SsmExecutionResult>();

let stateMachineArn: string | undefined;
let latestSfnExecution: ExecutionListItem | undefined;

// =============================================================================
// Tests
// =============================================================================

describe('SSM Automation Runtime — Post-Deploy Verification', () => {
    // ── Global Setup ─────────────────────────────────────────────────────
    beforeAll(async () => {
        // 1. Resolve Step Functions state machine ARN
        const machines = await sfn.send(new ListStateMachinesCommand({}));
        const match = machines.stateMachines?.find(
            (sm) => sm.name === STATE_MACHINE_NAME,
        );
        stateMachineArn = match?.stateMachineArn;

        // 2. Fetch latest SFN execution if state machine exists
        if (stateMachineArn) {
            const executions = await sfn.send(
                new ListExecutionsCommand({
                    stateMachineArn,
                    maxResults: 1,
                }),
            );
            latestSfnExecution = executions.executions?.[0];
        }

        // 3. Resolve SSM Automation execution results
        for (const target of AUTOMATION_TARGETS) {
            let docName: string;

            try {
                docName = await getParam(target.docNameParam);
            } catch {
                // Document not deployed — skip this target
                continue;
            }

            const result = await ssm.send(
                new DescribeAutomationExecutionsCommand({
                    Filters: [
                        {
                            Key: 'DocumentNamePrefix',
                            Values: [docName],
                        },
                    ],
                    MaxResults: 1,
                }),
            );

            const exec: AutomationExecutionMetadata | undefined =
                result.AutomationExecutionMetadataList?.[0];
            if (!exec) continue;

            ssmResults.set(target.label, {
                status: exec.AutomationExecutionStatus ?? 'Unknown',
                documentName: exec.DocumentName ?? '',
            });
        }
    }, 30_000);

    // ── Step Functions Orchestrator ───────────────────────────────────────
    describe('Step Functions Orchestrator', () => {
        it('should have the bootstrap orchestrator state machine', () => {
            expect(stateMachineArn).toBeDefined();
            expect(stateMachineArn).toContain(STATE_MACHINE_NAME);
        });

        it('should have at least one execution', () => {
            expect(latestSfnExecution).toBeDefined();
        });

        it('should have a successful latest execution', () => {
            expect(latestSfnExecution).toBeDefined();
            expect(SFN_SUCCESS_STATUSES).toContain(
                latestSfnExecution!.status,
            );
        });
    });

    // ── SSM Automation per-role verification ─────────────────────────────
    describe.each(AUTOMATION_TARGETS)('$label', (target) => {
        let execution: SsmExecutionResult | undefined;

        // Depends on: ssmResults populated in top-level beforeAll
        beforeAll(() => {
            execution = ssmResults.get(target.label);
        });

        it('should have a recent execution', () => {
            expect(execution).toBeDefined();
        });

        it('should have completed successfully', () => {
            expect(execution).toBeDefined();
            const exec = requireResult(ssmResults, target.label);
            expect(SSM_SUCCESS_STATUSES).toContain(exec.status);
        });

        it('should have document name matching expected pattern', () => {
            expect(execution).toBeDefined();
            const exec = requireResult(ssmResults, target.label);
            expect(exec.documentName).toMatch(
                new RegExp(`^${NAME_PREFIX}-`),
            );
        });
    });
});
