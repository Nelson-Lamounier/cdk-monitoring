/**
 * @format
 * Monitoring Project Configuration - Barrel Export
 *
 * Centralized configuration for Monitoring project infrastructure.
 * Import from this file to access all allocations and configurations.
 *
 * @example
 * ```typescript
 * import {
 *     getMonitoringAllocations,
 *     getMonitoringConfigs,
 *     getEbsAllocation,
 *     getBackupConfig,
 * } from '../../config/monitoring';
 * ```
 */

// Export all allocations
export * from './allocations';

// Export all configurations
export * from './configurations';
