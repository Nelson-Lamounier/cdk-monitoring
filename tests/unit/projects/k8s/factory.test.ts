/**
 * @format
 * K8sProjectFactory Unit Tests
 *
 * Tests for the factory that creates k3s Kubernetes infrastructure stacks.
 *
 * IMPORTANT: Edge config env vars MUST be set before the config module is
 * imported (it evaluates fromEnv() at module load time). The env vars are
 * set at the top of this file before any imports that trigger the config.
 */

// --- Set env vars BEFORE any CDK/config imports ---
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';
process.env.MONITOR_DOMAIN_NAME = 'monitoring.dev.nelsonlamounier.com';
process.env.HOSTED_ZONE_ID = 'Z04763221QPB6CZ9R77GM';
process.env.CROSS_ACCOUNT_ROLE_ARN = 'arn:aws:iam::711387127421:role/Route53DnsValidationRole';

// --- Now safe to import modules ---
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { Project } from '../../../../lib/config/projects';
import {
    K8sProjectFactory,
    K8sFactoryContext,
} from '../../../../lib/projects/k8s';

/**
 * Helper to create a typed factory context
 */
function createFactoryContext(
    overrides?: Partial<K8sFactoryContext>
): K8sFactoryContext {
    return {
        environment: Environment.DEVELOPMENT,
        ...overrides,
    };
}

describe('K8sProjectFactory', () => {
    describe('Factory Properties', () => {
        it('should have correct project type', () => {
            const factory = new K8sProjectFactory(Environment.DEVELOPMENT);
            expect(factory.project).toBe(Project.K8S);
        });

        it('should have correct environment', () => {
            const factory = new K8sProjectFactory(Environment.STAGING);
            expect(factory.environment).toBe(Environment.STAGING);
        });

        it('should have correct namespace', () => {
            const factory = new K8sProjectFactory(Environment.DEVELOPMENT);
            expect(factory.namespace).toBe('Monitoring-K8s');
        });
    });

    describe('createAllStacks', () => {
        let app: cdk.App;

        beforeEach(() => {
            app = new cdk.App();
        });

        it('should create compute and edge stacks', () => {
            const factory = new K8sProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // k3s project has 2 stacks: Compute + Edge
            expect(stacks).toHaveLength(2);
            expect(stackMap).toHaveProperty('compute');
            expect(stackMap).toHaveProperty('edge');
        });

        it('should name stacks correctly with namespace and environment', () => {
            const factory = new K8sProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map(s => s.stackName);
            expect(stackNames.some(name => name.includes('K8s'))).toBe(true);
            expect(stackNames.some(name => name.includes('development'))).toBe(true);
        });

        it('should create different stack names for different environments', () => {
            const devFactory = new K8sProjectFactory(Environment.DEVELOPMENT);
            const prodFactory = new K8sProjectFactory(Environment.PRODUCTION);

            const devApp = new cdk.App();
            const devContext = createFactoryContext();
            const { stacks: devStacks } = devFactory.createAllStacks(devApp, devContext);

            const prodApp = new cdk.App();
            const prodContext = createFactoryContext({ environment: Environment.PRODUCTION });
            const { stacks: prodStacks } = prodFactory.createAllStacks(prodApp, prodContext);

            expect(devStacks[0].stackName).toContain('development');
            expect(prodStacks[0].stackName).toContain('production');
        });
    });
});
