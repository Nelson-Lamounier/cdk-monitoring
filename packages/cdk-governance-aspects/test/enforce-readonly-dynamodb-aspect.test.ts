import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';

import { Annotations, Match } from 'aws-cdk-lib/assertions';

import { EnforceReadOnlyDynamoDbAspect } from '../src/enforce-readonly-dynamodb-aspect';

import type { EnforceReadOnlyDynamoDbProps } from '../src/enforce-readonly-dynamodb-aspect';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a stack with an IAM role + policy and the enforcement aspect applied.
 *
 * @param actions - IAM actions to grant on the policy
 * @param roleId - Construct ID for the role (defaults to 'EcsTaskRole')
 * @param aspectProps - Optional aspect configuration
 * @returns The synthesised CDK stack for assertion
 */
function buildStackWithPolicy(
    actions: string[],
    roleId = 'EcsTaskRole',
    aspectProps: EnforceReadOnlyDynamoDbProps = {},
): cdk.Stack {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const role = new iam.Role(stack, roleId, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    role.addToPolicy(new iam.PolicyStatement({
        actions,
        resources: ['arn:aws:dynamodb:eu-west-1:123456789012:table/MyTable'],
    }));

    cdk.Aspects.of(stack).add(new EnforceReadOnlyDynamoDbAspect(aspectProps));

    // Force synthesis to trigger aspect visitors
    app.synth();

    return stack;
}

// =============================================================================
// TESTS — Read-only enforcement
// =============================================================================

describe('EnforceReadOnlyDynamoDbAspect', () => {
    describe('allowed actions', () => {
        it('should allow dynamodb:GetItem', () => {
            const stack = buildStackWithPolicy(['dynamodb:GetItem']);
            Annotations.fromStack(stack).hasNoError(
                '*',
                Match.anyValue(),
            );
        });

        it('should allow dynamodb:Query', () => {
            const stack = buildStackWithPolicy(['dynamodb:Query']);
            Annotations.fromStack(stack).hasNoError(
                '*',
                Match.anyValue(),
            );
        });

        it('should allow dynamodb:Scan', () => {
            const stack = buildStackWithPolicy(['dynamodb:Scan']);
            Annotations.fromStack(stack).hasNoError(
                '*',
                Match.anyValue(),
            );
        });

        it('should allow dynamodb:BatchGetItem', () => {
            const stack = buildStackWithPolicy(['dynamodb:BatchGetItem']);
            Annotations.fromStack(stack).hasNoError(
                '*',
                Match.anyValue(),
            );
        });
    });

    describe('forbidden write actions', () => {
        it('should block dynamodb:PutItem', () => {
            const stack = buildStackWithPolicy(['dynamodb:PutItem']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*PutItem'),
            );
        });

        it('should block dynamodb:DeleteItem', () => {
            const stack = buildStackWithPolicy(['dynamodb:DeleteItem']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*DeleteItem'),
            );
        });

        it('should block dynamodb:UpdateItem', () => {
            const stack = buildStackWithPolicy(['dynamodb:UpdateItem']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*UpdateItem'),
            );
        });

        it('should block dynamodb:BatchWriteItem', () => {
            const stack = buildStackWithPolicy(['dynamodb:BatchWriteItem']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp(
                    'EnforceReadOnlyDynamoDb.*BatchWriteItem',
                ),
            );
        });
    });

    describe('forbidden admin actions', () => {
        it('should block dynamodb:CreateTable', () => {
            const stack = buildStackWithPolicy(['dynamodb:CreateTable']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*CreateTable'),
            );
        });

        it('should block dynamodb:DeleteTable', () => {
            const stack = buildStackWithPolicy(['dynamodb:DeleteTable']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*DeleteTable'),
            );
        });
    });

    describe('wildcard detection', () => {
        it('should block dynamodb:* as it includes write actions', () => {
            const stack = buildStackWithPolicy(['dynamodb:*']);
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb'),
            );
        });
    });

    describe('configuration options', () => {
        it('should emit warnings instead of errors when failOnViolation is false', () => {
            const stack = buildStackWithPolicy(
                ['dynamodb:PutItem'],
                'EcsTaskRole',
                { failOnViolation: false },
            );
            Annotations.fromStack(stack).hasNoError(
                '*',
                Match.anyValue(),
            );
            Annotations.fromStack(stack).hasWarning(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*PutItem'),
            );
        });

        it('should skip roles that do not match the roleNamePattern', () => {
            const stack = buildStackWithPolicy(
                ['dynamodb:PutItem'],
                'LambdaExecutionRole', // does not contain 'taskrole'
            );
            Annotations.fromStack(stack).hasNoError(
                '*',
                Match.anyValue(),
            );
        });

        it('should match custom roleNamePattern', () => {
            const stack = buildStackWithPolicy(
                ['dynamodb:PutItem'],
                'NextjsWorkerRole',
                { roleNamePattern: 'workerrole' },
            );
            Annotations.fromStack(stack).hasError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb.*PutItem'),
            );
        });
    });
});
