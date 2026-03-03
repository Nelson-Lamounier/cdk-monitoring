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
// K8S PROJECT (kubeadm Kubernetes Cluster — 10-Stack Architecture)
// Synth outputs all 10 stacks. Infra pipeline deploys Data→Base→GoldenAmi→SSM→Compute→Workers→AppIam→Edge.
// API stack is deployed separately from core infrastructure.
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
    id: 'goldenAmi',
    name: 'Golden AMI Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'goldenAmi', env),
    description: 'EC2 Image Builder pipeline for baking Kubernetes Golden AMI',
    dependsOn: ['base'],
  },
  {
    id: 'ssmAutomation',
    name: 'SSM Automation Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'ssmAutomation', env),
    description: 'SSM Automation documents for K8s bootstrap orchestration (control plane + worker)',
    dependsOn: ['base'],
  },
  {
    id: 'controlPlane',
    name: 'Control Plane Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'controlPlane', env),
    description: 'kubeadm Kubernetes control plane: EC2 + ASG + SSM documents + S3 scripts bucket',
    dependsOn: ['base', 'ssmAutomation'],
  },
  {
    id: 'appWorker',
    name: 'App Worker Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'appWorker', env),
    description: 'Application worker node: kubeadm join + role=application label/taint',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'monitoringWorker',
    name: 'Monitoring Worker Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'monitoringWorker', env),
    description: 'Monitoring worker node: kubeadm join + role=monitoring label/taint',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'appIam',
    name: 'App IAM Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'appIam', env),
    description: 'Application-tier IAM grants: DynamoDB, S3, Secrets Manager, SSM',
    dependsOn: ['controlPlane'],
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
    dependsOn: ['controlPlane'],
    region: 'us-east-1',
  },
];

const k8sProject: ProjectConfig = {
  id: 'kubernetes',
  name: 'Kubernetes',
  description: 'Self-managed kubeadm Kubernetes cluster for unified workloads (requires Shared VPC)',
  stacks: k8sStacks,
  cdkContext: (env) => {
    const context: Record<string, string> = {
      project: 'kubernetes',
      environment: env,
    };

    // WAF IP allowlist — bridged from GitHub Environment
    // RESTRICT_ACCESS (variable): "true"/"false" toggle
    // ALLOW_IPV4 / ALLOW_IPV6 (secrets): IPs in CIDR notation
    const restrictAccess = process.env.RESTRICT_ACCESS;
    if (restrictAccess) context.restrictAccess = restrictAccess;

    const ipv4 = process.env.ALLOW_IPV4;
    const ipv6 = process.env.ALLOW_IPV6;
    if (ipv4) context.allowedIps = JSON.stringify([ipv4]);
    if (ipv6) context.allowedIpv6s = JSON.stringify([ipv6]);

    return context;
  },
};

// =============================================================================
// EXPORTS
// =============================================================================

export const projects: ProjectConfig[] = [
  sharedProject,
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
