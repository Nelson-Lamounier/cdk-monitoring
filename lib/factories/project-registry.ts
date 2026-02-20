/**
 * @format
 * Project Registry
 *
 * Maps project + environment combinations to their respective factories.
 * This is the central registry for all project factories.
 */

import { Environment, isValidEnvironment, resolveEnvironment } from '../config/environments';
import { Project, isValidProject, getAvailableProjects } from '../config/projects';
import { MonitoringProjectFactory } from '../projects/monitoring';
import { NextJSProjectFactory } from '../projects/nextjs';
import { OrgProjectFactory } from '../projects/org';
import { SharedProjectFactory } from '../projects/shared';
import { K8sProjectFactory } from '../projects/k8s';

import { IProjectFactory, ProjectFactoryConstructor } from './project-interfaces';

/**
 * Registry of project factories by project type
 */
const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
    [Project.SHARED]: SharedProjectFactory,
    [Project.MONITORING]: MonitoringProjectFactory,
    [Project.NEXTJS]: NextJSProjectFactory,
    [Project.ORG]: OrgProjectFactory,
    [Project.K8S]: K8sProjectFactory,
};

/**
 * Get a project factory for a specific project and environment.
 *
 * @param project - The project to get factory for
 * @param environment - The target environment
 * @returns The project factory instance
 *
 * @example
 * ```typescript
 * const factory = getProjectFactory(Project.MONITORING, Environment.DEVELOPMENT);
 * factory.createAllStacks(app, { environment: Environment.DEVELOPMENT });
 * ```
 */
export function getProjectFactory(project: Project, environment: Environment): IProjectFactory {
    const FactoryClass = projectFactoryRegistry[project];

    if (!FactoryClass) {
        const available = getAvailableProjects().join(', ');
        throw new Error(`Unknown project: ${project}. Available: ${available}`);
    }

    return new FactoryClass(environment);
}

/**
 * Get a project factory from context values (strings).
 * Used when parsing CDK context.
 *
 * @param projectStr - Project string from context
 * @param environmentStr - Environment string from context
 * @returns The project factory instance
 *
 * @example
 * ```typescript
 * // From CDK context: -c project=monitoring -c environment=dev
 * const factory = getProjectFactoryFromContext('monitoring', 'dev');
 * ```
 */
export function getProjectFactoryFromContext(
    projectStr: string,
    environmentStr: string
): IProjectFactory {
    // Validate project
    if (!isValidProject(projectStr)) {
        const available = getAvailableProjects().join(', ');
        throw new Error(`Invalid project: '${projectStr}'. Valid projects: ${available}`);
    }

    // Validate environment
    if (!isValidEnvironment(environmentStr)) {
        const available = Object.values(Environment).join(', ');
        throw new Error(`Invalid environment: '${environmentStr}'. Valid environments: ${available}`);
    }

    // Use resolveEnvironment to handle short names (dev -> development, prod -> production)
    const resolvedEnv = resolveEnvironment(environmentStr);
    return getProjectFactory(projectStr as Project, resolvedEnv);
}

/**
 * Check if a project factory exists for the given project
 */
export function hasProjectFactory(project: Project): boolean {
    return project in projectFactoryRegistry;
}

/**
 * Register a custom project factory.
 * Useful for extending with additional projects.
 *
 * @param project - The project enum value
 * @param factory - The factory constructor
 */
export function registerProjectFactory(
    project: Project,
    factory: ProjectFactoryConstructor
): void {
    projectFactoryRegistry[project] = factory;
}
