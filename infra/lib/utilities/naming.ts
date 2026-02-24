/**
 * @format
 * Naming Utilities — Single Source of Truth
 *
 * Centralised resource and stack naming conventions.
 * All CDK factories and deployment scripts derive names from here.
 *
 * Stack name pattern: {Namespace}-{Component}-{environment}
 *   e.g. NextJS-Compute-development, Monitoring-K8s-Compute-production
 */

import { EnvironmentName } from '../config/environments';
import { Project, getProjectConfig } from '../config/projects';

// =============================================================================
// STACK REGISTRY — Every stack's identity, defined once
// =============================================================================

/**
 * Maps each project's stack keys to their component names.
 * This is the authoritative list of all stacks in the codebase.
 *
 * The component name is combined with the project namespace and environment
 * to produce the full CloudFormation stack name / CDK construct ID.
 *
 * @example
 * STACK_REGISTRY.nextjs.k8sCompute  // → 'K8s-Compute'
 * // Full stack name: NextJS-K8s-Compute-development
 */
export const STACK_REGISTRY = {
    shared: {
        infra: 'Infra',
    },
    monitoring: {
        storage: 'Storage',
        ssm: 'SSM',
        compute: 'Compute',
    },
    nextjs: {
        data: 'Data',
        compute: 'Compute',
        networking: 'Networking',
        application: 'Application',
        k8sCompute: 'K8s-Compute',
        api: 'Api',
        edge: 'Edge',
    },
    kubernetes: {
        data: 'Data',
        compute: 'Compute',
        api: 'Api',
        edge: 'Edge',
    },
    org: {
        dnsRole: 'DnsRole',
    },
} as const;

/** Type-safe project keys */
export type RegistryProject = keyof typeof STACK_REGISTRY;

/** Type-safe stack keys for a given project */
export type RegistryStackKey<P extends RegistryProject> = keyof (typeof STACK_REGISTRY)[P];

// =============================================================================
// STACK NAMING FUNCTIONS
// =============================================================================

/**
 * Generate a CDK construct ID / CloudFormation stack name.
 *
 * Pattern: {Namespace}-{Component}-{environment}
 *
 * @param namespace - Project namespace (e.g. 'NextJS', 'Monitoring-K8s')
 * @param component - Stack component name (e.g. 'Compute', 'K8s-Compute')
 * @param environment - Target environment (e.g. 'development')
 * @returns Full stack name (e.g. 'NextJS-K8s-Compute-development')
 *
 * @example
 * stackId('Monitoring', 'Storage', 'development')
 * // Returns: 'Monitoring-Storage-development'
 *
 * stackId('NextJS', 'K8s-Compute', 'production')
 * // Returns: 'NextJS-K8s-Compute-production'
 */
export function stackId(
    namespace: string,
    component: string,
    environment: EnvironmentName
): string {
    return `${namespace}-${component}-${environment}`;
}

/**
 * Mapping from Project enum to STACK_REGISTRY key.
 * Required because Project enum values ('shared', 'monitoring', …)
 * already match the registry keys exactly.
 */
const PROJECT_TO_REGISTRY: Record<Project, RegistryProject> = {
    [Project.SHARED]: 'shared',
    [Project.MONITORING]: 'monitoring',
    [Project.NEXTJS]: 'nextjs',
    [Project.KUBERNETES]: 'kubernetes',
    [Project.ORG]: 'org',
};

/**
 * Resolve a full stack name from project enum, stack key, and environment.
 *
 * Combines the project namespace from `projects.ts` with the component
 * name from `STACK_REGISTRY` to produce the CloudFormation stack name.
 *
 * @param project - Project enum value
 * @param stackKey - Key into the project's registry entry (e.g. 'compute', 'k8sCompute')
 * @param environment - Target environment
 * @returns Full stack name
 * @throws Error if project or stackKey is invalid
 *
 * @example
 * getStackId(Project.NEXTJS, 'k8sCompute', 'development')
 * // Returns: 'NextJS-K8s-Compute-development'
 *
 * getStackId(Project.MONITORING, 'storage', 'production')
 * // Returns: 'Monitoring-Storage-production'
 */
export function getStackId(
    project: Project,
    stackKey: string,
    environment: EnvironmentName
): string {
    const registryKey = PROJECT_TO_REGISTRY[project];
    if (!registryKey) {
        throw new Error(`Unknown project: ${project}`);
    }

    const projectRegistry = STACK_REGISTRY[registryKey];
    const component = (projectRegistry as Record<string, string>)[stackKey];
    if (!component) {
        const validKeys = Object.keys(projectRegistry).join(', ');
        throw new Error(
            `Unknown stack key '${stackKey}' for project '${project}'. ` +
            `Valid keys: ${validKeys}`
        );
    }

    const namespace = getProjectConfig(project).namespace;
    return stackId(namespace, component, environment);
}

// =============================================================================
// RESOURCE NAMING FUNCTIONS
// =============================================================================

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
