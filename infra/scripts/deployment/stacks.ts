/**
 * Stack Configuration
 *
 * All stack definitions for the multi-project CDK infrastructure.
 * Stack names are derived from the centralised naming utility (lib/utilities/naming.ts).
 */

import { Project } from '../../lib/config/projects.js';
import { getStackId } from '../../lib/utilities/naming.js';

export type Environment = 'development' | 'staging' | 'production';

export interface StackConfig {
  id: string; // Short identifier for CLI (e.g., 'vpc', 'ecr')
  name: string; // Display name
  getStackName: (env: Environment) => string; // Full CDK stack name
  description: string;
  dependsOn?: string[]; // Stack IDs this depends on (for deploy order)
  optional?: boolean; // If true, requires extra context (e.g., CloudFront)
  requiredContext?: string[]; // Context keys required for this stack
  region?: string; // Override deployment region (e.g., 'us-east-1' for Edge)
}

/**
 * Extra context variables for optional stacks
 * Cross-account CloudFront requires all of these
 */
export interface ExtraContext {
  // CloudFront/Edge context
  domainName?: string;
  hostedZoneId?: string;
  subjectAlternativeNames?: string[];
  /** Cross-account IAM role ARN for Route53 access */
  crossAccountRoleArn?: string;
  // Org project context
  /** Route53 hosted zone IDs to allow access to (comma-separated) */
  hostedZoneIds?: string;
  /** Trusted AWS account IDs (comma-separated) */
  trustedAccountIds?: string;
  /** External ID for additional security */
  externalId?: string;
  /** Generic additional context key-value pairs */
  additionalContext?: Record<string, string>;
}

export interface ProjectConfig {
  id: string;
  name: string;
  description: string;
  stacks: StackConfig[];
  cdkContext: (env: Environment, extra?: ExtraContext) => Record<string, string>;
}

// =============================================================================
// MONITORING PROJECT (Consolidated 3-Stack Architecture)
// =============================================================================

const monitoringStacks: StackConfig[] = [
  {
    id: 'storage',
    name: 'Storage Stack',
    getStackName: (env) => getStackId(Project.MONITORING, 'storage', env),
    description: 'EBS volume with DLM backups and lifecycle management',
  },
  {
    id: 'ssm',
    name: 'SSM Stack',
    getStackName: (env) => getStackId(Project.MONITORING, 'ssm', env),
    description: 'SSM Run Command document and S3 scripts bucket for monitoring configuration',
  },
  {
    id: 'compute',
    name: 'Compute Stack',
    getStackName: (env) => getStackId(Project.MONITORING, 'compute', env),
    description: 'Security group + EC2/ASG running Prometheus and Grafana',
    dependsOn: ['storage'],
  },
];

const monitoringProject: ProjectConfig = {
  id: 'monitoring',
  name: 'Monitoring',
  description: 'Prometheus + Grafana monitoring infrastructure (3-stack architecture)',
  stacks: monitoringStacks,
  cdkContext: (env) => ({
    project: 'monitoring',
    environment: env,
  }),
};

// =============================================================================
// NEXTJS PROJECT (Consolidated Domain-Based Stacks)
// =============================================================================

const nextjsStacks: StackConfig[] = [
  // -------------------------------------------------------------------------
  // Phase 1: Data Layer (ECR, DynamoDB, S3, SSM)
  // -------------------------------------------------------------------------
  {
    id: 'data',
    name: 'Data Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'data', env),
    description: 'DynamoDB table, S3 assets bucket, and SSM parameters (ECR is in Shared stack)',
  },

  // -------------------------------------------------------------------------
  // Phase 2: Compute Layer (ECS Cluster, IAM Roles, Auto Scaling)
  // -------------------------------------------------------------------------
  {
    id: 'compute',
    name: 'Compute Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'compute', env),
    description: 'ECS cluster, IAM roles, launch template, and auto scaling',
    dependsOn: ['data'],
  },

  // -------------------------------------------------------------------------
  // Phase 3: Networking Layer (ALB, Security Groups, Service Discovery)
  // -------------------------------------------------------------------------
  {
    id: 'networking',
    name: 'Networking Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'networking', env),
    description: 'Application Load Balancer, target groups, and security groups',
    dependsOn: ['compute'],
  },

  // -------------------------------------------------------------------------
  // Phase 4: Application Layer (ECS Services, Task Definitions)
  // -------------------------------------------------------------------------
  {
    id: 'application',
    name: 'Application Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'application', env),
    description: 'ECS service with NextJS task definition and auto-deploy Lambda',
    dependsOn: ['networking', 'compute'],
  },

  // -------------------------------------------------------------------------
  // Phase 4b: K8s Compute Layer (EC2 kubeadm worker + EIP + EBS)
  // Replaces: ECS Compute + Networking + Application stacks
  // -------------------------------------------------------------------------
  {
    id: 'k8sCompute',
    name: 'K8s Compute Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'k8sCompute', env),
    description: 'kubeadm Kubernetes worker node: EC2 + ASG + EBS + EIP for NextJS workloads',
    dependsOn: ['data'],
  },

  // -------------------------------------------------------------------------
  // Phase 5: API Layer (API Gateway, Lambda)
  // -------------------------------------------------------------------------
  {
    id: 'api',
    name: 'API Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'api', env),
    description: 'API Gateway with Lambda functions for articles CRUD',
    dependsOn: ['data'],
  },

  // -------------------------------------------------------------------------
  // Phase 6: Edge Layer (CloudFront, ACM, WAF) - us-east-1
  // -------------------------------------------------------------------------
  {
    id: 'edge',
    name: 'Edge Stack',
    getStackName: (env) => getStackId(Project.NEXTJS, 'edge', env),
    description: 'CloudFront distribution with ACM certificate and WAF (deploys to us-east-1)',
    dependsOn: ['networking', 'application', 'api'],
    region: 'us-east-1',
  },
];

const nextjsProject: ProjectConfig = {
  id: 'nextjs',
  name: 'NextJS',
  description: 'NextJS application on ECS with consolidated domain-based stacks (requires Shared VPC)',
  stacks: nextjsStacks,
  cdkContext: (env) => ({
    project: 'nextjs',
    environment: env,
  }),
};

// =============================================================================
// SHARED PROJECT (VPC + ECR shared infrastructure)
// =============================================================================

const sharedStacks: StackConfig[] = [
  {
    id: 'infra',
    name: 'Shared Infrastructure',
    getStackName: (env) => getStackId(Project.SHARED, 'infra', env),
    description: 'Shared VPC with public subnets and ECR repository',
  },
];

const sharedProject: ProjectConfig = {
  id: 'shared',
  name: 'Shared',
  description: 'Shared infrastructure (VPC, ECR) used by multiple projects',
  stacks: sharedStacks,
  cdkContext: (env) => ({
    project: 'shared',
    environment: env,
  }),
};

// =============================================================================
// ORG PROJECT
// =============================================================================

const orgStacks: StackConfig[] = [
  {
    id: 'dns-role',
    name: 'DNS Role Stack',
    getStackName: () => getStackId(Project.ORG, 'dnsRole', 'production'), // Always production for root account
    description: 'Cross-account DNS delegation role in root account',
  },
];

const orgProject: ProjectConfig = {
  id: 'org',
  name: 'Org',
  description: 'Root account resources for AWS Organizations',
  stacks: orgStacks,
  cdkContext: (_env, extra?: ExtraContext) => {
    const context: Record<string, string> = {
      project: 'org',
      environment: 'production', // Always production for root account
    };

    // Add org-specific context if provided (from ExtraContext)
    if (extra?.hostedZoneIds) {
      context.hostedZoneIds = extra.hostedZoneIds;
    }
    if (extra?.trustedAccountIds) {
      context.trustedAccountIds = extra.trustedAccountIds;
    }
    if (extra?.externalId) {
      context.externalId = extra.externalId;
    }

    // Add any additional generic context
    if (extra?.additionalContext) {
      Object.assign(context, extra.additionalContext);
    }

    return context;
  },
};

// =============================================================================
// K8S PROJECT (kubeadm Kubernetes Cluster — 6-Stack Architecture)
// Synth outputs all 6 stacks. Infra pipeline deploys Data→Base→Compute→AppIam→Edge.
// API stack is deployed by the Next.js thin wrapper pipeline.
// Bootstrap/app manifests synced by independent S3 sync pipelines.
// =============================================================================

const k8sStacks: StackConfig[] = [
  {
    id: 'data',
    name: 'Data Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'data', env),
    description: 'DynamoDB, S3 assets, SSM parameters for K8s application',
  },
  {
    id: 'base',
    name: 'Base Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'base', env),
    description: 'VPC networking, security group, KMS key, EBS volume, Elastic IP',
    dependsOn: ['data'],
  },
  {
    id: 'compute',
    name: 'Compute Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'compute', env),
    description: 'kubeadm Kubernetes cluster: EC2 + ASG + SSM documents + S3 scripts bucket',
    dependsOn: ['base'],
  },
  {
    id: 'appIam',
    name: 'App IAM Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'appIam', env),
    description: 'Application-tier IAM grants: DynamoDB, S3, Secrets Manager, SSM',
    dependsOn: ['compute'],
  },
  {
    id: 'api',
    name: 'API Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'api', env),
    description: 'API Gateway with Lambda for email subscriptions (subscribe + verify)',
    dependsOn: ['data'],
    optional: true, // Application-layer — deployed separately from infrastructure
  },
  {
    id: 'edge',
    name: 'Edge Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'edge', env),
    description: 'CloudFront distribution with ACM certificate and WAF (us-east-1)',
    dependsOn: ['compute'],
    region: 'us-east-1',
  },
];

const k8sProject: ProjectConfig = {
  id: 'kubernetes',
  name: 'Monitoring-K8s',
  description: 'Self-managed kubeadm Kubernetes cluster for unified workloads (requires Shared VPC)',
  stacks: k8sStacks,
  cdkContext: (env) => ({
    project: 'kubernetes',
    environment: env,
  }),
};

// =============================================================================
// EXPORTS
// =============================================================================

export const projects: ProjectConfig[] = [
  sharedProject,
  monitoringProject,
  nextjsProject,
  orgProject,
  k8sProject,
];

export function getProject(projectId: string): ProjectConfig | undefined {
  return projects.find((p) => p.id === projectId);
}

export function getStack(projectId: string, stackId: string): StackConfig | undefined {
  const project = getProject(projectId);
  return project?.stacks.find((s) => s.id === stackId);
}

export function getAllStacksForProject(projectId: string): StackConfig[] {
  return getProject(projectId)?.stacks ?? [];
}

/**
 * Get non-optional stacks for a project (excludes CloudFront etc.)
 */
export function getRequiredStacksForProject(projectId: string): StackConfig[] {
  return getAllStacksForProject(projectId).filter((s) => !s.optional);
}

/**
 * Get effective stacks based on provided context
 * Filters out optional stacks that lack required context
 */
export function getEffectiveStacks(
  projectId: string,
  extraContext?: ExtraContext
): { stacks: StackConfig[]; skipped: StackConfig[] } {
  const allStacks = getAllStacksForProject(projectId);
  const stacks: StackConfig[] = [];
  const skipped: StackConfig[] = [];

  for (const stack of allStacks) {
    if (!stack.optional) {
      stacks.push(stack);
      continue;
    }

    // Check if all required context is provided for optional stacks
    const requiredContext = stack.requiredContext ?? [];
    const hasAllContext = requiredContext.every((key) => {
      if (key === 'domainName') return !!extraContext?.domainName;
      if (key === 'hostedZoneId') return !!extraContext?.hostedZoneId;
      if (key === 'crossAccountRoleArn') return !!extraContext?.crossAccountRoleArn;
      return false;
    });

    if (hasAllContext) {
      stacks.push(stack);
    } else {
      skipped.push(stack);
    }
  }

  return { stacks, skipped };
}

/**
 * Check if a stack requires CloudFront/Edge context
 */
export function isCloudFrontStack(stackId: string): boolean {
  return stackId === 'edge';
}

/**
 * Get required context message for a stack
 */
export function getRequiredContextMessage(stack: StackConfig): string {
  if (!stack.requiredContext?.length) return '';
  return `Required context: ${stack.requiredContext.join(', ')}`;
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

export interface DefaultConfig {
  environment: Environment;
  awsProfile: string;
  awsRegion: string;
  awsAccountId?: string;
  outputDir: string;
  cdkOutDir: string;
}

export const defaults: DefaultConfig = {
  environment: 'development',
  awsProfile: 'dev-account',
  awsRegion: 'eu-west-1',
  outputDir: 'cdk-outputs',
  cdkOutDir: 'cdk.out',
};

// Profile mapping for environments
export const profileMap: Record<Environment, string> = {
  development: 'dev-account',
  staging: 'staging-account',
  production: 'prod-account',
};
