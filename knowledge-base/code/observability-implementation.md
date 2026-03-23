# Observability Implementation — Prometheus, Grafana, CloudWatch, Loki, Tempo

**Project:** cdk-monitoring
**Last Updated:** 2026-03-22

## Architecture

Observability runs on a dedicated monitoring worker node (t3.medium Spot) with Kubernetes node label `workload=monitoring`. Workloads are placed via node affinity in Helm values.

The monitoring stack includes:
- **Prometheus Operator** — metrics collection and alerting
- **Grafana** — dashboards and visualisation
- **Loki** — log aggregation (replacing EFK stack)
- **Tempo** — distributed tracing (OTLP gRPC)
- **Node Exporter** — host-level metrics
- **CloudWatch** — pre-deployment infrastructure dashboards

## Prometheus

Deployed via the kube-prometheus-stack Helm chart through ArgoCD (`kubernetes-app/platform/argocd-apps/monitoring.yaml`).

Prometheus scrapes targets via ServiceMonitor CRDs:
- kubelet (port 10250)
- kube-state-metrics
- Node Exporter (port 9101)
- Traefik metrics (port 9100)
- CoreDNS
- Application pods with `prometheus.io/scrape: "true"` annotations

Monitoring SG rules enable cross-node scraping:
- TCP 9090 from VPC CIDR — Prometheus web UI / API
- TCP 9100 from VPC CIDR + Pod CIDR — Node Exporter metrics
- TCP 30100 from VPC CIDR — Loki push API (NodePort)
- TCP 30417 from VPC CIDR — Tempo OTLP gRPC (NodePort)

## Grafana

Grafana is deployed as part of the kube-prometheus-stack with pre-configured dashboards:

- **CloudWatch Edge dashboard** (`kubernetes-app/platform/charts/monitoring/chart/dashboards/cloudwatch-edge.json`) — CloudFront request counts, error rates, cache hit ratios
- **Kubernetes cluster dashboards** — node resource usage, pod status, namespace quotas
- **Application dashboards** — request latency, error rates per service

Grafana is accessible at `ops.nelsonlamounier.com/grafana` via Traefik ingress.

## CloudWatch

### Pre-Deployment Dashboard

The `KubernetesObservabilityStack` creates a CloudWatch dashboard (`infra/lib/constructs/observability/cloudwatch-dashboard.ts`) that monitors infrastructure health before workloads are deployed:

- EC2 instance CPU, memory, disk utilisation
- ASG desired vs running instances
- NLB healthy host count and connection metrics
- EBS volume read/write IOPS and throughput
- Lambda invocation counts and error rates (EIP failover, bootstrap router)

### CloudWatch Logs

All Lambda functions and EC2 instances ship logs to CloudWatch Log Groups:
- KMS-encrypted with the cluster KMS key
- Retention: 1 week (development), 3 months (production)
- Log groups created explicitly in CDK (not auto-created by Lambda runtime)

### Bedrock Observability

The `BedrockObservabilityConstruct` (`infra/lib/constructs/observability/bedrock-observability.ts`) creates:
- CloudWatch dashboard for Bedrock model invocations
- CloudTrail data events for model invocation logging
- Metrics: invocation count, latency, token usage, throttling

## Loki — Log Aggregation

Loki is deployed via ArgoCD Helm chart. Application pods ship logs to Loki via the Loki push API on NodePort 30100.

## Tempo — Distributed Tracing

Tempo receives OTLP gRPC traces on NodePort 30417. Applications instrument with OpenTelemetry SDKs and ship traces to Tempo for visualisation in Grafana.

## Troubleshooting Guides

Operational troubleshooting documentation:
- `docs/kubernetes/monitoring-troubleshooting-guide.md` — Prometheus target down, Grafana dashboards not loading
- `docs/kubernetes/prometheus-targets-troubleshooting.md` — ServiceMonitor not scraping, target endpoints missing
- `docs/cloudwatch-steampipe-data-paths.md` — CloudWatch metrics data path analysis

## Decision Reasoning

1. **K8s-native observability over SaaS** — Prometheus + Grafana + Loki + Tempo run inside the cluster, not as SaaS subscriptions (Datadog, New Relic). This eliminates per-host licensing costs (~$15/host/month) and keeps all telemetry data within the AWS account. The trade-off is operational overhead for maintaining the monitoring stack.

2. **Dedicated monitoring node** — Observability workloads (Prometheus, Grafana, Loki, Tempo) run on a dedicated `t3.medium` node with `workload=monitoring` taint. This prevents monitoring pods from competing with application pods for resources. Prometheus in particular has unpredictable memory usage (grows with number of time series).

3. **CloudWatch for pre-deployment validation** — CloudWatch dashboards monitor EC2/NLB/Lambda health before Kubernetes workloads are deployed. This provides visibility during the bootstrap window when Prometheus doesn't exist yet.

4. **NodePort for cross-stack log/trace shipping** — Loki (30100) and Tempo (30417) use NodePorts instead of ClusterIP. This allows the CloudWatch agent and non-K8s components to push data directly to the monitoring node without needing Kubernetes DNS resolution.

## Challenges Encountered

- **Prometheus target discovery** — ServiceMonitor CRDs weren't finding targets because the Prometheus Operator was deployed before the monitored services. Solved by adding ArgoCD sync-wave ordering (monitoring at wave 3, after workloads at wave 5).
- **Grafana dashboard ConfigMap size** — Complex dashboards (CloudWatch edge, K8s cluster) exceeded the 1MB ConfigMap limit. Solved by splitting into separate ConfigMaps per dashboard and using Grafana's dashboard provider for dynamic loading.
- **Loki log volume** — Loki ingested all pod logs by default, consuming excessive storage. Configured log retention policies and namespace-based filtering to only ingest logs from non-system namespaces.

## Transferable Skills Demonstrated

- **Full-stack observability design** — implementing metrics (Prometheus), logs (Loki), traces (Tempo), and dashboards (Grafana) in a single, self-hosted stack. This is the same LGTM (Loki, Grafana, Tempo, Mimir) stack pattern adopted by organisations standardising on open-source observability.
- **Cost-conscious monitoring** — avoiding SaaS vendor lock-in by self-hosting observability at a fraction of the cost. Applicable to any team evaluating build-vs-buy decisions for monitoring infrastructure.
- **Multi-layer visibility** — combining CloudWatch (AWS infrastructure) with Prometheus (Kubernetes) for visibility across both the cloud provider and the container orchestrator. This dual-layer approach is standard in production environments.

## Source Files

- `infra/lib/constructs/observability/cloudwatch-dashboard.ts` — CloudWatch dashboard construct
- `infra/lib/constructs/observability/bedrock-observability.ts` — Bedrock model monitoring
- `kubernetes-app/platform/argocd-apps/monitoring.yaml` — ArgoCD App for monitoring stack
- `kubernetes-app/platform/charts/monitoring/chart/dashboards/cloudwatch-edge.json` — CloudFront dashboard
- `infra/lib/config/kubernetes/configurations.ts` — Monitoring SG rules (ports 9090, 9100, 30100, 30417)
- `docs/kubernetes/monitoring-troubleshooting-guide.md` — Operational troubleshooting