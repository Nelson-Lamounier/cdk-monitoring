/**
 * @format
 * KubernetesProjectFactory Unit Tests
 *
 * Tests for the factory that creates shared k3s Kubernetes infrastructure.
 * Creates 4 stacks: Data, Compute, API, and Edge.
 *
 * IMPORTANT: Edge config env vars MUST be set before the config module is
 * imported (it evaluates fromEnv() at module load time). The env vars are
 * set at the top of this file before any imports that trigger the config.
 */

// --- Set env vars BEFORE any CDK/config imports ---
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';
process.env.DOMAIN_NAME = 'dev.nelsonlamounier.com';
process.env.MONITOR_DOMAIN_NAME = 'monitoring.dev.nelsonlamounier.com';
process.env.HOSTED_ZONE_ID = 'Z04763221QPB6CZ9R77GM';
process.env.CROSS_ACCOUNT_ROLE_ARN = 'arn:aws:iam::711387127421:role/Route53DnsValidationRole';

// --- Now safe to import modules ---
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { Project } from '../../../../lib/config/projects';
import {
    KubernetesProjectFactory,
    KubernetesFactoryContext,
} from '../../../../lib/projects/kubernetes';

/**
 * Helper to create a typed factory context
 */
function createFactoryContext(
    overrides?: Partial<KubernetesFactoryContext>
): KubernetesFactoryContext {
    return {
        environment: Environment.DEVELOPMENT,
        ...overrides,
    };
}

describe('KubernetesProjectFactory', () => {
    describe('Factory Properties', () => {
        it('should have correct project type', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            expect(factory.project).toBe(Project.K8S);
        });

        it('should have correct environment', () => {
            const factory = new KubernetesProjectFactory(Environment.STAGING);
            expect(factory.environment).toBe(Environment.STAGING);
        });

        it('should have correct namespace', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            expect(factory.namespace).toBe('Monitoring-K8s');
        });
    });

    describe('createAllStacks', () => {
        let app: cdk.App;

        beforeEach(() => {
            app = new cdk.App();
        });

        it('should create 4 stacks: Data, Compute, API, and Edge', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // Shared k3s project has 4 stacks: Data, Compute, API, Edge
            expect(stacks).toHaveLength(4);
            expect(stackMap).toHaveProperty('data');
            expect(stackMap).toHaveProperty('compute');
            expect(stackMap).toHaveProperty('api');
            expect(stackMap).toHaveProperty('edge');
        });

        it('should order stacks as Data → Compute → API → Edge', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            expect(stackNames[0]).toContain('Data');
            expect(stackNames[1]).toContain('Compute');
            expect(stackNames[2]).toContain('Api');
            expect(stackNames[3]).toContain('Edge');
        });

        it('should name stacks correctly with namespace and environment', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map((s: cdk.Stack) => s.stackName);
            expect(stackNames.some((name: string) => name.includes('K8s'))).toBe(true);
            expect(stackNames.some((name: string) => name.includes('development'))).toBe(true);
        });

        it('should deploy Edge stack in us-east-1', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);

            expect(stackMap.edge.region).toBe('us-east-1');
        });

        it('should deploy Data, Compute, and API stacks in primary region', () => {
            const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);

            expect(stackMap.data.region).toBe('eu-west-1');
            expect(stackMap.compute.region).toBe('eu-west-1');
            expect(stackMap.api.region).toBe('eu-west-1');
        });

        it('should create different stack names for different environments', () => {
            const devFactory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
            const prodFactory = new KubernetesProjectFactory(Environment.PRODUCTION);

            const devApp = new cdk.App();
            const devContext = createFactoryContext();
            const { stacks: devStacks } = devFactory.createAllStacks(devApp, devContext);

            const prodApp = new cdk.App();
            const prodContext = createFactoryContext({
                environment: Environment.PRODUCTION,
                verificationSecret: 'test-prod-secret',
            });
            const { stacks: prodStacks } = prodFactory.createAllStacks(prodApp, prodContext);

            expect(devStacks[0].stackName).toContain('development');
            expect(prodStacks[0].stackName).toContain('production');
        });
    });
});
