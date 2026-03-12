/**
 * @format
 * Enforce Read-Only DynamoDB Aspect
 *
 * CDK Aspect that validates ECS task roles only have read-only DynamoDB actions.
 * Prevents accidental drift from the read/write boundary established by the
 * dual-path architecture (SSR reads directly, writes go through API Gateway).
 *
 * Applied to the NextJs compute stack to ensure the task role never gains
 * PutItem, DeleteItem, UpdateItem, or BatchWriteItem permissions.
 *
 * @see {@link https://docs.aws.amazon.com/cdk/v2/guide/aspects.html CDK Aspects}
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { IConstruct } from 'constructs';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * DynamoDB write actions that must NEVER appear on an ECS task role.
 * Writes must go through API Gateway → Lambda (auditable, rate-limited).
 */
export const DYNAMODB_WRITE_ACTIONS: readonly string[] = [
    'dynamodb:PutItem',
    'dynamodb:DeleteItem',
    'dynamodb:UpdateItem',
    'dynamodb:BatchWriteItem',
] as const;

/**
 * DynamoDB administrative actions that must NEVER appear on an ECS task role.
 * Table management should only happen through CDK, never at runtime.
 */
export const DYNAMODB_ADMIN_ACTIONS: readonly string[] = [
    'dynamodb:CreateTable',
    'dynamodb:DeleteTable',
    'dynamodb:UpdateTable',
    'dynamodb:CreateGlobalTable',
] as const;

/** All forbidden DynamoDB actions for ECS task roles */
export const FORBIDDEN_DYNAMODB_ACTIONS: readonly string[] = [
    ...DYNAMODB_WRITE_ACTIONS,
    ...DYNAMODB_ADMIN_ACTIONS,
] as const;

// =============================================================================
// ASPECT
// =============================================================================

/**
 * Configuration for the read-only DynamoDB enforcement aspect
 */
export interface EnforceReadOnlyDynamoDbProps {
    /**
     * Whether to throw an error (fail synthesis) or just warn.
     * @default true - fails synthesis
     */
    readonly failOnViolation?: boolean;

    /**
     * Role construct ID pattern to match. Only roles whose construct path
     * contains this pattern (case-insensitive) are checked.
     * @default 'taskrole' - matches ECS task roles
     */
    readonly roleNamePattern?: string;
}

/**
 * CDK Aspect that enforces read-only DynamoDB access on ECS task roles.
 *
 * Inspects IAM Policy L1 constructs and checks if any policy statement
 * attached to a matching role contains DynamoDB write or admin actions.
 *
 * The aspect resolves CfnPolicy.roles Refs to logical IDs and matches
 * them against the roleNamePattern to identify task role policies.
 *
 * @example
 * ```typescript
 * // Apply to compute stack during synthesis
 * Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect());
 *
 * // Or with custom options
 * Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect({
 *     failOnViolation: false, // warn only
 *     roleNamePattern: 'nextjs-task',
 * }));
 * ```
 */
export class EnforceReadOnlyDynamoDbAspect implements cdk.IAspect {
    private readonly failOnViolation: boolean;
    private readonly roleNamePattern: string;

    constructor(props: EnforceReadOnlyDynamoDbProps = {}) {
        this.failOnViolation = props.failOnViolation ?? true;
        this.roleNamePattern = (props.roleNamePattern ?? 'taskrole').toLowerCase();
    }

    public visit(node: IConstruct): void {
        // Only inspect IAM Policy L1 CFN resources
        if (!(node instanceof iam.CfnPolicy)) {
            return;
        }

        // Resolve the roles array — may contain { Ref: 'LogicalId' } tokens
        const resolved = cdk.Stack.of(node).resolve(node.roles);
        if (!resolved || !Array.isArray(resolved)) {
            return;
        }

        // Check if any role reference matches the task role pattern
        const isTaskRolePolicy = resolved.some((role) => {
            // After resolution, roles are either strings or { Ref: 'LogicalId' }
            const roleId = typeof role === 'string'
                ? role
                : (role as { Ref?: string })?.Ref ?? '';
            return roleId.toLowerCase().includes(this.roleNamePattern);
        });

        if (!isTaskRolePolicy) {
            return;
        }

        // Inspect the policy document for forbidden DynamoDB actions
        const policyDocument = node.policyDocument;
        if (!policyDocument) {
            return;
        }

        this.inspectPolicyDocument(node, policyDocument);
    }

    /**
     * Inspects a resolved policy document for forbidden DynamoDB actions.
     */
    private inspectPolicyDocument(
        node: IConstruct,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doc: any,
    ): void {
        // Resolve all CDK tokens/Lazy values in the document
        const resolved = cdk.Stack.of(node).resolve(doc);
        if (!resolved?.Statement) {
            return;
        }

        for (const statement of resolved.Statement) {
            // Only check Allow statements (Deny with write actions is fine)
            if (statement.Effect !== 'Allow') {
                continue;
            }

            const actions: string[] = Array.isArray(statement.Action)
                ? statement.Action
                : statement.Action ? [statement.Action] : [];

            for (const action of actions) {
                const normalizedAction = action.toLowerCase();
                const violation = FORBIDDEN_DYNAMODB_ACTIONS.find(
                    (forbidden) => normalizedAction === forbidden.toLowerCase()
                        || this.matchesWildcard(normalizedAction, forbidden.toLowerCase()),
                );

                if (violation) {
                    const message =
                        `[EnforceReadOnlyDynamoDb] ECS task role has forbidden DynamoDB action: "${action}". ` +
                        'Task roles must be read-only (GetItem, Query, Scan only). ' +
                        'Write operations must go through API Gateway → Lambda. ' +
                        `Forbidden action matched: "${violation}"`;

                    if (this.failOnViolation) {
                        cdk.Annotations.of(node).addError(message);
                    } else {
                        cdk.Annotations.of(node).addWarning(message);
                    }
                }
            }
        }
    }

    /**
     * Checks if an action matches via wildcard (e.g., 'dynamodb:*' matches all).
     */
    private matchesWildcard(action: string, forbidden: string): boolean {
        // Check if action is 'dynamodb:*' which would include write actions
        if (action === 'dynamodb:*') {
            return true;
        }
        // Check prefix wildcard like 'dynamodb:Put*'
        if (action.endsWith('*')) {
            const prefix = action.slice(0, -1);
            return forbidden.startsWith(prefix);
        }
        return false;
    }
}
