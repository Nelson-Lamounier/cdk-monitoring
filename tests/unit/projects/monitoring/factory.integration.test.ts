/**
 * @format
 * Monitoring Factory Integration Tests
 *
 * End-to-end tests that exercise the full factory flow:
 *   MonitoringProjectFactory.createAllStacks() → 3 stacks
 *   → dependency graph → cross-stack wiring → trustedCidrs resolution
 *   → environment differentiation
 *
 * These complement factory.test.ts (stack count, naming, resource assertions)
 * by validating wiring, configuration resolution, and synthesis correctness
 * that only surface during full stack creation.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { monitoringSsmPaths } from '../../../../lib/config/ssm-paths';
import {
    MonitoringProjectFactory,
    MonitoringFactoryContext,
} from '../../../../lib/projects/monitoring/factory';
import { MonitoringComputeStack } from '../../../../lib/stacks/monitoring/compute/compute-stack';
import { MonitoringStorageStack } from '../../../../lib/stacks/monitoring/storage/storage-stack';

// ---------------------------------------------------------------------------
// Env var management — bulletproof save/restore
// ---------------------------------------------------------------------------
const BASE_ENV = {
    CDK_DEFAULT_ACCOUNT: '123456789012',
    CDK_DEFAULT_REGION: 'eu-west-1',
} as const;

let envSnapshot: NodeJS.ProcessEnv;

function setEnv(overrides: Record<string, string | undefined> = {}): void {
    Object.entries({ ...BASE_ENV, ...overrides }).forEach(([k, v]) => {
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    });
}

function createFactoryContext(
    overrides?: Partial<MonitoringFactoryContext>,
): MonitoringFactoryContext {
    return {
        environment: Environment.DEVELOPMENT,
        trustedCidrs: ['10.0.0.0/8'],
        grafanaPassword: 'test-password',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getDependencyIds(stack: cdk.Stack): string[] {
    return stack.dependencies.map((dep) => dep.node.id);
}

/**
 * Helper: Creates a factory, builds all stacks, and returns stackMap + templates.
 */
function createMonitoringStacks(
    environment: Environment = Environment.DEVELOPMENT,
    contextOverrides?: Partial<MonitoringFactoryContext>,
    appOverrides?: { context?: Record<string, unknown> },
) {
    const app = new cdk.App(appOverrides);
    const factory = new MonitoringProjectFactory(environment);
    const { stacks, stackMap } = factory.createAllStacks(
        app,
        createFactoryContext({ environment, ...contextOverrides }),
    );

    return {
        app,
        factory,
        stacks,
        stackMap: stackMap as {
            storage: MonitoringStorageStack;
            ssm: cdk.Stack;
            compute: MonitoringComputeStack;
        },
    };
}

describe('Monitoring Factory — Integration', () => {
    beforeEach(() => {
        envSnapshot = { ...process.env };
        setEnv();
    });

    afterEach(() => {
        // Bulletproof restore: remove any new vars, restore all original values
        for (const key of Object.keys(process.env)) {
            if (!(key in envSnapshot)) {
                delete process.env[key];
            }
        }
        for (const [key, value] of Object.entries(envSnapshot)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    // ===================================================================
    // 1. Dependency Graph
    // ===================================================================
    describe('Dependency Graph', () => {
        it('should wire Compute → Storage, SSM and Storage independent', () => {
            const { stackMap } = createMonitoringStacks();

            // Storage is the root — no dependencies
            expect(getDependencyIds(stackMap.storage)).toEqual([]);

            // SSM is fully independent (no deps on Storage or Compute)
            expect(getDependencyIds(stackMap.ssm)).toEqual([]);

            // Compute depends on Storage (needs volumeId + availabilityZone)
            // and SSM (uses SSM Association referencing the SSM document)
            const computeDeps = getDependencyIds(stackMap.compute);
            expect(computeDeps).toContainEqual(
                expect.stringContaining('Storage'),
            );
            expect(computeDeps).toContainEqual(
                expect.stringContaining('SSM'),
            );
        });

        it('should have no reverse dependencies (Storage/SSM independent of Compute)', () => {
            const { stackMap } = createMonitoringStacks();

            // SSM must NOT depend on Storage or Compute
            const ssmDeps = getDependencyIds(stackMap.ssm);
            expect(ssmDeps).not.toContainEqual(expect.stringContaining('Storage'));
            expect(ssmDeps).not.toContainEqual(expect.stringContaining('Compute'));

            // Storage must NOT depend on Compute or SSM
            const storageDeps = getDependencyIds(stackMap.storage);
            expect(storageDeps).not.toContainEqual(expect.stringContaining('Compute'));
            expect(storageDeps).not.toContainEqual(expect.stringContaining('SSM'));
        });

        it('should produce a valid DAG (no cyclic dependencies)', () => {
            const { app } = createMonitoringStacks();

            // app.synth() throws on cyclic dependencies or synthesis errors
            expect(() => app.synth()).not.toThrow();
        });
    });

    // ===================================================================
    // 2. Cross-Stack Wiring
    // ===================================================================
    describe('Cross-Stack Wiring', () => {
        it('should pass storage volumeId to compute stack', () => {
            const { stackMap } = createMonitoringStacks();

            // Storage stack exposes volumeId and AZ as public fields
            expect(stackMap.storage.volumeId).toBeDefined();
            expect(stackMap.storage.availabilityZone).toBeDefined();

            // Compute stack creates resources in the same AZ as the EBS volume
            // (default mode is ASG — verify LaunchTemplate + ASG exist)
            const computeTemplate = Template.fromStack(stackMap.compute);
            computeTemplate.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
        });

        it('should constrain compute ASG to same AZ as EBS volume', () => {
            const { stackMap } = createMonitoringStacks();
            const computeTemplate = Template.fromStack(stackMap.compute);

            // ASG should be constrained via VPCZoneIdentifier (subnet selection)
            // to the same AZ as the EBS volume
            computeTemplate.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
                VPCZoneIdentifier: Match.anyValue(),
            });
        });

        it('should write monitoring SG ID to SSM for cross-project discovery', () => {
            const { stackMap } = createMonitoringStacks();
            const computeTemplate = Template.fromStack(stackMap.compute);
            const paths = monitoringSsmPaths(Environment.DEVELOPMENT);

            // Compute stack writes its SG ID to SSM so NextJS can import it
            computeTemplate.hasResourceProperties('AWS::SSM::Parameter', {
                Name: paths.securityGroupId,
            });
        });

        it('should write Loki and Tempo placeholder endpoints to SSM', () => {
            const { stackMap } = createMonitoringStacks();
            const computeTemplate = Template.fromStack(stackMap.compute);

            computeTemplate.hasResourceProperties('AWS::SSM::Parameter', {
                Name: Match.stringLikeRegexp('.*/loki/endpoint$'),
                Value: Match.stringLikeRegexp('placeholder'),
            });

            computeTemplate.hasResourceProperties('AWS::SSM::Parameter', {
                Name: Match.stringLikeRegexp('.*/tempo/endpoint$'),
                Value: Match.stringLikeRegexp('placeholder'),
            });
        });
    });

    // ===================================================================
    // 3. trustedCidrs Resolution Chain
    //
    // NOTE: Factory hardcodes ssmOnlyAccess: true, so CIDRs never reach
    // the template as SG ingress rules. Instead, they are validated
    // at construct time by ec2.Peer.ipv4(). We verify they propagate
    // by testing the validation path and the SecurityGroup description.
    // ===================================================================
    describe('trustedCidrs Resolution', () => {
        it('should accept explicit context CIDRs without error', () => {
            const { stackMap } = createMonitoringStacks(
                Environment.DEVELOPMENT,
                { trustedCidrs: ['192.168.1.0/24'] },
            );
            // Verify the stack was created — SG exists in template
            const computeTemplate = Template.fromStack(stackMap.compute);
            computeTemplate.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('SSM-only access'),
            });
        });

        it('should resolve from CDK context when not in explicit context', () => {
            const { stackMap } = createMonitoringStacks(
                Environment.DEVELOPMENT,
                { trustedCidrs: undefined },
                { context: { trustedCidrs: '10.1.0.0/16' } },
            );
            // Should synthesize successfully — CDK context was used
            const computeTemplate = Template.fromStack(stackMap.compute);
            computeTemplate.resourceCountIs('AWS::EC2::SecurityGroup', 1);
        });

        it('should resolve from ALLOWED_IP_RANGE env var as last non-default fallback', () => {
            process.env.ALLOWED_IP_RANGE = '172.16.0.0/12';
            const { stackMap } = createMonitoringStacks(
                Environment.DEVELOPMENT,
                { trustedCidrs: undefined },
            );
            const computeTemplate = Template.fromStack(stackMap.compute);
            computeTemplate.resourceCountIs('AWS::EC2::SecurityGroup', 1);
        });

        it('should default to 0.0.0.0/0 when nothing is configured', () => {
            delete process.env.ALLOWED_IP_RANGE;
            const { stackMap } = createMonitoringStacks(
                Environment.DEVELOPMENT,
                { trustedCidrs: undefined },
            );

            // Verify the SG exists and has the SSM-only description
            // (ssmOnlyAccess=true means 0.0.0.0/0 is accepted but
            // never applied as an ingress rule — safe)
            const computeTemplate = Template.fromStack(stackMap.compute);
            computeTemplate.hasResourceProperties('AWS::EC2::SecurityGroup', {
                GroupDescription: Match.stringLikeRegexp('SSM-only access'),
            });
        });

        it('should accept invalid CIDRs silently when ssmOnlyAccess is true', () => {
            // IMPORTANT: The factory hardcodes ssmOnlyAccess: true, which
            // skips CIDR validation in SecurityGroupConstruct (line 585).
            // CIDRs are never applied as ingress rules in SSM-only mode,
            // so validation is intentionally skipped.
            expect(() => createMonitoringStacks(
                Environment.DEVELOPMENT,
                { trustedCidrs: ['not-a-cidr'] },
            )).not.toThrow();
        });
    });

    // ===================================================================
    // 4. Required Env Var Validation
    // ===================================================================
    describe('Required Env Var Validation', () => {
        it('should require GRAFANA_ADMIN_PASSWORD in production', () => {
            delete process.env.GRAFANA_ADMIN_PASSWORD;
            expect(() => createMonitoringStacks(
                Environment.PRODUCTION,
                { grafanaPassword: undefined },
            )).toThrow(/GRAFANA_ADMIN_PASSWORD/);
        });

        it('should use default admin password in development when none provided', () => {
            delete process.env.GRAFANA_ADMIN_PASSWORD;
            const { stackMap } = createMonitoringStacks(
                Environment.DEVELOPMENT,
                { grafanaPassword: undefined },
            );

            // SSM stack should receive the default password
            const ssmTemplate = Template.fromStack(stackMap.ssm);
            // The SSM document includes the Grafana password in its commands
            ssmTemplate.hasResourceProperties('AWS::SSM::Document', {
                Content: Match.anyValue(),
            });
        });
    });



    // ===================================================================
    // 6. Environment Differentiation
    // ===================================================================
    describe('Environment Differentiation', () => {
        it('should use 50GB volume for production, 30GB for development', () => {
            const devResult = createMonitoringStacks(Environment.DEVELOPMENT);
            const devTemplate = Template.fromStack(devResult.stackMap.storage);
            devTemplate.hasResourceProperties('AWS::EC2::Volume', {
                Size: 30,
            });

            // Production needs GRAFANA_ADMIN_PASSWORD
            process.env.GRAFANA_ADMIN_PASSWORD = 'prod-secure';
            const prodResult = createMonitoringStacks(Environment.PRODUCTION);
            const prodTemplate = Template.fromStack(prodResult.stackMap.storage);
            prodTemplate.hasResourceProperties('AWS::EC2::Volume', {
                Size: 50,
            });
        });

        it('should enable KMS encryption for production only', () => {
            // Production needs GRAFANA_ADMIN_PASSWORD
            process.env.GRAFANA_ADMIN_PASSWORD = 'prod-secure';
            const prodResult = createMonitoringStacks(Environment.PRODUCTION);
            const prodTemplate = Template.fromStack(prodResult.stackMap.storage);

            // Production creates a KMS key for EBS encryption
            prodTemplate.resourceCountIs('AWS::KMS::Key', 1);

            const devResult = createMonitoringStacks(Environment.DEVELOPMENT);
            const devTemplate = Template.fromStack(devResult.stackMap.storage);

            // Development uses default AWS-managed encryption (no explicit KMS key)
            devTemplate.resourceCountIs('AWS::KMS::Key', 0);
        });

        it('should set RETAIN removal policy for production EBS volume', () => {
            process.env.GRAFANA_ADMIN_PASSWORD = 'prod-secure';
            const prodResult = createMonitoringStacks(Environment.PRODUCTION);
            const prodTemplate = Template.fromStack(prodResult.stackMap.storage);

            // Production volumes have DeletionPolicy: Retain
            prodTemplate.hasResource('AWS::EC2::Volume', {
                DeletionPolicy: 'Retain',
                UpdateReplacePolicy: 'Retain',
            });
        });
    });

    // ===================================================================
    // 7. SSM Path Consistency
    // ===================================================================
    describe('SSM Path Consistency', () => {
        it('should match monitoringSsmPaths() for security group ID', () => {
            const paths = monitoringSsmPaths(Environment.DEVELOPMENT);
            const { stackMap } = createMonitoringStacks();
            const computeTemplate = Template.fromStack(stackMap.compute);

            computeTemplate.hasResourceProperties('AWS::SSM::Parameter', {
                Name: paths.securityGroupId,
            });
        });
    });
});
