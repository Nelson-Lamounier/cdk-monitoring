---
title: "Pod CrashLoopBackOff Troubleshooting"
doc_type: runbook
domain: kubernetes
tags:
  - pod
  - crashloopbackoff
  - troubleshooting
  - kubernetes
  - k8sgpt
  - argocd
related_docs:
  - ai-ml/self-healing-agent.md
  - observability/observability-implementation.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
---

# Runbook: Pod CrashLoopBackOff

**Last Updated:** 2026-03-22
**Operator:** Solo — infrastructure owner

## Trigger

A pod enters `CrashLoopBackOff` state — the container starts, crashes, and Kubernetes restarts it with exponential backoff (10s, 20s, 40s, up to 5 minutes).

## Diagnosis Steps

### 1. Identify the Crashing Pod

```bash
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
# or for a specific namespace:
kubectl get pods -n production --field-selector=status.containerStatuses[0].state.waiting.reason=CrashLoopBackOff
```

### 2. Check Pod Events

```bash
kubectl describe pod POD_NAME -n NAMESPACE
# Look for:
# - "Back-off restarting failed container" events
# - OOMKilled in lastState.terminated.reason
# - ImagePullBackOff (wrong image tag or ECR auth failure)
```

### 3. Check Container Logs

```bash
# Current container attempt:
kubectl logs POD_NAME -n NAMESPACE
# Previous (crashed) container:
kubectl logs POD_NAME -n NAMESPACE --previous
```

### 4. Common Causes and Fixes

#### A. OOMKilled — Container Exceeds Memory Limit

The pod's `resources.limits.memory` is too low for the workload.

```bash
kubectl describe pod POD_NAME -n NAMESPACE | grep -A5 "Last State"
# Look for: reason: OOMKilled
```

**Fix:** Increase memory limit in the Helm values or deployment manifest. The golden-path-service chart (`kubernetes-app/workloads/charts/golden-path-service/chart/`) sets resource limits in `values.yaml`.

#### B. Application Error — Process Exits Non-Zero

The container process crashes due to a code error (unhandled exception, missing env var, database connection failure).

```bash
kubectl logs POD_NAME -n NAMESPACE --previous
# Check for stack traces, missing environment variables, connection refused errors
```

**Fix:** Check environment variables in the Deployment spec. For secrets, verify the SSM Automation secrets deployment ran successfully:
```bash
aws stepfunctions list-executions --state-machine-arn ARN --status-filter SUCCEEDED
```

#### C. Liveness Probe Failure

The liveness probe endpoint returns non-200 or times out, causing Kubernetes to restart the container.

```bash
kubectl describe pod POD_NAME -n NAMESPACE | grep -A10 "Liveness"
# Check: path, port, initialDelaySeconds, timeoutSeconds
```

**Fix:** Increase `initialDelaySeconds` if the app needs more startup time, or fix the health endpoint.

#### D. ECR Image Pull Failure

The ECR credential provider fails to authenticate, or the image tag doesn't exist.

```bash
kubectl describe pod POD_NAME -n NAMESPACE | grep "Failed to pull image"
```

**Fix:** Verify the ECR credential provider is configured (installed in Golden AMI v1.31.0) and the IAM instance profile has `ecr:GetAuthorizationToken` + `ecr:BatchGetImage` permissions.

### 5. K8sGPT AI Diagnosis (Self-Healing Pipeline)

If the self-healing pipeline is active, K8sGPT runs automated cluster analysis:

```bash
# On the control plane instance (via SSM):
k8sgpt analyse --explain
```

K8sGPT provides AI-powered explanations of Kubernetes issues, including CrashLoopBackOff, and suggests remediation steps. The self-healing Lambda invokes this via SSM SendCommand.

## Monitoring Integration

- **Prometheus Alert:** `KubePodCrashLooping` fires after 15 minutes of crash loops
- **Grafana Dashboard:** Pod status panel shows CrashLoopBackOff pods in red
- **Loki:** Container logs searchable via Grafana Explore → Loki datasource
- **ArgoCD:** If the pod is managed by ArgoCD, the application health status shows `Degraded`

## Source Files

- `kubernetes-app/workloads/charts/golden-path-service/chart/` — Helm chart with resource limits, probes
- `infra/lib/config/kubernetes/configurations.ts` — Golden AMI config (ECR credential provider v1.31.0, K8sGPT v0.4.29)
- `docs/kubernetes/monitoring-troubleshooting-guide.md` — Extended troubleshooting guide
- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` — Secrets deployment chaining

---

*Commands and paths above are real values from the cdk-monitoring repository.*
## Transferable Skills Demonstrated

- **Kubernetes troubleshooting methodology** — systematic Pod lifecycle debugging with kubectl
- **Container diagnostics** — analysing OOMKilled, ImagePullBackOff, and probe failures
- **AI-assisted operations** — leveraging K8sGPT for automated root cause analysis
- **Incident response** — structured triage from symptom to root cause to validation

## Summary

This runbook provides systematic troubleshooting steps for Kubernetes pods in CrashLoopBackOff state: checking pod events for common root causes (OOMKilled, image pull errors, readiness probe failures, misconfigured secrets), reviewing logs, and leveraging K8sGPT and the monitoring integration for automated diagnosis.

## Keywords

pod, crashloopbackoff, troubleshooting, kubernetes, k8sgpt, argocd, oom, image-pull, readiness-probe, secrets
