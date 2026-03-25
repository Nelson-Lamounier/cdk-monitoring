# ADR: Traefik over NGINX Ingress / ALB

**Date:** 2026-03-23
**Status:** Accepted

## Context

The Kubernetes cluster requires an ingress controller to route external traffic from CloudFront → NLB → EC2 → pods. Three options were evaluated: AWS Application Load Balancer (ALB) with the AWS Load Balancer Controller, NGINX Ingress Controller, and Traefik.

## Decision

I chose Traefik as the ingress controller for four reasons:

1. **Kubernetes-native CRDs (IngressRoute)** — Traefik's `IngressRoute` CRD provides per-route middleware chains (rate limiting, redirects, headers) without annotation sprawl. NGINX relies on annotations on standard `Ingress` resources, which become unwieldy with complex routing rules.

2. **DaemonSet + hostNetwork for EIP failover** — Traefik runs as a DaemonSet with `hostNetwork: true`, meaning every node (including the control plane) binds ports 80/443 directly. When the EIP failover Lambda moves the Elastic IP to a different node, Traefik is already listening — zero reconfiguration needed. NGINX typically runs as a Deployment behind a LoadBalancer Service, which adds a kube-proxy hop and requires service reconfiguration on failover.

3. **No ALB cost** — ALB charges ~$16/month (fixed) plus per-LCU pricing. Since the cluster already has an NLB for TCP passthrough, adding an ALB doubles the load balancer cost. Traefik runs as a pod — zero additional AWS cost.

4. **Built-in observability** — Traefik natively exposes Prometheus metrics (port 9100) and ships OTLP traces to Tempo (`tempo.monitoring.svc.cluster.local:4317`). NGINX requires separate exporters for equivalent observability.

## Evidence

> Files in this repository that demonstrate this decision:

- `kubernetes-app/k8s-bootstrap/system/traefik/traefik-values.yaml` — DaemonSet config, hostNetwork, cert-manager TLS, OTLP tracing
- `kubernetes-app/platform/argocd-apps/traefik.yaml` — ArgoCD App for Traefik deployment
- `kubernetes-app/platform/argocd-apps/cert-manager.yaml` — cert-manager for TLS certificate issuance
- `kubernetes-app/platform/argocd-apps/cert-manager-config.yaml` — ClusterIssuer + Certificate CR
- `kubernetes-app/workloads/charts/nextjs/chart/templates/ingressroute.yaml` — IngressRoute CRD usage
- `kubernetes-app/workloads/charts/golden-path-service/chart/templates/ingress.yaml` — Golden-path ingress template
- `kubernetes-app/platform/charts/monitoring/chart/templates/grafana/ingressroute.yaml` — Grafana IngressRoute
- `kubernetes-app/platform/charts/monitoring/chart/templates/prometheus/ingressroute.yaml` — Prometheus IngressRoute

## Consequences

### Benefits

- **Zero additional AWS cost** — Traefik runs as a pod, no ALB/NLB fees for ingress
- **Seamless EIP failover** — DaemonSet + hostNetwork means every node is ready to serve traffic instantly
- **Native observability** — Prometheus metrics + OTLP tracing without additional exporters
- **cert-manager integration** — TLS certificates auto-renewed via DNS-01 ACME challenge, stored as K8s Secrets available on all nodes via etcd

### Trade-offs

- **Security context complexity** — `hostNetwork: true` requires `NET_BIND_SERVICE` capability and `runAsUser: 0`, which is less restrictive than a standard pod
- **No AWS-managed TLS** — TLS termination is handled by Traefik + cert-manager, not by ALB. This adds operational overhead for certificate monitoring
- **Smaller community** — NGINX ingress has a larger community and more Stack Overflow answers. Traefik's CRD-based approach requires reading official docs
- **Rolling update constraint** — With hostNetwork, `maxSurge: 0` is required because two pods cannot bind the same host port simultaneously

## Transferable Skills Demonstrated

- **Ingress architecture design** — evaluating and selecting ingress controllers based on cost, failover, and observability requirements. Applicable to any team designing traffic routing for K8s clusters.
- **Cost-aware infrastructure decisions** — choosing pod-based ingress over managed load balancers to eliminate ~$16/month fixed cost. Demonstrates FinOps thinking at the component level.
- **Observability integration** — configuring Prometheus metrics + OTLP tracing natively within the ingress layer. The same pattern applies to any observability-first platform team.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*