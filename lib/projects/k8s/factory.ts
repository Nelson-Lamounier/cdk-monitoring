/**
 * @format
 * k3s Kubernetes Project Factory
 *
 * Creates infrastructure for a self-managed k3s Kubernetes cluster on EC2.
 * Follows the same factory pattern as MonitoringProjectFactory and NextJSProjectFactory.
 *
 * Stack Architecture (1 stack):
 *   1. K8s-Compute: EC2 instance, ASG, Security Group, IAM, EBS, Elastic IP
 *
 * Usage:
 *   npx cdk synth -c project=k8s -c environment=dev
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment, cdkEnvironment, getEnvironmentConfig } from '../../config/environments';
import { getK8sConfigs } from '../../config/k8s';
import { Project, getProjectConfig } from '../../config/projects';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import { K8sComputeStack } from '../../stacks/k8s';

// =============================================================================
// FACTORY CONTEXT
// =============================================================================

/**
 * Factory context for k3s Kubernetes project.
 * All configuration is resolved from typed config files — no overrides needed.
 */
export interface K8sFactoryContext extends ProjectFactoryContext {
    /** Target environment (inherited from base) */
    readonly environment: Environment;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * k3s Kubernetes project factory.
 * Creates a single compute stack with k3s installed via UserData.
 *
 * @example
 * ```typescript
 * const factory = new K8sProjectFactory(Environment.DEVELOPMENT);
 * factory.createAllStacks(app, { environment: Environment.DEVELOPMENT });
 * ```
 */
export class K8sProjectFactory implements IProjectFactory<K8sFactoryContext> {
    readonly project = Project.K8S;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.K8S).namespace;
    }

    /**
     * Generate stack ID with project namespace and environment suffix.
     *
     * @example stackId('Compute') → 'K8s-Compute-development'
     */
    private stackId(resource: string): string {
        return `${this.namespace}-${resource}-${this.environment}`;
    }

    /**
     * Create all stacks for the k3s Kubernetes project.
     */
    createAllStacks(scope: cdk.App, context: K8sFactoryContext): ProjectStackFamily {
        const environment = context.environment ?? this.environment;
        const envConfig = getEnvironmentConfig(environment);
        const configs = getK8sConfigs(environment);

        const namePrefix = `k8s-${environment}`;

        // =====================================================================
        // 1. COMPUTE STACK (EC2 + k3s + Security + Storage)
        // =====================================================================

        const computeStack = new K8sComputeStack(scope, this.stackId('Compute'), {
            env: cdkEnvironment(environment),
            description: `k3s Kubernetes cluster compute resources (${environment})`,
            targetEnvironment: environment,
            configs,
            namePrefix,
            ssmPrefix: `/k8s/${environment}`,
        });

        return {
            stacks: [computeStack],
            stackMap: {
                compute: computeStack,
            },
        };
    }
}
