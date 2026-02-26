/**
 * @format
 * NextJS Project Configuration - Barrel Export
 *
 * Centralized configuration for NextJS project infrastructure.
 * Import from this file to access all allocations and configurations.
 *
 * @example
 * ```typescript
 * import {
 *     getNextJsAllocations,
 *     getNextJsConfigs,
 *     getLambdaAllocation,
 *     getCorsConfig,
 * } from '../../config/nextjs';
 * ```
 */

// Export all allocations
export * from './allocations';

// Export all configurations
export * from './configurations';

// Export shared resource naming
export * from './resource-names';

// Export K8s deployment configurations
export * from './kubernetes-configurations';
