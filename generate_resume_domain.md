# Prompt: Generate Resume Domain KB File
#
# PURPOSE
# Scan this codebase and produce a single structured markdown document that will
# be added to an existing AI Knowledge Base (KB) system. The KB is used by a
# multi-agent AWS Bedrock workflow to generate tailored resumes and cover letters
# when a job description is submitted via a UI form.
#
# This document is the "Resume Domain" — a strategic layer that sits alongside
# the existing DORA metrics domain already in the KB. Where the DORA domain
# covers pipeline health and deployment metrics, this domain covers:
#   - How to articulate implemented concepts in job application language
#   - The engineer's unified narrative across both projects
#   - Concept-to-wording mappings for resume bullets
#   - Honest gap awareness so agents don't overclaim
#   - Achievement patterns the AI agents can adapt per job description
#
# IMPORTANT INSTRUCTIONS BEFORE SCANNING
# - Scan ALL files: CDK stacks, Kubernetes manifests, GitHub Actions workflows,
#   Dockerfiles, Next.js components, Lambda functions, scripts, READMEs, and
#   any existing KB markdown files already present in the repository.
# - Reference specific file paths as evidence for every claim you make.
# - Do not generalise. "Uses Kubernetes" is not useful. "ArgoCD ApplicationSet
#   at /gitops/apps/ with automated sync and self-heal enabled" is useful.
# - Be honest about partial implementations. Flag them explicitly so the AI
#   agents know the boundary of what can be claimed.
# - The output IS the KB document. Write it in clean, structured markdown ready
#   for direct ingestion — no preamble, no "here is the document", just the
#   document itself starting from the first heading.
#
# OUTPUT: Write the following document exactly as specified below.
# ─────────────────────────────────────────────────────────────────────────────

---
domain: resume
version: 1.0
last_updated: [INSERT DATE]
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
<!--
  Write 2–3 sentences that capture who this engineer is based on the full
  codebase. This is the thesis statement agents should adapt into summary lines.
  It must reflect both projects as a unified system, not two separate things.

  IMPORTANT: The two projects must be framed as a system, not two experiments:
  - cdk-monitoring = the platform layer (infrastructure, delivery, observability)
  - Frontend/portfolio site = the product deployed onto that platform
  Together they demonstrate both sides of the engineer/operator relationship
  on the same infrastructure. This is unusual and must be stated explicitly.
  Agents should use this framing whenever a JD values platform or full-stack
  depth simultaneously.
-->

[AGENT: Generate 2–3 sentence identity statement from codebase evidence]

### 1.2 Role identity variants
<!--
  Based on what you find in the codebase, generate a one-line identity for
  each of the following role types. Agents should select the relevant variant
  when the submitted JD matches that role type.
-->

- **Platform / DevOps Engineer:** [generate from codebase]
- **Cloud Infrastructure Engineer:** [generate from codebase]
- **Full Stack Engineer:** [generate from codebase]
- **Site Reliability / Support Engineer:** [generate from codebase]
- **AI-integrated tooling / Developer Tooling:** [generate from codebase]

### 1.3 Unified project narrative
<!--
  This section is critical. It must describe the relationship between the two
  projects in a way that makes them feel like a deliberate system:

  Project 1 (cdk-monitoring): The platform — CDK-provisioned AWS infrastructure,
  self-hosted Kubernetes, GitOps delivery via ArgoCD, full observability stack.
  This is the foundation everything runs on.

  Project 2 (Frontend / portfolio site): The product — Next.js application with
  serverless AWS backend, deployed onto the platform above.

  The narrative insight: This engineer built the platform AND deployed a product
  onto it, experiencing the engineer/operator relationship from both sides on the
  same infrastructure. Most engineers only experience one side. Agents should
  surface this framing when a JD values both platform thinking and product delivery.
-->

[AGENT: Write the unified narrative in 3–4 sentences based on codebase evidence,
confirming the platform → product relationship. Reference specific files from
both projects that prove the connection — e.g. the CDK stack that provisions
the EC2 nodes the frontend runs on, or the ArgoCD application manifest that
deploys the Next.js service.]


---

## 2. Concept Library

<!--
  For each concept below, scan the codebase and populate all fields.
  If a concept is NOT present, mark status as ABSENT and leave evidence blank.
  Do not invent evidence. Agents use the status field to know what can be claimed.

  STATUS VALUES:
    STRONG    — fully implemented, multiple file references, defensible in interview
    PARTIAL   — present but incomplete; agents must use recommended_framing only
    IMPLIED   — inferred from adjacent patterns, not directly implemented
    ABSENT    — not found in codebase; do not claim
    IN_PROGRESS — evidence of planned/partial work found (TODOs, branches, comments)
-->

### 2.1 Container Orchestration & Kubernetes

#### Self-healing infrastructure
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [path]
    description: [what this file proves]
resume_verb: "Deployed"
achievement_pattern: >
  [Verb] self-healing Kubernetes workloads via ArgoCD GitOps — automatic drift
  correction against Git as source of truth, enabling [METRIC] without manual
  cluster access.
interview_depth: >
  [AGENT: Write 2 sentences the engineer can say if asked to explain this in an
  interview — specific to what was found in the codebase]
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

#### Microservices / namespace isolation
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [path]
    description: [what this file proves]
resume_verb: "Architected"
achievement_pattern: >
  [Verb] microservices deployment topology across isolated Kubernetes namespaces
  — independent deployability, fault isolation, and namespace-scoped RBAC per
  service boundary.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

#### Kubernetes internals (kubeadm / control plane)
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [path]
    description: [what this file proves]
gap_note: >
  Self-hosted kubeadm exposes control plane internals (etcd, kube-apiserver,
  CNI, kubelet) that managed services like GKE abstract away. This is a
  differentiator vs candidates who have only used managed Kubernetes. Agents
  should surface this when a JD requires Kubernetes troubleshooting depth.
recommended_framing: >
  "Self-hosted Kubernetes via kubeadm — hands-on exposure to control plane
  internals, CNI configuration, and node-level operations that managed services
  abstract away."
```

#### Service mesh
```yaml
status: PARTIAL
evidence:
  - file: [AGENT: find Traefik IngressRoute and middleware configs]
    description: Traefik v3 handles L7 ingress and cross-namespace routing
honest_boundary: >
  IMPORTANT — Traefik v3 provides ingress routing and middleware chains.
  This is NOT a full service mesh. It does not provide mTLS between pods,
  circuit breaking, retries, or sidecar-based traffic policies (Istio/Linkerd).
  Agents must NEVER use the phrase "service mesh" when describing this project.
  Use "Traefik v3 ingress and cross-namespace routing" instead.
recommended_framing: >
  "Traefik v3 for ingress routing, cross-namespace traffic management, and
  middleware-based auth enforcement — L7 routing without a full service mesh."
```

#### Cluster autoscaling
```yaml
status: IN_PROGRESS
evidence:
  - file: [AGENT: search for ASG configs, Cluster Autoscaler YAML, Karpenter
           references, TODO comments, or any worker node scaling configs]
    description: [what was found]
gap_note: >
  Static named worker nodes are the current architecture. Migration to
  ASG-backed worker pools with Cluster Autoscaler is in progress.
  Agents should frame this as architectural evolution, not a gap:
  "Currently migrating from static worker nodes to ASG-backed auto-scaling
  groups with Cluster Autoscaler — enabling dynamic horizontal scaling
  under variable load."
recommended_framing: >
  Present as in-progress work that demonstrates forward architectural thinking.
  Do not claim dynamic auto-scaling as complete.
```

---

### 2.2 GitOps & Delivery

#### GitOps delivery model (ArgoCD)
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [path]
    description: [what this file proves]
achievement_pattern: >
  Implemented GitOps delivery via ArgoCD — all cluster changes driven through
  Git commits, enabling complete audit history, one-command rollback, and
  eliminating direct cluster access as a deployment mechanism.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

#### Separated CI/CD pipeline design
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find GitHub Actions workflow files, note CI vs CD separation]
    description: [what this file proves]
design_rationale: >
  CI pipeline (lint, test, build, security scan) runs on every commit.
  CD pipeline (image push, CDK diff, deploy, smoke test) runs on merge
  to main only. This separation reduces per-commit pipeline time by ~20%
  and significantly reduces GitHub Actions minutes consumed on dev branches.
achievement_pattern: >
  Architected separated CI/CD pipeline on GitHub Actions — decoupling quality
  gates from deployment stages, reducing per-commit feedback time by 20% and
  cutting Actions spend ~5× on non-main branches.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

### 2.3 Observability

#### Three-pillar observability (metrics / logs / traces)
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  metrics:
    - file: [path to Prometheus config / scrape configs / alert rules]
  logs:
    - file: [path to Loki config or Alloy log pipeline]
  traces:
    - file: [path to Tempo config]
  collector:
    - file: [path to Grafana Alloy config]
  dashboards:
    - file: [path to any Grafana dashboard JSON or provisioning config]
achievement_pattern: >
  Deployed complete observability stack (Prometheus, Grafana, Loki, Tempo)
  covering all three pillars — metrics, logs, and distributed traces — with
  Grafana Alloy as unified collector and <METRIC>-minute alert-to-detection
  on pod failures.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

#### SLO / alerting design
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find Prometheus alerting rules, recording rules, or any
           SLO-related configuration]
    description: [what this file proves]
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

### 2.4 Networking & Ingress

#### Request routing stack
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find Traefik IngressRoute YAML, middleware configs,
           CloudFront distribution, NLB configuration in CDK stacks]
    description: [what this file proves]
stack_description: >
  [AGENT: Describe the full request path from browser to pod based on what
  you find — e.g. Browser → CloudFront → NLB → Traefik → K8s Service → Pod.
  This is a key interview answer for networking questions.]
gap_note: >
  Practical networking depth demonstrated through Traefik middleware chains,
  CloudFront distribution config, and VPC routing in CDK. Candidate should be
  prepared to narrate request flow at each hop with protocol-level vocabulary:
  DNS resolution, TLS termination, L7 routing rules, kube-proxy / iptables,
  coreDNS, endpoint slices.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

### 2.5 Infrastructure as Code

#### AWS CDK TypeScript (multi-account)
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find CDK stack files, cdk.json, account/env config]
    description: [what this file proves]
accounts_found: [AGENT: list account IDs or environment names found in code]
achievement_pattern: >
  Managed all AWS infrastructure exclusively through CDK TypeScript across
  [N] accounts — zero console-deployed resources, full drift prevention, and
  cross-account OIDC-based CI/CD with environment-specific stack isolation.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

### 2.6 Security & Secrets Management

#### Zero-trust / OIDC federation
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find OIDC provider config, cross-account role assumptions,
           SSM parameter references, Secrets Manager usage]
    description: [what this file proves]
honest_boundary: >
  [AGENT: Describe what IS implemented vs what would constitute full zero-trust.
  Note any hardcoded values, overly broad IAM permissions, or missing rotation
  policies if found.]
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

### 2.7 Cloud-Native & Serverless Architecture

#### Serverless backend (frontend project)
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find Lambda functions, API Gateway config in CDK,
           DynamoDB table definitions, S3 bucket configs]
    description: [what this file proves]
achievement_pattern: >
  Built serverless cloud-native backend (API Gateway → Lambda → DynamoDB/S3)
  with CloudFront as global CDN layer — zero server management, automatic
  scaling, and documented cost optimisation eliminating ~$22/month in
  over-provisioned infrastructure.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

### 2.8 AI / ML Integration & Tooling

#### AWS Bedrock / AI pipeline integration
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find any Bedrock API calls, Claude API usage, AI pipeline
           code, prompt templates, agent configurations]
    description: [what this file proves]
achievement_pattern: >
  Integrated AWS Bedrock into operational tooling — AI-powered content pipeline
  with cost tracking, editorial workflow automation, and prompt engineering for
  [specific use case found in code].
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
gap_note: >
  If Bedrock integration is present, agents should surface this prominently
  for any JD that mentions AI tooling, agent orchestration, or workflow
  automation — this is a genuine differentiator as most infrastructure
  candidates do not have AI integration experience.
```

---

### 2.9 Developer Tooling & CLI

#### Commander.js CLI / workflow automation
```yaml
status: [STRONG|PARTIAL|IMPLIED|ABSENT|IN_PROGRESS]
evidence:
  - file: [AGENT: find CLI entry points, Commander.js usage, any scripts
           that replaced Makefile tasks]
    description: [what this file proves]
achievement_pattern: >
  Refactored 500+ line Makefile into a Commander.js CLI with typed subcommands,
  validation, and cross-environment support — reducing operational friction and
  improving pipeline maintainability.
recommended_framing: >
  [AGENT: One sentence for resume/cover letter use]
```

---

## 3. Achievement Bank

<!--
  AGENT: For each of the following, generate a complete resume achievement bullet
  based on actual evidence found in the codebase. Use the format:
  [Strong action verb] + [what was built/changed] + [measurable outcome or scope].
  Past tense. Under 2 lines. Reference real metrics where config files provide them
  (e.g. alert thresholds, timeout values, resource limits).

  If a metric is not found in code, use the pattern [METRIC] as a placeholder
  so the engineer knows to fill it in from their own measurements.
-->

### 3.1 Platform & infrastructure bullets
1. [AGENT: generate — self-healing K8s / ArgoCD]
2. [AGENT: generate — CDK multi-account IaC]
3. [AGENT: generate — kubeadm control plane depth]
4. [AGENT: generate — VPC/networking/cost optimisation]

### 3.2 Delivery & pipeline bullets
5. [AGENT: generate — separated CI/CD design with 20% time saving]
6. [AGENT: generate — GitOps rollback / MTTR]
7. [AGENT: generate — security scanning in pipeline]

### 3.3 Observability bullets
8. [AGENT: generate — three-pillar observability stack]
9. [AGENT: generate — alerting / SLO design]

### 3.4 Full stack & product bullets
10. [AGENT: generate — serverless backend architecture]
11. [AGENT: generate — Next.js frontend + admin dashboard as internal tooling]
12. [AGENT: generate — AI / Bedrock integration]

### 3.5 Tooling & process bullets
13. [AGENT: generate — Commander.js CLI replacing Makefile]
14. [AGENT: generate — cross-account OIDC / secrets management]


---

## 4. Gap Registry

<!--
  AGENT: Populate each entry based on your codebase scan. These entries tell
  the resume generation agents what CANNOT be claimed and what framing to use
  instead. This section is as important as the achievement bank.
-->

### 4.1 Known honest boundaries

| Concept | Status | Safe framing | Do not claim |
|---|---|---|---|
| Service mesh | PARTIAL | "Traefik v3 ingress and cross-namespace routing" | "Service mesh", "mTLS between pods", "Istio" |
| Cluster autoscaling | IN_PROGRESS | "Migrating to ASG-backed auto-scaling" | "Dynamic auto-scaling", "Cluster Autoscaler implemented" |
| GCP / GKE | ABSENT | "AWS-native, Kubernetes transferable" | "GCP experience", "GKE" |
| PHP / Hack | [AGENT: check codebase] | "TypeScript/Node backend development" | "PHP developer" |
| Kernel debugging | [AGENT: check for any perf/strace/ebpf tooling] | [AGENT: fill] | [AGENT: fill] |
| Large-scale multi-node | EXPERIENCE GAP | "Self-hosted production Kubernetes" | "Enterprise-scale cluster operations" |

### 4.2 In-progress work — present as architectural evolution, not gaps

<!--
  AGENT: For each of the following, find evidence in the codebase (TODOs,
  branch names, partial configs, documentation notes) and write the recommended
  framing. These should be presented as forward-looking architectural decisions,
  not missing features.
-->

1. **ASG / Cluster Autoscaler migration**
   - Evidence found: [AGENT: list files/comments]
   - Recommended framing: "Currently migrating from static worker nodes to
     ASG-backed worker pools with Cluster Autoscaler — enabling dynamic
     horizontal scaling under variable load."

2. [AGENT: identify any other in-progress work from TODOs, branch names,
   or partial configurations and add entries here]


---

## 5. Narrative Framing Library

<!--
  These are pre-written narrative blocks agents can draw on when writing
  cover letters or resume summaries. Agents should select and adapt the
  most relevant block based on the submitted JD.
-->

### 5.1 Platform engineering narrative
[AGENT: Write a 3-sentence narrative describing the cdk-monitoring project
as a platform engineering initiative — emphasis on building the foundational
layer that application workloads run on. Use specific technologies found.]

### 5.2 Full stack + platform unified narrative
<!--
  CRITICAL FRAMING — use this when a JD values both infrastructure depth
  and product delivery capability simultaneously.

  The narrative: This engineer built the platform layer (cdk-monitoring) AND
  deployed a real product onto it (frontend/portfolio site). He experienced
  the platform engineer's perspective AND the application engineer's perspective
  on the same infrastructure. Most candidates only experience one side.
  This is the unified narrative that connects both projects.
-->
[AGENT: Write a 3-sentence narrative using the two-project relationship
as evidence. Confirm by finding the CDK stack that provisions infrastructure
used by the frontend, and the ArgoCD manifest or Kubernetes deployment that
runs the Next.js application.]

### 5.3 Support-to-DevOps transition narrative
[AGENT: Write a 2-sentence narrative bridging the AWS Technical Support
background with the self-built infrastructure portfolio — framing the
transition as deliberate: support experience → understanding how systems
fail → building systems that don't.]

### 5.4 AI-augmented engineering narrative
[AGENT: Write a 2-sentence narrative if Bedrock/AI integration evidence
is found — positioning the engineer as someone who builds AI-integrated
operational tooling, not just consumes AI tools.]


---

## 6. DORA Metrics Integration

<!--
  This section connects to the existing DORA domain already in the KB.
  Agents should cross-reference both domains when a JD mentions reliability,
  deployment frequency, or pipeline metrics.
-->

### 6.1 DORA metrics as resume evidence
<!--
  AGENT: Find any metric configurations, alert thresholds, or pipeline timing
  that can produce concrete DORA numbers. If found, populate below.
  If not found, leave as [MEASURE] placeholders.
-->

| Metric | Value | Evidence file | Resume framing |
|---|---|---|---|
| Lead time for changes | [MEASURE] | [AGENT: find pipeline timing config] | "Commit → prod in under [N] minutes" |
| Deployment frequency | [MEASURE] | [AGENT: find deploy trigger config] | "Regular deployments via ArgoCD on main merge" |
| MTTR | [MEASURE] | [AGENT: find rollback config / alert rules] | "Sub-[N]-minute recovery via ArgoCD rollback" |
| Change failure rate | [MEASURE] | [AGENT: find test coverage, pipeline gates] | "[N]% CFR enforced via CI quality gates" |

### 6.2 Solo-dev DORA adaptations
<!--
  The DORA domain should already contain standard team-based thresholds.
  These adaptations apply when the engineer presents solo project metrics.
  Agents should use these framings to prevent overstating team-scale claims.
-->
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

<!--
  Instructions for the Bedrock agents on how to use this domain document
  when generating resumes and cover letters.
-->

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

*Resume Domain v1.0 — Generated by codebase scan*
*Integrates with: dora-metrics domain*
*Next review: after ASG/Cluster Autoscaler migration is complete*