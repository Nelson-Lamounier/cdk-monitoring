/**
 * @format
 * Project Configuration
 *
 * Defines available projects and their metadata for multi-project IaC.
 */

/**
 * Available projects in this repository.
 * Each project has its own factory and stacks, but may share infrastructure.
 */
export enum Project {
    /** Shared infrastructure (VPC, etc.) used by multiple projects */
    SHARED = 'shared',
    /** Grafana/Prometheus monitoring stack */
    MONITORING = 'monitoring',
    /** Next.js web application */
    NEXTJS = 'nextjs',
    /** AWS Organization and root account resources */
    ORG = 'org',
    /** k3s Kubernetes cluster for unified workloads */
    K8S = 'k8s',
}

/**
 * Project metadata configuration
 */
export interface ProjectConfig {
    /** Display name for the project */
    readonly displayName: string;
    /** Short description */
    readonly description: string;
    /** Stack namespace prefix */
    readonly namespace: string;
    /** Whether this project requires the shared VPC */
    readonly requiresSharedVpc: boolean;
}

/**
 * Project configurations mapped by project enum
 */
export const PROJECT_CONFIGS: Record<Project, ProjectConfig> = {
    [Project.SHARED]: {
        displayName: 'Shared',
        description: 'Shared infrastructure (VPC) used by multiple projects',
        namespace: 'Shared',
        requiresSharedVpc: false, // This project CREATES the shared VPC
    },
    [Project.MONITORING]: {
        displayName: 'Monitoring',
        description: 'Grafana and Prometheus monitoring infrastructure',
        namespace: 'Monitoring',
        requiresSharedVpc: true,
    },
    [Project.NEXTJS]: {
        displayName: 'Next.js',
        description: 'Next.js web application infrastructure',
        namespace: 'NextJS',
        requiresSharedVpc: true,
    },
    [Project.ORG]: {
        displayName: 'Organization',
        description: 'AWS Organization and root account resources',
        namespace: 'Org',
        requiresSharedVpc: false,
    },
    [Project.K8S]: {
        displayName: 'Kubernetes',
        description: 'k3s Kubernetes cluster for unified workloads',
        namespace: 'K8s',
        requiresSharedVpc: true,
    },
} as const;

/**
 * Get project configuration by project enum
 */
export function getProjectConfig(project: Project): ProjectConfig {
    return PROJECT_CONFIGS[project];
}

/**
 * Check if a string is a valid project
 */
export function isValidProject(value: string): value is Project {
    return Object.values(Project).includes(value as Project);
}

/**
 * Get all available project names
 */
export function getAvailableProjects(): Project[] {
    return Object.values(Project);
}
