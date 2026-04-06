---
title: "Observability Stack Implementation"
doc_type: code-analysis
domain: observability
tags:
  - prometheus
  - grafana
  - loki
  - tempo
  - alloy
  - faro
  - alerting
  - monitoring
related_docs:
  - observability/rum-dashboard-review.md
  - observability/frontend-performance.md
  - observability/runbooks/faro-rum-no-data.md
last_updated: "2026-03-31"
author: Nelson Lamounier
status: accepted
---

# Observability Implementation — Prometheus, Grafana, CloudWatch, Loki, Tempo, Alloy

**Project:** cdk-monitoring
**Last Updated:** 2026-03-29

## Architecture

Observability runs on a dedicated monitoring worker node (t3.medium Spot in development, t3.small Spot in staging/production) with Kubernetes node label `workload=monitoring`. Workloads are placed via `nodeSelector` in Helm values. DaemonSets (node-exporter, Promtail) run on all nodes.

The monitoring stack includes 11 services deployed via a **custom Helm chart** (`kubernetes-app/platform/charts/monitoring/chart/`), managed by ArgoCD:

- **Prometheus** — metrics collection (native `scrape_configs`, not Prometheus Operator)
- **Grafana** — dashboards (14 dashboards), alerting (11 rules), and federated datasources (6 sources)
- **Loki** — log aggregation (TSDB store, v13 schema, 7d retention in dev)
- **Tempo** — distributed tracing with metrics generator (span-metrics → Prometheus remote write)
- **Alloy** — Grafana Faro collector for browser Real User Monitoring (RUM)
- **Promtail** — DaemonSet log shipper (pushes pod logs to Loki)
- **Node Exporter** — DaemonSet host-level metrics
- **kube-state-metrics** — Kubernetes object state metrics
- **GitHub Actions Exporter** — CI/CD pipeline metrics
- **Steampipe** — AWS cloud inventory via SQL (PostgreSQL datasource in Grafana)
- **CloudWatch** — pre-deployment infrastructure dashboards (eu-west-1 + us-east-1)

## Custom Helm Chart (Not kube-prometheus-stack)

The stack uses a custom Helm chart, not the `kube-prometheus-stack`. Templates are organised into service-isolated subdirectories:

```
chart/templates/
├── _helpers.tpl              # Cross-cutting Helm helpers
├── network-policy.yaml       # Namespace ingress guard
├── resource-quota.yaml       # Budget enforcement
├── alloy/                    # Faro collector
├── grafana/                  # 8 files (deployment, alerting, dashboards, ingress, configmaps)
├── loki/                     # Log aggregation
├── prometheus/               # Metrics engine + RBAC
├── tempo/                    # Distributed tracing
├── promtail/                 # Log shipper DaemonSet
├── node-exporter/            # Host metrics DaemonSet
├── kube-state-metrics/       # Cluster state metrics
├── github-actions-exporter/  # CI/CD pipeline metrics
├── steampipe/                # AWS cloud inventory SQL
└── traefik/                  # Ingress configuration
```

## Prometheus

Prometheus is deployed as a single-replica Deployment with native `scrape_configs` in a ConfigMap — not Prometheus Operator, not ServiceMonitor CRDs.

13 scrape jobs covering the full cluster surface:

| Job | Target | Discovery |
|---|---|---|
| `prometheus` | Self-scrape | Static |
| `kubernetes-nodes` | Kubelet | K8s SD (node role) |
| `kubernetes-cadvisor` | Container metrics | K8s SD (node role) |
| `kubernetes-service-endpoints` | Annotated services | K8s SD (endpoints) |
| `node-exporter` | Host metrics | K8s SD (endpoints) |
| `kube-state-metrics` | Cluster state | Static |
| `grafana` | Grafana internal | Static |
| `loki` | Loki internal | Static |
| `tempo` | Tempo internal | Static |
| `github-actions-exporter` | CI/CD metrics | Static |
| `traefik` | Ingress controller | K8s SD (pod role) |
| `nextjs-app` | Application metrics | Static |
| `alloy` | Faro collector | Static |
| `opencost` | FinOps cost metrics | Static |

Configuration: 15d retention, 30s scrape interval, ClusterRole RBAC for cross-namespace discovery.

## Tempo — Distributed Tracing with Metrics Generator

Tempo receives OTLP gRPC/HTTP traces. Key configuration:

- **Metrics generator** enabled: `span-metrics`, `service-graphs`, `local-blocks`
- **Remote write** to Prometheus with `send_exemplars: true` — creates Metrics → Traces bridge
- **Block retention**: 72h, max 5MB per trace, 2000 max live traces
- **Storage**: EBS CSI PVC (`ebs-sc`, 10Gi dev)

## Alloy — Faro RUM Collector

Alloy bridges browser telemetry into the backend:

1. **Faro Receiver** (port 12347) — accepts Faro SDK payloads
2. **Loki Writer** — forwards client logs (JS errors, Web Vitals)
3. **OTLP Exporter** — forwards client traces to Tempo via gRPC
4. **Prometheus Exporter** — self-monitoring metrics

Exposed at `/faro` via Traefik IngressRoute with `StripPrefix` middleware.

## Grafana — Federated Datasources

6 datasources configured:

| Datasource | Type | Purpose |
|---|---|---|
| Prometheus | Default | Cluster metrics, span-derived RED metrics |
| Loki | Logs | Pod logs + client-side Faro logs |
| Tempo | Traces | Distributed traces with service graph |
| CloudWatch (eu-west-1) | Cloud | Lambda, SSM, EC2, VPC Flow Logs |
| CloudWatch Edge (us-east-1) | Cloud | CloudFront request counts, error rates |
| Steampipe | PostgreSQL | Live AWS resource inventory via SQL |

Three-pillar cross-linking:
- **Loki → Tempo**: `derivedFields` regex links log lines to trace IDs
- **Tempo → Loki**: `tracesToLogs` configuration links traces to associated logs
- **Tempo → Prometheus**: `serviceMap` connects service graph to metric queries

14 dashboards loaded via external JSON dashboard pattern (sidecar with `grafana_dashboard: "1"` label).

## Alerting — Grafana Unified Alerting to SNS

11 alert rules across 3 groups, backed by an SNS contact point (KMS-encrypted):

- **Cluster Health**: Node Down (2m), High CPU (5m), High Memory (5m), Pod CrashLooping, Pod Not Ready (5m)
- **Application Health**: High Error Rate 5xx (5m), High Latency P95 >2s (5m)
- **Storage & Tracing**: Disk Space Low >80% (5m), Disk Space Critical >90% (2m), DynamoDB Error Rate (span-metric), Span Ingestion Stopped (10m)

SNS topic ARN is injected via ArgoCD Helm parameter override from SSM.

## Ingress — ClusterIP + Traefik IngressRoutes (Not NodePorts)

All monitoring services use standard ClusterIP services with Traefik IngressRoutes:

- Grafana at `/grafana` (native `GF_SERVER_ROOT_URL`)
- Prometheus at `/prometheus` (native `--web.external-url`)
- Alloy Faro at `/faro` (with `StripPrefix` middleware)

## NetworkPolicy and ResourceQuota

**NetworkPolicy** allows:
- Intra-namespace: all pods communicate freely
- Cross-namespace: Loki (3100), Tempo OTLP (4317, 4318), node-exporter (9100)
- External via Traefik: Grafana (3000), Prometheus (9090), Alloy (12347) — `ipBlock: 0.0.0.0/0` due to `hostNetwork`

**ResourceQuota** (development): 1.5 CPU requests / 2Gi memory requests / 3 CPU limits / 4Gi memory limits / 6 PVCs.

### Bedrock Content Pipeline Dashboard

The Bedrock Content Pipeline dashboard (`bedrock-pipeline`) visualises the multi-agent article pipeline using two metric sources:

1. **EMF Custom Metrics** (namespace: `BedrockPublisher`) — emitted by the Publish Lambda via structured JSON logs. Includes: `ArticlesPublished`, `ArticlesFailed`, `InputTokens`, `OutputTokens`, `ThinkingTokens`, `EstimatedCostUSD`, `TechnicalConfidence`, `QaScore`.
2. **AWS Native Metrics** — `AWS/Lambda` (invocations, errors, duration), `AWS/Bedrock` (invocation latency, throttles), `AWS/DynamoDB` (RCU/WCU, throttles).

> **Naming convention**: Bedrock resources use `bedrock-dev-*` prefix (abbreviated environment), NOT `bedrock-development-*`. Always verify against `aws lambda list-functions` or `pipeline-stack.ts`.

### FinOps / OpenCost Dashboard

The FinOps Cost Visibility dashboard (`finops-cost`) uses Prometheus metrics from OpenCost to provide per-namespace and per-workload cost attribution. OpenCost is deployed via ArgoCD with a static Prometheus scrape job (ServiceMonitor CRDs are not supported).

## CloudWatch

### Pre-Deployment Dashboard

The `KubernetesObservabilityStack` creates a CloudWatch dashboard monitoring infrastructure health before workloads are deployed:

- EC2 instance CPU, memory, disk utilisation
- ASG desired vs running instances
- NLB healthy host count and connection metrics
- EBS volume read/write IOPS and throughput
- Lambda invocation counts and error rates

### Bedrock Observability

The `BedrockObservabilityConstruct` creates:
- CloudWatch dashboard for Bedrock model invocations
- CloudTrail data events for model invocation logging
- Metrics: invocation count, latency, token usage, throttling

## Real Challenges Encountered

- **RWO PVC deadlock** — `RollingUpdate` strategy creates new pod before terminating old, but RWO PVC can't be mounted by both. Fix: `Recreate` strategy with explicit `rollingUpdate: null`.
- **Loki compactor validation** — Enabling `retention_enabled: true` fails with `CONFIG ERROR` if `delete_request_store` isn't defined. Fix: add `delete_request_store: filesystem`.
- **Grafana SNS schema mismatch** — Error says `topicArn` (camelCase), docs say `sns_topic_arn`, actual provisioning requires `topic_arn` (snake_case). Fix: API Discovery Pattern via `GET /api/v1/provisioning/contact-points`.

## Transferable Skills Demonstrated

- **Full-stack observability design** — implementing metrics (Prometheus), logs (Loki), traces (Tempo), RUM (Faro/Alloy), cloud inventory (Steampipe), and CI/CD metrics (GitHub Actions Exporter) in a single, self-hosted stack.
- **Span-metric alerting** — DynamoDB error rate and latency alerts derived from Tempo span metrics, not CloudWatch. Demonstrates trace-based alerting patterns.
- **Cost-conscious monitoring** — avoiding SaaS vendor lock-in by self-hosting at a fraction of the cost. Applicable to build-vs-buy decisions.
- **Multi-layer visibility** — combining CloudWatch (AWS infrastructure) with Prometheus (Kubernetes) for complementary observability windows.

## Source Files

- `kubernetes-app/platform/charts/monitoring/chart/` — Custom Helm chart (all 11 services)
- `kubernetes-app/platform/argocd-apps/monitoring.yaml` — ArgoCD Application
- `infra/lib/stacks/kubernetes/monitoring-worker-stack.ts` — CDK monitoring node stack
- `infra/lib/config/kubernetes/configurations.ts` — Monitoring worker config + SG rules
- `infra/lib/constructs/observability/cloudwatch-dashboard.ts` — CloudWatch dashboard
- `infra/lib/constructs/observability/bedrock-observability.ts` — Bedrock model monitoring
- `infra/scripts/cd/deploy-monitoring-secrets.ts` — CI/CD secrets deployment pipeline
## Summary

This document analyses the Kubernetes-native monitoring stack: Prometheus with custom Helm chart and native scrape_configs (13 jobs including OpenCost), Grafana with 14 dashboards and unified alerting to SNS, Loki for log aggregation, Tempo for distributed tracing, Alloy as the Faro RUM collector, and Promtail DaemonSet for pod log shipping.

## Keywords

prometheus, grafana, loki, tempo, alloy, faro, alerting, monitoring, scrape-configs, dashboards, rum, promtail, opencost, finops, bedrock, emf
