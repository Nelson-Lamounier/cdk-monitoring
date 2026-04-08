---
title: "CDK Stack Architecture Overview"
doc_type: architecture
domain: infrastructure
tags:
  - cdk
  - typescript
  - cloudformation
  - stack-architecture
  - 22-stacks
  - aws
  - kubernetes
  - bedrock
  - jest
  - unit-testing
  - integration-testing
  - template-assertions
related_docs:
  - infrastructure/adrs/cdk-over-terraform.md
  - infrastructure/networking-implementation.md
  - infrastructure/security-implementation.md
  - infrastructure/infrastructure-topology.md
  - infrastructure/stacks/kubernetes-base-stack.md
  - operations/ci-cd-implementation.md
last_updated: "2026-04-08"
author: Nelson Lamounier
status: accepted
---

# Architecture Overview: Self-Managed Kubernetes on AWS with CDK

**Project:** cdk-monitoring
**Author:** Nelson Lamounier
**Last Updated:** 2026-03-31

## Multi-Project Architecture

The infrastructure is organised as two independent factory-driven projects, totalling 22 CDK stacks:

- **Kubernetes Project** — 14 stacks (VPC, compute, edge, observability)
- **Bedrock Project** — 8 stacks (AI/ML pipelines, knowledge base, API)

The Kubernetes platform is deployed as 14 independent CloudFormation stacks, orchestrated by a factory pattern in `infra/lib/projects/kubernetes/factory.ts`. Stacks are decoupled through SSM parameters — no cross-stack CloudFormation exports.

### Stack Dependency Graph

```
1. Kubernetes-Data          → DynamoDB, S3 Assets, SSM parameters
2. Kubernetes-Base          → VPC lookup, Security Groups ×4, KMS, EBS, EIP, Route 53, S3 scripts bucket, NLB
  2b. Kubernetes-GoldenAmi  → EC2 Image Builder pipeline (bakes Golden AMI with kubeadm, containerd, Calico)
  2c. Kubernetes-SsmAutomation → SSM Automation documents ×6, Step Functions orchestrator, EventBridge triggers
3. Kubernetes-ControlPlane  → Control plane EC2 (t3.medium), ASG min=1/max=1, EIP failover Lambda
  3b. Kubernetes-AppWorker       → Application node EC2 (t3.small), ASG, kubeadm join (legacy)
  3c. Kubernetes-MonitoringWorker → Monitoring node EC2 (t3.medium Spot), ASG, kubeadm join (legacy)
  3d. Kubernetes-ArgocdWorker    → ArgoCD node EC2 (t3.small Spot), ASG, kubeadm join (legacy)
  3e. Kubernetes-GeneralPool → Parameterised ASG pool (t3.small Spot, min=1/max=4, CA-enabled, node-pool=general)
  3f. Kubernetes-MonitoringPool → Parameterised ASG pool (t3.medium Spot, min=1/max=2, CA-enabled, tainted)
4. Kubernetes-AppIam        → Application-tier IAM grants (DynamoDB, S3, Secrets)
5. Kubernetes-API           → API Gateway + Lambda (email subscriptions)
6. Kubernetes-Edge          → ACM + WAF + CloudFront (us-east-1), Route 53 alias
7. Kubernetes-Observability → CloudWatch pre-deployment dashboard
```

### Per-Stack Deep-Dive Documentation

Detailed problem → solution documentation for individual stacks is available in the `infrastructure/stacks/` folder. Each document covers: what resources the stack creates, what problem it solves, why it was designed that way, design patterns, cost estimates, and failure impact analysis.

| Stack | Deep-Dive Document |
|---|---|
| Kubernetes-Base | [kubernetes-base-stack.md](infrastructure/stacks/kubernetes-base-stack.md) |

### Bedrock Stack Dependency Graph

The Bedrock AI/ML stacks are deployed as a separate project via `infra/lib/projects/bedrock/factory.ts`:

```
1. Bedrock-Data              → S3 assets bucket, DynamoDB content table
2. Bedrock-Kb                → Bedrock Knowledge Base, Pinecone integration
3. Bedrock-Agent             → Bedrock Agent with KB data source
4. Bedrock-Api               → API Gateway (chatbot), Lambda handlers
5. Bedrock-Content           → DynamoDB content pipeline table, S3 event config
6. Bedrock-Pipeline          → Step Functions (3-agent article pipeline), 6 Lambdas, version history
7. Bedrock-StrategistData    → DynamoDB job strategist table + GSI
8. Bedrock-StrategistPipeline → Step Functions (3-agent job strategist), 4 Lambdas
```

### Why 14 Stacks?

Splitting into granular stacks isolates blast radius:
- Changing an AMI only redeploys GoldenAmi + Compute stacks
- Changing SG rules only redeploys Base stack
- Changing WAF rules only redeploys Edge stack (in us-east-1)
- SSM Automation docs can be updated independently from EC2 instances
- New pool stacks (GeneralPool, MonitoringPool) are additive — legacy workers remain until workloads are migrated via `nodeSelector`

### Cross-Stack Communication via SSM

All stacks discover each other through SSM Parameter Store paths (`/k8s/development/*`). The `SsmParameterStoreConstruct` writes parameters in producing stacks. Consuming stacks read via `ssm.StringParameter.valueFromLookup()` at synth time or `AwsCustomResource` at deploy time.

Example SSM parameters:
- `/k8s/development/vpc-id` — VPC ID from shared stack
- `/k8s/development/security-group-id` — cluster base SG
- `/k8s/development/control-plane-sg-id` — control plane SG
- `/k8s/development/eip-allocation-id` — Elastic IP
- `/k8s/development/kms-key-arn` — CloudWatch encryption key
- `/k8s/development/scripts-bucket-name` — S3 scripts bucket
- `/k8s/development/golden-ami/latest` — latest Golden AMI ID

### Factory Pattern

The Kubernetes factory (`infra/lib/projects/kubernetes/factory.ts`) implements `IProjectFactory` and creates all 14 stacks with correct dependency ordering. The two new pool stacks (`generalPool`, `monitoringPool`) are registered via `KubernetesWorkerAsgStack` and use `WorkerPoolType` to branch instance type, capacity, taint, and IAM policy set. Usage:

```typescript
// infra/bin/app.ts selects factory based on -c project=k8s
const factory = new KubernetesFactory();
factory.create(app, { environment: Environment.DEVELOPMENT });
```

## Kubernetes Cluster Configuration

All cluster parameters are defined in `infra/lib/config/kubernetes/configurations.ts`:

| Parameter | Development | Production |
|---|---|---|
| Kubernetes version | 1.35.1 | 1.35.1 |
| Pod network CIDR | 192.168.0.0/16 | 192.168.0.0/16 |
| Service subnet | 10.96.0.0/12 | 10.96.0.0/12 |
| Control plane instance | t3.medium | t3.small |
| App worker instance | t3.small | t3.small |
| Monitoring worker | t3.medium (Spot) | t3.small (Spot) |
| ArgoCD worker | t3.small (Spot) | t3.small (Spot) |
| **General pool** (new) | t3.small Spot, min=1/max=4 | t3.small Spot |
| **Monitoring pool** (new) | t3.medium Spot, min=1/max=2 | t3.medium Spot |
| EBS volume | 30 GB | 50 GB |
| Log retention | 1 week | 3 months |
| Removal policy | DESTROY | RETAIN |

## Golden AMI — Baked Software Versions

The EC2 Image Builder pipeline bakes these into every AMI (from `K8sImageConfig`):

| Software | Version | Purpose |
|---|---|---|
| containerd | 1.7.24 | Container runtime |
| runc | 1.2.4 | OCI runtime |
| kubeadm/kubelet/kubectl | 1.35.1 | Kubernetes toolchain |
| Calico | v3.29.3 | CNI networking (BGP + VXLAN) |
| CNI plugins | 1.6.1 | Container Network Interface |
| crictl | 1.32.0 | CRI debugging tool |
| ECR credential provider | v1.31.0 | Pull images from ECR |
| K8sGPT | 0.4.29 | AI-powered K8s diagnostics (self-healing) |
| Docker Compose | v2.24.0 | Local development |
| AWS CLI | 2.x | AWS API access |

Base image: Amazon Linux 2023 (kernel 6.1, x86_64) from SSM path `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64`.

## Security Groups — 4 Data-Driven SGs

All rules are defined as typed config in `configurations.ts` — not inline in stack code. The `SecurityGroupConstruct` reads the config array and calls `addIngressRule()` for each entry.

### Cluster Base SG (intra-cluster)

Self-referencing rules for node-to-node communication:

| Port(s) | Protocol | Source | Purpose |
|---|---|---|---|
| 2379–2380 | TCP | self | etcd client and peer |
| 6443 | TCP | self | K8s API server |
| 10250 | TCP | self | kubelet API |
| 10257 | TCP | self | kube-controller-manager |
| 10259 | TCP | self | kube-scheduler |
| 4789 | UDP | self | VXLAN overlay networking |
| 179 | TCP | self | Calico BGP peering |
| 30000–32767 | TCP | self | NodePort services |
| 53 | TCP+UDP | self | CoreDNS |
| 5473 | TCP | self | Calico Typha |
| 9100 | TCP | self | Traefik metrics |
| 9101 | TCP | self | Node Exporter metrics |

Pod CIDR (192.168.0.0/16) → node rules:

| Port | Protocol | Purpose |
|---|---|---|
| 6443 | TCP | K8s API server (from pods) |
| 10250 | TCP | kubelet API (from pods) |
| 53 | TCP+UDP | CoreDNS (from pods) |
| 9100 | TCP | Traefik metrics (from pods) |
| 9101 | TCP | Node Exporter metrics (from pods) |

### Control Plane SG

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 6443 | TCP | VPC CIDR | K8s API from VPC (SSM port-forwarding) |

### Monitoring SG

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 9090 | TCP | VPC CIDR | Prometheus metrics |
| 9100 | TCP | VPC CIDR + Pod CIDR | Node Exporter metrics |
| 30100 | TCP | VPC CIDR | Loki push API (cross-stack log shipping) |
| 30417 | TCP | VPC CIDR | Tempo OTLP gRPC (cross-stack trace shipping) |

### Ingress SG

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 80 | TCP | VPC CIDR | HTTP health checks from NLB |
| 443 | TCP | CloudFront prefix list | HTTPS from CloudFront (added at runtime) |
| 80+443 | TCP | Admin IPs (SSM) | Admin access (added at runtime from `/admin/allowed-ips`) |

## Traffic Flow

```
User → CloudFront (HTTPS, dev.nelsonlamounier.com)
       → WAF (rate limit 2000/5min, IP reputation, AWS managed rules)
       → Elastic IP (HTTP — avoids SSL hostname mismatch with Traefik self-signed cert)
       → NLB (TCP passthrough, eu-west-1)
       → Traefik Ingress Controller (port 80/443)
       → Kubernetes Service → Pod
```

CloudFront is deployed in us-east-1 (required), compute in eu-west-1. The Edge stack reads the EIP from SSM cross-region.

## Bootstrap Pipeline

Instance boot follows a 4-layer hybrid strategy:

1. **Layer 1: Golden AMI** — pre-baked software (kubeadm, containerd, Calico manifests)
2. **Layer 2: User Data** — slim trigger: attach EBS volume, signal CloudFormation
3. **Layer 3: SSM Automation** — one-shot kubeadm bootstrap (control plane init or worker join)
4. **Layer 3b: SSM State Manager** — continuous drift enforcement every 30 minutes (kernel modules, sysctl, services)

EventBridge triggers the Step Functions orchestrator on every ASG `EC2 Instance Launch Successful` event. The orchestrator Lambda reads `k8s:bootstrap-role` ASG tags to resolve the correct SSM Automation document.

## Self-Healing Pipeline

Deployed as 2 additional CDK stacks: `SelfHealing-Gateway-development` (AgentCore Gateway + tool Lambdas) and `SelfHealing-Agent-development` (agent Lambda + EventBridge + SNS + S3 + DLQ).

- **Model:** `eu.anthropic.claude-sonnet-4-6` via Bedrock ConverseCommand (tool-use loop, max 10 iterations)
- **Auth:** Cognito M2M OAuth2 client credentials flow (JWT per invocation)
- **Tools:** `diagnose_alarm` (CloudWatch API), `ebs_detach` (EC2+ASG), `check_node_health` (SSM→kubectl), `analyse_cluster_health` (SSM→K8sGPT)
- **FinOps:** Token budget alarm (100K/hr MathExpression), reserved concurrency, EventBridge self-exclusion filter, DRY_RUN mode
- **PoC verified:** 2026-03-23 — agent completed full diagnostic loop in 26.3s using 4,448 tokens (~$0.02)

## CDK Testing Strategy

The codebase implements a **dual-layer testing strategy** using Jest for both unit and integration tests. This approach provides synth-time confidence (unit tests) and post-deployment correctness (integration tests), catching different categories of defects.

### TypeScript CDK — Language & Tooling

| Aspect | Standard |
|---|---|
| **Language** | TypeScript 5.x with `strict: true` |
| **Test framework** | Jest 29 with `ts-jest` transformer |
| **CDK assertion library** | `aws-cdk-lib/assertions` (`Template`, `Match`) |
| **Linting** | ESLint + `@typescript-eslint` + `jest/no-conditional-in-test` |
| **CI command** | `just test-unit <path>` / `just ci-integration-test <path> <env>` |
| **Coverage** | Enabled in CI, excluded from local rapid-iteration runs |

### Unit Tests — Synth-Time Template Assertions

Unit tests synthesise the CDK stack via `Template.fromStack()` and assert against the resulting CloudFormation JSON. They run **without AWS credentials** and complete in under 3 seconds.

**What they verify:**
- Resource existence and counts (`resourceCountIs`)
- Resource properties and configuration (`hasResourceProperties`, `Match.objectLike`)
- Security group inline rules (ingress and egress arrays)
- Self-referencing vs CIDR-based SG rule rendering patterns
- SSM parameter publishing for cross-stack discovery
- Stack outputs (`CfnOutput` exports)
- Public property exposure (typed API surface)
- Config integration (config-driven values flow correctly to resources)

**Test file layout:**
```
infra/tests/
├── fixtures/                        # Shared test factories, VPC mock context
│   ├── index.ts                     # Re-exports all fixtures
│   └── test-app.ts                  # createTestApp() with VPC context mock
├── unit/
│   ├── stacks/
│   │   ├── kubernetes/
│   │   │   ├── base-stack.test.ts           # 108 tests — reference implementation
│   │   │   ├── compute-stack.test.ts
│   │   │   ├── data-stack.test.ts
│   │   │   ├── api-stack.test.ts
│   │   │   ├── app-iam-stack.test.ts
│   │   │   ├── observability-stack.test.ts
│   │   │   ├── ssm-automation-stack.test.ts
│   │   │   ├── argocd-worker-stack.test.ts
│   │   │   ├── monitoring-worker-stack.test.ts
│   │   │   └── worker-asg-stack.test.ts    # NEW — general + monitoring pool unit tests
│   │   ├── bedrock/
│   │   │   ├── agent-stack.test.ts
│   │   │   ├── ai-content-stack.test.ts
│   │   │   ├── api-stack.test.ts
│   │   │   ├── data-stack.test.ts
│   │   │   ├── kb-stack.test.ts
│   │   │   ├── strategist-data-stack.test.ts
│   │   │   └── strategist-pipeline-stack.test.ts
│   │   ├── self-healing/
│   │   │   ├── agent-stack.test.ts
│   │   │   └── gateway-stack.test.ts
│   │   └── shared/
│   │       ├── cognito-auth-stack.test.ts
│   │       ├── crossplane-stack.test.ts
│   │       ├── finops-stack.test.ts
│   │       └── security-baseline-stack.test.ts
│   ├── constructs/                  # Isolated construct-level tests
│   ├── lambda/                      # Lambda handler tests
│   ├── factories/                   # Factory pattern tests
│   └── utilities/                   # Naming, tagging utility tests
└── integration/
    ├── kubernetes/                   # 12 post-deploy verification suites
    └── self-healing/                 # Agent stack integration
```

**Unit test conventions (enforced by ESLint + custom rules):**

1. **Named constants** — no magic values in assertions (`TEST_VPC_CIDR`, `ANY_IPV4`, `NLB_LOG_LIFECYCLE_DAYS`)
2. **Data-driven tests** — `it.each()` for repetitive rule validation (e.g., 19 SG rules in one loop)
3. **No conditionals in tests** — `jest/no-conditional-in-test` is `error` for unit, `warn` for integration
4. **`requireParam` guard** — never use `!` (non-null assertion) on external data; throw descriptive errors
5. **`import type`** — all type-only imports use `import type` for `isolatedModules` compliance
6. **`satisfies` over `as`** — typed literal arrays use `satisfies` to catch structural errors at definition
7. **Resource caching** — API results fetched in `beforeAll`, never inside `it()` blocks

### Integration Tests — Post-Deployment AWS Verification

Integration tests call **live AWS APIs** (EC2, ELBv2, S3, SSM, KMS, Route 53) to verify deployed resources match expectations. They require valid AWS credentials and a deployed stack.

**What they verify:**
- AWS resource state (`available`, `enabled`, `in-service`)
- Security group rules exist on live EC2 security groups
- NLB configuration, target group health, listener protocols
- S3 bucket encryption, lifecycle policies, access logging
- KMS key rotation and enablement status
- EBS volume size, type, encryption, and AZ placement
- Route 53 hosted zones and DNS records
- SSM parameter values match expected cross-stack contracts

**Integration test file inventory:**

| Test Suite | Stack Verified | Key Assertions |
|---|---|---|
| `base-stack.integration.test.ts` | KubernetesBaseStack | ~80 assertions: VPC, SGs ×5, NLB, EBS, EIP, S3, KMS, Route 53, SSM |
| `control-plane-stack.integration.test.ts` | ControlPlaneStack | ASG config, instance type, user-data, SG attachment |
| `app-worker-stack.integration.test.ts` | AppWorkerStack | Worker ASG, Spot config, kubeadm join |
| `argocd-worker-stack.integration.test.ts` | ArgocdWorkerStack | ArgoCD node ASG, Spot config |
| `monitoring-worker-stack.integration.test.ts` | MonitoringWorkerStack | Monitoring node ASG, EBS attachment |
| `worker-asg-stack.integration.test.ts` | **KubernetesWorkerAsgStack** | Pool-aware: `--pool general` / `--pool monitoring`; ASG tags, IAM policies, CA tags, SNS (monitoring only) |
| `golden-ami-stack.integration.test.ts` | GoldenAmiStack | Image Builder pipeline, components, AMI output |
| `edge-stack.integration.test.ts` | EdgeStack | CloudFront, WAF, ACM, cookie forwarding |
| `data-stack.integration.test.ts` | DataStack | DynamoDB tables, S3 asset bucket |
| `bootstrap-orchestrator.integration.test.ts` | SsmAutomationStack | Step Functions state machine, SSM documents |
| `ssm-automation-runtime.integration.test.ts` | SsmAutomation (runtime) | Instance targeting, EC2 health, SSM Agent |
| `s3-bootstrap-artefacts.integration.test.ts` | S3 artefacts | Bucket exists, script file counts per prefix |
| `bluegreen.integration.test.ts` | Argo Rollouts | Traffic segregation in BlueGreen transitions |
| `agent-stack.integration.test.ts` | SelfHealingAgent | Bedrock agent, EventBridge rules, SNS topics |

### KubernetesBaseStack — Reference Implementation

The `KubernetesBaseStack` serves as the **gold standard** for CDK testing in this project. It demonstrates the complete dual-layer approach with 108 unit tests and ~80 integration test assertions.

#### Unit Test Coverage (108 tests)

| Describe Block | Tests | What It Validates |
|---|---|---|
| Security Groups — Existence | 5 | 5 SGs created (4 custom + 1 NLB), correct egress policies |
| Cluster Base SG — Ingress Rules | 19 | All 19 config-driven rules: self-referencing TCP/UDP, VPC CIDR, pod CIDR |
| Control Plane SG — Rules | 1 | Port 6443 from VPC CIDR |
| Ingress SG — Rules | 1 | Port 80 from VPC CIDR (NLB health checks) |
| Monitoring SG — Rules | 5 | Prometheus (9090), Node Exporter (9100), Loki (30100), Tempo (30417), pod CIDR |
| CloudFront Prefix List | 2 | Custom resource lookup + IAM permissions |
| NLB — Configuration | 2 | Internet-facing scheme, load balancer name |
| NLB — Target Groups | 4 | HTTP/HTTPS TGs, port/protocol, health check |
| NLB — Listeners | 3 | 2 listeners (count), TCP on port 80, TCP on port 443 |
| NLB — Security Group | 5 | Inline ingress (80/443 from 0.0.0.0/0), inline egress (80/443 to VPC CIDR) |
| KMS Key | 4 | Encryption enabled, rotation, alias, CloudWatch service principal |
| EBS Volume | 5 | GP3 type, encryption, volume size, AZ, tagging |
| DLM Snapshot Policy | 4 | Lifecycle policy, target tag, daily schedule, IAM role |
| Elastic IP | 2 | VPC domain, name tagging |
| Route 53 | 2 | Private hosted zone, placeholder A record |
| S3 Buckets | 2 | 3 buckets created, encryption enabled |
| NLB Access Logs Bucket | 3 | SSE-S3 encryption, 3-day lifecycle, bucket name pattern |
| SSM Parameters | 12 | 14 parameters under correct prefix, SG IDs, TG ARNs, resource references |
| Stack Properties | 10 | Public fields (vpc, securityGroup, elasticIp, etc.) |
| Stack Outputs | 9 | CfnOutput exports (VpcId, SecurityGroupId, etc.) |
| Config Integration | 5 | Config values flow correctly to resources |
| Resource Counts | 1 | Total core resource count validation |

#### CDK Template Assertion Patterns

A critical design decision in the unit tests is understanding how CDK renders security group rules:

| Peer Type | CDK CFN Output | Assertion Pattern |
|---|---|---|
| Self-referencing (`Peer.self()`) | Separate `AWS::EC2::SecurityGroupIngress` resource | `template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', ...)` |
| CIDR (`Peer.ipv4(cidr)`) | Inline on `AWS::EC2::SecurityGroup` | `SecurityGroupIngress` array with `Match.arrayWith()` |
| Egress with `allowAllOutbound: false` | Inline `SecurityGroupEgress` array | Replaces default `Disallow all traffic` placeholder |

This distinction is essential for writing correct assertions. Many CDK test suites fail because they assume all rules render as standalone resources.

### Testing in CI/CD

Both test layers run in the GitHub Actions deployment pipeline:

```
┌─────────────────┐     ┌────────────────────┐     ┌────────────────────────┐
│  ci.yml         │     │ deploy-kubernetes   │     │  verify-base-stack     │
│                 │     │                     │     │                        │
│  just test-unit │────▶│  cdk deploy base    │────▶│  just ci-integration   │
│  (all stacks)   │     │                     │     │  kubernetes/base-stack │
│                 │     │                     │     │  $CDK_ENV --verbose    │
└─────────────────┘     └────────────────────┘     └────────────────────────┘
```

- **Unit tests** run on every PR (`ci.yml`) — no AWS credentials required
- **Integration tests** run after each stack deployment (`_deploy-kubernetes.yml`) — requires deployed stack
- **Gate pattern** — downstream stacks wait for `verify-base-stack` to succeed before deploying

### Industry Standards & Best Practices

The testing implementation follows established industry standards:

| Practice | Implementation | Industry Reference |
|---|---|---|
| **Shift-left testing** | Unit tests catch ~90% of CFN errors at synth time | AWS Well-Architected (Reliability Pillar) |
| **Template assertions** | `aws-cdk-lib/assertions` library (official CDK testing approach) | AWS CDK Developer Guide |
| **Data-driven tests** | `it.each()` eliminates copy-paste for config-driven resources | Jest best practices |
| **Test pyramid** | Many fast unit tests, fewer slow integration tests | Martin Fowler's Test Pyramid |
| **Post-deployment verification** | Integration tests validate deployed state matches intent | AWS Solutions Architect pattern |
| **Deterministic tests** | No conditionals (`jest/no-conditional-in-test`), no flaky assertions | `eslint-plugin-jest` enforcement |
| **CI gate pattern** | Pipeline blocks downstream deploys on test failure | Continuous Delivery (Humble & Farley) |
| **Config-driven assertions** | Test constants derived from the same config source as the stack | DRY principle |

### Problems the Test Suite Addresses

1. **Drift detection** — catches when CDK construct changes silently alter CloudFormation output
2. **Security group rule completeness** — validates all 19 ingress rules exist, preventing accidental omission that could break etcd, kubelet, or DNS
3. **NLB misconfiguration** — verifies health check ports, target group protocols, and listener bindings match the expected traffic flow
4. **Cross-stack contract integrity** — ensures all 14 SSM parameters are published, preventing downstream stack deployment failures
5. **Encryption compliance** — validates KMS key rotation, S3 encryption (SSE-S3 for NLB logs, SSE-KMS for scripts), and EBS encryption
6. **Lifecycle policy enforcement** — verifies DLM snapshot policies and S3 lifecycle rules to prevent cost surprises
7. **Post-deployment state mismatch** — integration tests catch AWS resource state that doesn't match the synthesised template (e.g., manual changes, failed deploys)

## Source Files

### Stack Definitions
- `infra/lib/projects/kubernetes/factory.ts` — 14-stack factory (now includes `generalPool` + `monitoringPool`)
- `infra/lib/config/kubernetes/configurations.ts` — all configs (SG rules, instance types, versions)
- `infra/lib/stacks/kubernetes/base-stack.ts` — long-lived infrastructure
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` — compute layer
- `infra/lib/stacks/kubernetes/worker-asg-stack.ts` — **NEW** parameterised ASG pool (`WorkerPoolType` = `general` | `monitoring`)
- `infra/lib/stacks/kubernetes/edge-stack.ts` — CloudFront + WAF
- `infra/lib/stacks/kubernetes/ssm-automation-stack.ts` — bootstrap orchestration
- `infra/lib/stacks/kubernetes/golden-ami-stack.ts` — AMI baking pipeline
- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` — Step Functions state machine
- `infra/lib/constructs/ssm/node-drift-enforcement.ts` — drift remediation

### Test Suites
- `infra/tests/unit/stacks/kubernetes/base-stack.test.ts` — 108 unit tests (reference implementation)
- `infra/tests/integration/kubernetes/base-stack.integration.test.ts` — ~80 post-deploy assertions
- `infra/tests/fixtures/` — shared VPC context mocks, test app factory
- `.agents/rules/integration-test-quality.md` — 11 enforced test quality rules

## Transferable Skills Demonstrated

- **Multi-stack CDK architecture** — organising 22 stacks across 2 factory-driven projects with SSM-based cross-stack discovery
- **TypeScript CDK testing** — dual-layer unit + integration test strategy using `aws-cdk-lib/assertions` with 108 template assertions on the reference stack
- **Test pyramid in infrastructure** — fast synth-time unit tests (no credentials) + slower post-deploy integration tests (live AWS APIs), gated in CI/CD
- **Data-driven test design** — config-derived assertions via `it.each()` aligned with the same configuration source as production stacks
- **Security group rule verification** — understanding CDK L1/L2 rendering patterns (self-referencing vs inline CIDR rules) for correct template assertions
- **Separation of concerns** — isolating compute, networking, AI/ML, and edge into independent stacks
- **AWS Well-Architected alignment** — designing for security, reliability, and cost optimisation
- **Infrastructure documentation** — communicating complex architectures to mixed audiences

## Summary

This document provides the high-level architectural overview of the entire cdk-monitoring infrastructure, mapping all 22 CDK stacks across 2 projects (Kubernetes + Bedrock). The Kubernetes project grew from 12 to 14 stacks in April 2026, adding two parameterised ASG pool stacks (`KubernetesWorkerAsgStack` — `general` and `monitoring` pools) with pool-specific IAM policies, Cluster Autoscaler tags, and a self-bootstrapping User Data orchestrator. The dual-layer CDK testing strategy (unit + integration), the KubernetesBaseStack reference implementation, and the pool-aware integration test suite are also documented.

## Keywords

cdk, typescript, cloudformation, stack-architecture, aws, kubernetes, bedrock, self-healing, edge, networking, security, observability, jest, unit-testing, integration-testing, template-assertions, test-pyramid, worker-asg, asg-pool, cluster-autoscaler, spot-instances
