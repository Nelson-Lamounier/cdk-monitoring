---
title: "ArgoCD over Flux"
doc_type: adr
domain: kubernetes
tags:
  - argocd
  - flux
  - gitops
  - image-updater
  - sync-waves
  - app-of-apps
related_docs:
  - operations/ci-cd-implementation.md
  - kubernetes/adrs/argo-rollouts-zero-downtime.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
---

# ADR: ArgoCD over Flux

**Date:** 2026-03-22
**Status:** Accepted

## Context

The Kubernetes cluster requires a GitOps controller to manage workload deployments, platform components, and configuration drift detection. The two main options were ArgoCD and Flux CD.

## Decision

I chose ArgoCD over Flux for three reasons:

1. **Web UI** — ArgoCD provides a built-in web dashboard accessible at `ops.nelsonlamounier.com/argocd` via Traefik ingress. This gives immediate visual feedback on sync status, health checks, and resource diffs without needing `kubectl`. For a solo operator, this reduces mean-time-to-detect sync failures.

2. **App-of-Apps pattern** — ArgoCD's Application CRD supports a hierarchical App-of-Apps deployment model. The root application at `kubernetes-app/platform/argocd-apps/` contains child Application manifests for each component (Traefik, cert-manager, monitoring, Argo Rollouts). Sync waves (`argocd.argoproj.io/sync-wave`) control deployment ordering.

3. **Image Updater** — ArgoCD Image Updater watches ECR for new container image tags and automatically creates commits to update the deployment image references, completing the CD loop without manual intervention.

## Evidence

Key implementation files:

- `kubernetes-app/platform/argocd-apps/` — App-of-Apps root: traefik.yaml, cert-manager.yaml, monitoring.yaml, argo-rollouts.yaml, argocd-image-updater.yaml
- `kubernetes-app/k8s-bootstrap/system/argocd/` — ArgoCD Helm values, ingress configuration
- `kubernetes-app/workloads/argocd-apps/` — Workload apps: golden-path-service.yaml, nextjs.yaml
- `kubernetes-app/platform/argocd-apps/argocd-notifications.yaml` — Slack/webhook notification config
- `infra/scripts/cd/verify-argocd-sync.ts` — CI script that verifies ArgoCD sync status after deployments

Sync wave ordering:
```
Wave 0: cert-manager (TLS prerequisites)
Wave 1: cert-manager-config (ClusterIssuer, certificates)
Wave 2: traefik (ingress controller)
Wave 3: monitoring (Prometheus Operator, Grafana, Loki, Tempo)
Wave 4: argocd-notifications, argocd-image-updater
Wave 5: workloads (nextjs, golden-path-service)
```

## Consequences

### Benefits

- **Visual sync status** — ArgoCD UI shows real-time diff between desired (Git) and live (cluster) state
- **Automated image updates** — ECR → Image Updater → Git commit → ArgoCD sync (full CD loop)
- **Sync wave ordering** — ensures TLS certs exist before Traefik needs them, monitoring exists before workloads
- **CI integration** — `verify-argocd-sync.ts` programmatically checks sync status in GitHub Actions pipelines

### Trade-offs

- **Resource overhead** — ArgoCD server, repo-server, and redis pods consume ~300MB RAM on the dedicated ArgoCD worker node (t3.small Spot)
- **CRD complexity** — ArgoCD's Application CRD adds another abstraction layer that must be understood and maintained
- **No native Helm controller** — ArgoCD renders Helm charts at sync time rather than using native Helm releases, which can complicate `helm list` debugging

## Transferable Skills Demonstrated

- **GitOps orchestration** — designing sync-wave dependency ordering (cert-manager → Traefik → monitoring → workloads) demonstrates systems thinking about deployment sequencing. This pattern is used by platform teams managing complex multi-service deployments.
- **Automated CD loop** — ECR → Image Updater → Git commit → ArgoCD sync creates a fully automated deployment pipeline from container build to production. Applicable to any team implementing continuous delivery without manual promotion gates.
- **Operational visibility** — integrating ArgoCD UI, sync verification scripts, and notification channels (argocd-notifications) provides multi-layer deployment observability. This reduces MTTR for deployment failures across the entire stack.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*
## Summary

This ADR explains why ArgoCD was chosen over Flux CD as the GitOps controller for the Kubernetes cluster, citing the built-in web UI, App-of-Apps pattern with sync-wave ordering, and the ArgoCD Image Updater for automated ECR-to-Git image promotion.

## Keywords

argocd, flux, gitops, image-updater, sync-waves, app-of-apps, kubernetes, cd-pipeline, ecr
