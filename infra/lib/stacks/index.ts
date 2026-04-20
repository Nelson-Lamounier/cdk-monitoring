/**
 * @format
 * Stacks - Central Export
 *
 * Modular Stacks Approach:
 * - SharedVpcStack (lib/shared/): Shared networking infrastructure
 * - Kubernetes (lib/stacks/kubernetes/): K8s cluster, workers, edge, API
 * - Self-Healing (lib/stacks/self-healing/): Agentic remediation pipeline
 */

// Shared stacks (cross-account resources)
export * from './shared';

// Kubernetes cluster stacks
export * from './kubernetes';

// Self-Healing pipeline stacks
export * from './self-healing';
