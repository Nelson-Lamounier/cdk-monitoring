# Live Infrastructure — Architecture Topology

**Region:** eu-west-1 (Ireland)
**Environment:** development

## Network Topology

```
Internet
    │
    ├── CloudFront Distribution (us-east-1)
    │       ├── Static assets → S3 OAC origin (eu-west-1)
    │       └── Dynamic content → EIP origin (HTTP_ONLY)
    │
    ├── Elastic IP (eu-west-1)
    │       │
    │   NLB (TCP passthrough)
    │       ├── Target Group: HTTP  (TCP 80)
    │       └── Target Group: HTTPS (TCP 443)
    │               │
    │           Traefik DaemonSet (hostNetwork)
    │               ├── ops.{domain} → Grafana, Prometheus, ArgoCD
    │               └── {domain} → Next.js frontend
    │
    └── API Gateway (eu-west-1)
            ├── Bedrock API (content generation)
            ├── NextJS API (subscriptions, articles)
            └── Self-Healing Gateway (MCP protocol)
```

## VPC Architecture

```
VPC (/16 CIDR)
│
├── Public Subnet 1 (AZ-a)
│       ├── Control Plane Node
│       ├── App Worker Node
│       └── Monitoring Worker Node
│
└── Public Subnet 2 (AZ-b)
        └── ArgoCD Worker Node
```

**Design choice:** Public subnets only — no NAT Gateway cost (~€30/month). Instances use public IPs but are protected by strict security group rules and SSM-only access (no SSH).

## Kubernetes Cluster Architecture

```
K8s Cluster (kubeadm, private API endpoint on port 6443)
│
├── Control Plane Node
│       ├── kube-apiserver
│       ├── etcd
│       ├── kube-scheduler
│       └── kube-controller-manager
│
├── App Worker Node
│       ├── Next.js Frontend (via ArgoCD)
│       ├── Crossplane Providers (S3, SQS XRDs)
│       └── Application workloads
│
├── ArgoCD Worker Node
│       ├── ArgoCD Server
│       ├── ArgoCD Repo Server
│       └── ArgoCD ApplicationSet Controller
│
└── Monitoring Worker Node
        ├── Prometheus (custom Helm chart, native scrape_configs)
        ├── Grafana (13 dashboards, unified alerting → SNS)
        ├── Loki (log aggregation via ClusterIP)
        ├── Tempo (distributed tracing via ClusterIP)
        ├── Alloy (Faro RUM collector)
        ├── Promtail (DaemonSet log shipper)
        ├── kube-state-metrics
        ├── GitHub Actions Exporter
        └── Steampipe (AWS cloud inventory via SQL)
```

## Data Flow

### Article Generation Pipeline

```
1. Step Functions trigger (scheduled or on-demand)
2. → Publisher Lambda
3.   → Bedrock KB Retrieve API ← S3 source documents
4.   → Bedrock Converse API (Claude model)
5.   → DynamoDB (published article metadata)
6.   → S3 (article content blob)
7. Failures → SQS DLQ
```

### Self-Healing Agent (eu.anthropic.claude-sonnet-4-6)

```
1. CloudWatch Alarm → EventBridge Rule (self-exclusion filter)
2. → Agent Lambda (Bedrock ConverseCommand loop, DRY_RUN mode)
3.   → Cognito M2M OAuth2 → JWT token
4.   → Bedrock AgentCore Gateway (MCP tools/list → tools/call)
5.     → Tool: diagnose-alarm (CloudWatch API)
6.     → Tool: ebs-detach (EC2 + ASG API)
7.     → Tool: check-node-health (SSM → kubectl)
8.     → Tool: analyse-cluster-health (SSM → K8sGPT)
9. Session memory → S3 (30d lifecycle)
10. Failures → SQS DLQ (2 retries)
11. Notifications → SNS → Email report
```

**PoC verified:** 2026-03-23 — full loop completed in 26.3s, 4,448 tokens (~$0.02).

### Frontend Request Path

```
Browser → Route 53 DNS
  → CloudFront (us-east-1) — HTTPS termination, WAF
    ├── Static assets → S3 OAC (1yr cache)
    └── Dynamic → EIP origin (HTTP_ONLY)
      → Traefik (hostNetwork, route matching)
        → Next.js Pod (SSR, ISR)
          → API Gateway (subscriptions, article data)
            → Lambda → DynamoDB / SES / S3
```

### Monitoring Data Path

```
K8s Pods → Prometheus (native scrape_configs, 30s interval, 12 jobs)
  → Grafana (13 dashboards)
  → Grafana Unified Alerting (11 rules) → SNS topic → Email notifications

Pod logs → Promtail DaemonSet → Loki (ClusterIP)
  → Grafana (log queries, derived fields → Tempo trace links)

Browser → Faro SDK → Alloy (port 12347 via /faro IngressRoute)
  → Loki (client logs) + Tempo (client traces)

Application traces → Tempo (OTLP gRPC/HTTP, ClusterIP)
  → Metrics generator → Prometheus (span-metrics remote write)
  → Grafana (trace explorer, service graph)

CloudWatch ← Lambda invocations, API Gateway metrics, EC2 metrics
  → CloudWatch Dashboards (Bedrock observability, pre-deployment)
  → Grafana (CloudWatch datasource eu-west-1 + us-east-1)
```

## Security Group Architecture

```
Cluster Base SG
  ├── Intra-cluster communication (self-reference rule)
  ├── Pod CIDR range allowed
  └── Kubelet and API server ports

Control Plane SG
  ├── Port 6443 (API server) from VPC CIDR only
  └── Port 2379-2380 (etcd) from control plane only

Ingress SG (Traefik)
  ├── Port 80 from 0.0.0.0/0
  ├── Port 443 from 0.0.0.0/0
  └── Port 8443 (Traefik dashboard) from admin IPs only

Monitoring SG
  ├── Port 9090 (Prometheus) from VPC CIDR
  ├── Port 9100 (Node Exporter) from VPC CIDR + Pod CIDR
  └── Port 12347 (Alloy Faro) from VPC CIDR
```

**Admin IPs** are stored in SSM configuration and referenced dynamically by CDK — not hardcoded in security group rules.

## Bootstrap Provenance

Every node's bootstrap is traceable via SSM Automation:

| Node Role | Bootstrap Method | Provenance |
|:---|:---|:---|
| Control Plane | SSM Automation document | Execution ID stored in SSM |
| App Worker | SSM Automation document | Execution ID stored in SSM |
| ArgoCD Worker | SSM Automation document | Execution ID stored in SSM |
| Monitoring Worker | SSM Automation document | Execution ID stored in SSM |

**SSM Documents:** Separate documents for control plane and worker node bootstrap. Step Functions orchestrates the execution sequence (control plane first, then workers in dependency order).

## Decision Reasoning

- **4-node cluster** — Separated concerns by node role (control plane, app, GitOps, monitoring) to prevent resource contention. Prometheus scraping does not steal CPU from application pods.
- **Public subnets only** — No NAT Gateway cost (~€30/month). Instances use public IPs but are protected by strict security group rules and SSM-only access (no SSH).
- **EIP on NLB** — Static IP for DNS A records. Avoids the need for Route 53 ALIAS targets and simplifies the Traefik → cert-manager flow.
- **Cross-account DNS** — TLS certificate validation uses a cross-account IAM role to update Route 53 in a separate account. Demonstrates multi-account architecture patterns.

## Transferable Skills Demonstrated

- **Multi-tier topology design** — Separating control plane, application, GitOps, and monitoring workloads across dedicated nodes. Applicable to production cluster design.
- **End-to-end request flow understanding** — Tracing a request from Internet → CloudFront → NLB → Traefik → Pod → API Gateway → Lambda → DynamoDB. Critical for SRE and platform roles.
- **Infrastructure as evidence** — Every component has a traceable bootstrap execution ID, Golden AMI SHA, and container image SHA. Demonstrates immutable infrastructure and audit readiness.
- **Multi-account architecture** — Cross-account IAM roles for DNS validation demonstrates workload isolation and least-privilege boundaries across AWS accounts.
