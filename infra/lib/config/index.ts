/**
 * @format
 * Configuration - Central Export
 *
 * Exports global configs (environments, defaults, projects) and
 * project-specific configs (nextjs, monitoring).
 */

// Global configuration
export * from './environments';
export * from './defaults';
export * from './projects';
export * from './ssm-paths';

// Project-specific configuration
export * as nextjsConfig from './nextjs';
export * as monitoringConfig from './monitoring';
