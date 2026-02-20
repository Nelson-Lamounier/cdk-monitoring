/**
 * @format
 * K8sProjectFactory Unit Tests
 *
 * Tests for the factory that creates k3s Kubernetes infrastructure stacks.
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { Project } from '../../../../lib/config/projects';
import {
    K8sProjectFactory,
    K8sFactoryContext,
} from '../../../../lib/projects/k8s';

// Set test environment
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';

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
            expect(factory.namespace).toBe('K8s');
        });
    });

    describe('createAllStacks', () => {
        let app: cdk.App;

        beforeEach(() => {
            app = new cdk.App();
        });

        it('should create a single compute stack', () => {
            const factory = new K8sProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // k3s project has 1 stack: Compute
            expect(stacks).toHaveLength(1);
            expect(stackMap).toHaveProperty('compute');
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
