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
    /** AWS Organization and root account resources */
    ORG = 'org',

    /** Kubernetes cluster for unified workloads */
    KUBERNETES = 'kubernetes',
    /** Amazon Bedrock AI agent */
    BEDROCK = 'bedrock',
    /** Agentic self-healing pipeline using AgentCore Gateway and Strands Agents */
    SELF_HEALING = 'self-healing',
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
    [Project.ORG]: {
        displayName: 'Organization',
        description: 'AWS Organization and root account resources',
        namespace: 'Org',
        requiresSharedVpc: false,
    },

    [Project.KUBERNETES]: {
        displayName: 'Kubernetes',
        description: 'Kubernetes cluster for unified workloads',
        namespace: '',
        requiresSharedVpc: true,
    },
    [Project.BEDROCK]: {
        displayName: 'Bedrock',
        description: 'Amazon Bedrock AI agent with Knowledge Bases and API Gateway',
        namespace: 'Bedrock',
        requiresSharedVpc: false, // Bedrock is fully managed serverless
    },
    [Project.SELF_HEALING]: {
        displayName: 'Self-Healing',
        description: 'Agentic self-healing pipeline using AgentCore Gateway and Strands Agents',
        namespace: 'SelfHealing',
        requiresSharedVpc: false, // Fully managed serverless
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
