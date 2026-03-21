/**
 * @fileoverview Predefined decision analysis templates.
 *
 * Each template maps to a real architectural decision in the portfolio,
 * with pre-populated criteria, options, scores, and risk assessments.
 * The agent can use these as-is or override with custom parameters.
 *
 * @module data/decision-templates
 */

import type { DecisionTemplate } from '../types/index.js';

/** Predefined decision templates mapped to the portfolio's real decisions. */
export const DECISION_TEMPLATES: readonly DecisionTemplate[] = [
  {
    id: 'hosting-platform',
    title: 'Application Hosting Platform',
    context:
      'Choosing where to host the Next.js application and supporting services. Must balance operational control, cost, learning value, and production readiness.',
    criteria: [
      { name: 'Operational Complexity', weight: 0.2, description: 'Day-to-day operational burden and maintenance effort.' },
      { name: 'Cost Efficiency', weight: 0.25, description: 'Monthly running cost at portfolio scale (single developer, low traffic).' },
      { name: 'Learning Value', weight: 0.25, description: 'Depth of transferable skills gained from operating this platform.' },
      { name: 'Production Readiness', weight: 0.15, description: 'How close the setup is to enterprise production standards.' },
      { name: 'Scalability', weight: 0.15, description: 'Ability to scale horizontally if demand increases.' },
    ],
    options: [
      {
        id: 'self-managed-k8s',
        name: 'Self-Managed Kubernetes (kubeadm on EC2)',
        description: 'Full control-plane ownership on EC2 instances using kubeadm, with Traefik ingress and ArgoCD GitOps.',
        prosAndCons: {
          pros: [
            'Deep understanding of Kubernetes internals',
            'Full control over networking, storage, and scheduling',
            'Strong portfolio signal — demonstrates operational maturity',
            'Lower cost than managed K8s at single-node scale',
          ],
          cons: [
            'Sole responsibility for upgrades, etcd backups, and certificate rotation',
            'No SLA — downtime recovery depends on one person',
            'Higher initial setup time compared to managed services',
          ],
        },
        scores: {
          'Operational Complexity': 2,
          'Cost Efficiency': 4,
          'Learning Value': 5,
          'Production Readiness': 3,
          'Scalability': 3,
        },
        risks: [
          { risk: 'Control plane failure with no automated recovery', probability: 'medium', impact: 'high', mitigation: 'Automated etcd snapshots to S3, user-data bootstrap recovery script.' },
          { risk: 'Certificate expiry causing API server downtime', probability: 'low', impact: 'high', mitigation: 'cert-manager with automated renewal monitoring via Prometheus alerts.' },
        ],
        shortTermScore: 3,
        longTermScore: 5,
      },
      {
        id: 'eks',
        name: 'Amazon EKS',
        description: 'AWS-managed Kubernetes control plane with managed node groups.',
        prosAndCons: {
          pros: [
            'AWS-managed control plane with 99.95% SLA',
            'Integrated IAM, VPC, and CloudWatch observability',
            'Managed upgrades and automatic patching',
          ],
          cons: [
            'Higher cost ($0.10/hr for control plane + node costs)',
            'Less differentiation in portfolio — EKS is the default choice',
            'Abstracts away control-plane knowledge',
          ],
        },
        scores: {
          'Operational Complexity': 4,
          'Cost Efficiency': 2,
          'Learning Value': 3,
          'Production Readiness': 5,
          'Scalability': 5,
        },
        risks: [
          { risk: 'Cost overrun from managed node groups at idle', probability: 'high', impact: 'medium', mitigation: 'Use Karpenter for scale-to-zero node management.' },
        ],
        shortTermScore: 5,
        longTermScore: 4,
      },
      {
        id: 'ecs-fargate',
        name: 'Amazon ECS Fargate',
        description: 'Serverless container orchestration — no cluster management required.',
        prosAndCons: {
          pros: [
            'Zero cluster management — purely container-focused',
            'Pay-per-task pricing scales to zero',
            'Tight integration with ALB, CloudMap, and CodeDeploy',
          ],
          cons: [
            'Limited Kubernetes ecosystem (no Helm, no ArgoCD)',
            'Less transferable to non-AWS environments',
            'No custom scheduling or admission controllers',
          ],
        },
        scores: {
          'Operational Complexity': 5,
          'Cost Efficiency': 3,
          'Learning Value': 2,
          'Production Readiness': 5,
          'Scalability': 4,
        },
        risks: [
          { risk: 'Vendor lock-in limiting multi-cloud portability', probability: 'medium', impact: 'low', mitigation: 'Containerise with standard Dockerfiles to reduce migration cost.' },
        ],
        shortTermScore: 5,
        longTermScore: 2,
      },
      {
        id: 'ec2-direct',
        name: 'Direct EC2 Deployment',
        description: 'Traditional deployment directly on EC2 instances with process managers (PM2/systemd).',
        prosAndCons: {
          pros: [
            'Simplest possible setup — SSH and deploy',
            'Lowest cost for a single-instance portfolio',
            'No container or orchestration overhead',
          ],
          cons: [
            'No container isolation or reproducible builds',
            'Manual scaling and deployment orchestration',
            'Weak portfolio signal — doesn\'t demonstrate modern practices',
          ],
        },
        scores: {
          'Operational Complexity': 4,
          'Cost Efficiency': 5,
          'Learning Value': 1,
          'Production Readiness': 2,
          'Scalability': 1,
        },
        risks: [
          { risk: 'Snowflake server configuration drift', probability: 'high', impact: 'medium', mitigation: 'Use Ansible or user-data scripts for idempotent provisioning.' },
        ],
        shortTermScore: 5,
        longTermScore: 1,
      },
    ],
    evidencePatterns: [
      '**/kubernetes-app/**',
      '**/controlPlan.yml',
      '**/kubeadm*',
      '**/argocd-apps/**',
      '**/traefik*',
    ],
  },
  {
    id: 'iac-tool',
    title: 'Infrastructure as Code Tool',
    context:
      'Selecting the primary IaC tool for defining and deploying AWS infrastructure. Must support TypeScript, integrate with CI/CD, and provide strong type safety.',
    criteria: [
      { name: 'Type Safety', weight: 0.25, description: 'Compile-time validation and IDE support for infrastructure definitions.' },
      { name: 'AWS Integration', weight: 0.25, description: 'Depth of native AWS service support and construct libraries.' },
      { name: 'Community & Ecosystem', weight: 0.2, description: 'Available constructs, documentation, and community support.' },
      { name: 'Learning Curve', weight: 0.15, description: 'Time to proficiency for a TypeScript developer.' },
      { name: 'Multi-Cloud Support', weight: 0.15, description: 'Ability to target non-AWS providers if needed.' },
    ],
    options: [
      {
        id: 'aws-cdk',
        name: 'AWS CDK',
        description: 'AWS-native IaC using TypeScript with L2/L3 constructs and CDK-nag compliance.',
        prosAndCons: {
          pros: ['Full TypeScript type safety', 'L2/L3 constructs reduce boilerplate', 'CDK-nag for compliance', 'Direct CloudFormation integration'],
          cons: ['AWS-only', 'CloudFormation limits apply', 'Slower synth/deploy cycle than Terraform'],
        },
        scores: { 'Type Safety': 5, 'AWS Integration': 5, 'Community & Ecosystem': 4, 'Learning Curve': 4, 'Multi-Cloud Support': 1 },
        risks: [
          { risk: 'CloudFormation resource limits on large stacks', probability: 'low', impact: 'medium', mitigation: 'Split into nested stacks with cross-stack references.' },
        ],
        shortTermScore: 5,
        longTermScore: 4,
      },
      {
        id: 'terraform',
        name: 'Terraform (HCL)',
        description: 'HashiCorp IaC with HCL syntax and multi-cloud provider support.',
        prosAndCons: {
          pros: ['Multi-cloud support', 'Massive provider ecosystem', 'Mature state management', 'Industry standard for platform teams'],
          cons: ['HCL lacks TypeScript-level type safety', 'State file management complexity', 'No native construct abstraction'],
        },
        scores: { 'Type Safety': 2, 'AWS Integration': 4, 'Community & Ecosystem': 5, 'Learning Curve': 3, 'Multi-Cloud Support': 5 },
        risks: [
          { risk: 'State file corruption or lock contention', probability: 'low', impact: 'high', mitigation: 'Use S3 + DynamoDB state backend with versioning.' },
        ],
        shortTermScore: 4,
        longTermScore: 5,
      },
      {
        id: 'pulumi',
        name: 'Pulumi',
        description: 'Multi-language IaC using real programming languages including TypeScript.',
        prosAndCons: {
          pros: ['TypeScript-native', 'Multi-cloud support', 'Real programming language constructs', 'Policy-as-code built-in'],
          cons: ['Smaller community than Terraform', 'Managed state service adds cost', 'Fewer pre-built components'],
        },
        scores: { 'Type Safety': 5, 'AWS Integration': 3, 'Community & Ecosystem': 3, 'Learning Curve': 4, 'Multi-Cloud Support': 4 },
        risks: [
          { risk: 'Vendor dependency on Pulumi Cloud for state', probability: 'medium', impact: 'medium', mitigation: 'Self-host Pulumi state backend on S3.' },
        ],
        shortTermScore: 4,
        longTermScore: 4,
      },
    ],
    evidencePatterns: [
      '**/cdk.json',
      '**/lib/**/*-stack.ts',
      '**/lib/**/*-construct.ts',
      '**/tsconfig.json',
    ],
  },
  {
    id: 'ingress-controller',
    title: 'Ingress Controller Selection',
    context:
      'Choosing the edge traffic management layer for Kubernetes. Must support TLS termination, path-based routing, and integrate with cert-manager.',
    criteria: [
      { name: 'K8s-Native CRDs', weight: 0.25, description: 'Support for custom Kubernetes resources (IngressRoute, middleware).' },
      { name: 'TLS Automation', weight: 0.25, description: 'Integration with cert-manager for automatic certificate provisioning.' },
      { name: 'Observability', weight: 0.2, description: 'Built-in metrics, tracing, and access logging.' },
      { name: 'Resource Footprint', weight: 0.15, description: 'Memory and CPU consumption at idle.' },
      { name: 'Configuration Flexibility', weight: 0.15, description: 'Middleware chains, rate limiting, IP allowlisting.' },
    ],
    options: [
      {
        id: 'traefik',
        name: 'Traefik',
        description: 'Cloud-native edge router with K8s CRDs, automatic TLS, and middleware support.',
        prosAndCons: {
          pros: ['IngressRoute CRD for declarative routing', 'Built-in Let\'s Encrypt via cert-manager', 'Middleware chains (IP allowlist, headers)', 'Dashboard for debugging'],
          cons: ['Smaller community than NGINX', 'Custom CRDs add learning curve', 'Enterprise features require paid licence'],
        },
        scores: { 'K8s-Native CRDs': 5, 'TLS Automation': 5, 'Observability': 4, 'Resource Footprint': 4, 'Configuration Flexibility': 5 },
        risks: [
          { risk: 'CRD version conflicts during Traefik upgrades', probability: 'low', impact: 'medium', mitigation: 'Pin CRD versions in Helm values, test upgrades in staging.' },
        ],
        shortTermScore: 4,
        longTermScore: 5,
      },
      {
        id: 'nginx-ingress',
        name: 'NGINX Ingress Controller',
        description: 'The most widely deployed K8s ingress controller, using standard Ingress resources.',
        prosAndCons: {
          pros: ['Industry standard — widely understood', 'Massive community and documentation', 'Annotation-based configuration'],
          cons: ['Uses annotations over CRDs — less type-safe', 'Complex NGINX config snippets for advanced routing', 'No built-in dashboard'],
        },
        scores: { 'K8s-Native CRDs': 2, 'TLS Automation': 4, 'Observability': 3, 'Resource Footprint': 3, 'Configuration Flexibility': 3 },
        risks: [
          { risk: 'Annotation sprawl making debugging difficult', probability: 'medium', impact: 'low', mitigation: 'Enforce annotation standards via OPA/Gatekeeper policies.' },
        ],
        shortTermScore: 5,
        longTermScore: 3,
      },
      {
        id: 'alb-ingress',
        name: 'AWS ALB Ingress Controller',
        description: 'AWS-native load balancer integration, provisioning ALBs per Ingress resource.',
        prosAndCons: {
          pros: ['AWS-managed — no in-cluster proxy', 'Native WAF and Shield integration', 'Scales automatically with AWS infrastructure'],
          cons: ['One ALB per Ingress — expensive at scale', 'No in-cluster traffic control', 'Requires EKS or well-configured AWS integration'],
        },
        scores: { 'K8s-Native CRDs': 2, 'TLS Automation': 3, 'Observability': 4, 'Resource Footprint': 5, 'Configuration Flexibility': 2 },
        risks: [
          { risk: 'ALB cost accumulation with multiple services', probability: 'high', impact: 'medium', mitigation: 'Use shared ALB with target group routing.' },
        ],
        shortTermScore: 4,
        longTermScore: 2,
      },
    ],
    evidencePatterns: [
      '**/traefik*',
      '**/ingress*',
      '**/cert-manager*',
      '**/middleware*',
    ],
  },
  {
    id: 'gitops-engine',
    title: 'GitOps Continuous Delivery Engine',
    context:
      'Selecting the GitOps engine for declarative, Git-driven deployments to Kubernetes. Must support sync-wave ordering, ApplicationSets, and self-service onboarding.',
    criteria: [
      { name: 'Sync Orchestration', weight: 0.25, description: 'Ability to order deployments (sync waves, dependencies).' },
      { name: 'Developer Self-Service', weight: 0.2, description: 'ApplicationSet generators or similar for automated app onboarding.' },
      { name: 'UI & Observability', weight: 0.2, description: 'Built-in dashboard for deployment status and drift detection.' },
      { name: 'Resource Footprint', weight: 0.15, description: 'Memory and CPU consumption in the cluster.' },
      { name: 'Multi-Cluster Support', weight: 0.2, description: 'Ability to manage deployments across multiple clusters.' },
    ],
    options: [
      {
        id: 'argocd',
        name: 'ArgoCD',
        description: 'Declarative GitOps CD with sync waves, ApplicationSets, and a built-in UI.',
        prosAndCons: {
          pros: ['Sync-wave ordering for complex deployments', 'ApplicationSet for self-service onboarding', 'Rich web UI with diff views', 'Active CNCF project'],
          cons: ['Higher memory footprint (~500MB baseline)', 'Redis dependency for caching', 'Complex RBAC configuration'],
        },
        scores: { 'Sync Orchestration': 5, 'Developer Self-Service': 5, 'UI & Observability': 5, 'Resource Footprint': 2, 'Multi-Cluster Support': 4 },
        risks: [
          { risk: 'Redis pod crash causing ArgoCD UI failures', probability: 'medium', impact: 'low', mitigation: 'Pin Redis image version, configure resource limits and liveness probes.' },
        ],
        shortTermScore: 4,
        longTermScore: 5,
      },
      {
        id: 'flux',
        name: 'Flux CD',
        description: 'Lightweight GitOps toolkit using native Kubernetes controllers.',
        prosAndCons: {
          pros: ['Lower resource footprint than ArgoCD', 'Native Kubernetes controllers (no custom server)', 'OCI artifact support for Helm charts', 'Simpler architecture'],
          cons: ['No built-in UI (requires Weave GitOps or similar)', 'Less mature ApplicationSet equivalent', 'Smaller community'],
        },
        scores: { 'Sync Orchestration': 3, 'Developer Self-Service': 3, 'UI & Observability': 2, 'Resource Footprint': 5, 'Multi-Cluster Support': 4 },
        risks: [
          { risk: 'Limited visibility without a UI during incidents', probability: 'medium', impact: 'medium', mitigation: 'Deploy Weave GitOps UI or use kubectl plugins for status.' },
        ],
        shortTermScore: 4,
        longTermScore: 3,
      },
    ],
    evidencePatterns: [
      '**/argocd-apps/**',
      '**/argocd/**',
      '**/workload-generator*',
      '**/appset*',
    ],
  },
  {
    id: 'monitoring-stack',
    title: 'Observability & Monitoring Stack',
    context:
      'Selecting the monitoring and observability platform for Kubernetes workloads and AWS infrastructure. Must cover metrics, logs, traces, and dashboards.',
    criteria: [
      { name: 'Metrics Coverage', weight: 0.25, description: 'Breadth of metrics collection (node, pod, application, custom).' },
      { name: 'Log Aggregation', weight: 0.2, description: 'Structured log collection, querying, and retention.' },
      { name: 'Cost', weight: 0.25, description: 'Total cost of ownership including storage and compute.' },
      { name: 'Dashboard Quality', weight: 0.15, description: 'Pre-built and custom dashboard capabilities.' },
      { name: 'Alerting', weight: 0.15, description: 'Alert routing, escalation, and notification integrations.' },
    ],
    options: [
      {
        id: 'prometheus-grafana-loki',
        name: 'Prometheus + Grafana + Loki',
        description: 'Open-source, self-hosted observability stack with community dashboards.',
        prosAndCons: {
          pros: ['Zero licence cost', 'Deep Kubernetes-native metrics', 'Grafana ecosystem (dashboards, alerting)', 'Loki for lightweight log aggregation'],
          cons: ['Self-managed — requires storage, retention, upgrades', 'Resource consumption in-cluster', 'No managed SLA'],
        },
        scores: { 'Metrics Coverage': 5, 'Log Aggregation': 4, 'Cost': 5, 'Dashboard Quality': 5, 'Alerting': 4 },
        risks: [
          { risk: 'Prometheus TSDB storage growth causing OOM', probability: 'medium', impact: 'high', mitigation: 'Configure retention policies (3-day default), use remote write for long-term.' },
        ],
        shortTermScore: 3,
        longTermScore: 5,
      },
      {
        id: 'cloudwatch',
        name: 'Amazon CloudWatch',
        description: 'AWS-native monitoring with Container Insights, Logs, and dashboards.',
        prosAndCons: {
          pros: ['Zero infrastructure to manage', 'Native AWS integration', 'Container Insights for EKS/ECS', 'Alarm → SNS → Lambda pipelines'],
          cons: ['Per-metric and per-query pricing adds up', 'Dashboard UX inferior to Grafana', 'Limited custom metric flexibility'],
        },
        scores: { 'Metrics Coverage': 3, 'Log Aggregation': 4, 'Cost': 2, 'Dashboard Quality': 3, 'Alerting': 4 },
        risks: [
          { risk: 'Unexpected costs from high-cardinality custom metrics', probability: 'high', impact: 'medium', mitigation: 'Enforce metric namespace limits and review billing dashboards weekly.' },
        ],
        shortTermScore: 5,
        longTermScore: 3,
      },
    ],
    evidencePatterns: [
      '**/monitoring/**',
      '**/prometheus*',
      '**/grafana*',
      '**/loki*',
      '**/dashboards/**',
    ],
  },
  {
    id: 'content-pipeline',
    title: 'AI Content Generation Pipeline',
    context:
      'Selecting the architecture for AI-powered article generation. Must integrate with Bedrock, handle markdown transformation, and store versioned content.',
    criteria: [
      { name: 'Reliability', weight: 0.25, description: 'Determinism and failure predictability of the pipeline.' },
      { name: 'Cost Efficiency', weight: 0.2, description: 'Per-invocation cost including compute and API calls.' },
      { name: 'Extensibility', weight: 0.2, description: 'Ease of adding new steps, tools, or capabilities.' },
      { name: 'Complexity', weight: 0.2, description: 'Development and maintenance burden.' },
      { name: 'Portfolio Signal', weight: 0.15, description: 'How well this demonstrates AI engineering skills to employers.' },
    ],
    options: [
      {
        id: 'lambda-monolith',
        name: 'Lambda Monolith (Current)',
        description: 'Single Lambda with hardcoded steps: S3 read → complexity analysis → Bedrock transform → S3/DynamoDB write.',
        prosAndCons: {
          pros: ['Deterministic — same input, same output', 'Minimal infrastructure', 'Proven and debugged', 'Lowest cost per invocation'],
          cons: ['Adding steps requires code changes', 'No decision-making capability', 'Monolithic — all logic coupled'],
        },
        scores: { 'Reliability': 5, 'Cost Efficiency': 5, 'Extensibility': 2, 'Complexity': 5, 'Portfolio Signal': 3 },
        risks: [
          { risk: 'Lambda timeout for long-form content', probability: 'low', impact: 'medium', mitigation: 'Set Lambda timeout to 5 minutes, monitor 99th percentile durations.' },
        ],
        shortTermScore: 5,
        longTermScore: 2,
      },
      {
        id: 'bedrock-agent',
        name: 'Bedrock Agent with Action Groups',
        description: 'AWS-managed agentic runtime with OpenAPI-defined Action Group Lambdas.',
        prosAndCons: {
          pros: ['AWS-managed orchestration loop', 'Multi-trigger support (EventBridge, CloudWatch)', 'Knowledge Base RAG integration', 'Strong portfolio signal'],
          cons: ['Higher per-invocation cost (orchestration tokens)', 'Non-deterministic tool ordering', 'OpenAPI schema maintenance overhead', 'Loss of prompt caching control'],
        },
        scores: { 'Reliability': 3, 'Cost Efficiency': 2, 'Extensibility': 5, 'Complexity': 3, 'Portfolio Signal': 5 },
        risks: [
          { risk: 'Agent calling tools in incorrect order', probability: 'medium', impact: 'medium', mitigation: 'Constrain with explicit system prompt and guardrails.' },
          { risk: 'Cost unpredictability from orchestration tokens', probability: 'medium', impact: 'low', mitigation: 'Set budget alerts and monitor per-invocation token usage.' },
        ],
        shortTermScore: 2,
        longTermScore: 5,
      },
      {
        id: 'mcp-agentic',
        name: 'MCP Agentic (Converse API Loop)',
        description: 'Custom orchestrator Lambda using Bedrock Converse API with MCP-style tool decomposition.',
        prosAndCons: {
          pros: ['Tool decomposition without managed agent overhead', 'Full control over orchestration logic', 'Reusable tool schemas (Zod → Bedrock)', 'Moderate portfolio signal'],
          cons: ['Must write and maintain the agentic loop', 'Additional Bedrock API calls for orchestration', 'More complex than Lambda monolith'],
        },
        scores: { 'Reliability': 4, 'Cost Efficiency': 3, 'Extensibility': 4, 'Complexity': 3, 'Portfolio Signal': 4 },
        risks: [
          { risk: 'Infinite loop if Bedrock never returns end_turn', probability: 'low', impact: 'high', mitigation: 'Implement max-iteration guard (e.g. 10 steps) with graceful failure.' },
        ],
        shortTermScore: 3,
        longTermScore: 4,
      },
    ],
    evidencePatterns: [
      '**/bedrock-publisher/**',
      '**/ai-content-stack*',
      '**/prompts/**',
      '**/step-function*',
    ],
  },
] as const;
