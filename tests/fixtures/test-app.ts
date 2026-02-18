/**
 * @format
 * CDK App and Stack helpers for testing
 *
 * Reusable utilities for creating CDK Apps and Stacks with
 * standard test configuration.
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { TEST_ENV } from './constants';

/**
 * Creates a test CDK App with standard configuration
 */
export function createTestApp(): cdk.App {
    return new cdk.App();
}

/**
 * Creates a helper stack for supporting resources (VPC, SG, KMS, etc.)
 * Use this when your stack under test requires dependencies from another stack.
 *
 * @param app - CDK App to add the stack to
 * @param id - Stack identifier (default: 'HelperStack')
 * @returns A CDK Stack configured with TEST_ENV
 */
export function createHelperStack(app: cdk.App, id = 'HelperStack'): cdk.Stack {
    return new cdk.Stack(app, id, { env: TEST_ENV });
}

/**
 * Result type for stack factory functions
 */
export interface StackFactoryResult<T extends cdk.Stack> {
    /** The stack under test */
    stack: T;
    /** CloudFormation template for assertions */
    template: Template;
    /** CDK App containing the stack */
    app: cdk.App;
}

/**
 * Generic stack factory helper that creates a stack and returns it with its template.
 *
 * @param factory - Function that creates the stack given an App
 * @returns Stack, Template, and App for testing
 *
 * @example
 * ```typescript
 * const { stack, template } = createStackWithTemplate((app) =>
 *   new MyStack(app, 'TestStack', { env: TEST_ENV, ...props })
 * );
 * ```
 */
export function createStackWithTemplate<T extends cdk.Stack>(
    factory: (app: cdk.App) => T
): StackFactoryResult<T> {
    const app = createTestApp();
    const stack = factory(app);
    const template = Template.fromStack(stack);
    return { stack, template, app };
}

/**
 * Result type for stacks that depend on a helper stack
 */
export interface StackWithHelperResult<T extends cdk.Stack> extends StackFactoryResult<T> {
    /** The helper stack containing dependencies */
    helperStack: cdk.Stack;
}

/**
 * Creates a stack with a helper stack for dependencies.
 * Use this when your stack needs VPC, Security Groups, or other resources
 * that would normally come from another stack.
 *
 * @param helperFactory - Function to set up the helper stack
 * @param stackFactory - Function to create the stack under test
 * @returns Stack, Template, App, and HelperStack for testing
 */
export function createStackWithHelper<T extends cdk.Stack, H>(
    helperFactory: (helperStack: cdk.Stack) => H,
    stackFactory: (app: cdk.App, helpers: H) => T
): StackWithHelperResult<T> & { helpers: H } {
    const app = createTestApp();
    const helperStack = createHelperStack(app);
    const helpers = helperFactory(helperStack);
    const stack = stackFactory(app, helpers);
    const template = Template.fromStack(stack);
    return { stack, template, app, helperStack, helpers };
}
