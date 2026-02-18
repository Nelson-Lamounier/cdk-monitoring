/**
 * @format
 * Enforce Read-Only DynamoDB Aspect Tests
 *
 * Validates that the CDK Aspect correctly detects and reports
 * DynamoDB write actions on ECS task roles.
 */

import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { EnforceReadOnlyDynamoDbAspect, FORBIDDEN_DYNAMODB_ACTIONS } from '../../../../lib/aspects';
import { createTestApp } from '../../../fixtures';

/* eslint-disable jest/expect-expect */
// CDK Annotations.hasError/hasWarning/hasNoError ARE the assertions — they throw on failure
// jest/expect-expect doesn't recognize them as assertions

const TEST_ENV = { account: '123456789012', region: 'eu-west-1' };

/**
 * Helper to create a stack with a task role and an attached policy.
 */
function createStackWithPolicy(
    actions: string[],
    roleName: string = 'TestTaskRole',
): { stack: cdk.Stack; annotations: Annotations } {
    const app = createTestApp();
    const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });

    const role = new iam.Role(stack, roleName, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    role.addToPolicy(new iam.PolicyStatement({
        sid: 'DynamoDbAccess',
        effect: iam.Effect.ALLOW,
        actions,
        resources: ['arn:aws:dynamodb:eu-west-1:123456789012:table/test'],
    }));

    cdk.Aspects.of(stack).add(new EnforceReadOnlyDynamoDbAspect({
        failOnViolation: true,
        roleNamePattern: 'taskrole',
    }));

    // Force aspect evaluation
    const annotations = Annotations.fromStack(stack);

    return { stack, annotations };
}

describe('EnforceReadOnlyDynamoDbAspect', () => {
    describe('Read-only actions (should pass)', () => {
        it('should allow GetItem, Query, Scan', () => {
            const { annotations } = createStackWithPolicy([
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:Scan',
            ]);

            annotations.hasNoError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb'),
            );
        });

        it('should allow BatchGetItem and DescribeTable', () => {
            const { annotations } = createStackWithPolicy([
                'dynamodb:BatchGetItem',
                'dynamodb:DescribeTable',
            ]);

            annotations.hasNoError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb'),
            );
        });
    });

    describe('Write actions (should fail)', () => {
        it.each([
            ['dynamodb:PutItem'],
            ['dynamodb:DeleteItem'],
            ['dynamodb:UpdateItem'],
            ['dynamodb:BatchWriteItem'],
        ])('should detect forbidden action: %s', (action) => {
            const { annotations } = createStackWithPolicy([
                'dynamodb:GetItem',
                action,
            ]);

            annotations.hasError(
                '*',
                Match.stringLikeRegexp(`forbidden DynamoDB action: "${action}"`),
            );
        });

        it('should detect dynamodb:* wildcard as a violation', () => {
            const { annotations } = createStackWithPolicy([
                'dynamodb:*',
            ]);

            annotations.hasError(
                '*',
                Match.stringLikeRegexp('forbidden DynamoDB action'),
            );
        });
    });

    describe('Admin actions (should fail)', () => {
        it.each([
            ['dynamodb:CreateTable'],
            ['dynamodb:DeleteTable'],
            ['dynamodb:UpdateTable'],
        ])('should detect forbidden admin action: %s', (action) => {
            const { annotations } = createStackWithPolicy([
                'dynamodb:GetItem',
                action,
            ]);

            annotations.hasError(
                '*',
                Match.stringLikeRegexp('forbidden DynamoDB action'),
            );
        });
    });

    describe('Role name filtering', () => {
        it('should NOT flag policies on non-task roles', () => {
            const app = createTestApp();
            const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });

            const role = new iam.Role(stack, 'LambdaExecutionRole', {
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            });

            role.addToPolicy(new iam.PolicyStatement({
                sid: 'LambdaFullAccess',
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
                resources: ['arn:aws:dynamodb:eu-west-1:123456789012:table/test'],
            }));

            cdk.Aspects.of(stack).add(new EnforceReadOnlyDynamoDbAspect({
                failOnViolation: true,
                roleNamePattern: 'taskrole',
            }));

            const annotations = Annotations.fromStack(stack);
            annotations.hasNoError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb'),
            );
        });
    });

    describe('Warning mode', () => {
        it('should emit warning instead of error when failOnViolation is false', () => {
            const app = createTestApp();
            const stack = new cdk.Stack(app, 'TestStack', { env: TEST_ENV });

            const role = new iam.Role(stack, 'TestTaskRole', {
                assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            });

            role.addToPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:PutItem'],
                resources: ['arn:aws:dynamodb:eu-west-1:123456789012:table/test'],
            }));

            cdk.Aspects.of(stack).add(new EnforceReadOnlyDynamoDbAspect({
                failOnViolation: false,
                roleNamePattern: 'taskrole',
            }));

            const annotations = Annotations.fromStack(stack);

            // Should have warnings, not errors
            annotations.hasWarning(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb'),
            );
            annotations.hasNoError(
                '*',
                Match.stringLikeRegexp('EnforceReadOnlyDynamoDb'),
            );
        });
    });

    describe('Constants', () => {
        it('should export FORBIDDEN_DYNAMODB_ACTIONS with both write and admin actions', () => {
            expect(FORBIDDEN_DYNAMODB_ACTIONS).toContain('dynamodb:PutItem');
            expect(FORBIDDEN_DYNAMODB_ACTIONS).toContain('dynamodb:DeleteItem');
            expect(FORBIDDEN_DYNAMODB_ACTIONS).toContain('dynamodb:UpdateItem');
            expect(FORBIDDEN_DYNAMODB_ACTIONS).toContain('dynamodb:BatchWriteItem');
            expect(FORBIDDEN_DYNAMODB_ACTIONS).toContain('dynamodb:CreateTable');
            expect(FORBIDDEN_DYNAMODB_ACTIONS).toContain('dynamodb:DeleteTable');
            expect(FORBIDDEN_DYNAMODB_ACTIONS.length).toBeGreaterThanOrEqual(7);
        });
    });
});
