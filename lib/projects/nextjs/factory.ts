/**
 * @format
 * Next.js Project Factory (Consolidated Domain Stacks)
 *
 * Creates complete infrastructure for Next.js web application on ECS
 * using consolidated domain-based stacks for simpler deployment.
 *
 * Stack Deployment Order (6 stacks):
 * 1. DataStack: DynamoDB Personal Portfolio Table + S3 + SSM Secrets
 * 2. ComputeStack: ECS Cluster + IAM Roles + ASG + Launch Template
 * 3. NetworkingStack: ALB + Target Group + Task Security Group
 * 4. ApplicationStack: Task Definition + ECS Service + Auto-Deploy
 * 5. ApiStack: API Gateway + Lambda (separate lifecycle)
 * 6. EdgeStack: ACM + WAF + CloudFront (us-east-1)
 *
 * Benefits over legacy factory:
 * - Fewer stacks to manage (6 vs 14+)
 * - Faster deployments
 * - Clearer domain boundaries
 * - Simpler dependency management
 */

import * as cdk from 'aws-cdk-lib/core';

import { Environment, cdkEnvironment, cdkEdgeEnvironment } from '../../config/environments';
import { getNextJsConfigs } from '../../config/nextjs';
import { nextjsResourceNames } from '../../config/nextjs/resource-names';
import { Project, getProjectConfig } from '../../config/projects';
import { nextjsSsmPaths, monitoringSsmPaths } from '../../config/ssm-paths';
import {
    IProjectFactory,
    ProjectFactoryContext,
    ProjectStackFamily,
} from '../../factories/project-interfaces';
import {
    NextJsDataStack,
    NextJsComputeStack,
    NextJsNetworkingStack,
    NextJsApplicationStack,
    NextJsApiStack,
    NextJsEdgeStack,
} from '../../stacks/nextjs';

// =========================================================================
// Factory Context
// =========================================================================

/**
 * Extended factory context with CloudFront and secrets overrides.
 *
 * All synth-time values come from the typed config file (NextJsConfigs).
 * Context fields here are overrides — used by the app.ts env var bridge
 * and tests.
 */
export interface ConsolidatedFactoryContext extends ProjectFactoryContext {
    /** Override domain name from config */
    domainName?: string;
    /** Subject alternative names for CloudFront */
    subjectAlternativeNames?: string[];
    /** Override hosted zone ID from config */
    hostedZoneId?: string;
    /** Override cross-account role ARN from config */
    crossAccountRoleArn?: string;
    /** Override notification email from config */
    notificationEmail?: string;
    /** Override SES from email from config */
    sesFromEmail?: string;
    /** Override verification secret from config */
    verificationSecret?: string;
    /** Override verification base URL from config */
    verificationBaseUrl?: string;
    /**
     * Image tag to deploy
     * @default 'latest'
     */
    imageTag?: string;
}

/**
 * Consolidated Next.js project factory.
 * Creates complete ECS infrastructure using domain-based stacks.
 *
 * @example
 * ```typescript
 * const factory = new ConsolidatedNextJSFactory(Environment.DEVELOPMENT);
 * factory.createAllStacks(app, {
 *     environment: Environment.DEVELOPMENT,
 *     domainName: 'dev.example.com',
 *     hostedZoneId: 'Z1234567890ABC',
 *     crossAccountRoleArn: 'arn:aws:iam::ROOT:role/Route53Role',
 * });
 * ```
 */
export class ConsolidatedNextJSFactory implements IProjectFactory<ConsolidatedFactoryContext> {
    readonly project = Project.NEXTJS;
    readonly environment: Environment;
    readonly namespace: string;

    constructor(environment: Environment) {
        this.environment = environment;
        this.namespace = getProjectConfig(Project.NEXTJS).namespace;
    }

    /**
     * Generate stack ID with project namespace and environment suffix
     */
    private stackId(resource: string): string {
        return `${this.namespace}-${resource}-${this.environment}`;
    }

    createAllStacks(scope: cdk.App, context: ConsolidatedFactoryContext): ProjectStackFamily {
        // -------------------------------------------------------------
        // Load typed config for this environment
        // -------------------------------------------------------------
        const config = getNextJsConfigs(this.environment);

        // CDK environment: resolved from env vars via config
        const env = cdkEnvironment(this.environment);

        const namePrefix = this.namespace.toLowerCase();
        const stacks: cdk.Stack[] = [];
        const stackMap: Record<string, cdk.Stack> = {};
        const ssmPaths = nextjsSsmPaths(this.environment, namePrefix);
        const resourceNames = nextjsResourceNames(namePrefix, this.environment);

        // VPC name for synth-time lookup (matches Monitoring project pattern)
        const vpcName = `shared-vpc-${this.environment}`;
        // Default to 'latest' - the standard tag for production images
        const imageTag = context.imageTag ?? 'latest';

        // -------------------------------------------------------------
        // Edge / CloudFront configuration (context override > config)
        // -------------------------------------------------------------
        const edgeConfig = {
            domainName: context.domainName ?? config.domainName,
            hostedZoneId: context.hostedZoneId ?? config.hostedZoneId,
            crossAccountRoleArn: context.crossAccountRoleArn ?? config.crossAccountRoleArn,
        };

        // Sanity check: warn if domain doesn't match expected environment pattern
        // This catches misconfiguration like using production domain in a dev deployment
        if (edgeConfig.domainName && this.environment !== 'production') {
            const expectedPrefix = this.environment === 'development' ? 'dev.' : 'staging.';
            if (!edgeConfig.domainName.startsWith(expectedPrefix)) {
                cdk.Annotations.of(scope).addWarning(
                    `Domain "${edgeConfig.domainName}" does not start with "${expectedPrefix}" ` +
                    `for ${this.environment} environment. Expected something like "${expectedPrefix}example.com". ` +
                    `Check your domain configuration in the typed config file or context overrides.`,
                );
            }
        }

        // Soft validation — warn if edge config is incomplete.
        // CDK deploy --exclusively will only deploy the selected stack;
        // missing values only matter when the Edge stack is actually deployed.
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

        // -------------------------------------------------------------
        // Email / secrets configuration (context override > config)
        // Required for API stack integration with frontend contact form
        // -------------------------------------------------------------
        const emailConfig = {
            notificationEmail: context.notificationEmail ?? config.notificationEmail,
            sesFromEmail: context.sesFromEmail ?? config.sesFromEmail,
            verificationBaseUrl: context.verificationBaseUrl ?? config.verificationBaseUrl,
            verificationSecret: context.verificationSecret ?? config.verificationSecret,
        };

        // Soft validation — warn if email config is incomplete.
        // Only the API stack needs these values; other stacks synth fine without them.
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

        // -------------------------------------------------------------
        // Monitoring SSM paths (centralized config)
        // -------------------------------------------------------------
        const monitoringSsm = monitoringSsmPaths(this.environment);

        cdk.Annotations.of(scope).addInfo(
            `Creating consolidated NextJS infrastructure for ${this.environment}`,
        );

        // =================================================================
        // Stack 1: DATA STACK
        // DynamoDB Personal Portfolio Table + S3 Assets Bucket + SSM
        // =================================================================
        const dataStack = new NextJsDataStack(scope, this.stackId('Data'), {
            targetEnvironment: this.environment,
            projectName: namePrefix,
            env,
        });
        stacks.push(dataStack);
        stackMap.data = dataStack;

        // =================================================================
        // Stack 2: COMPUTE STACK
        // ECS Cluster + IAM Roles + Launch Template + ASG
        // =================================================================
        const computeStack = new NextJsComputeStack(scope, this.stackId('Compute'), {
            targetEnvironment: this.environment,
            vpcName,
            namePrefix,
            // Grant access to data resources via wildcard patterns
            ssmParameterPath: ssmPaths.wildcard,
            // Grant access to Secrets Manager secrets (auth-secret, auth-url)
            secretsManagerPathPattern: `${namePrefix}/${this.environment}/*`,
            // Resource ARNs from shared naming — single source of truth (Item 6)
            s3ReadBucketArns: [`arn:aws:s3:::${resourceNames.assetsBucketName}`],
            dynamoTableArns: [
                `arn:aws:dynamodb:${env.region}:${env.account}:table/${resourceNames.dynamoTableName}`,
            ],
            // Wire monitoring SG for Prometheus scraping (port 9100 + 3000)
            // Resolved inside Compute stack via SSM to avoid cross-stack exports
            monitoringSgSsmPath: monitoringSsm.securityGroupId,
            env,
        });
        computeStack.addDependency(dataStack);
        stacks.push(computeStack);
        stackMap.compute = computeStack;

        // =================================================================
        // Stack 3: NETWORKING STACK
        // ALB + Target Group + Task Security Group
        // Deploys in parallel with Compute (no dependency needed — Item 10)
        // =================================================================
        const networkingStack = new NextJsNetworkingStack(scope, this.stackId('Networking'), {
            targetEnvironment: this.environment,
            vpcName,
            namePrefix,
            // Cross-account certificate for ALB HTTPS (if CloudFront/Edge is enabled)
            domainName: edgeConfig.domainName,
            hostedZoneId: edgeConfig.hostedZoneId,
            crossAccountRoleArn: edgeConfig.crossAccountRoleArn,
            // Monitoring SG ingress for Prometheus scraping (port 3000)
            // Placed in Networking stack (not Application) to avoid cyclic refs
            monitoringSgSsmPath: monitoringSsm.securityGroupId,
            env,
        });
        stacks.push(networkingStack);
        stackMap.networking = networkingStack;

        // =================================================================
        // Stack 4: APPLICATION STACK
        // Task Definition + ECS Service + Auto-Deploy
        // =================================================================
        const applicationStack = new NextJsApplicationStack(scope, this.stackId('Application'), {
            targetEnvironment: this.environment,
            vpcName,
            // ECR is discovered via SSM from SharedVpcStack: /shared/ecr/{env}/repository-*
            imageTag,
            // From Compute Stack - construct role ARNs from names to avoid cyclic dependencies
            // Using role names avoids CDK token resolution that creates cross-stack refs
            cluster: computeStack.cluster,
            taskExecutionRoleArn: `arn:aws:iam::${env.account}:role/${computeStack.taskExecutionRoleName}`,
            taskRoleArn: `arn:aws:iam::${env.account}:role/${computeStack.taskRoleName}`,
            // From Networking Stack
            targetGroup: networkingStack.targetGroup,
            taskSecurityGroup: networkingStack.taskSecurityGroup,
            namePrefix,
            // Auto-deploy disabled: Frontend pipeline uses direct ecs:UpdateService
            // with 'latest' tag (Option B: Service-Only deployment strategy)
            autoDeploy: { enabled: false },
            // Monitoring integration
            monitoring: {
                // Enable node-exporter daemon for Prometheus metrics
                enableNodeExporter: true,
                // Enable Promtail sidecar for Loki log forwarding
                // Loki endpoint discovered from SSM (set by monitoring instance at boot)
                enablePromtail: true,
                lokiSsmPath: monitoringSsm.lokiEndpoint,
                // Cloud Map: auto-register ECS task IPs for Prometheus discovery
                cloudMapNamespace: computeStack.cloudMapNamespace,
            },
            env,
        });
        applicationStack.addDependency(dataStack);
        applicationStack.addDependency(computeStack);
        applicationStack.addDependency(networkingStack);
        stacks.push(applicationStack);
        stackMap.application = applicationStack;

        // =================================================================
        // Stack 5: API STACK (Separate Lifecycle)
        // API Gateway + Lambda for email subscriptions (frontend contact form)
        // =================================================================
        const apiStack = new NextJsApiStack(scope, this.stackId('Api'), {
            targetEnvironment: this.environment,
            projectName: namePrefix,
            tableSsmPath: ssmPaths.dynamodbTableName,
            bucketSsmPath: ssmPaths.assetsBucketName,
            namePrefix,
            // WAF: API traffic is routed through CloudFront, which has its own
            // WAF (managed in the Edge stack). A separate regional WAF on the
            // API Gateway would be redundant — all public access flows through
            // CloudFront edge → ALB → ECS, and the API Gateway is invoked by
            // the frontend form via CloudFront's /api/* behavior.
            skipWaf: true,

            // Email subscription configuration (soft-validated above)
            notificationEmail: emailConfig.notificationEmail ?? '',
            sesFromEmail: emailConfig.sesFromEmail ?? '',
            verificationBaseUrl: emailConfig.verificationBaseUrl ?? '',
            verificationSecret: emailConfig.verificationSecret ?? '',

            env,
        });

        apiStack.addDependency(dataStack);
        stacks.push(apiStack);
        stackMap.api = apiStack;

        // =================================================================
        // Stack 6: EDGE STACK (Required)
        // ACM + WAF + CloudFront (us-east-1) - Single consolidated stack
        // =================================================================
        const edgeEnv = cdkEdgeEnvironment(this.environment);

        const edgeStack = new NextJsEdgeStack(scope, this.stackId('Edge'), {
            targetEnvironment: this.environment,
            domainName: edgeConfig.domainName ?? '',
            subjectAlternativeNames: context.subjectAlternativeNames,
            hostedZoneId: edgeConfig.hostedZoneId ?? '',
            crossAccountRoleArn: edgeConfig.crossAccountRoleArn ?? '',
            // SSM lookups read from the primary region (where Data/Networking stacks deploy)
            albDnsSsmPath: ssmPaths.albDnsName,
            albDnsSsmRegion: env.region,
            assetsBucketSsmPath: ssmPaths.assetsBucketName,
            assetsBucketSsmRegion: env.region,
            rateLimitPerIp: 5000,
            enableIpReputationList: true,
            enableRateLimiting: true,
            createDnsRecords: true,
            namePrefix,
            env: edgeEnv,
        });
        edgeStack.addDependency(networkingStack);
        edgeStack.addDependency(dataStack);
        edgeStack.addDependency(apiStack);
        stacks.push(edgeStack);
        stackMap.edge = edgeStack;

        cdk.Annotations.of(scope).addInfo(
            `Edge stack enabled for domain: ${edgeConfig.domainName} ` +
            `(ACM + WAF + CloudFront in us-east-1)`,
        );

        return {
            stacks,
            stackMap,
        };
    }
}
