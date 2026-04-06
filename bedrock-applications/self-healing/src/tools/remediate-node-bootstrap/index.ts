/**
 * @format
 * Remediate Node Bootstrap — MCP Tool Lambda
 *
 * Triggers an SSM Automation Document to re-run the bootstrap sequence
 * on a failed Kubernetes node. Uses the existing SSM Documents deployed
 * by the `ssm-automation-stack` (k8s-bootstrap-control-plane,
 * k8s-bootstrap-worker).
 *
 * The tool resolves Document names and IAM roles from SSM Parameter Store
 * to ensure it always uses the latest deployed version. This is the
 * production-grade replacement for manually triggering the
 * `_deploy-ssm-automation.yml` GitHub Actions workflow.
 *
 * Registered as an MCP tool via the AgentCore Gateway.
 *
 * Input:
 *   - instanceId (string, required): EC2 instance to remediate
 *   - role (string, required): Node role — 'control-plane' or 'worker'
 *
 * Output:
 *   - instanceId: Target instance
 *   - executionId: SSM Automation execution ID (for tracking)
 *   - documentName: SSM Document used
 *   - status: 'triggered' or 'error'
 */

import {
    SSMClient,
    StartAutomationExecutionCommand,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

/** SSM Parameter Store prefix for K8s configuration */
const SSM_PREFIX = process.env.SSM_PREFIX ?? '/k8s/development';

// =============================================================================
// Types
// =============================================================================

/**
 * Valid node roles for bootstrap remediation
 */
type NodeRole = 'control-plane' | 'worker';

/**
 * MCP tool input schema
 */
interface RemediateInput {
    readonly instanceId: string;
    readonly role: string;
}

/**
 * Structured remediation report returned by this tool
 */
interface RemediationReport {
    readonly instanceId: string;
    readonly role: string;
    readonly documentName?: string;
    readonly executionId?: string;
    readonly status: 'triggered' | 'error';
    readonly error?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validate the node role input.
 *
 * @param role - Raw role string from the tool input
 * @returns Validated NodeRole
 * @throws Error if the role is invalid
 */
function validateRole(role: string): NodeRole {
    const valid: NodeRole[] = ['control-plane', 'worker'];
    if (!valid.includes(role as NodeRole)) {
        throw new Error(
            `Invalid role: "${role}". Expected one of: ${valid.join(', ')}`,
        );
    }
    return role as NodeRole;
}

/**
 * Resolve an SSM parameter value.
 *
 * @param name - Full parameter path
 * @returns Parameter value string
 * @throws Error if the parameter is not found
 */
async function resolveParameter(name: string): Promise<string> {
    const result = await ssm.send(
        new GetParameterCommand({
            Name: name,
            WithDecryption: false,
        }),
    );

    const value = result.Parameter?.Value;
    if (!value) {
        throw new Error(`SSM parameter not found: ${name}`);
    }
    return value;
}

/**
 * Map a node role to the SSM Document parameter path suffix.
 *
 * @param role - Validated node role
 * @returns SSM parameter path suffix for the document name
 */
function getDocumentParamSuffix(role: NodeRole): string {
    return role === 'control-plane'
        ? '/ssm-automation/cp-document-name'
        : '/ssm-automation/worker-document-name';
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Lambda handler — trigger SSM Automation to re-bootstrap a failed node.
 *
 * Resolves the appropriate SSM Document name and automation role from
 * Parameter Store, then starts the automation execution targeting the
 * specified instance.
 *
 * @param event - MCP tool invocation event with `instanceId` and `role`
 * @returns Structured remediation report
 */
export async function handler(event: RemediateInput): Promise<RemediationReport> {
    const { instanceId, role: rawRole } = event;

    if (!instanceId) {
        return {
            instanceId: 'unknown',
            role: rawRole ?? 'unknown',
            status: 'error',
            error: 'Missing required input: instanceId',
        };
    }

    if (!rawRole) {
        return {
            instanceId,
            role: 'unknown',
            status: 'error',
            error: 'Missing required input: role (control-plane or worker)',
        };
    }

    console.log(
        JSON.stringify({
            level: 'INFO',
            message: 'Initiating node bootstrap remediation',
            instanceId,
            role: rawRole,
        }),
    );

    try {
        // Validate role
        const role = validateRole(rawRole);

        // Resolve the SSM Document name from Parameter Store
        const documentParamPath = `${SSM_PREFIX}${getDocumentParamSuffix(role)}`;
        let documentName: string;
        try {
            documentName = await resolveParameter(documentParamPath);
        } catch {
            // Fallback to convention-based document naming
            const prefix = SSM_PREFIX.replace('/k8s/', '').replace('/', '-');
            documentName = `k8s-bootstrap-${role}-${prefix}`;
            console.log(
                JSON.stringify({
                    level: 'WARN',
                    message: 'SSM Document parameter not found, using convention',
                    paramPath: documentParamPath,
                    fallbackDocument: documentName,
                }),
            );
        }

        // Resolve the automation assume role ARN
        const roleParamPath = `${SSM_PREFIX}/ssm-automation/role-arn`;
        let automationRoleArn: string | undefined;
        try {
            automationRoleArn = await resolveParameter(roleParamPath);
        } catch {
            console.log(
                JSON.stringify({
                    level: 'WARN',
                    message: 'Automation role ARN not found in SSM, executing without AssumeRole',
                    paramPath: roleParamPath,
                }),
            );
        }

        console.log(
            JSON.stringify({
                level: 'INFO',
                message: 'Starting SSM Automation execution',
                documentName,
                instanceId,
                role,
                automationRoleArn: automationRoleArn ?? 'default',
            }),
        );

        // Build the automation parameters
        const parameters: Record<string, string[]> = {
            InstanceId: [instanceId],
        };

        // Start the automation execution
        const executionResult = await ssm.send(
            new StartAutomationExecutionCommand({
                DocumentName: documentName,
                Parameters: parameters,
                ...(automationRoleArn
                    ? { TargetParameterName: 'InstanceId' }
                    : {}),
            }),
        );

        const executionId = executionResult.AutomationExecutionId;

        console.log(
            JSON.stringify({
                level: 'INFO',
                message: 'SSM Automation execution started',
                executionId,
                documentName,
                instanceId,
                role,
            }),
        );

        return {
            instanceId,
            role,
            documentName,
            executionId,
            status: 'triggered',
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(
            JSON.stringify({
                level: 'ERROR',
                message: 'Bootstrap remediation failed',
                instanceId,
                role: rawRole,
                error,
            }),
        );

        return {
            instanceId,
            role: rawRole,
            status: 'error',
            error: `Failed to trigger bootstrap remediation: ${error}`,
        };
    }
}
