---
title: "BlueGreen Rollout Stuck (Argo Rollouts)"
doc_type: runbook
domain: kubernetes
tags:
  - argo-rollouts
  - bluegreen
  - troubleshooting
  - nextjs
  - argocd
  - image-updater
related_docs:
  - kubernetes/adrs/argo-rollouts-zero-downtime.md
  - frontend/frontend-integration.md
  - operations/ci-cd-implementation.md
last_updated: "2026-04-11"
author: Nelson Lamounier
status: accepted
---

# BlueGreen Rollout Stuck (Argo Rollouts)

**Severity:** Medium
**Component:** Frontend / ArgoCD
**Last Updated:** 2026-04-11

## Symptoms
- A new Next.js deployment was pushed to `develop`, the GitHub Action completed, but the new version is not available on the live website.
- Checking ArgoCD shows the application as `OutOfSync` or `Healthy` but suspended.
- Next.js pods stuck in pending or `CrashLoopBackOff` in the new ReplicaSet while the old ones still receive traffic.

## Diagnostics

1. **Verify ArgoCD Image Updater Commit:**
   Check the `develop` Git repository to see if the `argocd-image-updater` successfully wrote back the `.argocd-source-nextjs.yaml` file after the ECR push.
   
2. **Check Rollout State via SSM:**
   Initiate an SSM session to the control plane (or use the local `k8s-tunnel-auto`), and use the Argo Rollouts CLI (installed via bootstrap user data):
   ```bash
   kubectl argo rollouts status nextjs -n nextjs-app
   kubectl argo rollouts get rollout nextjs -n nextjs-app
   ```
   Look for events preventing the preview replicaset from coming online.

3. **Check Preview Service Health:**
   If the preview pods are running, verify they are healthy before they become active:
   ```bash
   kubectl logs -l app.kubernetes.io/name=nextjs -n nextjs-app --tail=50
   ```

## Resolution

### Scenario 1: Rollout Paused (Wait / Manual Promotion)
If the rollout is configured to pause indefinitely or is awaiting manual promotion:
```bash
kubectl argo rollouts promote nextjs -n nextjs-app
```

### Scenario 2: CrashLoopBackOff on New Pods (Abort)
If the new code is failing to start (e.g. bad environment variable, syntax error), abort the rollout and scale down the broken replica set:
```bash
kubectl argo rollouts abort nextjs -n nextjs-app
```
Then, fix the code and push a new commit via CI.

### Scenario 3: Image Updater Failed to Commit
If the `.argocd-source-nextjs.yaml` was not updated, review the ArgoCD Image Updater logs on the cluster for ECR authentication limits or regex misses:
```bash
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-image-updater
```

### Scenario 4: Pods Pending due to Topology Spread Constraints
If the rollout is stuck with new pods in `Pending` state with `FailedScheduling` events citing `node(s) didn't match pod topology spread constraints`:
This typically occurs on 2-node clusters when `maxSkew` is severely violated and the scheduler is blocking due to `DoNotSchedule`.
- **Fix:** Update the Helm chart to use `whenUnsatisfiable: ScheduleAnyway` rather than `DoNotSchedule`. This allows the rollout to proceed, and a descheduler will subsequently rebalance the pods as needed without breaking the CI pipeline.

## Transferable Skills Demonstrated

- **Progressive delivery** — operating Argo Rollouts BlueGreen deployments in production
- **GitOps debugging** — diagnosing ArgoCD sync failures and resource conflicts
- **Static asset versioning** — S3 retention strategy for zero-downtime frontend deploys
- **Rollback procedures** — safe manual promotion and abort workflows

## Summary

This runbook covers diagnosing and resolving stuck BlueGreen rollouts for the Next.js frontend: verifying ArgoCD Image Updater commits, checking rollout state via Argo Rollouts CLI, and resolution steps for paused rollouts (promote), failed pods (abort), and image updater failures.

## Keywords

argo-rollouts, bluegreen, troubleshooting, nextjs, argocd, image-updater, rollout-stuck, crashloopbackoff, promotion
