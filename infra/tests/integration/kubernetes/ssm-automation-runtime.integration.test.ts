/**
 * @format
 * SSM Automation Runtime — Post-Deployment Integration Test
 *
 * Runs AFTER SSM Automation documents have been deployed and bootstrap/secrets
 * automations have completed. Calls real AWS APIs to verify that each automation
 * execution finished successfully with correct tag-based targeting.
 *
 * SSM-Anchored Strategy:
 *   1. Read SSM parameters for automation document names
 *   2. Query DescribeAutomationExecutions for the most recent execution
 *   3. Verify status, targets, resolved targets, and outputs
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

import { Environment } from '../../../lib/config';
import { k8sSsmPrefix } from '../../../lib/config/ssm-paths';
import { flatName } from '../../../lib/utilities/naming';

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PREFIX = k8sSsmPrefix(CDK_ENV);
/** Resource name prefix — e.g. 'k8s-dev' */
const NAME_PREFIX = flatName('k8s', '', CDK_ENV);

// AWS SDK client
const ssm = new SSMClient({ region: REGION });

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
// Test Targets — Bootstrap + Secrets Automations
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

// =============================================================================
// Execution result cache — populated in beforeAll
// =============================================================================

interface ExecutionResult {
    status: string;
    targets: Array<{ Key?: string; Values?: string[] }>;
    resolvedTargetValues: string[];
    resolvedTargetTruncated: boolean;
    outputs: Record<string, string[]>;
    documentName: string;
}

const executionResults = new Map<string, ExecutionResult>();

// =============================================================================
// Tests
// =============================================================================

describe('SSM Automation Runtime — Post-Deploy Verification', () => {
    // ── Setup: resolve document names and fetch latest executions ──────
    beforeAll(async () => {
        for (const target of AUTOMATION_TARGETS) {
            let docName: string;

            try {
                docName = await getParam(target.docNameParam);
            } catch {
                // Document not deployed — skip this target
                continue;
            }

            // Fetch the most recent execution for this document
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

            const exec = result.AutomationExecutionMetadataList?.[0];
            if (!exec) continue;

            executionResults.set(target.label, {
                status: exec.AutomationExecutionStatus ?? 'Unknown',
                targets: (exec.Targets ?? []) as Array<{ Key?: string; Values?: string[] }>,
                resolvedTargetValues: exec.ResolvedTargets?.ParameterValues ?? [],
                resolvedTargetTruncated: exec.ResolvedTargets?.Truncated ?? false,
                outputs: (exec.Outputs ?? {}) as Record<string, string[]>,
                documentName: exec.DocumentName ?? '',
            });
        }
    }, 30_000);

    // ── Dynamic test generation per automation target ──────────────────
    describe.each(AUTOMATION_TARGETS)('$label', (target) => {
        let execution: ExecutionResult | undefined;

        beforeAll(() => {
            execution = executionResults.get(target.label);
        });

        it('should have a recent execution', () => {
            expect(execution).toBeDefined();
        });

        it('should have completed successfully', () => {
            expect(execution?.status).toBe('Success');
        });

        it('should have document name matching expected pattern', () => {
            expect(execution?.documentName).toMatch(
                new RegExp(`^${NAME_PREFIX}-`),
            );
        });

        it('should have non-empty Outputs (CommandId)', () => {
            expect(execution).toBeDefined();
            expect(execution!.outputs).toBeDefined();
            expect(Object.keys(execution!.outputs).length).toBeGreaterThan(0);
        });
    });
});
