/**
 * Stack Configuration — CDK Layer
 *
 * Defines actual stack arrays with `getStackName` lambdas that call into
 * `getStackId()` from CDK's naming utility. Registers each project into
 * the shared `@repo/script-utils/stacks.js` registry at import time.
 *
 * Consumer scripts import from this file (or from `@repo/script-utils/stacks.js`
 * for pure types). This file re-exports everything from the shared module
 * so existing `./stacks.js` imports continue to work unchanged.
 */

// Re-export everything from the shared module so consumers don't need
// to change their import paths.
export {
  type DefaultConfig,
  type Environment,
  type ExtraContext,
  type ProjectConfig,
  type StackConfig,
  defaults,
  getAllStacksForProject,
  getEffectiveStacks,
  getProject,
  getRequiredContextMessage,
  getRequiredStacksForProject,
  getStack,
  isCloudFrontStack,
  profileMap,
  projectsMap,
} from '@repo/script-utils/stacks.js';

import {
  registerProject,
  type Environment,
  type ExtraContext,
  type StackConfig,
} from '@repo/script-utils/stacks.js';

import { Project } from '../../lib/config/projects.js';
import { getStackId } from '../../lib/utilities/naming.js';

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

registerProject({
  id: 'shared',
  name: 'Shared',
  description: 'Shared infrastructure (VPC, ECR) used by multiple projects',
  stacks: sharedStacks,
  cdkContext: (env) => ({
    project: 'shared',
    environment: env,
  }),
});

// =============================================================================
// ORG PROJECT
// =============================================================================

const orgStacks: StackConfig[] = [
  {
    id: 'dns-role',
    name: 'DNS Role Stack',
    getStackName: () =>
      getStackId(Project.ORG, 'dnsRole', 'production'), // Always production for root account
    description: 'Cross-account DNS delegation role in root account',
  },
];

registerProject({
  id: 'org',
  name: 'Org',
  description: 'Root account resources for AWS Organizations',
  stacks: orgStacks,
  cdkContext: (_env: Environment, extra?: ExtraContext) => {
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
});

// =============================================================================
// K8S PROJECT (kubeadm Kubernetes Cluster — 14-Stack Architecture)
// Synth outputs all 14 stacks. Infra pipeline deploys Data→Base→GoldenAmi→SSM→
// Compute→Workers(legacy+pool)→AppIam→Edge→Observability.
// API stack is deployed separately from core infrastructure.
// Bootstrap/app manifests synced by independent S3 sync pipelines.
//
// ASG Pool Stacks (additive — run alongside legacy workers during migration):
//   - generalPool:    general-purpose ASG (Next.js, ArgoCD, system components)
//   - monitoringPool: observability ASG (Prometheus, Grafana, Loki, Tempo)
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
    description:
      'VPC networking, security group, KMS key, EBS volume, Elastic IP',
    dependsOn: ['data'],
  },
  {
    id: 'goldenAmi',
    name: 'Golden AMI Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'goldenAmi', env),
    description:
      'EC2 Image Builder pipeline for baking Kubernetes Golden AMI',
    dependsOn: ['base'],
  },
  {
    id: 'ssmAutomation',
    name: 'SSM Automation Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'ssmAutomation', env),
    description:
      'SSM Automation documents for K8s bootstrap orchestration (control plane + worker)',
    dependsOn: ['base'],
  },
  {
    id: 'controlPlane',
    name: 'Control Plane Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'controlPlane', env),
    description:
      'kubeadm Kubernetes control plane: EC2 + ASG + SSM documents + S3 scripts bucket',
    dependsOn: ['base', 'ssmAutomation'],
  },
  {
    id: 'appWorker',
    name: 'App Worker Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'appWorker', env),
    description:
      'Application worker node: kubeadm join + role=application label/taint',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'monitoringWorker',
    name: 'Monitoring Worker Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'monitoringWorker', env),
    description:
      'Monitoring worker node: kubeadm join + role=monitoring label/taint',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'argocdWorker',
    name: 'ArgoCD Worker Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'argocdWorker', env),
    description:
      'ArgoCD worker node: kubeadm join + role=argocd label/taint (Spot)',
    dependsOn: ['controlPlane'],
  },
  // ---------------------------------------------------------------------------
  // ASG Pool Stacks — Kubernetes-Native, Parameterised (additive during migration)
  // These run in parallel with the legacy worker stacks until workloads are shifted.
  // ---------------------------------------------------------------------------
  {
    id: 'generalPool',
    name: 'General Pool ASG Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'generalPool', env),
    description:
      'General-purpose ASG pool (Next.js, ArgoCD, system components) — no taint',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'monitoringPool',
    name: 'Monitoring Pool ASG Stack',
    getStackName: (env) =>
      getStackId(Project.KUBERNETES, 'monitoringPool', env),
    description:
      'Monitoring ASG pool (Prometheus, Grafana, Loki, Tempo) — dedicated=monitoring:NoSchedule taint',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'appIam',
    name: 'App IAM Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'appIam', env),
    description:
      'Application-tier IAM grants: DynamoDB, S3, Secrets Manager, SSM',
    dependsOn: ['controlPlane'],
  },
  {
    id: 'api',
    name: 'API Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'api', env),
    description:
      'API Gateway with Lambda for email subscriptions (subscribe + verify)',
    dependsOn: ['data'],
    optional: true, // Application-layer — deployed separately from infrastructure
  },
  {
    id: 'edge',
    name: 'Edge Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'edge', env),
    description:
      'CloudFront distribution with ACM certificate and WAF (us-east-1)',
    dependsOn: ['controlPlane'],
    region: 'us-east-1',
  },
  {
    id: 'observability',
    name: 'Observability Stack',
    getStackName: (env) => getStackId(Project.KUBERNETES, 'observability', env),
    description:
      'CloudWatch pre-deployment dashboard for infrastructure monitoring',
    dependsOn: ['base'],
  },
];

registerProject({
  id: 'kubernetes',
  name: 'Kubernetes',
  description:
    'Self-managed kubeadm Kubernetes cluster for unified workloads (requires Shared VPC)',
  stacks: k8sStacks,
  cdkContext: (env) => {
    const context: Record<string, string> = {
      project: 'kubernetes',
      environment: env,
    };

    // Bridge ALLOW_IPV4 / ALLOW_IPV6 env vars (set by GitHub Actions from
    // environment secrets) into the CDK context parameter that base-stack.ts
    // reads via tryGetContext('adminAllowedIps').
    const ipParts = [process.env.ALLOW_IPV4, process.env.ALLOW_IPV6].filter(
      Boolean,
    );
    if (ipParts.length > 0) {
      context.adminAllowedIps = ipParts.join(',');
    }

    return context;
  },
});
