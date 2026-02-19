/**
 * @format
 * NextJS Factory Integration Tests
 *
 * End-to-end tests that exercise the full factory flow:
 *   ConsolidatedNextJSFactory.createAllStacks() → 6 stacks
 *   → inter-stack dependencies → SSM path consistency
 *   → required env var validation
 *
 * These complement the existing factory.test.ts (which covers stack count,
 * naming, and cycle detection) by validating the dependency DAG and
 * configuration wiring that only surface at synthesis time.
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { nextjsSsmPaths, monitoringSsmPaths } from '../../../../lib/config/ssm-paths';
import { ConsolidatedNextJSFactory } from '../../../../lib/projects/nextjs/factory';

// ---------------------------------------------------------------------------
// CDK environment defaults (required for VPC lookup)
// ---------------------------------------------------------------------------
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'eu-west-1';

/**
 * Default context overrides for test factory invocations.
 * The factory reads edge config and email config from context overrides
 * (bridged from env vars in app.ts) or typed config files.
 */
const TEST_CONTEXT = {
    environment: Environment.DEVELOPMENT as const,
    // Edge config
    domainName: 'dev.example.com',
    hostedZoneId: 'Z1234567890ABC',
    crossAccountRoleArn: 'arn:aws:iam::111111111111:role/Route53Role',
    // Email config
    notificationEmail: 'test@example.com',
    sesFromEmail: 'noreply@example.com',
    verificationBaseUrl: 'https://dev.example.com',
    verificationSecret: 'test-secret-for-unit-tests',
};

function createFactoryApp(): cdk.App {
    return new cdk.App();
}

function createFactory(contextOverrides?: Partial<typeof TEST_CONTEXT>): {
    app: cdk.App;
    factory: ConsolidatedNextJSFactory;
    result: ReturnType<ConsolidatedNextJSFactory['createAllStacks']>;
} {
    const app = createFactoryApp();
    const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);
    const result = factory.createAllStacks(app, {
        ...TEST_CONTEXT,
        ...contextOverrides,
    });
    return { app, factory, result };
}

// ---------------------------------------------------------------------------
// Get the dependency stack IDs for a given stack.
// CDK stores dependencies as Stack objects; we extract the node.id.
// ---------------------------------------------------------------------------
function getDependencyIds(stack: cdk.Stack): string[] {
    return stack.dependencies.map((dep) => dep.node.id);
}

describe('NextJS Factory — Integration', () => {
    // No beforeEach/afterEach needed — we pass config via context overrides,
    // not process.env mutations.

    // ===================================================================
    // 1. Dependency Graph
    // ===================================================================
    describe('Dependency Graph', () => {
        it('should have correct inter-stack dependencies', () => {
            const { result } = createFactory();
            const { stackMap } = result;

            // Data has no dependencies (root stack)
            expect(getDependencyIds(stackMap.data)).toEqual([]);

            // Compute depends on Data
            expect(getDependencyIds(stackMap.compute)).toContainEqual(
                expect.stringContaining('Data'),
            );

            // Networking has no explicit dependency on Data or Compute
            // (it runs in parallel with Compute)
            expect(getDependencyIds(stackMap.networking)).toEqual([]);

            // Application depends on Data, Compute, and Networking
            const appDeps = getDependencyIds(stackMap.application);
            expect(appDeps).toContainEqual(expect.stringContaining('Data'));
            expect(appDeps).toContainEqual(expect.stringContaining('Compute'));
            expect(appDeps).toContainEqual(expect.stringContaining('Networking'));

            // Api depends on Data
            expect(getDependencyIds(stackMap.api)).toContainEqual(
                expect.stringContaining('Data'),
            );

            // Edge depends on Networking, Data, and Api
            const edgeDeps = getDependencyIds(stackMap.edge);
            expect(edgeDeps).toContainEqual(expect.stringContaining('Networking'));
            expect(edgeDeps).toContainEqual(expect.stringContaining('Data'));
            expect(edgeDeps).toContainEqual(expect.stringContaining('Api'));
        });

        it('should produce a valid DAG (no cyclic dependencies)', () => {
            const { app } = createFactory();
            expect(() => app.synth()).not.toThrow();
        });
    });

    // ===================================================================
    // 2. SSM Path Consistency
    // ===================================================================
    describe('SSM Path Consistency', () => {
        it('should use consistent SSM prefix across all stacks', () => {
            const paths = nextjsSsmPaths(Environment.DEVELOPMENT);

            // All paths should share the same prefix
            const prefix = paths.prefix; // /nextjs/development
            expect(paths.dynamodbTableName).toMatch(new RegExp(`^${prefix}/`));
            expect(paths.assetsBucketName).toMatch(new RegExp(`^${prefix}/`));
            expect(paths.albDnsName).toMatch(new RegExp(`^${prefix}/`));
            expect(paths.ecs.clusterName).toMatch(new RegExp(`^${prefix}/`));
            expect(paths.ecs.serviceName).toMatch(new RegExp(`^${prefix}/`));
            expect(paths.wildcard).toBe(`${prefix}/*`);
        });

        it('should wire monitoring SSM paths for cross-project discovery', () => {
            const monitoringPaths = monitoringSsmPaths(Environment.DEVELOPMENT);

            // The NextJS factory passes monitoringSsm.securityGroupId to
            // Compute and Networking stacks for Prometheus SG ingress
            expect(monitoringPaths.securityGroupId).toBe(
                '/monitoring-development/security-group/id',
            );
            // Loki endpoint used by Application stack for Promtail
            expect(monitoringPaths.lokiEndpoint).toBe('/monitoring-development/loki/endpoint');
        });
    });

    // ===================================================================
    // 3. Soft Config Validation (via context overrides)
    //
    // Factory uses CDK warnings (not throws) for missing config.
    // This allows stacks to synth without env vars they don't need,
    // enabling least-privilege secret scoping in the pipeline.
    // ===================================================================
    describe('Soft Config Validation', () => {
        it('should NOT throw when notificationEmail is missing (soft warning)', () => {
            expect(() => createFactory({ notificationEmail: undefined })).not.toThrow();
        });

        it('should NOT throw when sesFromEmail is missing (soft warning)', () => {
            expect(() => createFactory({ sesFromEmail: undefined })).not.toThrow();
        });

        it('should NOT throw when verificationSecret is missing (soft warning)', () => {
            expect(() => createFactory({ verificationSecret: undefined })).not.toThrow();
        });

        /**
         * Regression test: VERIFICATION_BASE_URL is consumed by the API
         * Lambda as an optional field. The factory must NOT throw for it.
         */
        it('should NOT throw when verificationBaseUrl is missing', () => {
            expect(() => createFactory({ verificationBaseUrl: undefined })).not.toThrow();
        });

        it('should NOT throw when edge config is incomplete (soft warning)', () => {
            expect(() => createFactory({
                domainName: undefined,
                hostedZoneId: undefined,
                crossAccountRoleArn: undefined,
            })).not.toThrow();
        });
    });
});
