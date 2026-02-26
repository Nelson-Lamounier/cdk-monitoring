/**
 * @format
 * Stacks - Central Export
 *
 * Modular Stacks Approach:
 * - SharedVpcStack (lib/shared/): Shared networking infrastructure
 * - Monitoring (lib/stacks/monitoring/): Modular SG + EBS + Compute + Lifecycle stacks
 * - NextJS (lib/stacks/nextjs/): ECR and ECS containers
 *
 * @deprecated MonitoringInfraStack - Use modular stacks from './monitoring' instead
 */

// New modular monitoring stacks (recommended)
export * from './monitoring';

// NextJS stacks
export * from './nextjs';

// Shared stacks (cross-account resources)
export * from './shared';

// Kubernetes cluster stacks
export * from './kubernetes';
