/**
 * @fileoverview DevOps/Cloud Engineering skills taxonomy.
 *
 * Curated from current job descriptions for DevOps, Cloud, Platform,
 * and SRE engineering roles. Each skill includes detection patterns
 * (glob + content regex) for evidence-based extraction.
 *
 * @module data/skills-taxonomy
 */

import type { SkillCategory } from '../types/index.js';

/** Complete skills taxonomy organised by job market categories. */
export const SKILLS_TAXONOMY: readonly SkillCategory[] = [
  {
    id: 'infrastructure-as-code',
    name: 'Infrastructure as Code',
    skills: [
      {
        id: 'aws-cdk',
        name: 'AWS CDK',
        demand: 'high',
        detectionPatterns: ['**/cdk.json', '**/lib/**/*-stack.ts', '**/lib/**/*-construct.ts'],
        contentPatterns: ['aws-cdk-lib', 'constructs', 'cdk\\.Construct'],
      },
      {
        id: 'cloudformation',
        name: 'CloudFormation',
        demand: 'high',
        detectionPatterns: ['**/*.template.json', '**/*.template.yaml', '**/cdk.out/**/*.template.json'],
        contentPatterns: ['AWSTemplateFormatVersion', 'AWS::CloudFormation'],
      },
      {
        id: 'crossplane-xrds',
        name: 'Crossplane XRDs',
        demand: 'medium-high',
        detectionPatterns: ['**/crossplane*', '**/x-*.yaml', '**/*-xrd*.yaml'],
        contentPatterns: ['CompositeResourceDefinition', 'apiextensions\\.crossplane\\.io'],
      },
    ],
  },
  {
    id: 'container-orchestration',
    name: 'Container Orchestration',
    skills: [
      {
        id: 'kubernetes-selfmanaged',
        name: 'Kubernetes (Self-Managed)',
        demand: 'high',
        detectionPatterns: ['**/controlPlan.yml', '**/kubeadm*', '**/kubernetes-app/**'],
        contentPatterns: ['kubeadm', 'kubelet', 'apiVersion.*v1'],
      },
      {
        id: 'helm',
        name: 'Helm Charts',
        demand: 'high',
        detectionPatterns: ['**/Chart.yaml', '**/values.yaml', '**/templates/**/*.yaml'],
        contentPatterns: ['apiVersion.*v2', 'helm\\.sh/chart'],
      },
      {
        id: 'argocd',
        name: 'ArgoCD',
        demand: 'high',
        detectionPatterns: ['**/argocd-apps/**', '**/argocd/**'],
        contentPatterns: ['argoproj\\.io', 'Application', 'ApplicationSet'],
      },
      {
        id: 'docker',
        name: 'Docker / Containerisation',
        demand: 'high',
        detectionPatterns: ['**/Dockerfile', '**/docker-compose.yml', '**/.dockerignore'],
        contentPatterns: ['FROM ', 'ENTRYPOINT', 'docker-compose'],
      },
    ],
  },
  {
    id: 'ci-cd-gitops',
    name: 'CI/CD & GitOps',
    skills: [
      {
        id: 'github-actions',
        name: 'GitHub Actions',
        demand: 'high',
        detectionPatterns: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
        contentPatterns: ['uses:', 'jobs:', 'on:.*push'],
      },
      {
        id: 'argocd-applicationsets',
        name: 'ArgoCD ApplicationSets',
        demand: 'medium-high',
        detectionPatterns: ['**/argocd-apps/**'],
        contentPatterns: ['ApplicationSet', 'generators'],
      },
      {
        id: 'gitops-sync-waves',
        name: 'GitOps Sync-Wave Orchestration',
        demand: 'medium',
        detectionPatterns: ['**/argocd-apps/**'],
        contentPatterns: ['argocd\\.argoproj\\.io/sync-wave'],
      },
    ],
  },
  {
    id: 'cloud-networking',
    name: 'Cloud Networking',
    skills: [
      {
        id: 'vpc-networking',
        name: 'VPC / Subnet Architecture',
        demand: 'high',
        detectionPatterns: ['**/vpc*', '**/networking*', '**/base-stack*'],
        contentPatterns: ['ec2\\.Vpc', 'SubnetType', 'SecurityGroup'],
      },
      {
        id: 'load-balancing',
        name: 'Network Load Balancer (NLB)',
        demand: 'high',
        detectionPatterns: ['**/nlb*', '**/load-balancer*'],
        contentPatterns: ['NetworkLoadBalancer', 'elbv2'],
      },
      {
        id: 'traefik-ingress',
        name: 'Traefik Ingress Controller',
        demand: 'medium',
        detectionPatterns: ['**/traefik*', '**/ingress*'],
        contentPatterns: ['traefik', 'IngressRoute', 'entryPoints'],
      },
      {
        id: 'dns-tls',
        name: 'DNS / TLS Certificate Management',
        demand: 'high',
        detectionPatterns: ['**/cert-manager*', '**/cloudfront*', '**/edge-stack*'],
        contentPatterns: ['cert-manager', 'ClusterIssuer', 'Certificate', 'acm'],
      },
    ],
  },
  {
    id: 'observability',
    name: 'Observability',
    skills: [
      {
        id: 'prometheus',
        name: 'Prometheus',
        demand: 'high',
        detectionPatterns: ['**/prometheus*', '**/monitoring*'],
        contentPatterns: ['kube-prometheus-stack', 'ServiceMonitor', 'prometheus'],
      },
      {
        id: 'grafana',
        name: 'Grafana Dashboards',
        demand: 'high',
        detectionPatterns: ['**/grafana*', '**/dashboards/**/*.json'],
        contentPatterns: ['grafana', 'dashboard', 'panels'],
      },
      {
        id: 'cloudwatch',
        name: 'CloudWatch',
        demand: 'high',
        detectionPatterns: ['**/cloudwatch*'],
        contentPatterns: ['cloudwatch', 'LogGroup', 'MetricFilter'],
      },
      {
        id: 'opencost',
        name: 'OpenCost',
        demand: 'medium',
        detectionPatterns: ['**/opencost*'],
        contentPatterns: ['opencost'],
      },
    ],
  },
  {
    id: 'security-compliance',
    name: 'Security & Compliance',
    skills: [
      {
        id: 'iam-least-privilege',
        name: 'IAM Least-Privilege Policies',
        demand: 'high',
        detectionPatterns: ['**/iam/**', '**/iam-*'],
        contentPatterns: ['PolicyStatement', 'iam\\.Effect', 'Condition'],
      },
      {
        id: 'guardduty',
        name: 'GuardDuty',
        demand: 'medium-high',
        detectionPatterns: ['**/security*', '**/guardduty*'],
        contentPatterns: ['guardduty', 'GuardDuty'],
      },
      {
        id: 'cdk-nag',
        name: 'CDK-nag Compliance',
        demand: 'medium',
        detectionPatterns: ['**/cdk.json', '**/lib/**/*.ts'],
        contentPatterns: ['cdk-nag', 'AwsSolutions', 'NagSuppressions'],
      },
      {
        id: 'network-policies',
        name: 'Kubernetes NetworkPolicies',
        demand: 'medium-high',
        detectionPatterns: ['**/networkpolicy*', '**/network-policy*'],
        contentPatterns: ['NetworkPolicy', 'policyTypes', 'ingress.*from'],
      },
    ],
  },
  {
    id: 'platform-engineering',
    name: 'Platform Engineering',
    skills: [
      {
        id: 'crossplane-providers',
        name: 'Crossplane AWS Providers',
        demand: 'medium-high',
        detectionPatterns: ['**/crossplane-providers*', '**/provider-aws*'],
        contentPatterns: ['provider-aws', 'ProviderConfig', 'ControllerConfig'],
      },
      {
        id: 'golden-path-templates',
        name: 'Golden-Path Service Templates',
        demand: 'medium-high',
        detectionPatterns: ['**/golden-path*', '**/workloads/charts/**'],
        contentPatterns: ['PodDisruptionBudget', 'HorizontalPodAutoscaler'],
      },
      {
        id: 'self-service-platform',
        name: 'Self-Service Developer Platform',
        demand: 'medium-high',
        detectionPatterns: ['**/workload-generator*', '**/applicationset*'],
        contentPatterns: ['ApplicationSet', 'generators.*gitDirectoryGenerator'],
      },
    ],
  },
  {
    id: 'serverless-compute',
    name: 'Serverless & Compute',
    skills: [
      {
        id: 'aws-lambda',
        name: 'AWS Lambda',
        demand: 'medium',
        detectionPatterns: ['**/lambda*'],
        contentPatterns: ['lambda\\.Function', 'NodejsFunction', '@aws-sdk/client-lambda'],
      },
      {
        id: 'step-functions',
        name: 'AWS Step Functions',
        demand: 'medium',
        detectionPatterns: ['**/step-function*', '**/state-machine*'],
        contentPatterns: ['StateMachine', 'stepfunctions', 'sfn\\.'],
      },
      {
        id: 'ec2-management',
        name: 'EC2 Instance Management',
        demand: 'medium',
        detectionPatterns: ['**/ec2*', '**/instance*'],
        contentPatterns: ['ec2\\.Instance', 'AutoScalingGroup', 'LaunchTemplate'],
      },
    ],
  },
  {
    id: 'data-storage',
    name: 'Data & Storage',
    skills: [
      {
        id: 'dynamodb',
        name: 'DynamoDB',
        demand: 'medium',
        detectionPatterns: ['**/dynamo*', '**/data-stack*'],
        contentPatterns: ['dynamodb', 'Table', 'partitionKey'],
      },
      {
        id: 's3',
        name: 'S3',
        demand: 'medium',
        detectionPatterns: ['**/s3*', '**/bucket*'],
        contentPatterns: ['s3\\.Bucket', '@aws-sdk/client-s3'],
      },
      {
        id: 'sqs',
        name: 'SQS',
        demand: 'medium',
        detectionPatterns: ['**/sqs*', '**/queue*'],
        contentPatterns: ['sqs\\.Queue', '@aws-sdk/client-sqs'],
      },
      {
        id: 'secrets-manager',
        name: 'Secrets Manager',
        demand: 'medium',
        detectionPatterns: ['**/secret*'],
        contentPatterns: ['secretsmanager', 'Secret'],
      },
    ],
  },
  {
    id: 'ai-ml-ops',
    name: 'AI/ML Ops',
    skills: [
      {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        demand: 'medium',
        detectionPatterns: ['**/bedrock*'],
        contentPatterns: ['bedrock', 'KnowledgeBase', 'InvokeModel'],
      },
      {
        id: 'agentic-pipelines',
        name: 'Agentic Content Pipelines',
        demand: 'medium',
        detectionPatterns: ['**/bedrock-publisher*', '**/blog-persona*'],
        contentPatterns: ['persona', 'content.*pipeline', 'article.*generation'],
      },
    ],
  },
  {
    id: 'developer-experience',
    name: 'Developer Experience',
    skills: [
      {
        id: 'mcp-servers',
        name: 'MCP Server Development',
        demand: 'medium',
        detectionPatterns: ['**/mcp-*/**'],
        contentPatterns: ['@modelcontextprotocol/sdk', 'McpServer'],
      },
      {
        id: 'typescript',
        name: 'TypeScript (Strict)',
        demand: 'high',
        detectionPatterns: ['**/tsconfig.json'],
        contentPatterns: ['"strict":\\s*true'],
      },
      {
        id: 'documentation-as-code',
        name: 'Documentation-as-Code',
        demand: 'medium',
        detectionPatterns: ['**/docs/**', '**/articles-draft/**', '**/typedoc.json', '**/README.md'],
        contentPatterns: ['typedoc', 'AG-DOC-01'],
      },
      {
        id: 'jsdoc-coverage',
        name: 'JSDoc/TSDoc Coverage',
        demand: 'medium',
        detectionPatterns: ['**/*.ts', '**/*.tsx'],
        contentPatterns: ['/\\*\\*', '@param', '@returns'],
      },
      {
        id: 'dry-compliance',
        name: 'DRY Principle Compliance',
        demand: 'medium',
        detectionPatterns: ['**/lib/**/*.ts', '**/src/**/*.ts'],
        contentPatterns: ['import.*from', 'export.*function'],
      },
      {
        id: 'strict-typing',
        name: 'Strict Typing Enforcement',
        demand: 'high',
        detectionPatterns: ['**/tsconfig.json', '**/*.ts'],
        contentPatterns: ['"strict":\\s*true', 'import\\s+type'],
      },
    ],
  },
  {
    id: 'operational-maturity',
    name: 'Operational Maturity',
    skills: [
      {
        id: 'finops',
        name: 'FinOps / Cost Management',
        demand: 'medium-high',
        detectionPatterns: ['**/finops*', '**/budget*', '**/opencost*'],
        contentPatterns: ['Budget', 'CostAllocation', 'cost-centre'],
      },
      {
        id: 'automated-testing',
        name: 'Automated Testing (Jest)',
        demand: 'high',
        detectionPatterns: ['**/tests/**', '**/*.test.ts', '**/*.spec.ts', '**/jest.config*'],
        contentPatterns: ['describe\\(', 'it\\(', 'expect\\('],
      },
      {
        id: 'eslint-code-quality',
        name: 'ESLint / Code Quality',
        demand: 'medium',
        detectionPatterns: ['**/eslint.config*', '**/.eslintrc*'],
        contentPatterns: ['eslint', 'no-unused-vars'],
      },
    ],
  },
] as const;
