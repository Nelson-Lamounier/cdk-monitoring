/**
 * @fileoverview Predefined Architecture Decision Record (ADR) topics.
 *
 * Each topic maps to a real decision made in the project, with file
 * patterns that provide evidence for the decision context.
 *
 * @module data/adr-topics
 */

import type { AdrTopic } from '../types/index.js';

/** Predefined ADR topics auto-populated from repo evidence. */
export const ADR_TOPICS: readonly AdrTopic[] = [
  {
    id: 'self-managed-k8s-vs-eks',
    title: 'Self-Managed Kubernetes over EKS',
    context:
      'Chose kubeadm-based self-managed Kubernetes on EC2 over Amazon EKS for full control-plane ownership, deeper operational learning, and lower cost at a single-node scale.',
    evidencePatterns: [
      '**/controlPlan.yml',
      '**/kubeadm*',
      '**/kubernetes-app/**',
      '**/monitoring*',
    ],
  },
  {
    id: 'step-functions-over-lambda-orchestration',
    title: 'Step Functions over Direct Lambda Orchestration',
    context:
      'Chose AWS Step Functions for multi-step content generation and infrastructure self-healing workflows, rather than chaining Lambda invocations directly.',
    evidencePatterns: [
      '**/step-function*',
      '**/state-machine*',
      '**/bedrock-publisher/**',
      '**/lambda*',
    ],
  },
  {
    id: 'argocd-over-flux',
    title: 'ArgoCD over Flux for GitOps',
    context:
      'Chose ArgoCD for GitOps delivery due to its sync-wave orchestration, built-in UI, and ApplicationSet support for developer self-service.',
    evidencePatterns: [
      '**/argocd-apps/**',
      '**/argocd/**',
      '**/workload-generator*',
    ],
  },
  {
    id: 'cdk-over-terraform',
    title: 'AWS CDK over Terraform',
    context:
      'Chose AWS CDK for infrastructure-as-code, leveraging TypeScript type safety, L2/L3 constructs, CDK-nag compliance, and tight AWS-native integration.',
    evidencePatterns: [
      '**/cdk.json',
      '**/lib/**/*-stack.ts',
      '**/lib/**/*-construct.ts',
      '**/tsconfig.json',
    ],
  },
  {
    id: 'traefik-over-nginx-alb',
    title: 'Traefik over NGINX Ingress / ALB',
    context:
      'Chose Traefik as the ingress controller for its Kubernetes-native CRDs (IngressRoute), automatic TLS via cert-manager integration, and middleware support.',
    evidencePatterns: [
      '**/traefik*',
      '**/ingress*',
      '**/cert-manager*',
    ],
  },
  {
    id: 'crossplane-for-app-level-iac',
    title: 'Crossplane for Application-Level IaC',
    context:
      'Chose Crossplane XRDs for application-level AWS resources (S3, SQS) to keep them in the same GitOps pipeline as workloads, while CDK manages foundation infrastructure.',
    evidencePatterns: [
      '**/crossplane*',
      '**/x-*.yaml',
      '**/crossplane-iam*',
      '**/workload-generator*',
    ],
  },
] as const;
