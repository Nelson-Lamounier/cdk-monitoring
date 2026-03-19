/**
 * @fileoverview Scoped scan profiles for targeted implementation analysis.
 *
 * Each profile defines the glob patterns and skill categories relevant
 * to a specific implementation area (e.g., Crossplane, FinOps, networking).
 *
 * @module data/scope-profiles
 */

import type { ScopeProfile } from '../types/index.js';

/** Predefined scope profiles for scoped repo scanning. */
export const SCOPE_PROFILES: readonly ScopeProfile[] = [
  {
    id: 'crossplane',
    name: 'Crossplane — Infrastructure Abstraction',
    includePatterns: [
      '**/crossplane*',
      '**/xrd*',
      '**/x-*.yaml',
      '**/iam/crossplane*',
      '**/crossplane-providers*',
      '**/workload-generator*',
    ],
    focusCategories: ['platform-engineering', 'infrastructure-as-code', 'security-compliance'],
  },
  {
    id: 'finops',
    name: 'FinOps — Cost Management Foundation',
    includePatterns: [
      '**/finops*',
      '**/opencost*',
      '**/budget*',
      '**/cost*',
    ],
    focusCategories: ['operational-maturity', 'observability'],
  },
  {
    id: 'networking',
    name: 'Cloud Networking — VPC, NLB, Traefik',
    includePatterns: [
      '**/nlb*',
      '**/traefik*',
      '**/vpc*',
      '**/security-group*',
      '**/base-stack*',
      '**/edge-stack*',
      '**/cert-manager*',
      '**/ingress*',
    ],
    focusCategories: ['cloud-networking', 'security-compliance'],
  },
  {
    id: 'ci-cd',
    name: 'CI/CD & GitOps Pipeline',
    includePatterns: [
      '.github/workflows/*',
      '**/argocd-apps/**',
      '**/argocd/**',
    ],
    focusCategories: ['ci-cd-gitops', 'container-orchestration'],
  },
  {
    id: 'observability',
    name: 'Observability — Prometheus, Grafana, CloudWatch',
    includePatterns: [
      '**/monitoring*',
      '**/grafana*',
      '**/prometheus*',
      '**/dashboards/**',
      '**/cloudwatch*',
    ],
    focusCategories: ['observability'],
  },
  {
    id: 'security',
    name: 'Security & Compliance',
    includePatterns: [
      '**/security*',
      '**/guardduty*',
      '**/cdk-nag*',
      '**/iam/**',
      '**/networkpolicy*',
    ],
    focusCategories: ['security-compliance'],
  },
  {
    id: 'bedrock',
    name: 'AI/ML — Bedrock Content Pipeline',
    includePatterns: [
      '**/bedrock*',
      '**/step-function*',
      '**/state-machine*',
      '**/lambda*',
      '**/blog-persona*',
    ],
    focusCategories: ['ai-ml-ops', 'serverless-compute'],
  },
  {
    id: 'chaos',
    name: 'Chaos Testing & Self-Healing',
    includePatterns: [
      '**/step-function*',
      '**/state-machine*',
      '**/health*',
      '**/pdb*',
      '**/argocd-apps/**',
    ],
    focusCategories: ['operational-maturity', 'container-orchestration'],
  },
] as const;
