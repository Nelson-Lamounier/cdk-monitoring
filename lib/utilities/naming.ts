/**
 * @format
 * Naming Utilities
 *
 * Consistent resource naming conventions.
 */

import { EnvironmentName } from '../config/environments';

/**
 * Options for resource naming
 */
export interface NamingOptions {
    /** Project name */
    readonly project?: string;
    /** Environment */
    readonly environment?: EnvironmentName;
    /** Resource component */
    readonly component?: string;
}

/**
 * Generate a consistent resource name
 *
 * Format: {project}-{component}-{environment}
 *
 * @example
 * resourceName({ project: 'monitoring', component: 'vpc', environment: 'dev' })
 * // Returns: 'monitoring-vpc-dev'
 */
export function resourceName(options: NamingOptions): string {
    const parts: string[] = [];

    if (options.project) {
        parts.push(options.project);
    }

    if (options.component) {
        parts.push(options.component);
    }

    if (options.environment) {
        parts.push(options.environment);
    }

    return parts.join('-');
}

/**
 * Generate stack name
 *
 * Format: {Project}{Component}Stack-{Environment}
 */
export function stackName(
    project: string,
    component: string,
    environment: EnvironmentName
): string {
    const capitalizedProject = project.charAt(0).toUpperCase() + project.slice(1);
    const capitalizedComponent = component.charAt(0).toUpperCase() + component.slice(1);
    return `${capitalizedProject}${capitalizedComponent}Stack-${environment}`;
}

/**
 * Generate log group name
 *
 * Format: /{project}/{component}/{environment}
 */
export function logGroupName(
    project: string,
    component: string,
    environment?: EnvironmentName
): string {
    const parts = ['', project, component];
    if (environment) {
        parts.push(environment);
    }
    return parts.join('/');
}

/**
 * Generate CloudFormation export name
 *
 * Format: {project}-{component}-{output}-{environment}
 */
export function exportName(
    project: string,
    component: string,
    output: string,
    environment?: EnvironmentName
): string {
    const parts = [project, component, output];
    if (environment) {
        parts.push(environment);
    }
    return parts.join('-');
}

/**
 * Describe a CIDR block in human-readable format
 */
export function describeCidr(cidr: string): string {
    if (cidr.endsWith('/32')) {
        return `IP ${cidr.replace('/32', '')}`;
    }
    if (cidr.endsWith('/0')) {
        return 'All IPs (0.0.0.0/0)';
    }
    return `CIDR ${cidr}`;
}
