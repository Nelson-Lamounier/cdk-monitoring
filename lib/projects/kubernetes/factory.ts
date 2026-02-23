/**
 * @format
 * Kubernetes Project Factory
 *
 * Creates shared Kubernetes infrastructure hosting both monitoring and
 * application workloads on a single k3s server node.
 *
 * Stack Architecture (4 stacks):
 *   1. Kubernetes-Data: DynamoDB, S3 Assets, SSM parameters
 *   2. Kubernetes-Compute: EC2 instance, ASG, Security Group, IAM, EBS,
 *      Elastic IP, S3 manifests, SSM doc, Golden AMI, State Manager
 *   3. Kubernetes-API: API Gateway + Lambda (email subscriptions)
 *   4. Kubernetes-Edge: ACM + WAF + CloudFront (us-east-1)
 *
 * Workload isolation is enforced at the Kubernetes layer via Namespaces,
 * NetworkPolicies, ResourceQuotas, and PriorityClasses.
 *
 * Usage:
 *   npx cdk synth -c project=k8s -c environment=dev
 */

import * as cdk from 'aws-cdk-lib/core';

import {
    Environment,
    cdkEnvironment,
    cdkEdgeEnvironment,
    getEnvironmentConfig,
} from '../../config/environments';
import { getK8sConfigs } from '../../config/kubernetes';
import { getNextJsConfigs } from '../../config/nextjs/configurations';
import { nextjsResourceNames } from '../../config/nextjs/resource-names';
import { Project, getProjectConfig } from '../../config/projects';
import { nextjsSsmPaths } from '../../config/ssm-paths';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    KubernetesComputeStack,
    KubernetesDataStack,
    KubernetesEdgeStack,
} from '../../stacks/kubernetes';
import { NextJsApiStack } from '../../stacks/nextjs/networking/api-stack';
import { stackId } from '../../utilities/naming';

// =============================================================================
// FACTORY CONTEXT
// =============================================================================

/**
 * Factory context for Kubernetes project.
 */
export interface KubernetesFactoryContext extends ProjectFactoryContext {
    /** Target environment (inherited from base) */
    readonly environment: Environment;

    /** Override domain name for edge stack */
    readonly domainName?: string;

    /** Override hosted zone ID for edge stack */
    readonly hostedZoneId?: string;

    /** Override cross-account role ARN for edge stack */
    readonly crossAccountRoleArn?: string;

    /** Additional domains for certificate SANs */
    readonly subjectAlternativeNames?: string[];

    // API stack email configuration
    /** Override notification email from config */
    readonly notificationEmail?: string;
    /** Override SES from email from config */
    readonly sesFromEmail?: string;
    /** Override verification secret from config */
    readonly verificationSecret?: string;
    /** Override verification base URL from config */
    readonly verificationBaseUrl?: string;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Kubernetes project factory.
 * Creates Data, Compute, API, and Edge stacks for a shared k3s cluster.
 *
 * @example
 * ```typescript
 * const factory = new KubernetesProjectFactory(Environment.DEVELOPMENT);
 * factory.createAllStacks(app, { environment: Environment.DEVELOPMENT });
 * ```
 */
export class KubernetesProjectFactory implements IProjectFactory<KubernetesFactoryContext> {
    readonly project = Project.K8S;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.K8S).namespace;
    }

    /**
     * Create all stacks for the Kubernetes project.
     */
    createAllStacks(scope: cdk.App, context: KubernetesFactoryContext): ProjectStackFamily {
        const environment = context.environment ?? this.environment;
        const _envConfig = getEnvironmentConfig(environment);
        const configs = getK8sConfigs(environment);
        const nextjsConfig = getNextJsConfigs(environment);

        const namePrefix = `k8s-${environment}`;
        const env = cdkEnvironment(environment);
        const ssmPrefix = `/k8s/${environment}`;

        // =================================================================
        // Resolve Next.js application config
        //
        // The shared k3s server hosts the Next.js application, so we need
        // the Next.js resource names, SSM paths, and edge configuration.
        // =================================================================
        const nextjsNamePrefix = getProjectConfig(Project.NEXTJS).namespace.toLowerCase();
        const resourceNames = nextjsResourceNames(nextjsNamePrefix, environment);
        const ssmPaths = nextjsSsmPaths(environment, nextjsNamePrefix);

        // Edge configuration (context override > Next.js config)
        const edgeConfig = {
            domainName: context.domainName ?? nextjsConfig.domainName,
            hostedZoneId: context.hostedZoneId ?? nextjsConfig.hostedZoneId,
            crossAccountRoleArn: context.crossAccountRoleArn ?? nextjsConfig.crossAccountRoleArn,
        };

        // Soft validation — warn if edge config is incomplete
        if (!edgeConfig.domainName || !edgeConfig.hostedZoneId || !edgeConfig.crossAccountRoleArn) {
            const missing: string[] = [];
            if (!edgeConfig.domainName) missing.push('domainName (DOMAIN_NAME)');
            if (!edgeConfig.hostedZoneId) missing.push('hostedZoneId (HOSTED_ZONE_ID)');
            if (!edgeConfig.crossAccountRoleArn) missing.push('crossAccountRoleArn (CROSS_ACCOUNT_ROLE_ARN)');
            cdk.Annotations.of(scope).addWarning(
                `Edge config incomplete: ${missing.join(', ')}. ` +
                `Edge stack will fail if deployed without these values.`,
            );
        }

        // Email / secrets configuration (context override > config)
        const emailConfig = {
            notificationEmail: context.notificationEmail ?? nextjsConfig.notificationEmail,
            sesFromEmail: context.sesFromEmail ?? nextjsConfig.sesFromEmail,
            verificationBaseUrl: context.verificationBaseUrl ?? nextjsConfig.verificationBaseUrl,
            verificationSecret: context.verificationSecret ?? nextjsConfig.verificationSecret,
        };

        // Soft validation — warn if email config is incomplete
        if (!emailConfig.notificationEmail || !emailConfig.sesFromEmail || !emailConfig.verificationSecret) {
            const missing: string[] = [];
            if (!emailConfig.notificationEmail) missing.push('notificationEmail (NOTIFICATION_EMAIL)');
            if (!emailConfig.sesFromEmail) missing.push('sesFromEmail (SES_FROM_EMAIL)');
            if (!emailConfig.verificationSecret) missing.push('verificationSecret (VERIFICATION_SECRET)');
            cdk.Annotations.of(scope).addWarning(
                `Email config incomplete: ${missing.join(', ')}. ` +
                `API stack will fail if deployed without these values.`,
            );
        }

        const stacks: cdk.Stack[] = [];
        const stackMap: Record<string, cdk.Stack> = {};

        // =================================================================
        // Stack 1: DATA STACK (DynamoDB + S3 + SSM)
        //
        // Data layer for the Next.js application running on k3s.
        // Rarely changes — deployed once per environment.
        // =================================================================
        const dataStack = new KubernetesDataStack(
            scope,
            stackId(this.namespace, 'Data', environment),
            {
                targetEnvironment: environment,
                projectName: nextjsNamePrefix,
                env,
            },
        );
        stacks.push(dataStack);
        stackMap.data = dataStack;

        // =================================================================
        // Stack 2: COMPUTE STACK (EC2 + k3s + Security + Storage)
        //
        // Single k3s server hosting both monitoring and app workloads.
        // Application-tier IAM grants are passed as optional props.
        // =================================================================
        const computeStack = new KubernetesComputeStack(
            scope,
            stackId(this.namespace, 'Compute', environment),
            {
                env,
                description: `Shared k3s Kubernetes cluster (monitoring + application) — ${environment}`,
                targetEnvironment: environment,
                configs,
                namePrefix,
                ssmPrefix,

                // Application-tier IAM grants (Next.js)
                ssmParameterPath: ssmPaths.wildcard,
                secretsManagerPathPattern: `${nextjsNamePrefix}/${environment}/*`,
                s3ReadBucketArns: [`arn:aws:s3:::${resourceNames.assetsBucketName}`],
                dynamoTableArns: [
                    `arn:aws:dynamodb:${env.region}:${env.account}:table/${resourceNames.dynamoTableName}`,
                ],
                dynamoKmsKeySsmPath: ssmPaths.dynamodbKmsKeyArn,
            },
        );
        computeStack.addDependency(dataStack);
        stacks.push(computeStack);
        stackMap.compute = computeStack;

        // =================================================================
        // Stack 3: API STACK (API Gateway + Lambda)
        //
        // Serverless email subscription API (subscribe + verify).
        // Independent lifecycle — depends only on Data stack (SSM discovery).
        // =================================================================
        const apiStack = new NextJsApiStack(
            scope,
            stackId(this.namespace, 'Api', environment),
            {
                targetEnvironment: environment,
                projectName: nextjsNamePrefix,
                tableSsmPath: ssmPaths.dynamodbTableName,
                bucketSsmPath: ssmPaths.assetsBucketName,
                namePrefix: nextjsNamePrefix,
                // WAF: API traffic is routed through CloudFront edge WAF
                skipWaf: true,

                // Email subscription configuration
                notificationEmail: emailConfig.notificationEmail ?? '',
                sesFromEmail: emailConfig.sesFromEmail ?? '',
                verificationBaseUrl: emailConfig.verificationBaseUrl ?? '',
                verificationSecret: emailConfig.verificationSecret ?? '',

                env,
            },
        );
        apiStack.addDependency(dataStack);
        stacks.push(apiStack);
        stackMap.api = apiStack;

        // =================================================================
        // Stack 4: EDGE STACK (ACM + WAF + CloudFront)
        //
        // MUST be deployed in us-east-1 (CloudFront requirement).
        // Routes traffic: CloudFront → EIP → Traefik → Next.js pod
        // =================================================================
        const edgeEnv = cdkEdgeEnvironment(environment);

        // EIP SSM path is written by the compute stack
        const eipSsmPath = `${ssmPrefix}/eip-public-ip`;

        const edgeStack = new KubernetesEdgeStack(
            scope,
            stackId(this.namespace, 'Edge', environment),
            {
                targetEnvironment: environment,
                domainName: edgeConfig.domainName ?? '',
                subjectAlternativeNames: context.subjectAlternativeNames,
                hostedZoneId: edgeConfig.hostedZoneId ?? '',
                crossAccountRoleArn: edgeConfig.crossAccountRoleArn ?? '',
                // SSM lookups read from the primary region
                eipSsmPath,
                eipSsmRegion: env.region,
                assetsBucketSsmPath: ssmPaths.assetsBucketName,
                assetsBucketSsmRegion: env.region,
                rateLimitPerIp: 5000,
                enableIpReputationList: true,
                enableRateLimiting: true,
                createDnsRecords: true,
                namePrefix: nextjsNamePrefix,
                env: edgeEnv,
            },
        );
        edgeStack.addDependency(computeStack);
        edgeStack.addDependency(dataStack);
        edgeStack.addDependency(apiStack);
        stacks.push(edgeStack);
        stackMap.edge = edgeStack;

        cdk.Annotations.of(scope).addInfo(
            `K8s factory created ${stacks.length} stacks for ${environment}: ` +
            `Data → Compute → Edge (domain: ${edgeConfig.domainName ?? 'not configured'})`,
        );

        return {
            stacks,
            stackMap,
        };
    }
}
