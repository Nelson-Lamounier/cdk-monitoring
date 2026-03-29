/**
 * @format
 * Kubernetes BlueGreen Deployment — Integration Test
 *
 * Verifies the Kubernetes state-machine for Argo Rollouts BlueGreen deployments.
 * Triggers a dummy rollout and ensures that during the transition window,
 * the active service routes to the stable pod, and the preview service
 * routes to the new pod.
 *
 * Uses strictly standard `kubectl` commands. No dependencies on the
 * `kubectl argo rollouts` CLI plugin.
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 */

import { execSync } from 'child_process';

import type { DeployableEnvironment } from '../../../lib/config';
import { Environment } from '../../../lib/config';

// =============================================================================
// Environment Parsing
// =============================================================================

function parseEnvironment(raw: string): DeployableEnvironment {
    const valid = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION] as const satisfies readonly DeployableEnvironment[];
    if (!valid.includes(raw as DeployableEnvironment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as DeployableEnvironment;
}

const _CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
const NAMESPACE = 'nextjs-app';
const ROLLOUT_NAME = 'nextjs';

// =============================================================================
// Helper Functions
// =============================================================================

function verifyKubectlConnectivity(): void {
    try {
        execSync('kubectl cluster-info', { stdio: 'ignore', timeout: 5000 });
    } catch {
        throw new Error(
            'Kubernetes API connection refused. ' +
            'Ensure you have an active SSM tunnel running: just k8s-tunnel-auto development'
        );
    }
}

// Verify before anything runs
verifyKubectlConnectivity();

function runKubectl(command: string): string {
    return execSync(`kubectl ${command} -n ${NAMESPACE}`, { encoding: 'utf-8' }).trim();
}

/**
 * Returns the active ReplicaSet hash from a Service selector.
 */
function getServiceSelectorHash(serviceName: string): string {
    const rawJson = runKubectl(`get service ${serviceName} -o json`);
    const service = JSON.parse(rawJson);
    const hash = service?.spec?.selector?.['rollouts-pod-template-hash'];
    if (!hash) {
        throw new Error(
            `Could not determine selector hash for service ${serviceName}. ` +
            `Current selector: ${JSON.stringify(service?.spec?.selector)}`
        );
    }
    return hash;
}

/**
 * Wait for a specific condition to be met by polling.
 */
async function waitForCondition(
    conditionFn: () => boolean,
    timeoutMs: number = 60000,
    intervalMs: number = 2000,
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (conditionFn()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Argo Rollouts BlueGreen Transition', () => {
    let stableReplicaSetHash: string;
    let previewReplicaSetHash: string;

    // Timeout extended to handle Pod scheduling during rollout
    jest.setTimeout(120000);

    // =========================================================================
    // Hooks (Initial State, Trigger, Cleanup)
    // =========================================================================

    beforeAll(async () => {
        // 1. Initial State Discovery
        // In steady state (Healthy), the service may not have the hash injected. 
        // We get the current stable hash directly from the Rollout status.
        stableReplicaSetHash = runKubectl(`get rollout ${ROLLOUT_NAME} -o jsonpath="{.status.blueGreen.activeSelector}"`);
        expect(stableReplicaSetHash).toBeTruthy();
        console.log(`Initial Stable ReplicaSet Hash: ${stableReplicaSetHash}`);

        const initialPhase = runKubectl(`get rollout ${ROLLOUT_NAME} -o jsonpath='{.status.phase}'`);
        expect(initialPhase).toBe('Healthy');

        // 2. Trigger Dummy Rollout
        const patchTrigger = `integration-test-${Date.now()}`;
        const patchJson = JSON.stringify({
            spec: {
                template: {
                    metadata: {
                        annotations: {
                            'bluegreen.test/trigger': patchTrigger,
                        },
                    },
                },
            },
        });

        runKubectl(`patch rollout ${ROLLOUT_NAME} --type=merge -p '${patchJson}'`);

        // Wait for the rollout to enter Progressing phase
        await waitForCondition(() => {
            const phase = runKubectl(`get rollout ${ROLLOUT_NAME} -o jsonpath='{.status.phase}'`);
            return phase === 'Progressing';
        }, 30000);

        // Extract the new ReplicaSet hash (safe from ESLint no-conditional-in-test because it's in beforeAll)
        await waitForCondition(() => {
            const newHash = runKubectl(`get rollout ${ROLLOUT_NAME} -o jsonpath='{.status.blueGreen.previewSelector}'`);
            return Boolean(newHash) && newHash !== stableReplicaSetHash;
        }, 30000);

        previewReplicaSetHash = runKubectl(`get rollout ${ROLLOUT_NAME} -o jsonpath='{.status.blueGreen.previewSelector}'`);
        console.log(`New Preview ReplicaSet Hash: ${previewReplicaSetHash}`);
        
        // Ensure the preview pod becomes ready
        await waitForCondition(() => {
            const pods = runKubectl(`get pods -l rollouts-pod-template-hash=${previewReplicaSetHash} -o jsonpath='{.items[*].status.phase}'`);
            return pods.includes('Running');
        }, 60000);
    });

    afterAll(async () => {
        console.log('Aborting dummy rollout and restoring original state...');
        try {
            const patchJson = '[{"op": "remove", "path": "/spec/template/metadata/annotations/bluegreen.test~1trigger"}]';
            runKubectl(`patch rollout ${ROLLOUT_NAME} --type=json -p '${patchJson}'`);

            await waitForCondition(() => {
                const phase = runKubectl(`get rollout ${ROLLOUT_NAME} -o jsonpath='{.status.phase}'`);
                return phase === 'Healthy';
            }, 60000);

            console.log('Cleanup complete. Rollout is Healthy again.');
        } catch (error) {
            console.error('Failed to abort dummy rollout. Manual cleanup may be required.');
            console.error(error);
        }
    });

    // =========================================================================
    // 3. Verify Traffic Routing
    // =========================================================================

    it('should route the active service (nextjs) to the old stable ReplicaSet', () => {
        const activeHash = getServiceSelectorHash('nextjs');
        expect(activeHash).toBe(stableReplicaSetHash);
    });

    it('should route the preview service (nextjs-preview) to the new preview ReplicaSet', () => {
        const previewHash = getServiceSelectorHash('nextjs-preview');
        expect(previewHash).toBe(previewReplicaSetHash);
    });
});
