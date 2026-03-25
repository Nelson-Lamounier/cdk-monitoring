/**
 * @format
 * Golden AMI Build Component — Unit Test
 *
 * Static analysis of the generated Image Builder component YAML.
 * Catches anti-patterns that caused production incidents (e.g. the
 * `alternatives --set python3` bug that broke cloud-init).
 *
 * These tests run locally with no AWS calls — they generate the
 * component YAML via `buildGoldenAmiComponent()` and assert against
 * its string content.
 *
 * @example
 *   yarn jest tests/unit/constructs/compute/build-golden-ami-component.test.ts
 */

import { buildGoldenAmiComponent } from '../../../../lib/constructs/compute/utils/build-golden-ami-component';
import { getK8sConfigs } from '../../../../lib/config/kubernetes';
import { Environment } from '../../../../lib/config/environments';

// =============================================================================
// Configuration (config-driven — no hardcoded versions)
// =============================================================================

const CONFIGS = getK8sConfigs(Environment.DEVELOPMENT);

// =============================================================================
// Shared State
// =============================================================================

let componentYaml: string;

// =============================================================================
// Test Suite
// =============================================================================

describe('buildGoldenAmiComponent — Anti-Pattern Detection', () => {
    beforeAll(() => {
        componentYaml = buildGoldenAmiComponent({
            imageConfig: CONFIGS.image,
            clusterConfig: CONFIGS.cluster,
        });
    });

    // =========================================================================
    // Critical: System Python Integrity
    // =========================================================================
    describe('System Python Integrity', () => {
        it('should NOT execute alternatives --set python3 (breaks cloud-init)', () => {
            const lines = componentYaml.split('\n');
            const executableAlternativesLines = lines.filter(
                (line) => {
                    const trimmed = line.trim();
                    return trimmed.includes('alternatives --set python3') && !trimmed.startsWith('#');
                },
            );
            expect(executableAlternativesLines).toHaveLength(0);
        });

        it('should NOT use alternatives --install for python3', () => {
            expect(componentYaml).not.toContain('alternatives --install /usr/bin/python3');
        });

        it('should verify system python3 is preserved in the validate phase', () => {
            expect(componentYaml).toContain('SYS_PY_VERSION');
        });
    });

    // =========================================================================
    // Critical: Virtualenv at /opt/k8s-venv
    // =========================================================================
    describe('Virtualenv Setup', () => {
        it('should create a virtualenv at /opt/k8s-venv with Python 3.11', () => {
            expect(componentYaml).toContain('python3.11 -m venv /opt/k8s-venv');
        });

        it('should install pip packages into the virtualenv (not system pip)', () => {
            expect(componentYaml).toContain('/opt/k8s-venv/bin/pip install');
        });

        it('should NOT install packages via bare pip3 (would use system Python)', () => {
            // Match "pip3 install" that is NOT preceded by /opt/k8s-venv/bin/
            const lines = componentYaml.split('\n');
            const barePipLines = lines.filter(
                (line) => line.includes('pip3 install') && !line.includes('/opt/k8s-venv/bin/pip'),
            );
            expect(barePipLines).toHaveLength(0);
        });

        it('should validate venv Python packages via /opt/k8s-venv/bin/python3', () => {
            expect(componentYaml).toContain('/opt/k8s-venv/bin/python3 -c');
        });
    });

    // =========================================================================
    // Validate Phase Completeness
    // =========================================================================
    describe('Validate Phase', () => {
        it('should validate cloud-init is functional', () => {
            expect(componentYaml).toContain('cloud-init status');
        });

        it('should functionally test cfn-signal (not just binary existence)', () => {
            expect(componentYaml).toContain('cfn-signal --version');
        });

        it('should check cfn-signal binary exists', () => {
            expect(componentYaml).toContain('test -f /opt/aws/bin/cfn-signal');
        });

        it('should validate boto3 is importable from venv', () => {
            expect(componentYaml).toContain("import boto3");
        });

        it('should validate kubernetes client is importable from venv', () => {
            expect(componentYaml).toContain("import kubernetes");
        });

        it('should validate bcrypt is importable from venv', () => {
            expect(componentYaml).toContain("import bcrypt");
        });
    });

    // =========================================================================
    // Component YAML Structure
    // =========================================================================
    describe('Component YAML Structure', () => {
        it('should be valid YAML with required phases', () => {
            expect(componentYaml).toContain('name: build');
            expect(componentYaml).toContain('name: validate');
        });

        it('should contain the correct Kubernetes version from config', () => {
            expect(componentYaml).toContain(CONFIGS.cluster.kubernetesVersion);
        });

        it('should contain the correct Calico version from config', () => {
            expect(componentYaml).toContain(CONFIGS.image.bakedVersions.calico);
        });

        it('should generate non-empty component YAML', () => {
            expect(componentYaml.length).toBeGreaterThan(1000);
        });
    });
});
