---
title: "CI/CD & GitOps Pipeline Implementation"
doc_type: code-analysis
domain: operations
tags:
  - github-actions
  - argocd
  - ci-cd
  - gitops
  - ssm-automation
  - reusable-workflows
  - day-1
related_docs:
  - kubernetes/adrs/argocd-over-flux.md
  - kubernetes/adrs/argo-rollouts-zero-downtime.md
  - kubernetes/bootstrap-pipeline.md
last_updated: "2026-04-10"
author: Nelson Lamounier
status: accepted
---

# CI/CD & GitOps Pipeline Implementation

**Project:** cdk-monitoring
**Last Updated:** 2026-03-30

## Architecture

The CI/CD pipeline spans two domains: GitHub Actions for CDK infrastructure deployment and ArgoCD for Kubernetes workload delivery. The two domains share a single Git repository but operate independently.

```
GitHub Actions (infrastructure)                ArgoCD (workloads)
  ci.yml → lint + test + synth                  workload-generator.yaml (ApplicationSet)
  deploy-kubernetes.yml → CDK deploy 12 stacks  → auto-discovers workloads in argocd-apps/
  deploy-bedrock.yml → CDK deploy 5 stacks      → sync-wave orchestrated deployment
  deploy-shared.yml → CDK deploy shared stacks   → Image Updater watches ECR for new tags
  gitops-k8s.yml → verify ArgoCD sync status     → commits updated image refs to Git
```

## Decision Reasoning

1. **Reusable workflow composition** — All GitHub Actions workflows use reusable sub-workflows (`_deploy-stack.yml`, `_build-push-image.yml`, `_verify-stack.yml`) prefixed with `_`. This means the deployment logic for each CDK stack is defined once and reused across 5 parent workflows. Adding a new stack to CI is a 3-line YAML change.

2. **Day-1 orchestration** — `day-1-orchestration.yml` provides full-stack deployment from zero: shared stacks → K8s base → Golden AMI → SSM Automation → Compute (CP + workers) → post-bootstrap config. This is the "big red button" for disaster recovery.

3. **6-phase SSM Automation pipeline** — `_deploy-ssm-automation.yml` implements a phased deployment: Admin IPs → S3 Sync → S3 Verify (integration test) → Trigger SSM → Verify SSM (integration test) → Post-Bootstrap. Each step is labelled with its phase number for clear observability. The S3 verification phase runs `s3-bootstrap-artefacts.integration.test.ts` to validate artefact presence before triggering SSM Automation.

4. **Consolidated secrets deployment** — `_post-bootstrap-config.yml` deploys both Next.js and monitoring secrets via a single `deploy-secrets` job, aligned with the consolidated `k8s-deploy-secrets` SSM Automation document. Eliminates redundant checkout/build/credential steps.

5. **Python test integration** — `ci.yml` includes a `test-k8s-bootstrap` job running the full 135-test Python suite (boot, deploy, system) via `just bootstrap-pytest`. Fully offline with all AWS/K8s calls mocked.

4. **ArgoCD ApplicationSet** — `workload-generator.yaml` uses a Git generator to auto-discover new workloads. Dropping a new ArgoCD Application YAML into `kubernetes-app/workloads/argocd-apps/` is all that's needed to deploy a new service — no CI changes required.

## Key Components

### GitHub Actions Workflows (21 files)

| Workflow | Purpose |
|---|---|
| `ci.yml` | Lint, test (TS + Python), synth on every PR |
| `deploy-kubernetes.yml` | Deploy all 12 K8s stacks |
| `deploy-bedrock.yml` | Deploy 5 Bedrock AI stacks + sync KB docs |
| `deploy-shared.yml` | Deploy shared infrastructure (VPC, security, FinOps) |
| `deploy-ssm-automation.yml` | 6-phase: Admin IPs → S3 Sync → Verify → Trigger → SSM Verify → Secrets |
| `deploy-frontend.yml` | Build + push Next.js image to ECR |
| `deploy-post-bootstrap.yml` | Post-bootstrap K8s configuration (single deploy-secrets job) |
| `day-1-orchestration.yml` | Full-stack deployment from zero |
| `gitops-k8s.yml` | Verify ArgoCD sync after deployments |
| `build-ci-image.yml` | Build custom Docker CI image |
| `publish-article.yml` | Upload draft → trigger Bedrock publisher |

### ArgoCD Configuration

| Component | File | Function |
|---|---|---|
| App-of-Apps root | `kubernetes-app/platform/argocd-apps/` | Parent apps for all platform components |
| Workload generator | `workload-generator.yaml` | ApplicationSet — auto-discovers workloads |
| Image Updater | `argocd-image-updater.yaml` | Watches ECR, commits image updates |
| Notifications | `argocd-notifications.yaml` | Deployment status notifications |
| Sync verification | `infra/scripts/cd/verify-argocd-sync.ts` | CI integration test for ArgoCD |
| **Argo Rollouts** | `kubernetes-app/workloads/charts/nextjs/chart/templates/rollout.yaml` | Orchestrates progressive BlueGreen frontend delivery |

## Integration Tests in Pipeline

| Test | Pipeline Phase | Validates |
|------|---------------|-----------|
| `s3-bootstrap-artefacts.integration.test.ts` | Phase 3 (S3 Verify) | Bucket existence, file counts per S3 prefix |
| `ssm-automation-runtime.integration.test.ts` | Phase 5 (SSM Verify) | Instance targeting, EC2 health, SSM Agent online |
| `bluegreen.integration.test.ts` | Local/CI (Post-deploy) | Validate traffic segregation (Active vs Preview) in BlueGreen transition |
| `edge-stack.integration.test.ts` | Local/CI (Post-deploy) | Verify ECR digest matching, S3 `BUILD_ID` retention sync, and CloudFront auth cookie forwarding (behaviour ordering, CookieBehavior, wildcard cookies) |
| `edge-stack.integration.test.ts` | `verify-edge-stack` CI job (Post-Edge deploy) | Validates live CloudFront distribution configuration: auth behaviours use `CookieBehavior: all`, API catch-all uses `none`, no wildcard cookies in OriginRequestPolicy, and auth paths listed before `/api/*` |

Both layout tests (`s3` and `ssm`) use the vacuous-pass pattern — assertions pass when resources don't exist yet (Day-0 deployments).

## Challenges Encountered

- **Sync-wave dependency ordering** — initial ArgoCD deployments failed because cert-manager wasn't ready when Traefik needed TLS certificates. Solved by assigning sync-wave annotations (0-5) to enforce correct deployment ordering.
- **Custom CI Docker image** — the default GitHub Actions runners didn't have `kubectl`, `helm`, or the AWS CLI v2 pre-installed. Built a custom CI image (`build-ci-image.yml`) to reduce pipeline execution time by 30%.
- **ArgoCD Redis CrashLoop** — ArgoCD's `secret-init` container failed when the redis-initial-password Secret was missing. Fixed by ensuring the ArgoCD namespace and secrets are provisioned before the ArgoCD Helm install.
- **SSM document proliferation** — separate SSM Automation documents for Next.js and monitoring secrets caused 4-state Step Functions orchestration. Consolidated into a single `k8s-deploy-secrets` document with 2-step sequence, reducing to 2-state (1 lookup + 1 chain).
- **Broken CSS during Deployments (Zero-Downtime constraints)** — Users encountered `404 Not Found` for static Next.js assets during rollout. CI was executing an imperative `kubectl rollout restart` while executing a destructive `aws s3 sync --delete`. Fixed by implementing an Argo Rollout constraint and a smart S3 sync script (`sync-static-to-s3.ts`) which retains historical chunk mapping for the preceding BUILD_ID.

## Transferable Skills Demonstrated

- **CI/CD pipeline design** — building composable, reusable GitHub Actions workflows with shared sub-workflows and matrix strategies. Applicable to any team standardising deployment pipelines across multiple services.
- **GitOps implementation** — designing an ArgoCD-based application delivery pipeline with sync-wave ordering, automated image updates, and programmatic sync verification. This is the production GitOps pattern adopted by Cloud Native organisations.
- **Day-1 disaster recovery** — implementing a single-command full-stack deployment for bare-metal recovery. Demonstrates operational readiness thinking that SRE teams value.

## Source Files

- `.github/workflows/` — 21 GitHub Actions workflow files
- `.github/workflows/_deploy-ssm-automation.yml` — 6-phase SSM deployment workflow
- `.github/workflows/_post-bootstrap-config.yml` — Consolidated secrets deployment
- `kubernetes-app/platform/argocd-apps/` — ArgoCD Application manifests
- `kubernetes-app/workloads/argocd-apps/` — Workload Application manifests
- `infra/scripts/cd/verify-argocd-sync.ts` — ArgoCD sync verification script
- `infra/tests/integration/kubernetes/s3-bootstrap-artefacts.integration.test.ts` — S3 artefact verification
- `infra/tests/integration/kubernetes/ssm-automation-runtime.integration.test.ts` — SSM runtime verification
- `kubernetes-app/k8s-bootstrap/system/argocd/` — ArgoCD Helm values and ingress
## Summary

This document analyses the CI/CD pipeline spanning GitHub Actions for CDK infrastructure deployment (21 workflow files, reusable sub-workflows) and ArgoCD for Kubernetes workload delivery via ApplicationSet auto-discovery, Image Updater, and sync-wave orchestration. Includes the day-1 full-stack deployment orchestration for disaster recovery.

## Keywords

github-actions, argocd, ci-cd, gitops, ssm-automation, reusable-workflows, day-1, ecr, applicationset, argo-rollouts, integration-tests
