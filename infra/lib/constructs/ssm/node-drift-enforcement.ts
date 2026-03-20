/**
 * @format
 * Node Drift Enforcement — SSM State Manager Association
 *
 * Continuously enforces critical OS-level Kubernetes prerequisites
 * across all K8s compute nodes. Runs every 30 minutes via State Manager,
 * providing automatic drift remediation for settings that the Golden AMI
 * bakes in but that can be lost after kernel upgrades, reboots, or
 * accidental configuration changes.
 *
 * Enforced settings:
 *   - Kernel modules: overlay, br_netfilter
 *   - Sysctl: net.bridge.bridge-nf-call-iptables, ip6tables, ip_forward
 *   - Services: containerd, kubelet
 *
 * Architecture (Layer 3b of hybrid bootstrap):
 *   - Layer 1: Golden AMI (pre-baked software)
 *   - Layer 2: User Data (EBS attach, cfn-signal — slim trigger)
 *   - Layer 3: SSM Automation (kubeadm bootstrap — one-shot)
 *   - Layer 3b: SSM Association (THIS) — continuous drift enforcement
 *   - Layer 4: Self-Healing Agent (application-level remediation)
 *
 * Design Decision: Targets all K8s nodes by the `project` tag applied
 * by the TaggingAspect (value: 'k8s-platform'). This captures control
 * plane + all worker roles without maintaining a per-stack tag list.
 *
 * Cost: SSM State Manager Associations and Run Command are free-tier.
 * The only indirect cost is CloudWatch Logs ingestion (~KB per execution).
 *
 * @example
 * ```typescript
 * new NodeDriftEnforcementConstruct(this, 'DriftEnforcement', {
 *     prefix: 'k8s',
 *     targetEnvironment: Environment.DEVELOPMENT,
 * });
 * ```
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';

import type { Environment } from '../../config/environments';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Kernel modules required by Kubernetes networking (Calico/iptables).
 * Must be loaded before containerd and kubelet start.
 */
const REQUIRED_KERNEL_MODULES = ['overlay', 'br_netfilter'] as const;

/**
 * Sysctl parameters required by Kubernetes networking.
 * These are volatile (/proc/sys) and can drift after reboots or
 * kernel upgrades if the /etc/sysctl.d/ drop-in is missing/overridden.
 */
const REQUIRED_SYSCTL: Record<string, string> = {
    'net.bridge.bridge-nf-call-iptables': '1',
    'net.bridge.bridge-nf-call-ip6tables': '1',
    'net.ipv4.ip_forward': '1',
};

/**
 * Critical systemd services that must be running for a functional K8s node.
 * If stopped, the association restarts them and logs a warning.
 */
const REQUIRED_SERVICES = ['containerd', 'kubelet'] as const;

/** Association schedule — runs every 30 minutes for drift detection */
const DRIFT_CHECK_SCHEDULE = 'rate(30 minutes)';

/** Tag key used by TaggingAspect to identify K8s project resources */
const K8S_PROJECT_TAG_KEY = 'project';

/** Tag value applied by TaggingAspect to all K8s stacks */
const K8S_PROJECT_TAG_VALUE = 'k8s-platform';

// =============================================================================
// PROPS
// =============================================================================

export interface NodeDriftEnforcementProps {
    /** Environment-aware name prefix (e.g., 'k8s') */
    readonly prefix: string;

    /** Target deployment environment */
    readonly targetEnvironment: Environment;

    /**
     * Schedule expression for the association.
     * @default 'rate(30 minutes)'
     */
    readonly schedule?: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * SSM State Manager Association for OS-level drift enforcement.
 *
 * Creates an SSM Command Document containing an idempotent shell script
 * that validates and remediates kernel modules, sysctl parameters, and
 * critical services on every K8s node. The State Manager Association
 * ensures this script runs on schedule and on new instance registration.
 *
 * ## Why not use the SSM Automation for this?
 *
 * SSM Automation is designed for complex, multi-step, one-shot workflows
 * (e.g., kubeadm init → Calico → ArgoCD). Drift enforcement is a
 * lightweight, repeating concern — State Manager Associations are
 * purpose-built for this pattern.
 *
 * ## Compliance
 *
 * The association reports compliance status in the SSM console:
 * - **Compliant**: All checks passed, no remediation needed
 * - **Non-Compliant**: Remediation was attempted but a service failed
 *
 * @see {@link https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-state-about.html}
 */
export class NodeDriftEnforcementConstruct extends Construct {
    /** The SSM Command Document for drift enforcement */
    public readonly document: ssm.CfnDocument;

    /** The State Manager Association */
    public readonly association: ssm.CfnAssociation;

    constructor(scope: Construct, id: string, props: NodeDriftEnforcementProps) {
        super(scope, id);

        const { prefix, targetEnvironment, schedule } = props;

        // -----------------------------------------------------------------
        // 1. SSM Command Document — Idempotent Drift Enforcement Script
        //
        // Single step that validates + remediates all OS-level K8s
        // prerequisites. Designed to be re-run safely every 30 minutes.
        // -----------------------------------------------------------------
        this.document = new ssm.CfnDocument(this, 'EnforcementDoc', {
            // Auto-generated name — avoids CFn replacement conflicts
            // on content changes (same pattern as SsmStateManagerConstruct).
            documentType: 'Command',
            documentFormat: 'YAML',
            targetType: '/AWS::EC2::Instance',
            content: {
                schemaVersion: '2.2',
                description: `Node drift enforcement for ${prefix}-${targetEnvironment}. Validates and remediates kernel modules, sysctl parameters, and critical services (containerd, kubelet).`,
                mainSteps: [
                    {
                        action: 'aws:runShellScript',
                        name: 'EnforceNodeConfig',
                        precondition: {
                            StringEquals: ['platformType', 'Linux'],
                        },
                        inputs: {
                            runCommand: this.buildEnforcementScript(),
                            timeoutSeconds: '120',
                        },
                    },
                ],
            },
            updateMethod: 'NewVersion',
        });

        // -----------------------------------------------------------------
        // 2. State Manager Association
        //
        // Targets all K8s nodes by the 'project' tag applied by
        // TaggingAspect. Runs on schedule + on new instance registration.
        // -----------------------------------------------------------------
        this.association = new ssm.CfnAssociation(this, 'DriftAssoc', {
            name: this.document.ref,
            // Auto-generated associationName to prevent CFn replacement
            // conflicts (same pattern as SsmStateManagerConstruct).
            targets: [
                {
                    key: `tag:${K8S_PROJECT_TAG_KEY}`,
                    values: [K8S_PROJECT_TAG_VALUE],
                },
            ],
            scheduleExpression: schedule ?? DRIFT_CHECK_SCHEDULE,
            maxConcurrency: '4',
            maxErrors: '0',
            complianceSeverity: 'HIGH',
            applyOnlyAtCronInterval: false, // Also apply on new instance registration
        });

        // Ensure document exists before the association references it
        this.association.addDependency(this.document);
    }

    // -----------------------------------------------------------------
    // PRIVATE — Script Builder
    // -----------------------------------------------------------------

    /**
     * Builds the idempotent enforcement shell script.
     *
     * Structure:
     *   1. Enforce kernel modules (modprobe — idempotent)
     *   2. Enforce sysctl parameters (sysctl -w — idempotent)
     *   3. Validate + restart critical services
     *   4. Report summary
     *
     * @returns Array of shell command lines for the SSM document
     */
    private buildEnforcementScript(): string[] {
        const sysctlEntries = Object.entries(REQUIRED_SYSCTL);

        return [
            '#!/bin/bash',
            'set -euo pipefail',
            '',
            'DRIFT_DETECTED=0',
            'REMEDIATION_FAILED=0',
            'echo "=== K8s Node Drift Enforcement — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="',
            '',
            '# -----------------------------------------------------------------',
            '# 1. Kernel Modules',
            '# -----------------------------------------------------------------',
            ...REQUIRED_KERNEL_MODULES.flatMap((mod) => [
                `if ! lsmod | grep -q "^${mod} "; then`,
                `  echo "DRIFT: kernel module '${mod}' not loaded — loading"`,
                `  modprobe ${mod}`,
                '  DRIFT_DETECTED=1',
                'else',
                `  echo "✓ kernel module: ${mod}"`,
                'fi',
                '',
            ]),
            '# -----------------------------------------------------------------',
            '# 2. Sysctl Parameters',
            '# -----------------------------------------------------------------',
            ...sysctlEntries.flatMap(([key, expected]) => {
                const procPath = `/proc/sys/${key.replace(/\./g, '/')}`;
                return [
                    `ACTUAL=$(cat ${procPath} 2>/dev/null || echo "MISSING")`,
                    `if [ "$ACTUAL" != "${expected}" ]; then`,
                    `  echo "DRIFT: ${key} = $ACTUAL (expected ${expected}) — enforcing"`,
                    `  sysctl -w ${key}=${expected} > /dev/null`,
                    '  DRIFT_DETECTED=1',
                    'else',
                    `  echo "✓ sysctl: ${key} = ${expected}"`,
                    'fi',
                    '',
                ];
            }),
            '# -----------------------------------------------------------------',
            '# 3. Critical Services',
            '# -----------------------------------------------------------------',
            ...REQUIRED_SERVICES.flatMap((svc) => [
                `if ! systemctl is-active --quiet ${svc}; then`,
                `  echo "DRIFT: ${svc} is not running — restarting"`,
                `  if systemctl restart ${svc}; then`,
                `    echo "  ✓ ${svc} restarted successfully"`,
                '  else',
                `    echo "  ✗ FAILED to restart ${svc}"`,
                '    REMEDIATION_FAILED=1',
                '  fi',
                '  DRIFT_DETECTED=1',
                'else',
                `  echo "✓ service: ${svc} (active)"`,
                'fi',
                '',
            ]),
            '# -----------------------------------------------------------------',
            '# 4. Summary',
            '# -----------------------------------------------------------------',
            'if [ "$REMEDIATION_FAILED" -eq 1 ]; then',
            '  echo "=== RESULT: NON-COMPLIANT — remediation failed ==="',
            '  exit 1',
            'elif [ "$DRIFT_DETECTED" -eq 1 ]; then',
            '  echo "=== RESULT: COMPLIANT — drift detected and remediated ==="',
            '  exit 0',
            'else',
            '  echo "=== RESULT: COMPLIANT — no drift detected ==="',
            '  exit 0',
            'fi',
        ];
    }
}
