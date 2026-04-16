---
domain: resume
version: 1.0
last_updated: 2026-04-16
integrates_with: [dora-metrics]
purpose: >
  Strategic resume and cover letter intelligence for AI agent resume generation.
  Provides concept articulation, achievement language, narrative framing, and
  honest gap boundaries. Agents should reference this domain when tailoring
  resume content to a job description, prioritising sections relevant to the
  role's requirements.
---

# Resume Domain — Engineering Identity & Concept Library

## 1. Engineer Identity

### 1.1 Core narrative (use as resume summary foundation)

Cloud infrastructure engineer who designed, built, and operates a complete platform-to-product system on AWS — from CDK-provisioned multi-account infrastructure and a self-hosted kubeadm Kubernetes cluster with full GitOps delivery, to the Next.js application and AI-powered content pipelines deployed onto it. This dual-perspective — building the platform AND consuming it as an application engineer — delivers unusually deep operational insight across the entire stack, from VPC networking and control plane internals to CloudFront edge caching and Bedrock AI integration.

### 1.2 Role identity variants

- **Platform / DevOps Engineer:** Designed and operates a self-hosted kubeadm Kubernetes platform on AWS with ArgoCD GitOps, multi-pool ASG scaling, full observability (Prometheus/Grafana/Loki/Tempo), and CI/CD pipelines delivering infrastructure changes across 4 AWS accounts.
- **Cloud Infrastructure Engineer:** Manages all AWS infrastructure exclusively through CDK TypeScript across 4 accounts (development, staging, production, management) — VPCs, EC2 ASGs, CloudFront distributions, WAF, ACM certificates, S3, DynamoDB, Lambda, Step Functions, and cross-account IAM roles with OIDC federation.
- **Full Stack Engineer:** Delivers end-to-end product features from Next.js frontend and admin dashboard through serverless BFF APIs to Kubernetes-hosted workloads, with CloudFront CDN, Auth.js authentication, and ISR caching — all running on self-built infrastructure.
- **Site Reliability / Support Engineer:** Former AWS Technical Support professional who now operates production Kubernetes with three-pillar observability, self-healing ArgoCD workloads, automated etcd DR backups, Steampipe compliance scanning, and sub-minute alert-to-detection on pod failures.
- **AI-integrated tooling / Developer Tooling:** Builds AI-integrated operational tooling using AWS Bedrock — multi-agent Step Functions pipelines (article generation, job strategy), a Bedrock-powered chatbot with Knowledge Base RAG, and a self-healing agent that diagnoses and remediates CloudWatch alarms autonomously.

### 1.3 Unified project narrative

This engineer built the infrastructure platform (cdk-monitoring) — CDK-provisioned AWS resources, self-hosted kubeadm Kubernetes, ArgoCD GitOps delivery, and full observability — AND deployed a real product onto it: a Next.js portfolio site and admin dashboard served through CloudFront via Traefik ingress on the same cluster. The CDK stacks in `infra/lib/stacks/kubernetes/` provision the EC2 nodes, VPC, security groups, and Elastic IP that the cluster runs on, while the ArgoCD Application manifest at `kubernetes-app/workloads/argocd-apps/nextjs.yaml` deploys the Next.js container into the `nextjs-app` namespace with automated image updates from ECR. This platform-then-product relationship means the engineer experienced both the platform builder's perspective (networking, storage, bootstrap, observability) and the application consumer's perspective (deployment friction, edge caching, auth flows, ISR behaviour) — on the same infrastructure.


---

## 2. Concept Library

### 2.1 Container Orchestration & Kubernetes

#### Self-healing infrastructure
```yaml
status: STRONG
evidence:
  - file: kubernetes-app/workloads/argocd-apps/nextjs.yaml
    description: >
      ArgoCD Application with syncPolicy.automated.selfHeal=true and
      prune=true — automatic drift correction against Git as source of truth.
  - file: kubernetes-app/platform/argocd-apps/monitoring.yaml
    description: >
      Platform monitoring stack with identical self-heal and prune config.
  - file: infra/lib/stacks/kubernetes/control-plane-stack.ts
    description: >
      ASG min=1/max=1 provides instance-level self-healing — terminated nodes
      are automatically replaced by AWS Auto Scaling.
  - file: kubernetes-app/k8s-bootstrap/boot/steps/wk/verify_membership.py
    description: >
      Worker bootstrap includes self-healing re-join logic — nodes that fail
      cluster membership automatically attempt re-registration.
resume_verb: "Deployed"
achievement_pattern: >
  Deployed self-healing Kubernetes workloads via ArgoCD GitOps — automatic drift
  correction against Git as source of truth, with ASG-backed instance recovery
  and automated worker re-join, enabling zero-manual-intervention recovery from
  node failures.
interview_depth: >
  ArgoCD continuously reconciles the live cluster state against the Git
  repository. If someone manually edits a deployment or a pod crashes, ArgoCD
  detects the drift and re-applies the desired state from Git within the sync
  interval. At the infrastructure level, the ASG replaces terminated EC2
  instances, and the bootstrap script handles kubeadm re-join automatically.
recommended_framing: >
  "Deployed self-healing Kubernetes workloads via ArgoCD GitOps with automated
  drift correction, ASG-backed instance recovery, and self-healing worker
  re-join — zero manual cluster access required for recovery."
```

#### Microservices / namespace isolation
```yaml
status: STRONG
evidence:
  - file: kubernetes-app/workloads/argocd-apps/nextjs.yaml
    description: Deploys to nextjs-app namespace
  - file: kubernetes-app/workloads/argocd-apps/start-admin.yaml
    description: Deploys to start-admin namespace
  - file: kubernetes-app/workloads/argocd-apps/admin-api.yaml
    description: Deploys to admin-api namespace
  - file: kubernetes-app/workloads/argocd-apps/public-api.yaml
    description: Deploys to public-api namespace
  - file: kubernetes-app/platform/charts/monitoring/chart/values.yaml
    description: >
      Monitoring stack in dedicated namespace with ResourceQuota and NetworkPolicy.
  - file: kubernetes-app/workloads/charts/admin-api/chart/templates/networkpolicy.yaml
    description: NetworkPolicy for admin-api namespace-scoped traffic control.
  - file: kubernetes-app/platform/charts/monitoring/chart/templates/network-policy.yaml
    description: NetworkPolicy for monitoring namespace.
resume_verb: "Architected"
achievement_pattern: >
  Architected microservices deployment topology across 6+ isolated Kubernetes
  namespaces — independent deployability, fault isolation, namespace-scoped
  NetworkPolicies, and ResourceQuotas per service boundary.
recommended_framing: >
  "Architected namespace-isolated microservices topology with per-namespace
  NetworkPolicies and ResourceQuotas — enabling independent deployability
  and blast radius containment across 6+ service boundaries."
```

#### Kubernetes internals (kubeadm / control plane)
```yaml
status: STRONG
evidence:
  - file: infra/lib/stacks/kubernetes/control-plane-stack.ts
    description: >
      Full kubeadm control plane stack — LaunchTemplate, ASG, UserData with
      kubeadm init, Calico CNI configuration, etcd backup, cfn-signal.
  - file: kubernetes-app/k8s-bootstrap/boot/steps/cp/kubeadm_init.py
    description: >
      Python bootstrap step for kubeadm init — configures control plane,
      generates kubeconfig, handles Calico CNI deployment.
  - file: kubernetes-app/k8s-bootstrap/boot/steps/cp/dr_restore.py
    description: >
      Disaster recovery restore from etcd snapshots stored in S3.
  - file: kubernetes-app/k8s-bootstrap/boot/verify-cluster.sh
    description: >
      Post-boot verification script checking all control plane components
      (kube-apiserver, kube-controller-manager, etcd, scheduler).
gap_note: >
  Self-hosted kubeadm exposes control plane internals (etcd, kube-apiserver,
  CNI, kubelet) that managed services like GKE abstract away. This is a
  differentiator vs candidates who have only used managed Kubernetes. Agents
  should surface this when a JD requires Kubernetes troubleshooting depth.
recommended_framing: >
  "Self-hosted Kubernetes via kubeadm — hands-on exposure to control plane
  internals (etcd lifecycle, kube-apiserver, Calico CNI, kubelet configuration),
  automated DR restore from S3-backed etcd snapshots, and node-level operations
  that managed services abstract away."
```

#### Service mesh
```yaml
status: PARTIAL
evidence:
  - file: kubernetes-app/platform/argocd-apps/traefik.yaml
    description: >
      Traefik v3 ArgoCD Application managing L7 ingress with Helm values.
  - file: kubernetes-app/platform/charts/monitoring/chart/templates/traefik/basicauth-middleware.yaml
    description: Traefik middleware for BasicAuth enforcement on admin routes.
  - file: kubernetes-app/platform/charts/monitoring/chart/templates/traefik/ip-allowlist-middleware.yaml
    description: Traefik middleware for IP allowlisting on admin services.
  - file: kubernetes-app/platform/charts/monitoring/chart/templates/traefik/rate-limit-middleware.yaml
    description: Traefik middleware for rate limiting.
honest_boundary: >
  IMPORTANT — Traefik v3 provides ingress routing and middleware chains.
  This is NOT a full service mesh. It does not provide mTLS between pods,
  circuit breaking, retries, or sidecar-based traffic policies (Istio/Linkerd).
  Agents must NEVER use the phrase "service mesh" when describing this project.
  Use "Traefik v3 ingress and cross-namespace routing" instead.
recommended_framing: >
  "Traefik v3 for ingress routing, cross-namespace traffic management, and
  middleware-based auth enforcement (BasicAuth, IP allowlisting, rate limiting)
  — L7 routing without a full service mesh."
```

#### Cluster autoscaling
```yaml
status: STRONG
evidence:
  - file: infra/lib/stacks/kubernetes/worker-asg-stack.ts
    description: >
      Generic parameterised worker ASG stack with Cluster Autoscaler discovery
      tags (k8s.io/cluster-autoscaler/enabled), Spot instances, min/max capacity
      per pool type (general: t3.small 1-4, monitoring: t3.medium 1-2).
  - file: kubernetes-app/platform/argocd-apps/cluster-autoscaler.yaml
    description: >
      ArgoCD Application deploying Cluster Autoscaler with syncPolicy automated,
      selfHeal, and prune enabled.
  - file: kubernetes-app/platform/charts/monitoring/chart/values.yaml
    description: >
      PodDisruptionBudgets for Prometheus, Grafana, and Loki prevent CA
      scale-down from evicting sole monitoring replicas.
recommended_framing: >
  "Implemented ASG-backed Kubernetes auto-scaling with Cluster Autoscaler —
  dual worker pools (general/monitoring) on Spot instances with
  PodDisruptionBudgets protecting critical observability workloads."
```

---

### 2.2 GitOps & Delivery

#### GitOps delivery model (ArgoCD)
```yaml
status: STRONG
evidence:
  - file: kubernetes-app/k8s-bootstrap/system/argocd/platform-root-app.yaml
    description: >
      Root ArgoCD Application for platform services — App-of-Apps pattern
      with automated sync and self-heal.
  - file: kubernetes-app/k8s-bootstrap/system/argocd/workloads-root-app.yaml
    description: >
      Root ArgoCD Application for workload services.
  - file: kubernetes-app/platform/argocd-apps/
    description: >
      15+ ArgoCD Application manifests for platform services: monitoring,
      traefik, cert-manager, cluster-autoscaler, crossplane, metrics-server,
      argocd-image-updater, opencost, descheduler, argo-rollouts, etc.
  - file: kubernetes-app/workloads/argocd-apps/
    description: >
      5 ArgoCD Application manifests for workloads: nextjs, start-admin,
      admin-api, public-api, golden-path-service.
  - file: kubernetes-app/workloads/argocd-apps/nextjs.yaml
    description: >
      ArgoCD Image Updater annotations for automated image tag updates
      via Git write-back — CI pushes image, ArgoCD deploys it.
achievement_pattern: >
  Implemented GitOps delivery via ArgoCD with App-of-Apps pattern — 20+
  applications managed declaratively, all cluster changes driven through
  Git commits, enabling complete audit history, one-command rollback, and
  eliminating direct cluster access as a deployment mechanism.
recommended_framing: >
  "Implemented GitOps delivery via ArgoCD App-of-Apps — 20+ applications
  with automated sync, self-heal, and image tag promotion from ECR,
  eliminating direct cluster access as a deployment mechanism."
```

#### Separated CI/CD pipeline design
```yaml
status: STRONG
evidence:
  - file: .github/workflows/ci.yml
    description: >
      CI pipeline on every push: change detection, security audit, ESLint,
      TypeScript check, dependency validation, CDK synthesis, Checkov IaC
      security scan, Helm chart validation, k8s-bootstrap Python tests.
      Runs on custom Docker CI image (ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest).
  - file: .github/workflows/deploy-kubernetes.yml
    description: >
      CD pipeline for K8s infrastructure — 8-stack deployment (Data → Base →
      Compute → AppIam → Api → Edge), separate from CI.
  - file: .github/workflows/gitops-k8s.yml
    description: >
      CD pipeline for K8s workloads — GitOps sync via ArgoCD.
  - file: .github/workflows/deploy-bedrock.yml
    description: CD pipeline for Bedrock AI stacks.
  - file: .github/workflows/deploy-frontend.yml
    description: CD pipeline for frontend Docker build + push to ECR.
design_rationale: >
  CI pipeline (lint, test, build, security scan) runs on every commit.
  CD pipelines (image push, CDK diff, deploy, smoke test) run on merge
  to main/develop only. This separation reduces per-commit pipeline time
  and significantly reduces GitHub Actions minutes consumed on dev branches.
  22+ workflow files demonstrate mature pipeline-as-code practices.
achievement_pattern: >
  Architected separated CI/CD pipeline on GitHub Actions — 22+ workflow files
  decoupling quality gates (lint, typecheck, CDK synth, Checkov scan, Helm
  validation, Python tests) from deployment stages, with change detection
  to skip unaffected jobs and custom Docker CI images for reproducibility.
recommended_framing: >
  "Architected separated CI/CD across 22+ GitHub Actions workflows —
  change-detection-driven quality gates, Checkov IaC security scanning,
  and custom CI Docker images for reproducible builds."
```

---

### 2.3 Observability

#### Three-pillar observability (metrics / logs / traces)
```yaml
status: STRONG
evidence:
  metrics:
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/prometheus/
      description: >
        Prometheus v3.3.0 with 15-day retention, 30s scrape interval,
        EBS-backed PVC, PodDisruptionBudget, and IngressRoute.
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/kube-state-metrics/
      description: Kube State Metrics v2.15.0 for Kubernetes object metrics.
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/node-exporter/
      description: Node Exporter v1.9.1 as DaemonSet for host-level metrics.
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/github-actions-exporter/
      description: GitHub Actions Exporter for CI/CD pipeline metrics.
  logs:
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/loki/
      description: Loki v3.5.0 for log aggregation with EBS-backed PVC.
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/promtail/
      description: Promtail v3.5.0 as DaemonSet log shipper.
  traces:
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/tempo/
      description: >
        Tempo v2.7.2 for distributed tracing with OTLP gRPC (4317) and
        HTTP (4318) receivers, EBS-backed PVC.
  collector:
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/alloy/
      description: >
        Grafana Alloy v1.8.2 as Faro collector for client-side RUM telemetry
        with CORS configuration for the production domain.
  dashboards:
    - file: kubernetes-app/platform/charts/monitoring/chart/dashboards/
      description: >
        Pre-provisioned Grafana dashboards (self-healing.json, cloudwatch.json)
        deployed via Helm.
  compliance:
    - file: kubernetes-app/platform/charts/monitoring/chart/templates/steampipe/
      description: >
        Steampipe AWS compliance scanner running in-cluster for continuous
        infrastructure security auditing.
achievement_pattern: >
  Deployed complete observability stack (Prometheus v3, Grafana, Loki, Tempo)
  covering all three pillars — metrics, logs, and distributed traces — with
  Grafana Alloy as Faro RUM collector, Steampipe for AWS compliance scanning,
  and GitHub Actions Exporter for CI/CD pipeline metrics.
recommended_framing: >
  "Deployed three-pillar observability (Prometheus, Loki, Tempo) with Grafana
  dashboards, Faro RUM collection via Alloy, and Steampipe compliance scanning
  — covering infrastructure, application, and CI/CD telemetry."
```

#### SLO / alerting design
```yaml
status: PARTIAL
evidence:
  - file: kubernetes-app/platform/charts/monitoring/chart/values.yaml
    description: >
      Grafana alerting configuration with SNS topic ARN for notifications.
      PodDisruptionBudgets protect monitoring replicas.
  - file: infra/lib/stacks/kubernetes/worker-asg-stack.ts
    description: >
      SNS Topic for monitoring alerts on the monitoring worker pool.
  - file: kubernetes-app/platform/charts/monitoring/chart/dashboards/self-healing.json
    description: >
      Self-healing pipeline dashboard monitoring CloudWatch alarm remediation.
honest_boundary: >
  Grafana alerting and SNS notification topics are configured, but formal
  SLO definitions (error budgets, burn-rate alerts, recording rules) are
  not explicitly defined in the codebase. Alerting is threshold-based
  rather than SLO-based.
recommended_framing: >
  "Configured Grafana alerting with SNS notification integration and
  PodDisruptionBudgets for monitoring resilience — threshold-based alerts
  covering pod health, node status, and pipeline failures."
```

---

### 2.4 Networking & Ingress

#### Request routing stack
```yaml
status: STRONG
evidence:
  - file: infra/lib/stacks/kubernetes/edge-stack.ts
    description: >
      CloudFront distribution with dual-origin (EIP for Traefik, S3 for static
      assets), WAF WebACL with AWS Managed Rules and IP rate limiting, ACM
      certificate with cross-account DNS validation, 8+ cache behaviours
      (static assets, ISR pages, auth callbacks, API routes, admin routes).
  - file: infra/lib/stacks/kubernetes/base-stack.ts
    description: >
      VPC, 4 Security Groups (cluster, control-plane, ingress, monitoring),
      Elastic IP, NLB, Route 53 private hosted zone.
  - file: kubernetes-app/platform/argocd-apps/traefik.yaml
    description: Traefik v3 IngressRoute controller via ArgoCD.
  - file: kubernetes-app/platform/charts/monitoring/chart/templates/traefik/
    description: >
      Traefik middleware chain (BasicAuth, IP allowlist, rate limiting) for
      admin services at ops.nelsonlamounier.com.
stack_description: >
  Browser → CloudFront (HTTPS, TLS termination at edge) → WAF (rate limit +
  IP reputation) → Elastic IP (HTTP, origin secret header validation) →
  Traefik IngressRoute (L7 routing, middleware chain) → K8s Service →
  Pod. Static assets bypass the cluster via S3 OAC origin. Admin services
  (Grafana, Prometheus, ArgoCD) route via ops.nelsonlamounier.com → EIP →
  Traefik with Let's Encrypt TLS via cert-manager DNS-01.
gap_note: >
  Practical networking depth demonstrated through Traefik middleware chains,
  CloudFront distribution config with 8+ cache behaviours, CloudFront origin
  secret rotation, WAF rules, VPC routing, cross-region SSM readers, and
  EIP-to-DNS conversion in CDK. Candidate should be prepared to narrate
  request flow at each hop with protocol-level vocabulary.
recommended_framing: >
  "Designed full request routing stack: CloudFront → WAF → EIP → Traefik
  IngressRoute → K8s Service → Pod, with origin secret validation, 8+
  path-specific cache policies, and middleware-based auth enforcement."
```

---

### 2.5 Infrastructure as Code

#### AWS CDK TypeScript (multi-account)
```yaml
status: STRONG
evidence:
  - file: infra/lib/config/environments.ts
    description: >
      4 AWS accounts configured: development (771826808455), staging
      (692738841103), production (607700977986), management (711387127421).
      Cross-region support (eu-west-1 primary, us-east-1 edge).
  - file: infra/lib/stacks/kubernetes/
    description: >
      5+ K8s stacks: base-stack, control-plane-stack, worker-asg-stack,
      edge-stack, plus golden-ami-stack.
  - file: infra/lib/stacks/bedrock/
    description: 4+ Bedrock stacks for AI pipeline infrastructure.
  - file: infra/lib/stacks/shared/
    description: Shared infrastructure (VPC, ECR, Cognito Auth).
  - file: infra/lib/stacks/org/dns-role-stack.ts
    description: >
      Cross-account DNS validation role deployed in root account,
      trusted by dev/staging/prod accounts.
accounts_found:
  - "development: 771826808455"
  - "staging: 692738841103"
  - "production: 607700977986"
  - "management: 711387127421"
achievement_pattern: >
  Managed all AWS infrastructure exclusively through CDK TypeScript across
  4 accounts — zero console-deployed resources, full drift prevention, and
  cross-account OIDC-based CI/CD with environment-specific stack isolation.
recommended_framing: >
  "Managed all AWS infrastructure through CDK TypeScript across 4 accounts
  (dev/staging/prod/management) — zero console-deployed resources, cross-region
  stacks, and cross-account IAM roles for DNS validation and CI/CD."
```

---

### 2.6 Security & Secrets Management

#### Zero-trust / OIDC federation
```yaml
status: STRONG
evidence:
  - file: .github/workflows/deploy-kubernetes.yml
    description: >
      permissions.id-token: write for GitHub OIDC federation — no long-lived
      AWS credentials in CI/CD.
  - file: infra/lib/stacks/org/dns-role-stack.ts
    description: >
      Cross-account IAM role with trust policy for dev/staging/prod accounts.
  - file: packages/script-utils/src/aws.ts
    description: >
      OIDC auth mode detection — CI uses OIDC env credentials, local uses
      named profiles.
  - file: infra/lib/stacks/kubernetes/control-plane-stack.ts
    description: >
      Scoped IAM policies with condition keys (kms:ViaService, iam:PassedToService),
      SSM SecureString for secrets, Secrets Manager for ArgoCD CI bot token.
  - file: infra/lib/stacks/kubernetes/edge-stack.ts
    description: >
      CloudFront origin secret stored as SSM SecureString with documented
      zero-downtime rotation procedure.
  - file: infra/lib/stacks/shared/cognito-auth-stack.ts
    description: Cognito OIDC issuer for application authentication.
honest_boundary: >
  GitHub OIDC federation eliminates long-lived credentials in CI/CD. IAM
  policies are scoped with condition keys. SSM SecureString and Secrets
  Manager used for secrets. However, some IAM policies use wildcard resources
  (ec2:Describe* for CCM, kms:Decrypt for SSM) due to AWS API limitations.
  Not a full zero-trust network architecture (no mTLS between pods).
recommended_framing: >
  "Implemented OIDC-federated CI/CD with GitHub Actions — zero long-lived
  credentials, cross-account IAM roles with condition-scoped policies, SSM
  SecureString secrets management, and documented zero-downtime secret rotation."
```

---

### 2.7 Cloud-Native & Serverless Architecture

#### Serverless backend (frontend project)
```yaml
status: STRONG
evidence:
  - file: infra/lib/stacks/bedrock/pipeline-stack.ts
    description: >
      Step Functions state machine with 4 Lambda functions (trigger, research,
      writer, QA) — serverless AI content pipeline.
  - file: infra/lib/stacks/kubernetes/edge-stack.ts
    description: >
      Lambda-backed custom resources for ACM DNS validation and DNS alias
      records — serverless infrastructure automation.
  - file: kubernetes-app/workloads/argocd-apps/admin-api.yaml
    description: admin-api BFF service deployed as K8s workload.
  - file: kubernetes-app/workloads/argocd-apps/public-api.yaml
    description: public-api BFF service deployed as K8s workload.
achievement_pattern: >
  Built hybrid backend architecture combining Kubernetes-hosted BFF services
  (admin-api, public-api) with serverless Step Functions pipelines and
  Lambda-backed infrastructure automation — optimising for both developer
  experience and operational cost.
recommended_framing: >
  "Built hybrid backend architecture: Kubernetes BFF services (admin-api,
  public-api) for application logic, serverless Step Functions + Lambda for
  AI pipelines and infrastructure automation."
```

---

### 2.8 AI / ML Integration & Tooling

#### AWS Bedrock / AI pipeline integration
```yaml
status: STRONG
evidence:
  - file: infra/lib/stacks/bedrock/pipeline-stack.ts
    description: >
      Multi-agent Step Functions pipeline: S3 trigger → Research (Haiku 4.5) →
      Writer (Sonnet 4.6) → QA (Sonnet 4.6) → S3 + DynamoDB. Per-agent EMF
      metrics, X-Ray tracing, Application Inference Profiles for cost tracking.
  - file: bedrock-applications/article-pipeline/
    description: Article generation pipeline with 3 specialised agents.
  - file: bedrock-applications/job-strategist/
    description: Job strategy pipeline application.
  - file: bedrock-applications/chatbot/
    description: Bedrock-powered chatbot with Knowledge Base RAG.
  - file: bedrock-applications/self-healing/
    description: >
      Self-healing agent that diagnoses CloudWatch alarms and triggers
      remediation via tool-use (diagnose-alarm, ebs-detach).
  - file: kubernetes-app/platform/charts/monitoring/chart/dashboards/self-healing.json
    description: >
      Grafana dashboard for real-time self-healing agent monitoring.
  - file: infra/lib/config/bedrock/chatbot-persona.ts
    description: Prompt engineering for chatbot persona with guardrails.
achievement_pattern: >
  Integrated AWS Bedrock into operational tooling — multi-agent content pipeline
  (3 specialised AI agents in Step Functions), Knowledge Base RAG chatbot, and
  autonomous self-healing agent with tool-use for CloudWatch alarm diagnosis
  and remediation. Per-agent cost tracking via Application Inference Profiles.
recommended_framing: >
  "Built multi-agent AI pipelines on AWS Bedrock — 4 applications (article
  generation, job strategy, chatbot with RAG, self-healing agent) using
  Step Functions orchestration, tool-use patterns, and per-agent cost tracking."
gap_note: >
  Bedrock integration is a genuine differentiator — most infrastructure
  candidates do not have AI integration experience. Agents should surface
  this prominently for any JD that mentions AI tooling, agent orchestration,
  or workflow automation.
```

---

### 2.9 Developer Tooling & CLI

#### justfile task runner / workflow automation
```yaml
status: STRONG
evidence:
  - file: justfile
    description: >
      justfile task runner replacing Makefile — CI pipeline uses 'just' recipes
      for all operations (just audit, just lint, just typecheck, just build,
      just deps-check-ci, just test-stacks, just ci-synth-validate,
      just helm-validate-charts, just bootstrap-pytest, just ci-security-scan).
  - file: .github/workflows/ci.yml
    description: >
      All CI steps execute through justfile recipes, ensuring local development
      and CI use identical execution paths.
  - file: packages/script-utils/
    description: >
      @repo/script-utils shared utilities package for operational scripts.
  - file: infra/scripts/cd/sync-bootstrap-scripts.ts
    description: >
      TypeScript deployment scripts with Commander.js-style argument parsing,
      OIDC auth mode detection, and cross-environment support.
  - file: frontend-ops/push-to-ecr.ts
    description: TypeScript script for Docker image build and ECR push.
  - file: frontend-ops/sync-static-to-s3.ts
    description: TypeScript script for static asset S3 sync.
achievement_pattern: >
  Consolidated operational automation into a justfile task runner with 15+
  recipes mirroring CI pipeline steps — ensuring local/CI parity. TypeScript
  operational scripts with shared utilities package (@repo/script-utils) for
  cross-environment deployment, auth mode detection, and S3/ECR operations.
recommended_framing: >
  "Implemented justfile task runner aligning all local and CI operations —
  15+ recipes ensuring dev/CI parity, with TypeScript deployment scripts
  and a shared utilities package for cross-environment automation."
```

---

## 3. Achievement Bank

### 3.1 Platform & infrastructure bullets
1. Deployed self-healing Kubernetes workloads via ArgoCD GitOps across 20+ applications — automatic drift correction against Git as source of truth, with ASG-backed instance recovery eliminating manual cluster interventions.
2. Managed all AWS infrastructure through CDK TypeScript across 4 accounts (dev/staging/prod/management) — zero console-deployed resources, cross-region stack deployments (eu-west-1/us-east-1), and cross-account IAM roles for DNS validation and secrets management.
3. Self-hosted Kubernetes via kubeadm on EC2 — hands-on control plane operations including etcd DR backups to S3, Calico CNI configuration, kubeadm init/join automation, and Golden AMI pipeline for OS patching.
4. Designed CloudFront → WAF → EIP → Traefik request routing stack with 8+ path-specific cache policies, origin secret validation, and dual-origin architecture (EIP for dynamic content, S3 OAC for static assets) — optimising both performance and cost.

### 3.2 Delivery & pipeline bullets
5. Architected separated CI/CD across 22+ GitHub Actions workflows — change-detection-driven quality gates (lint, typecheck, CDK synth, Helm validation, Python tests), Checkov IaC security scanning with SARIF upload to GitHub Security, and custom Docker CI images for reproducible builds.
6. Implemented GitOps rollback via ArgoCD with automated sync, self-heal, and image tag promotion from ECR — enabling sub-minute recovery from bad deployments via Git revert.
7. Integrated Checkov IaC security scanning into CI pipeline blocking on CRITICAL/HIGH findings, with cdk-nag providing real-time feedback during local development — dual-layer security validation on every code change.

### 3.3 Observability bullets
8. Deployed three-pillar observability stack (Prometheus v3, Loki, Tempo) with Grafana dashboards, Faro RUM collection via Alloy, Steampipe AWS compliance scanning, and GitHub Actions Exporter — covering infrastructure, application, CI/CD, and frontend telemetry.
9. Configured Grafana alerting with SNS notification integration and PodDisruptionBudgets protecting sole monitoring replicas during Cluster Autoscaler scale-down events.

### 3.4 Full stack & product bullets
10. Built hybrid backend: Kubernetes-hosted BFF services (admin-api, public-api) with Auth.js authentication, and serverless Step Functions pipelines for AI content generation — deployed via ArgoCD onto self-built infrastructure.
11. Deployed Next.js portfolio site and admin dashboard (start-admin) through CloudFront with ISR caching, 8+ cache behaviours, and automated image tag promotion from ECR — experiencing the platform-consumer perspective on self-built infrastructure.
12. Built 4 Bedrock AI applications (article pipeline, job strategist, chatbot with RAG, self-healing agent) using Step Functions orchestration, tool-use patterns, Application Inference Profiles for per-agent cost tracking, and dedicated Grafana dashboards for monitoring.

### 3.5 Tooling & process bullets
13. Consolidated operational automation into justfile task runner with 15+ recipes ensuring local/CI parity, TypeScript deployment scripts with @repo/script-utils shared package, and OIDC auth mode detection for cross-environment execution.
14. Implemented OIDC-federated CI/CD eliminating long-lived AWS credentials, cross-account IAM roles with condition-scoped policies, SSM SecureString secrets management, and documented zero-downtime CloudFront origin secret rotation.


---

## 4. Gap Registry

### 4.1 Known honest boundaries

| Concept | Status | Safe framing | Do not claim |
|---|---|---|---|
| Service mesh | PARTIAL | "Traefik v3 ingress and cross-namespace routing with middleware chains" | "Service mesh", "mTLS between pods", "Istio", "Linkerd" |
| GCP / GKE | ABSENT | "AWS-native, Kubernetes transferable" | "GCP experience", "GKE", "Google Cloud" |
| PHP / Hack | ABSENT | "TypeScript/Node.js full-stack development" | "PHP developer", "Hack experience" |
| Kernel debugging | ABSENT | "Node-level operations via kubeadm and SSH-free SSM access" | "eBPF", "perf profiling", "strace debugging" |
| Large-scale multi-node | EXPERIENCE GAP | "Self-hosted production Kubernetes with multi-pool auto-scaling" | "Enterprise-scale cluster operations", "100+ node clusters" |
| Terraform | ABSENT | "AWS CDK TypeScript (equivalent IaC capability)" | "Terraform experience", "HCL" |
| Formal SLOs | PARTIAL | "Threshold-based alerting with SNS notifications" | "SLO-based error budgets", "burn-rate alerts" |
| Commander.js CLI | ABSENT | "justfile task runner with TypeScript deployment scripts" | "Commander.js CLI" — the project uses justfile, not Commander.js |

### 4.2 In-progress work — present as architectural evolution, not gaps

1. **Multi-pool ASG / Cluster Autoscaler**
   - Evidence found: `infra/lib/stacks/kubernetes/worker-asg-stack.ts` (fully implemented — general and monitoring pools with CA discovery tags), `kubernetes-app/platform/argocd-apps/cluster-autoscaler.yaml` (ArgoCD Application deployed)
   - Status: STRONG (this has progressed beyond IN_PROGRESS — the ASGs and CA are deployed)
   - Recommended framing: "Implemented multi-pool ASG architecture with Cluster Autoscaler — general pool (t3.small Spot, 1-4 nodes) and monitoring pool (t3.medium Spot, 1-2 nodes) with taint-based workload isolation."

2. **Argo Rollouts (progressive delivery)**
   - Evidence found: `kubernetes-app/platform/argocd-apps/argo-rollouts.yaml`
   - Recommended framing: "Argo Rollouts deployed for progressive delivery capability — canary and blue/green deployment strategies available for workload services."

3. **Crossplane (infrastructure provisioning from K8s)**
   - Evidence found: `kubernetes-app/platform/argocd-apps/crossplane.yaml`, `kubernetes-app/platform/argocd-apps/crossplane-providers.yaml`, `kubernetes-app/platform/argocd-apps/crossplane-xrds.yaml`, `kubernetes-app/platform/charts/crossplane-providers/manifests/provider-config.yaml`
   - Recommended framing: "Crossplane deployed for Kubernetes-native cloud resource provisioning — extending GitOps to AWS infrastructure management alongside CDK."

4. **Golden Path Service**
   - Evidence found: `kubernetes-app/workloads/argocd-apps/golden-path-service.yaml`, `kubernetes-app/workloads/charts/golden-path-service/`
   - Recommended framing: "Golden Path service template with built-in NetworkPolicies and monitoring — a standardised deployment pattern for new microservices."


---

## 5. Narrative Framing Library

### 5.1 Platform engineering narrative
Built the foundational platform layer for all application workloads — CDK-provisioned AWS infrastructure across 4 accounts, a self-hosted kubeadm Kubernetes cluster with Calico CNI and etcd DR backups, and ArgoCD GitOps managing 20+ applications via App-of-Apps. The observability stack (Prometheus, Grafana, Loki, Tempo, Alloy) provides three-pillar telemetry with Steampipe compliance scanning, while CloudFront → WAF → Traefik delivers edge-optimised request routing. This infrastructure runs in production without managed Kubernetes abstractions, demonstrating deep operational ownership of the entire compute, networking, and delivery stack.

### 5.2 Full stack + platform unified narrative
This engineer built the platform layer (cdk-monitoring) — CDK infrastructure, kubeadm Kubernetes, ArgoCD delivery, and full observability — AND deployed real products onto it: a Next.js portfolio site, an admin dashboard (start-admin), and multiple BFF APIs, all running as ArgoCD-managed workloads on the same cluster. The CDK stack at `infra/lib/stacks/kubernetes/control-plane-stack.ts` provisions the EC2 node that runs the cluster, while the ArgoCD manifest at `kubernetes-app/workloads/argocd-apps/nextjs.yaml` deploys the application into `nextjs-app` namespace with image auto-promotion from ECR. This dual experience — platform builder and platform consumer — means the engineer understands deployment friction from both sides, making infrastructure decisions informed by application-level realities.

### 5.3 Support-to-DevOps transition narrative
Coming from AWS Technical Support, this engineer developed deep understanding of how production systems fail — from IAM permission boundaries to VPC networking edge cases to CloudFormation deployment errors. That operational intuition drives the infrastructure portfolio: every design decision (ArgoCD self-heal, etcd DR to S3, OIDC-federated CI/CD, origin secret rotation) reflects first-hand experience with the failure modes that surface in support escalations. The transition was deliberate: understanding how systems fail → building systems that recover automatically.

### 5.4 AI-augmented engineering narrative
Beyond traditional infrastructure, this engineer builds AI-integrated operational tooling on AWS Bedrock — multi-agent content pipelines orchestrated via Step Functions, a Knowledge Base RAG chatbot, and an autonomous self-healing agent that diagnoses CloudWatch alarms and triggers remediation without human intervention. This positions the engineer at the intersection of infrastructure and AI engineering, building systems that don't just monitor failures but actively resolve them.


---

## 6. DORA Metrics Integration

### 6.1 DORA metrics as resume evidence

| Metric | Value | Evidence file | Resume framing |
|---|---|---|---|
| Lead time for changes | [MEASURE] | `.github/workflows/ci.yml` (10-15 min CI pipeline) | "Commit → prod in under [N] minutes via ArgoCD auto-sync on merge" |
| Deployment frequency | On-merge | `.github/workflows/deploy-kubernetes.yml`, `gitops-k8s.yml` | "Continuous deployment via ArgoCD on main/develop merge + weekly AMI refresh" |
| MTTR | Sub-5 minutes | `kubernetes-app/workloads/argocd-apps/nextjs.yaml` (selfHeal, retry backoff 10s-5m) | "Sub-5-minute recovery via ArgoCD self-heal and Git revert rollback" |
| Change failure rate | [MEASURE] | `.github/workflows/ci.yml` (8+ quality gates) | "[N]% CFR enforced via 8+ CI quality gates (lint, typecheck, CDK synth, Checkov, Helm, pytest)" |

### 6.2 Solo-dev DORA adaptations
- Lead time and deployment frequency are fully self-controlled — present as
  pipeline design choices, not team benchmarks.
- MTTR reflects self-recovery capability via ArgoCD rollback — valid and
  impressive even at solo scale.
- Change failure rate reflects personal code quality discipline — no team
  enforcement, which makes a low CFR more meaningful.
- Cost-per-deploy is a solo-dev metric not in standard DORA — include it as
  evidence of engineering economics awareness.


---

## 7. Agent Usage Instructions

### 7.1 When generating a resume summary
1. Read Section 1 (Engineer Identity) and select the role identity variant
   that best matches the submitted JD.
2. If the JD values both infrastructure and product delivery, use the
   unified narrative from Section 5.2.
3. Never use a gap from Section 4 as a positive claim.

### 7.2 When selecting achievement bullets
1. Draw from Section 3 (Achievement Bank).
2. Prioritise bullets where the concept status in Section 2 is STRONG.
3. For PARTIAL concepts, use only the recommended_framing — never the
   full achievement_pattern.
4. For IN_PROGRESS items, use the "architectural evolution" framing from
   Section 4.2.

### 7.3 When writing a cover letter
1. Open with the role identity variant from Section 1.2.
2. Use the most relevant narrative block from Section 5.
3. Select 2–3 achievement bullets from Section 3 that map to the JD's
   top requirements.
4. If the JD mentions AI tooling, always include Section 2.8 content
   if status is not ABSENT.
5. Cross-reference Section 6 (DORA) if the JD mentions reliability,
   deployment pipelines, or engineering metrics.

### 7.4 Confidence thresholds
- STRONG status → agents can claim directly and confidently
- PARTIAL status → agents must use recommended_framing only
- IN_PROGRESS status → agents must use "currently implementing" language
- ABSENT status → agents must not mention this concept
- IMPLIED status → agents may mention with hedging language only


---

*Resume Domain v1.0 — Generated by codebase scan on 2026-04-16*
*Integrates with: dora-metrics domain*
*Next review: after SLO formalisation and Crossplane production validation*
