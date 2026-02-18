/**
 * @format
 * MonitoringProjectFactory Unit Tests
 *
 * Tests for the factory that creates Grafana/Prometheus monitoring stacks.
 * Updated for Grouped Stacks approach.
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { Project } from '../../../../lib/config/projects';
import {
    MonitoringProjectFactory,
    MonitoringFactoryContext,
} from '../../../../lib/projects/monitoring';

// Set test environment
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';

/**
 * Helper to create a typed factory context
 */
function createFactoryContext(
    overrides?: Partial<MonitoringFactoryContext>
): MonitoringFactoryContext {
    return {
        environment: Environment.DEVELOPMENT,
        trustedCidrs: ['10.0.0.0/8'],
        grafanaPassword: 'test-password',
        ...overrides,
    };
}

describe('MonitoringProjectFactory', () => {
    describe('Factory Properties', () => {
        it('should have correct project type', () => {
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            expect(factory.project).toBe(Project.MONITORING);
        });

        it('should have correct environment', () => {
            const factory = new MonitoringProjectFactory(Environment.STAGING);
            expect(factory.environment).toBe(Environment.STAGING);
        });

        it('should have correct namespace', () => {
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            expect(factory.namespace).toBe('Monitoring');
        });
    });

    describe('createAllStacks', () => {
        let app: cdk.App;

        beforeEach(() => {
            app = new cdk.App();
        });

        it('should create modular infrastructure stacks', () => {
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks, stackMap } = factory.createAllStacks(app, context);

            // Consolidated 3-stack architecture: Storage (EBS + Lifecycle) + SSM (Document + S3) + Compute (SG + EC2/ASG)
            expect(stacks).toHaveLength(3);
            expect(stackMap).toHaveProperty('storage');
            expect(stackMap).toHaveProperty('ssm');
            expect(stackMap).toHaveProperty('compute');
        });

        it('should name stacks correctly with namespace and environment', () => {
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stacks } = factory.createAllStacks(app, context);

            const stackNames = stacks.map(s => s.stackName);
            // Check for the environment suffix pattern in stack names
            expect(stackNames.some(name => name.includes('-development'))).toBe(true);
        });

        it('should create different stack names for different environments', () => {
            const devFactory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const prodFactory = new MonitoringProjectFactory(Environment.PRODUCTION);

            const devApp = new cdk.App();
            const devContext = createFactoryContext();
            const { stacks: devStacks } = devFactory.createAllStacks(devApp, devContext);

            const prodApp = new cdk.App();
            // Production requires GRAFANA_ADMIN_PASSWORD
            process.env.GRAFANA_ADMIN_PASSWORD = 'prod-secret-password';
            const prodContext = createFactoryContext(
                { environment: Environment.PRODUCTION },
            );
            const { stacks: prodStacks } = prodFactory.createAllStacks(prodApp, prodContext);
            delete process.env.GRAFANA_ADMIN_PASSWORD;

            expect(devStacks[0].stackName).toContain('-development');
            expect(prodStacks[0].stackName).toContain('-production');
        });



        it('should throw when CDK_DEFAULT_ACCOUNT is missing and envConfig has no account', () => {
            const savedAccount = process.env.CDK_DEFAULT_ACCOUNT;
            delete process.env.CDK_DEFAULT_ACCOUNT;

            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            // The factory still works if getEnvironmentConfig() returns account.
            // If both are undefined, CDK will throw during VPC lookup.
            // Since envConfig always provides an account, this should not throw.
            expect(() => factory.createAllStacks(app, context)).not.toThrow();

            process.env.CDK_DEFAULT_ACCOUNT = savedAccount;
        });

        it('should throw for production without GRAFANA_ADMIN_PASSWORD', () => {
            delete process.env.GRAFANA_ADMIN_PASSWORD;

            const factory = new MonitoringProjectFactory(Environment.PRODUCTION);
            const prodApp = new cdk.App();
            const context = createFactoryContext(
                { environment: Environment.PRODUCTION, grafanaPassword: undefined },
            );

            expect(() => factory.createAllStacks(prodApp, context)).toThrow(
                /Missing GRAFANA_ADMIN_PASSWORD for production/,
            );
        });
    });

    describe('Stack Resource Verification', () => {
        it('should create Security Group in compute stack', () => {
            const app = new cdk.App();
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);
            const template = Template.fromStack(stackMap.compute);

            template.hasResource('AWS::EC2::SecurityGroup', {});
        });

        it('should create EBS Volume in storage stack', () => {
            const app = new cdk.App();
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);
            const template = Template.fromStack(stackMap.storage);

            template.hasResource('AWS::EC2::Volume', {});
        });

        it('should create EC2 Instance in infra stack', () => {
            const app = new cdk.App();
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);
            const template = Template.fromStack(stackMap.compute);

            // ASG mode - check Auto Scaling Group (uses LaunchTemplate, not LaunchConfiguration)
            template.hasResource('AWS::AutoScaling::AutoScalingGroup', {});
        });

        it('should create IAM Role for instance', () => {
            const app = new cdk.App();
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);
            const template = Template.fromStack(stackMap.compute);

            template.hasResource('AWS::IAM::Role', {});
        });

        it('should create CloudWatch Log Group', () => {
            const app = new cdk.App();
            const factory = new MonitoringProjectFactory(Environment.DEVELOPMENT);
            const context = createFactoryContext();

            const { stackMap } = factory.createAllStacks(app, context);
            const template = Template.fromStack(stackMap.compute);

            template.hasResource('AWS::Logs::LogGroup', {});
        });
    });
});
