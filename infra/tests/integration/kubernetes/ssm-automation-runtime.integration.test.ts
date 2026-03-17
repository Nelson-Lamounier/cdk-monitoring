/**
 * @format
 * SSM Automation Runtime — Post-Deployment Integration Test
 *
 * Runs AFTER SSM Automation documents and the Step Functions orchestrator
 * have been deployed. Validates infrastructure provisioning and, when
 * available, runtime execution results.
 *
 * Architecture (post–Step Functions migration):
 *   EventBridge → Step Functions → SSM Automation (per-role documents)
 *
 * Test Strategy — Two-Phase Verification:
 *   Phase 1 (Infrastructure — runs after deploy-ssm):
 *     - Step Functions state machine exists with correct name
 *     - SSM Automation documents are published to SSM Parameter Store
 *
 *   Phase 2 (Runtime — only asserts when executions exist):
 *     - Step Functions orchestrator has successful executions
 *     - SSM Automation documents executed with correct status
 *     - Tests pass vacuously if no executions yet (instances not launched)
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
const resolvedDocNames = new Map<string, string>();

let stateMachineArn: string | undefined;
let latestSfnExecution: ExecutionListItem | undefined;

// =============================================================================
// Tests
// =============================================================================

describe('SSM Automation Runtime — Post-Deploy Verification', () => {
    // ── Global Setup ─────────────────────────────────────────────────────
    beforeAll(async () => {
        // 1. Resolve Step Functions state machine ARN (may not exist yet)
        try {
            const machines = await sfn.send(new ListStateMachinesCommand({}));
            const match = machines.stateMachines?.find(
                (sm) => sm.name === STATE_MACHINE_NAME,
            );
            stateMachineArn = match?.stateMachineArn;
        } catch {
            // SFN permissions not available or service error
            stateMachineArn = undefined;
        }

        // 2. Fetch latest SFN execution if state machine exists
        if (stateMachineArn) {
            try {
                const executions = await sfn.send(
                    new ListExecutionsCommand({
                        stateMachineArn,
                        maxResults: 1,
                    }),
                );
                latestSfnExecution = executions.executions?.[0];
            } catch {
                latestSfnExecution = undefined;
            }
        }

        // 3. Resolve SSM parameter names and fetch execution results
        for (const target of AUTOMATION_TARGETS) {
            let docName: string;

            try {
                docName = await getParam(target.docNameParam);
                resolvedDocNames.set(target.label, docName);
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

    // =====================================================================
    // Phase 1: Infrastructure — verifies resources exist after deploy-ssm
    // These tests MUST pass immediately after the SSM Automation stack
    // is deployed, regardless of whether any instance has launched.
    // =====================================================================
    describe('Infrastructure — Step Functions State Machine', () => {
        it('should have the bootstrap orchestrator state machine', () => {
            expect(stateMachineArn).toBeDefined();
            expect(stateMachineArn).toContain(STATE_MACHINE_NAME);
        });
    });

    describe.each(AUTOMATION_TARGETS)(
        'Infrastructure — $label Document',
        (target) => {
            it('should have the SSM parameter published', () => {
                const docName = resolvedDocNames.get(target.label);
                expect(docName).toBeDefined();
                expect(docName).toMatch(new RegExp(`^${NAME_PREFIX}-`));
            });
        },
    );

    // =====================================================================
    // Phase 2: Runtime — verifies executions completed successfully.
    // These tests only assert when executions exist. If no instances
    // have launched yet (e.g. first pipeline run), they pass vacuously
    // with a console warning.
    // =====================================================================
    describe('Runtime — Step Functions Orchestrator', () => {
        it('should have a successful latest execution (if any)', () => {
            if (!latestSfnExecution) {
                console.warn(
                    '⚠ No Step Functions executions found — ' +
                    'instances have not been launched yet. Skipping runtime assertion.',
                );
                return;
            }
            expect(SFN_SUCCESS_STATUSES).toContain(
                latestSfnExecution.status,
            );
        });
    });

    describe.each(AUTOMATION_TARGETS)(
        'Runtime — $label Execution',
        (target) => {
            let execution: SsmExecutionResult | undefined;

            // Depends on: ssmResults populated in top-level beforeAll
            beforeAll(() => {
                execution = ssmResults.get(target.label);
            });

            it('should have completed successfully (if executed)', () => {
                if (!execution) {
                    console.warn(
                        `⚠ No execution found for ${target.label} — ` +
                        'instance not yet launched. Skipping runtime assertion.',
                    );
                    return;
                }
                expect(SSM_SUCCESS_STATUSES).toContain(execution.status);
            });

            it('should have document name matching expected pattern (if executed)', () => {
                if (!execution) return;
                const exec = requireResult(ssmResults, target.label);
                expect(exec.documentName).toMatch(
                    new RegExp(`^${NAME_PREFIX}-`),
                );
            });
        },
    );
});
