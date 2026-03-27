# BlueGreen Rollout Stuck (Argo Rollouts)

**Severity:** Medium
**Component:** Frontend / ArgoCD
**Last Updated:** 2026-03-27

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
