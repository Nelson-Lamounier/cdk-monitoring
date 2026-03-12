/**
 * @format
 * Factories - Central Export
 *
 * Project Factory pattern for creating infrastructure stacks.
 * Each project (monitoring, nextjs) has its own factory implementation.
 *
 * @example
 * ```typescript
 * import { getProjectFactoryFromContext } from '../lib/factories';
 *
 * const factory = getProjectFactoryFromContext('monitoring', 'dev');
 * const { stacks } = factory.createAllStacks(app, { environment });
 * ```
 */

// Project Factory Interfaces
export * from './project-interfaces';

// Project Factory Registry (main entry point)
export * from './project-registry';

