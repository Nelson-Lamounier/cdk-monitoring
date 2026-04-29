/**
 * @format
 * Stacks - Central Export
 *
 * Modular Stacks Approach:
 * - SharedVpcStack (lib/shared/): Shared networking infrastructure
 * - Kubernetes (lib/stacks/kubernetes/): K8s cluster, workers, edge, API
 */

// Shared stacks (cross-account resources)
export * from './shared';

// Kubernetes cluster stacks
export * from './kubernetes';
