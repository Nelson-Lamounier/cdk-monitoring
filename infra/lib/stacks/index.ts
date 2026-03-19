/**
 * @format
 * Stacks - Central Export
 *
 * Modular Stacks Approach:
 * - SharedVpcStack (lib/shared/): Shared networking infrastructure
 * - Kubernetes (lib/stacks/kubernetes/): K8s cluster, workers, edge, API
 * - Bedrock (lib/stacks/bedrock/): AI agent stacks
 * - Self-Healing (lib/stacks/self-healing/): Agentic remediation pipeline
 */

// Shared stacks (cross-account resources)
export * from './shared';

// Kubernetes cluster stacks
export * from './kubernetes';

// Bedrock AI agent stacks
export * from './bedrock';

// Self-Healing pipeline stacks
export * from './self-healing';
