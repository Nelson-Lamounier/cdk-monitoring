/**
 * @format
 * NextJS Factory Integration Tests
 *
 * Tests the full factory stack creation, including dependency cycle detection.
 * Unlike individual stack tests (which use Template.fromStack on isolated stacks),
 * these tests call app.synth() to trigger CDK's cross-stack dependency validation.
 *
 * This catches cyclic dependency errors BEFORE they hit CI synthesis.
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { Project } from '../../../../lib/config/projects';
import { ConsolidatedNextJSFactory } from '../../../../lib/projects/nextjs/factory';

// Required env vars for CDK environment resolution
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';

/**
 * Default context overrides for test factory invocations.
 * These replace the old process.env reads — the factory now gets
 * edge config and email config from context overrides (app.ts bridge)
 * or typed config files.
 */
const TEST_CONTEXT = {
    environment: Environment.DEVELOPMENT as const,
    // Edge config (previously from process.env)
    domainName: 'dev.example.com',
    hostedZoneId: 'Z1234567890ABC',
    crossAccountRoleArn: 'arn:aws:iam::111111111111:role/Route53Role',
    // Email config (previously from process.env)
    notificationEmail: 'test@example.com',
    sesFromEmail: 'noreply@example.com',
    verificationBaseUrl: 'https://dev.example.com',
    verificationSecret: 'test-secret-for-unit-tests',
};

/**
 * Creates a CDK App for NextJS factory tests
 */
function createFactoryApp(): cdk.App {
    return new cdk.App();
}

describe('ConsolidatedNextJSFactory', () => {
    describe('Factory Properties', () => {
        it('should have correct project type', () => {
            const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);
            expect(factory.project).toBe(Project.NEXTJS);
        });

        it('should have correct environment', () => {
            const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);
            expect(factory.environment).toBe(Environment.DEVELOPMENT);
        });

        it('should have correct namespace', () => {
            const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);
            expect(factory.namespace).toBe('NextJS');
        });
    });

    describe('createAllStacks', () => {
        it('should create all 7 stacks', () => {
            const app = createFactoryApp();
            const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);

            const { stacks, stackMap } = factory.createAllStacks(app, TEST_CONTEXT);

            expect(stacks).toHaveLength(7);
            expect(stackMap).toHaveProperty('data');
            expect(stackMap).toHaveProperty('compute');
            expect(stackMap).toHaveProperty('networking');
            expect(stackMap).toHaveProperty('application');
            expect(stackMap).toHaveProperty('api');
            expect(stackMap).toHaveProperty('edge');
            expect(stackMap).toHaveProperty('k8sCompute');
        });

        it('should name stacks with correct namespace and environment suffix', () => {
            const app = createFactoryApp();
            const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);

            const { stacks } = factory.createAllStacks(app, TEST_CONTEXT);

            const stackNames = stacks.map(s => s.stackName);
            expect(stackNames).toContain('NextJS-Data-development');
            expect(stackNames).toContain('NextJS-Compute-development');
            expect(stackNames).toContain('NextJS-Networking-development');
            expect(stackNames).toContain('NextJS-Application-development');
            expect(stackNames).toContain('NextJS-Api-development');
            expect(stackNames).toContain('NextJS-Edge-development');
            expect(stackNames).toContain('NextJS-K8s-Compute-development');
        });
    });

    describe('Stack Dependency Cycle Detection', () => {
        /**
         * This is the critical regression test.
         *
         * app.synth() triggers CDK's dependency graph validation which
         * detects circular references between stacks. Individual stack
         * tests using Template.fromStack() do NOT catch cross-stack cycles.
         *
         * If this test fails with "ValidationError: cyclic reference",
         * it means a cross-stack reference has been introduced that creates
         * a dependency cycle (e.g., Stack A depends on Stack B and B on A).
         */
        it('should synthesize without cyclic dependency errors', () => {
            const app = createFactoryApp();
            const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);

            factory.createAllStacks(app, TEST_CONTEXT);

            // app.synth() validates the full dependency graph.
            // Throws ValidationError if any cyclic references exist.
            expect(() => app.synth()).not.toThrow();
        });
    });
});
