/**
 * @format
 * k3s Kubernetes Project Factory
 *
 * Creates infrastructure for a self-managed k3s Kubernetes cluster on EC2.
 * Follows the same factory pattern as MonitoringProjectFactory and NextJSProjectFactory.
 *
 * Stack Architecture (2 stacks):
 *   1. K8s-Compute: EC2 instance, ASG, Security Group, IAM, EBS, Elastic IP
 *   2. K8s-Edge: CloudFront, WAF, ACM certificate, DNS alias (us-east-1)
 *
 * Usage:
 *   npx cdk synth -c project=k8s -c environment=dev
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment, cdkEnvironment, cdkEdgeEnvironment, getEnvironmentConfig } from '../../config/environments';
import { getK8sConfigs } from '../../config/k8s';
import { Project, getProjectConfig } from '../../config/projects';
import { k8sSsmPaths } from '../../config/ssm-paths';
import { stackId } from '../../utilities/naming';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import { K8sComputeStack, K8sEdgeStack } from '../../stacks/monitoring/k8s';

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
 * Creates compute + edge stacks for k3s monitoring infrastructure.
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
     * Create all stacks for the k3s Kubernetes project.
     */
    createAllStacks(scope: cdk.App, context: K8sFactoryContext): ProjectStackFamily {
        const environment = context.environment ?? this.environment;
        const _envConfig = getEnvironmentConfig(environment);
        const configs = getK8sConfigs(environment);

        const namePrefix = `k8s-${environment}`;
        const env = cdkEnvironment(environment);
        const ssmPrefix = `/k8s/${environment}`;

        // =====================================================================
        // 1. COMPUTE STACK (EC2 + k3s + Security + Storage)
        // =====================================================================

        const computeStack = new K8sComputeStack(scope, stackId(this.namespace, 'Compute', environment), {
            env,
            description: `k3s Kubernetes cluster compute resources (${environment})`,
            targetEnvironment: environment,
            configs,
            namePrefix,
            ssmPrefix,
        });

        // =====================================================================
        // 2. EDGE STACK (CloudFront + WAF + ACM in us-east-1)
        // =====================================================================

        // Edge config values (domainName, hostedZoneId, crossAccountRoleArn)
        // are read from SSM Parameter Store at deploy time — no process.env needed.
        const edgeConfig = configs.edge;
        const ssmPaths = k8sSsmPaths(environment);

        const edgeStack = new K8sEdgeStack(scope, stackId(this.namespace, 'Edge', environment), {
            env: cdkEdgeEnvironment(environment),
            description: `Edge infrastructure (ACM + WAF + CloudFront) for k8s monitoring (${environment})`,
            targetEnvironment: environment,
            edgeSsmPaths: {
                domainName: ssmPaths.edge.domainName,
                hostedZoneId: ssmPaths.edge.hostedZoneId,
                crossAccountRoleArn: ssmPaths.edge.crossAccountRoleArn,
            },
            edgeSsmRegion: env.region,
            elasticIpSsmPath: `${ssmPrefix}/elastic-ip`,
            elasticIpSsmRegion: env.region,
            rateLimitPerIp: edgeConfig.rateLimitPerIp,
            enableIpReputationList: edgeConfig.enableIpReputationList,
            enableRateLimiting: edgeConfig.enableRateLimiting,
            createDnsRecords: true,
            namePrefix,
        });
        edgeStack.addDependency(computeStack);

        return {
            stacks: [computeStack, edgeStack],
            stackMap: {
                compute: computeStack,
                edge: edgeStack,
            },
        };
    }
}

