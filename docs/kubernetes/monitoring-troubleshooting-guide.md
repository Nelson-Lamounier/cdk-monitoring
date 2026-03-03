# Monitoring Stack Troubleshooting Guide

A beginner-friendly, step-by-step guide to verifying that your monitoring stack (Prometheus, Grafana, Loki, Tempo, Promtail, Node Exporter, Kube State Metrics) is running and healthy on your Kubernetes cluster. All commands are run from the **control-plane node** via an AWS SSM session.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Key Concepts Before You Start](#key-concepts-before-you-start)
- [Step 1 — Verify Kubernetes Cluster Health](#step-1--verify-kubernetes-cluster-health)
- [Step 2 — Check the Monitoring Namespace](#step-2--check-the-monitoring-namespace)
- [Step 3 — Inspect ArgoCD Sync Status](#step-3--inspect-argocd-sync-status)
- [Step 4 — Inspect Pod Status](#step-4--inspect-pod-status)
- [Step 5 — Check PersistentVolumeClaims](#step-5--check-persistentvolumeclaims)
- [Step 6 — Diagnose Pending Pods](#step-6--diagnose-pending-pods)
- [Step 7 — Check ResourceQuota](#step-7--check-resourcequota)
- [Step 8 — Check ReplicaSets for FailedCreate](#step-8--check-replicasets-for-failedcreate)
- [Step 9 — Check Pod Logs](#step-9--check-pod-logs)
- [Step 10 — Verify Health Probes](#step-10--verify-health-probes)
- [Step 11 — Verify Services and Endpoints](#step-11--verify-services-and-endpoints)
- [Step 12 — Verify Cross-Node Connectivity](#step-12--verify-cross-node-connectivity)
- [Step 13 — End-to-End Validation](#step-13--end-to-end-validation)
- [Quick One-Liner Health Check](#quick-one-liner-health-check)
- [Troubleshooting — Common Issues](#troubleshooting--common-issues)
  - [Issue 7: ArgoCD Shows "Unknown" Sync Status — Helm Template Rendering Error](#issue-7-argocd-shows-unknown-sync-status--helm-template-rendering-error)
  - [Issue 8: ArgoCD Application Stuck in Stale State After Fix](#issue-8-argocd-application-stuck-in-stale-state-after-fix)
  - [Issue 9: Loki PVC Stuck in Pending](#issue-9-loki-pvc-stuck-in-pending)
  - [Issue 10: Calico CNI Install Fails on Re-Bootstrap](#issue-10-calico-cni-install-fails-on-re-bootstrap-ssm-automation)
  - [Issue 11: Loki CrashLoopBackOff After Removing Root Init Container](#issue-11-loki-crashloopbackoff-after-removing-root-init-container)
  - [Issue 12: Loki Still Crashing After ConfigMap Fix — Pod Not Restarted](#issue-12-loki-still-crashing-after-configmap-fix--pod-not-restarted)
  - [Issue 13: New Loki Pod Stuck in Pending After Rollout Restart](#issue-13-new-loki-pod-stuck-in-pending-after-rollout-restart)
  - [Issue 14: RWO PVC Deadlocks on Rolling Updates — Recreate Strategy Fix](#issue-14-rwo-pvc-deadlocks-on-rolling-updates--recreate-strategy-fix)
  - [Issue 15: Prometheus CrashLoopBackOff — TSDB Lock Conflict](#issue-15-prometheus-crashloopbackoff--tsdb-lock-conflict)
  - [Issue 16: Traefik IngressRoute Returns 504 — NetworkPolicy Blocks hostNetwork Traffic](#issue-16-traefik-ingressroute-returns-504--networkpolicy-blocks-hostnetwork-traffic)
  - [Issue 17: ArgoCD Sync Fails — Recreate Strategy Rejects Leftover rollingUpdate Settings](#issue-17-argocd-sync-fails--recreate-strategy-rejects-leftover-rollingupdate-settings)
- [Glossary](#glossary)

---

## Prerequisites

Before following this guide, ensure you have:

- **AWS CLI** installed and configured with a named profile
- **SSM Plugin** for the AWS CLI installed ([installation guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))
- **Network access** to AWS (internet connection)
- Your control plane EC2 instance must have the **SSM Agent** running and an **IAM instance profile** that allows SSM
- The cluster is deployed with **3 nodes** (1 control plane + 2 workers)
- You are **already connected to the control plane** via SSM (see the [ArgoCD Readiness Verification Guide](./argocd-readiness-verification-guide.md) for SSM connection instructions)

---

## Key Concepts Before You Start

### How the Monitoring Stack is Deployed

The monitoring stack is deployed to Kubernetes using a **Helm chart** managed by **ArgoCD**. Here's how all the pieces fit together:

```text
Git Repository (develop branch)
  └── kubernetes-app/app-deploy/monitoring/
        ├── chart/
        │     ├── Chart.yaml                → Helm chart metadata
        │     ├── values.yaml               → Default config (all components)
        │     └── templates/
        │           ├── prometheus-deployment.yaml   → Prometheus pod definition
        │           ├── prometheus-configmap.yaml    → Scrape configuration
        │           ├── prometheus-pvc.yaml          → Prometheus storage
        │           ├── prometheus-rbac.yaml         → Prometheus RBAC
        │           ├── prometheus-service.yaml      → ClusterIP Service
        │           ├── grafana-deployment.yaml      → Grafana pod definition
        │           ├── grafana-configmap.yaml       → Datasource provisioning
        │           ├── grafana-pvc.yaml             → Grafana storage
        │           ├── grafana-secret.yaml          → Admin credentials
        │           ├── grafana-service.yaml         → ClusterIP Service
        │           ├── loki-deployment.yaml         → Loki pod definition
        │           ├── loki-configmap.yaml          → Loki configuration
        │           ├── loki-pvc.yaml                → Loki storage
        │           ├── loki-service.yaml            → ClusterIP Service
        │           ├── tempo-deployment.yaml        → Tempo pod definition
        │           ├── tempo-configmap.yaml         → Tempo configuration
        │           ├── tempo-pvc.yaml               → Tempo storage
        │           ├── tempo-service.yaml           → ClusterIP Service
        │           ├── promtail-daemonset.yaml      → Promtail (DaemonSet)
        │           ├── promtail-configmap.yaml      → Promtail scrape config
        │           ├── promtail-service.yaml        → ClusterIP Service
        │           ├── node-exporter-daemonset.yaml → Node Exporter (DaemonSet)
        │           ├── node-exporter-service.yaml   → ClusterIP Service
        │           ├── kube-state-metrics-*.yaml    → Kube State Metrics
        │           ├── resource-quota.yaml          → Namespace resource limits
        │           └── network-policy.yaml          → Network isolation rules
        └── monitoring-values.yaml → Dev environment overrides
```

ArgoCD watches this Git path and **automatically syncs** changes to the cluster (within ~3 minutes of a push).

### Component Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     monitoring namespace                            │
│                                                                     │
│  ┌──────────────┐  ┌──────────┐  ┌──────┐  ┌───────┐              │
│  │  Prometheus   │  │ Grafana  │  │ Loki │  │ Tempo │              │
│  │  (Deployment) │  │(Deploy)  │  │(Dep) │  │(Dep)  │              │
│  │  :9090        │  │ :3000    │  │:3100 │  │:3200  │              │
│  │  PVC: 10Gi    │  │ PVC:5Gi  │  │PVC:  │  │PVC:   │              │
│  │               │  │          │  │10Gi  │  │10Gi   │              │
│  │  Scrapes:     │  │ Reads:   │  │      │  │       │              │
│  │  ├node-export │  │├Prometheus│ │      │  │       │              │
│  │  ├kube-state  │  │├Loki     │  │      │  │       │              │
│  │  └promtail    │  │└Tempo    │  │      │  │       │              │
│  └──────────────┘  └──────────┘  └──────┘  └───────┘              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  DaemonSets (run on ALL nodes)                               │    │
│  │  ┌──────────────┐  ┌────────────┐                           │    │
│  │  │ Node Exporter │  │  Promtail  │                           │    │
│  │  │ :9100         │  │  :9080     │                           │    │
│  │  │ Host metrics  │  │  Log ship  │                           │    │
│  │  └──────────────┘  └────────────┘                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────────────┐                                             │
│  │ Kube State Metrics  │  (Deployment, 1 replica)                   │
│  │ :8080               │                                             │
│  └────────────────────┘                                             │
│                                                                     │
│  ResourceQuota: monitoring-quota                                    │
│  NetworkPolicy: monitoring-allow-internal                           │
└─────────────────────────────────────────────────────────────────────┘
```

### What Namespace Does the Monitoring Stack Run In?

All monitoring resources are deployed into the `monitoring` namespace. Every `kubectl` command in this guide uses `-n monitoring` to target this namespace.

### Where Do Monitoring Pods Run?

| Component | Type | Node Selector | Runs On |
|---|---|---|---|
| Prometheus | Deployment | `workload: monitoring` | Monitoring worker only |
| Grafana | Deployment | `workload: monitoring` | Monitoring worker only |
| Loki | Deployment | `workload: monitoring` | Monitoring worker only |
| Tempo | Deployment | `workload: monitoring` | Monitoring worker only |
| Kube State Metrics | Deployment | `workload: monitoring` | Monitoring worker only |
| Node Exporter | DaemonSet | none | **All 3 nodes** |
| Promtail | DaemonSet | none | **All 3 nodes** |

> [!IMPORTANT]
> The `workload: monitoring` label is applied to the monitoring worker node during bootstrap. If no node has this label, Deployment pods will remain in `Pending` state.

### What Are PersistentVolumeClaims?

Prometheus, Grafana, Loki, and Tempo each need persistent storage to survive pod restarts. They use **PersistentVolumeClaims (PVCs)** backed by the `local-path` StorageClass (provided by the local-path-provisioner).

| PVC | Size | Used By |
|---|---|---|
| `prometheus-data` | 10Gi | Prometheus (metrics storage) |
| `grafana-data` | 5Gi | Grafana (dashboards, config) |
| `loki-data` | 10Gi | Loki (log storage) |
| `tempo-data` | 10Gi | Tempo (trace storage) |

### What is the ResourceQuota?

The `monitoring-quota` ResourceQuota limits total resource consumption in the `monitoring` namespace. **Every container** (including init containers) **must** specify `resources.requests` and `resources.limits`, or Kubernetes will reject the pod.

---

## Step 1 — Verify Kubernetes Cluster Health

Before checking the monitoring stack, confirm the cluster itself is healthy.

### 1a — Check Node Status

```bash
sudo kubectl get nodes -o wide
```

| Flag | Meaning |
|---|---|
| `sudo` | Run with administrator privileges. Required because the kubeconfig is owned by root. |
| `kubectl get nodes` | List all machines registered to the cluster. |
| `-o wide` | Show extra columns: internal IP, OS, kernel version, and container runtime. |

#### Why You Need This

If the monitoring worker node shows `NotReady`, monitoring pods cannot run.

#### What Success Looks Like

```text
NAME               STATUS   ROLES           INTERNAL-IP   OS-IMAGE
ip-10-0-0-169...   Ready    control-plane   10.0.0.169    Amazon Linux 2023
ip-10-0-0-160...   Ready    <none>          10.0.0.160    Amazon Linux 2023
ip-10-0-0-26...    Ready    <none>          10.0.0.26     Amazon Linux 2023
```

All 3 nodes should show `Ready`.

### 1b — Verify Node Labels

```bash
sudo kubectl get nodes -o custom-columns='NAME:.metadata.name,WORKLOAD:.metadata.labels.workload'
```

| Flag | Meaning |
|---|---|
| `-o custom-columns=...` | Show custom columns extracted from the JSON structure of each node. |
| `.metadata.labels.workload` | Extract the value of the `workload` label from each node. |

#### What Success Looks Like

```text
NAME                                       WORKLOAD
ip-10-0-0-160.eu-west-1.compute.internal   frontend
ip-10-0-0-169.eu-west-1.compute.internal   <none>
ip-10-0-0-26.eu-west-1.compute.internal    monitoring
```

One node must have `workload=monitoring`. If not, apply the label:

```bash
sudo kubectl label node <NODE_NAME> workload=monitoring
```

---

## Step 2 — Check the Monitoring Namespace

### 2a — Verify the Namespace Exists

```bash
sudo kubectl get namespace monitoring
```

#### What Success Looks Like

```text
NAME         STATUS   AGE
monitoring   Active   24h
```

If the namespace shows `Terminating` or doesn't exist, ArgoCD may not have synced yet.

### 2b — List All Resources in the Namespace

```bash
sudo kubectl get all -n monitoring
```

| Flag | Meaning |
|---|---|
| `get all` | Show pods, services, deployments, replicasets, and daemonsets. |
| `-n monitoring` | Target the monitoring namespace. |

This gives a quick overview of everything deployed.

---

## Step 3 — Inspect ArgoCD Sync Status

```bash
sudo kubectl get applications -n argocd -o wide
```

| Flag | Meaning |
|---|---|
| `applications` | ArgoCD custom resource representing a deployed application. |
| `-n argocd` | ArgoCD lives in the `argocd` namespace. |
| `-o wide` | Show extra columns: revision (Git commit hash). |

#### What Success Looks Like

```text
NAME         SYNC STATUS   HEALTH STATUS   REVISION
monitoring   Synced        Healthy         43321b5a80e8...
```

#### Understanding Health Status

| Status | Meaning |
|---|---|
| **Healthy** | All Kubernetes resources are running correctly. |
| **Degraded** | One or more resources are unhealthy (pod crash, PVC unbound, etc.). |
| **Progressing** | Resources are updating (rolling out new pods). |
| **Missing** | Expected resources don't exist in the cluster. |

> [!NOTE]
> ArgoCD may take a few minutes to re-check health after fixing an issue. You can force a refresh by clicking "Refresh" in the ArgoCD UI or by running:
> ```bash
> sudo kubectl -n argocd patch application monitoring \
>   --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'
> ```

---

## Step 4 — Inspect Pod Status

### 4a — List All Monitoring Pods

```bash
sudo kubectl get pods -n monitoring -o wide
```

| Flag | Meaning |
|---|---|
| `get pods` | List all pods in the namespace. |
| `-o wide` | Show the assigned node address, pod IP, and nominated node. |

#### What Success Looks Like

```text
NAME                                  READY   STATUS    NODE
grafana-7996bdc64-9knhz               1/1     Running   ip-10-0-0-26...
kube-state-metrics-6bb7899667-5rdht   1/1     Running   ip-10-0-0-26...
node-exporter-4skt9                   1/1     Running   ip-10-0-0-26...
node-exporter-gbz4w                   1/1     Running   ip-10-0-0-160...
node-exporter-vp6cf                   1/1     Running   ip-10-0-0-169...
prometheus-57b6c56878-gthzn           1/1     Running   ip-10-0-0-26...
promtail-cdt2t                        1/1     Running   ip-10-0-0-26...
promtail-nj9k4                        1/1     Running   ip-10-0-0-160...
promtail-xk8sg                        1/1     Running   ip-10-0-0-169...
tempo-fff5fb67f-k9gnp                 1/1     Running   ip-10-0-0-26...
```

#### Expected Pod Count

| Component | Expected Pods | Type |
|---|---|---|
| Prometheus | 1 | Deployment |
| Grafana | 1 | Deployment |
| Loki | 1 | Deployment |
| Tempo | 1 | Deployment |
| Kube State Metrics | 1 | Deployment |
| Node Exporter | 3 (one per node) | DaemonSet |
| Promtail | 3 (one per node) | DaemonSet |

**Total: 10 pods** when fully healthy.

### 4b — Check Pod Status Interpretation

| Status | Meaning | Action |
|---|---|---|
| `Running` + `1/1` | Pod is healthy and ready. | None — all good! |
| `Pending` | Pod cannot be scheduled. | Go to [Step 6](#step-6--diagnose-pending-pods). |
| `CrashLoopBackOff` | Pod keeps crashing and restarting. | Go to [Step 9](#step-9--check-pod-logs). |
| `ContainerCreating` | Pod is pulling images or mounting volumes. | Wait a minute then re-check. |
| `ImagePullBackOff` | Cannot download the container image. | Check image name and network/registry access. |

---

## Step 5 — Check PersistentVolumeClaims

```bash
sudo kubectl get pvc -n monitoring
```

| Flag | Meaning |
|---|---|
| `get pvc` | List all PersistentVolumeClaims — storage requests made by pods. |

#### What Success Looks Like

```text
NAME              STATUS   VOLUME                                     CAPACITY   STORAGECLASS
grafana-data      Bound    pvc-abc123...                              5Gi        local-path
loki-data         Bound    pvc-def456...                              10Gi       local-path
prometheus-data   Bound    pvc-ghi789...                              10Gi       local-path
tempo-data        Bound    pvc-jkl012...                              10Gi       local-path
```

All 4 PVCs must show `Bound`. If any show `Pending`, the pod that needs that volume cannot start.

#### Diagnose a Pending PVC

```bash
sudo kubectl describe pvc <PVC_NAME> -n monitoring
```

Look at the **Events** section at the bottom:

| Event Message | Root Cause | Fix |
|---|---|---|
| `no persistent volumes available for this claim and no storage class is set` | PVC has no `storageClassName` and no default StorageClass | Set `storageClassName: local-path` in the PVC spec, or set `local-path` as the default StorageClass |
| `waiting for first consumer to be created before binding` | Normal with `WaitForFirstConsumer` | PVC will bind when a pod using it gets scheduled |
| `storageclass.storage.k8s.io "xxx" not found` | The requested StorageClass doesn't exist | Install local-path-provisioner or correct the storageClass name |

#### Fix: Set local-path as Default StorageClass

```bash
sudo kubectl patch sc local-path -p \
  '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

#### Verify StorageClass

```bash
sudo kubectl get sc
```

**Expected:**

```text
NAME                   PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE
local-path (default)   rancher.io/local-path   Delete          WaitForFirstConsumer
```

The `(default)` annotation must be present.

---

## Step 6 — Diagnose Pending Pods

If a pod shows `Pending`, inspect why:

```bash
sudo kubectl describe pod <POD_NAME> -n monitoring
```

| Flag | Meaning |
|---|---|
| `describe pod` | Show detailed information about a specific pod, including events. |

Scroll to the **Events** section at the bottom. Common scheduling failures:

### 6a — No Matching Node (NodeSelector)

```text
0/3 nodes are available: 1 node(s) had untolerated taint, 2 node(s) didn't match Pod's node selector.
```

**Root Cause:** The pod requires `nodeSelector: workload=monitoring` but no node has this label.

**Fix:**

```bash
# Check current node labels
sudo kubectl get nodes --show-labels | grep workload

# Apply the label to the monitoring worker
sudo kubectl label node <NODE_NAME> workload=monitoring
```

### 6b — Unbound PersistentVolumeClaim

```text
0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.
```

**Root Cause:** The PVC referenced by the pod hasn't bound yet. See [Step 5](#step-5--check-persistentvolumeclaims).

### 6c — Insufficient Resources

```text
0/3 nodes are available: Insufficient cpu. Insufficient memory.
```

**Root Cause:** The node doesn't have enough free CPU or memory to satisfy the pod's `resources.requests`.

**Diagnose:**

```bash
# Check resource consumption on the monitoring worker
sudo kubectl describe node <MONITORING_WORKER_NAME> | grep -A 20 "Allocated resources"
```

**Fix:** Either reduce resource requests in `values.yaml` or scale up the EC2 instance.

---

## Step 7 — Check ResourceQuota

The `monitoring-quota` ResourceQuota limits total resource consumption in the namespace.

```bash
sudo kubectl get resourcequota -n monitoring -o yaml
```

| Flag | Meaning |
|---|---|
| `resourcequota` | Kubernetes resource that enforces resource limits at the namespace level. |
| `-o yaml` | Show the full YAML including `status.used` vs `spec.hard`. |

#### Key Fields

```yaml
spec:
  hard:                          # Maximum allowed
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    persistentvolumeclaims: "10"
status:
  used:                          # Currently consumed
    requests.cpu: 550m
    requests.memory: 800Mi
    limits.cpu: 1206m
    limits.memory: 1600Mi
    persistentvolumeclaims: "4"
```

> [!IMPORTANT]
> When a ResourceQuota is active, **every container** (including init containers) **must specify** `resources.requests` and `resources.limits`. If any container omits this, Kubernetes will reject the pod with a `FailedCreate` error.

#### Check for Quota Violations

If a pod can't be created, the ReplicaSet events will show:

```text
Error creating: pods "xxx" is forbidden: failed quota: monitoring-quota:
  must specify limits.cpu for: <container>;
  limits.memory for: <container>
```

**Fix:** Add `resources` to the offending container in the Helm template. See [Step 8](#step-8--check-replicasets-for-failedcreate) for details.

---

## Step 8 — Check ReplicaSets for FailedCreate

When a Deployment's ReplicaSet can't create pods, the error appears in the ReplicaSet events — not the Deployment events.

### 8a — List ReplicaSets

```bash
sudo kubectl get replicasets -n monitoring
```

| Flag | Meaning |
|---|---|
| `replicasets` | Intermediate controller between Deployment and Pod. Manages pod replicas. |

Look for ReplicaSets with `DESIRED > 0` but `CURRENT = 0`:

```text
NAME               DESIRED   CURRENT   READY   AGE
loki-6dd77dd79d    1         0         0       7h     ← Problem!
```

### 8b — Describe the Failing ReplicaSet

```bash
sudo kubectl describe rs <REPLICASET_NAME> -n monitoring
```

| Flag | Meaning |
|---|---|
| `describe rs` | Show detailed information about a ReplicaSet, including pod creation events. |

#### Example: Missing Resources on Init Container

```text
Events:
  Warning  FailedCreate  replicaset-controller  Error creating: pods "loki-xxx" is forbidden:
    failed quota: monitoring-quota:
    must specify limits.cpu for: fix-permissions;
    limits.memory for: fix-permissions;
    requests.cpu for: fix-permissions;
    requests.memory for: fix-permissions
```

**Root Cause:** The `fix-permissions` init container lacked `resources`, violating the ResourceQuota.

**Fix:** Add resources to the init container in the Helm template:

```yaml
initContainers:
  - name: fix-permissions
    image: busybox:1.36
    command: ["sh", "-c", "chown -R 10001:10001 /loki"]
    securityContext:
      runAsUser: 0
    resources:            # ← This was missing
      requests:
        cpu: 10m
        memory: 32Mi
      limits:
        cpu: 50m
        memory: 64Mi
```

After fixing the template, commit and push to Git. ArgoCD will sync the change and recreate the pod.

### 8c — Force a Rollout After Fix

If ArgoCD has already synced but the old ReplicaSet still exists:

```bash
sudo kubectl rollout restart deployment loki -n monitoring
sudo kubectl rollout status deployment loki -n monitoring --timeout=120s
```

---

## Step 9 — Check Pod Logs

### 9a — Tail Recent Logs

```bash
sudo kubectl logs <POD_NAME> -n monitoring --tail=50
```

| Flag | Meaning |
|---|---|
| `logs <POD_NAME>` | Fetch container output (stdout/stderr) for the specified pod. |
| `--tail=50` | Show only the last 50 lines, keeping the output manageable. |

### 9b — Logs from a Specific Container

Some pods have init containers. To see logs from a specific container:

```bash
# List containers in a pod
sudo kubectl get pod <POD_NAME> -n monitoring -o jsonpath='{.spec.containers[*].name}'

# View logs for a specific container
sudo kubectl logs <POD_NAME> -n monitoring -c <CONTAINER_NAME>
```

### 9c — Logs from a Previous (Crashed) Container

If a container restarted, view the previous container's logs:

```bash
sudo kubectl logs <POD_NAME> -n monitoring --previous --tail=50
```

### 9d — Check Specific Component Logs

```bash
# Prometheus
sudo kubectl logs -n monitoring -l app=prometheus --tail=30

# Grafana
sudo kubectl logs -n monitoring -l app=grafana --tail=30

# Loki
sudo kubectl logs -n monitoring -l app=loki --tail=30

# Tempo
sudo kubectl logs -n monitoring -l app=tempo --tail=30
```

#### Common Log Errors

| Error | Component | Likely Cause |
|---|---|---|
| `opening storage failed` | Prometheus | PVC not mounted or permissions wrong |
| `permission denied` | Loki/Tempo | Init container (`fix-permissions`) didn't run |
| `connection refused` | Grafana | Datasource target (Prometheus/Loki/Tempo) not running |
| `503 Service Unavailable` | Tempo | Startup delay — ingester ring not ready yet (transient) |

---

## Step 10 — Verify Health Probes

Each stateful component has readiness and liveness probes.

### 10a — Check Probe Configuration

```bash
sudo kubectl get deploy <DEPLOYMENT_NAME> -n monitoring \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}' | python3 -m json.tool
```

### 10b — Manually Test a Probe Endpoint

```bash
# Prometheus readiness
sudo kubectl exec -n monitoring deploy/prometheus -- wget -qO- http://localhost:9090/-/ready 2>&1

# Grafana health
sudo kubectl exec -n monitoring deploy/grafana -- wget -qO- http://localhost:3000/api/health 2>&1

# Loki readiness
sudo kubectl exec -n monitoring deploy/loki -- wget -qO- http://localhost:3100/ready 2>&1

# Tempo readiness
sudo kubectl exec -n monitoring deploy/tempo -- wget -qO- http://localhost:3200/ready 2>&1
```

#### What Success Looks Like

- **Prometheus:** Returns the text `Prometheus Server is Ready.`
- **Grafana:** Returns `{"commit":"...","database":"ok","version":"..."}`
- **Loki:** Returns `ready`
- **Tempo:** Returns `ready` (may return 503 during initial startup for ~30 seconds)

> [!NOTE]
> Tempo's readiness probe often returns **503** for the first 20–30 seconds after startup while the ingester ring forms. This is normal — Kubernetes will retry the probe until it succeeds.

---

## Step 11 — Verify Services and Endpoints

### 11a — List All Services

```bash
sudo kubectl get svc -n monitoring
```

#### What Success Looks Like

```text
NAME                 TYPE        CLUSTER-IP       PORT(S)
grafana              ClusterIP   10.96.xxx.xxx    3000/TCP
kube-state-metrics   ClusterIP   10.96.xxx.xxx    8080/TCP
loki                 ClusterIP   10.96.xxx.xxx    3100/TCP
node-exporter        ClusterIP   10.96.xxx.xxx    9100/TCP
prometheus           ClusterIP   10.96.xxx.xxx    9090/TCP
promtail             ClusterIP   10.96.xxx.xxx    9080/TCP
tempo                ClusterIP   10.96.xxx.xxx    3200/TCP,4317/TCP,4318/TCP
```

### 11b — Verify Service Has Endpoints

A Service with no endpoints means no healthy pods match its selector:

```bash
sudo kubectl get endpoints -n monitoring
```

#### What Success Looks Like

Each service should have at least one IP address (the pod IP):

```text
NAME                 ENDPOINTS
grafana              192.168.177.15:3000
kube-state-metrics   192.168.177.7:8080
loki                 192.168.177.16:3100
prometheus           192.168.177.14:9090
...
```

If an endpoint shows `<none>`, the corresponding pods are either not running or their readiness probe is failing.

---

## Step 12 — Verify Cross-Node Connectivity

DaemonSet pods (Node Exporter, Promtail) run on **all nodes**, while Prometheus runs on the **monitoring worker**. Prometheus must be able to scrape metrics from pods on other nodes.

### 12a — Test Cross-Node Scraping

```bash
# Get Prometheus pod
PROM_POD=$(sudo kubectl get pods -n monitoring -l app=prometheus \
  -o jsonpath='{.items[0].metadata.name}')

# Get a node-exporter pod IP on a DIFFERENT node
EXPORTER_IP=$(sudo kubectl get pods -n monitoring -l app=node-exporter \
  --field-selector spec.nodeName=$(sudo kubectl get node \
    -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}') \
  -o jsonpath='{.items[0].status.podIP}')

echo "Testing Prometheus → Node Exporter ($EXPORTER_IP) cross-node"
sudo kubectl exec -n monitoring $PROM_POD -- wget -qO- --timeout=3 \
  http://$EXPORTER_IP:9100/metrics 2>&1 | head -5
```

If this fails, see the [Cross-Node Networking Troubleshooting Guide](./cross-node-networking-troubleshooting.md).

### 12b — Check Prometheus Targets

```bash
sudo kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- http://localhost:9090/api/v1/targets 2>&1 | python3 -m json.tool | grep -E '"health"|"job"'
```

All targets should show `"health": "up"`. Any showing `"health": "down"` indicate a connectivity or configuration issue.

---

## Step 13 — End-to-End Validation

### 13a — Verify Grafana Datasources

```bash
# Log into Grafana API and check datasources
GRAFANA_POD=$(sudo kubectl get pods -n monitoring -l app=grafana \
  -o jsonpath='{.items[0].metadata.name}')
sudo kubectl exec -n monitoring $GRAFANA_POD -- \
  curl -s http://admin:admin@localhost:3000/api/datasources 2>&1 | python3 -m json.tool
```

You should see Prometheus, Loki, and Tempo as configured datasources.

### 13b — Query Prometheus for Active Metrics

```bash
sudo kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=up' 2>&1 | python3 -m json.tool
```

This should return a list of all scrape targets with their current `up` status (1 = healthy, 0 = down).

### 13c — Verify Loki is Receiving Logs

```bash
sudo kubectl exec -n monitoring deploy/grafana -- \
  curl -s 'http://loki:3100/loki/api/v1/query?query={namespace="monitoring"}' 2>&1 \
  | python3 -m json.tool | head -20
```

### 13d — Verify Tempo is Ready

```bash
sudo kubectl exec -n monitoring deploy/tempo -- \
  wget -qO- http://localhost:3200/status 2>&1
```

---

## Quick One-Liner Health Check

Run this comprehensive check from the control plane:

```bash
echo "=== Monitoring Stack Health ===" && \
echo "--- Pods ---" && \
sudo kubectl get pods -n monitoring -o wide && \
echo "--- PVCs ---" && \
sudo kubectl get pvc -n monitoring && \
echo "--- Services ---" && \
sudo kubectl get svc -n monitoring && \
echo "--- ResourceQuota ---" && \
sudo kubectl get resourcequota -n monitoring \
  -o custom-columns='NAME:.metadata.name,CPU-USED:.status.used.requests\.cpu,CPU-LIMIT:.status.hard.requests\.cpu,MEM-USED:.status.used.requests\.memory,MEM-LIMIT:.status.hard.requests\.memory' && \
echo "--- ArgoCD ---" && \
sudo kubectl get applications monitoring -n argocd \
  -o custom-columns='SYNC:.status.sync.status,HEALTH:.status.health.status'
```

---

## Troubleshooting — Common Issues

### Issue 1: PVCs Stuck in Pending

**Symptoms:** Pods show `Pending`, PVCs show `Pending` status.

**Root Cause:** PVCs have no `storageClassName` and no default StorageClass exists.

**Fix:**

```bash
# Option A: Set default StorageClass (cluster-wide)
sudo kubectl patch sc local-path -p \
  '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# Option B: Patch PVCs individually (if already created without a class)
# Note: storageClassName cannot be changed on an existing PVC.
# Delete and recreate the PVC with the correct storageClass.
sudo kubectl delete pvc <PVC_NAME> -n monitoring
# Then let ArgoCD recreate it (or manually apply the template).
```

### Issue 2: Init Container Missing Resources (ResourceQuota Violation)

**Symptoms:** Pods never created, ReplicaSet shows `FailedCreate`.

**Root Cause:** The `monitoring-quota` ResourceQuota requires all containers to specify `resources`, but an init container (e.g., `fix-permissions`) is missing them.

**Fix:** Add `resources` to the init container in the Helm template, commit, and push.

### Issue 3: Tempo Returns 503 on Startup

**Symptoms:** Tempo pod shows `0/1 Running`, readiness/liveness probes fail with 503.

**Root Cause:** Tempo needs ~30 seconds to initialize its ingester ring and WAL replay.

**Fix:** Wait. Tempo will become ready on its own. If it persists beyond 2 minutes, check logs:

```bash
sudo kubectl logs -n monitoring deploy/tempo --tail=50
```

### Issue 4: Grafana Cannot Connect to Datasource

**Symptoms:** Grafana dashboards show "No Data" or datasource errors.

**Root Cause:** Prometheus, Loki, or Tempo Service is unreachable.

**Fix:**

```bash
# Check if endpoints exist for each datasource
sudo kubectl get endpoints prometheus loki tempo -n monitoring

# Test connectivity from Grafana pod
GRAFANA_POD=$(sudo kubectl get pods -n monitoring -l app=grafana \
  -o jsonpath='{.items[0].metadata.name}')
sudo kubectl exec -n monitoring $GRAFANA_POD -- wget -qO- http://prometheus:9090/-/ready 2>&1
sudo kubectl exec -n monitoring $GRAFANA_POD -- wget -qO- http://loki:3100/ready 2>&1
sudo kubectl exec -n monitoring $GRAFANA_POD -- wget -qO- http://tempo:3200/ready 2>&1
```

### Issue 5: Old Pending Pods Still Visible

**Symptoms:** After a fix, old `Pending` pods from a previous ReplicaSet remain.

**Root Cause:** Kubernetes created a new ReplicaSet for the updated config, but the old one still has `DESIRED > 0`.

**Fix:**

```bash
# Rollout restart cleans up old pods
sudo kubectl rollout restart deployment <DEPLOYMENT_NAME> -n monitoring
```

### Issue 6: Prometheus Targets Down

**Symptoms:** `up` query returns `0` for some targets.

**Root Cause:** Usually a NetworkPolicy or cross-node networking issue.

**Fix:**

```bash
# Check which targets are down
sudo kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- http://localhost:9090/api/v1/targets 2>&1 \
  | python3 -m json.tool | grep -B2 '"health": "down"'

# Verify cross-node networking
# See: cross-node-networking-troubleshooting.md
```

### Issue 7: ArgoCD Shows "Unknown" Sync Status — Helm Template Rendering Error

**Symptoms:** ArgoCD UI shows the monitoring application as `Sync: Unknown`, `Health: Degraded`.
All resources within the application appear as `Unknown`. Running `kubectl get application`
confirms the status:

```bash
sudo kubectl get application monitoring -n argocd \
  -o jsonpath='{.status.sync.status}{" "}{.status.health.status}'
```

Output: `Unknown Degraded`

**Root Cause:** Broken Helm template delimiters in one or more chart templates.
For example, `{{ .Values.foo }}` was corrupted to `{ { .Values.foo } }` (spaces inside braces).
This prevents Helm from parsing **any** template in the chart, so ArgoCD cannot render any
resources, resulting in `Unknown` sync status for all resources — not just the broken file.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Attempt to render the chart locally — Helm will show the parse error
sudo helm template monitoring-stack \
  /data/app-deploy/monitoring/chart \
  -f /data/app-deploy/monitoring/chart/values-development.yaml

# 2. Check ArgoCD application conditions for error messages
sudo kubectl get application monitoring -n argocd \
  -o jsonpath='{.status.conditions[*].message}'

# 3. Check ArgoCD repo-server logs for rendering errors
sudo kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server \
  --tail=50 | grep -i "error\|fail"
```

**Fix:**

```bash
# Fix broken delimiters in the affected template (example for loki-deployment.yaml)
sudo sed -i 's/{ { /{{/g; s/ } /}}/g' \
  /path/to/chart/templates/loki-deployment.yaml

# Verify the fix renders correctly
sudo helm template monitoring-stack /path/to/chart/ \
  -f /path/to/chart/values-development.yaml
```

Then commit and push to Git. ArgoCD will re-sync within ~3 minutes.

> [!IMPORTANT]
> A CI pipeline validation step (`just helm-validate-charts`) was added to the GitOps workflow
> to catch this class of error **before** ArgoCD syncs. See
> `.github/workflows/gitops-k8s-dev.yml` → `Validate Helm Charts` step.

### Issue 8: ArgoCD Application Stuck in Stale State After Fix

**Symptoms:** You've pushed a fix to Git, but ArgoCD still shows the old Degraded/Unknown status.
The ArgoCD UI timestamp shows the last sync was hours ago.

**Root Cause:** ArgoCD caches the rendered manifests. When the chart was broken, ArgoCD cached
the failure state. Even after the fix is pushed, ArgoCD may not automatically re-evaluate
if it considers the application in an error state.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check the current revision ArgoCD is tracking
sudo kubectl get application monitoring -n argocd \
  -o jsonpath='{.status.sync.revision}'

# 2. Compare with the latest commit on develop
# (From your local machine or CI, not via SSM)
git log -1 --format='%H' origin/develop

# 3. Check ArgoCD sync status details
sudo kubectl get application monitoring -n argocd -o yaml | \
  grep -A5 'sync:'
```

**Fix — Force a Hard Refresh:**

```bash
# Option A: Force a hard refresh via kubectl
sudo kubectl -n argocd patch application monitoring \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# Option B: Delete and let ArgoCD recreate (if app-of-apps manages it)
sudo kubectl delete application monitoring -n argocd
# ArgoCD's app-of-apps root will recreate it from Git within ~3 minutes

# Option C: Restart the ArgoCD application controller (last resort)
sudo kubectl rollout restart deployment argocd-application-controller -n argocd
```

> [!NOTE]
> After a hard refresh, wait 2–3 minutes for ArgoCD to re-render and re-sync the application.
> Monitor progress with:
> ```bash
> sudo kubectl get application monitoring -n argocd -w
> ```

### Issue 9: Loki PVC Stuck in Pending

**Symptoms:** Loki pod is `Pending`, and the `loki-data` PVC shows `Pending` while other
PVCs (grafana-data, prometheus-data, tempo-data) are `Bound`.

```bash
sudo kubectl get pvc -n monitoring
```

Output shows `loki-data` as `Pending` with no volume assigned.

**Root Cause:** The `local-path-provisioner` uses `WaitForFirstConsumer` volume binding mode.
If the Loki pod was previously stuck due to another error (e.g., Issue 7), the PVC may have
been created but never bound because no pod was successfully scheduled to consume it. A stale
PVC can block a fresh deployment.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check PVC events for binding details
sudo kubectl describe pvc loki-data -n monitoring

# 2. Check if any Loki pods exist
sudo kubectl get pods -l app=loki -n monitoring

# 3. Check local-path-provisioner logs
sudo kubectl logs -n local-path-provisioner \
  -l app=local-path-provisioner --tail=30
```

**Fix — Delete the stale PVC and let ArgoCD recreate it:**

```bash
# 1. Delete any existing Loki pods (if stuck)
sudo kubectl delete pod -l app=loki -n monitoring

# 2. Delete the stale PVC
sudo kubectl delete pvc loki-data -n monitoring

# 3. Force ArgoCD to recreate the PVC
sudo kubectl -n argocd patch application monitoring \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# 4. Verify the PVC is recreated and binds
sudo kubectl get pvc -n monitoring -w
```

> [!CAUTION]
> Deleting a PVC **destroys any data** stored in the corresponding PersistentVolume.
> For Loki, this means all ingested logs are lost. This is acceptable during initial
> deployment but should be avoided in production without a backup strategy.

### Issue 10: Calico CNI Install Fails on Re-Bootstrap (SSM Automation)

**Symptoms:** The SSM Automation bootstrap step `installCalicoCNI` fails with a timeout
or resource conflict error when the cluster is re-bootstrapped on an existing EBS volume.

```text
SSM Bootstrap Steps (Status: Failed)
    [PASS] validateGoldenAMI
    [PASS] initKubeadm
    [FAIL] installCalicoCNI
```

**Root Cause:** On re-bootstrap (when the control plane instance is replaced but the EBS
root volume is retained), Calico's operator and CRDs already exist from the previous
installation. Re-applying `tigera-operator.yaml` causes resource conflicts or timeouts
waiting for resources that are already converging.

**Fix — Idempotency Guard:**

The Calico install step was updated to use a `skip_if` marker file. On re-bootstrap, if
the marker exists, the step is skipped entirely:

```python
# In 03_install_calico.py
CALICO_MARKER = "/etc/kubernetes/.calico-installed"

runner = StepRunner(
    name="install-calico",
    skip_if=CALICO_MARKER,   # ← Skip on re-bootstrap
)
```

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check if the Calico marker exists (indicates prior install)
ls -la /etc/kubernetes/.calico-installed

# 2. Check Calico operator status
sudo kubectl get pods -n tigera-operator
sudo kubectl get tigerastatus

# 3. Check if Calico networking is functional
sudo kubectl get pods -n calico-system
sudo kubectl get nodes -o wide  # All nodes should be Ready
```

**Manual Recovery (if Calico is partially installed):**

```bash
# 1. Force re-apply the operator with server-side apply
sudo kubectl apply --server-side --force-conflicts \
  -f /opt/calico/tigera-operator.yaml

# 2. Apply the Calico installation resource
sudo kubectl apply -f /opt/calico/custom-resources.yaml

# 3. Wait for Calico to converge
sudo kubectl rollout status daemonset/calico-node -n calico-system \
  --timeout=120s

# 4. Create the marker to prevent future conflicts
sudo touch /etc/kubernetes/.calico-installed
```

### Issue 11: Loki CrashLoopBackOff After Removing Root Init Container

**Symptoms:** After removing the `fix-permissions` init container (see Issue 7), Loki enters
`CrashLoopBackOff` with exit code 1. The container repeatedly restarts.

```text
back-off 2m40s restarting failed container=loki
pod=loki-6d78d44d94-qbcx6_monitoring
```

**Root Cause:** The old PVC data directory was written by a root-owned process (the now-removed
init container). While `fsGroup: 10001` sets group ownership on **new** volume mounts,
it does not recursively `chown` existing files. Loki (running as UID 10001) cannot write
to directories still owned by root.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check Loki logs to confirm the permissions error
sudo kubectl logs -n monitoring -l app=loki --tail=20
```

**Fix — Delete and recreate the PVC:**

```bash
# 2. Delete the old PVC (it was previously stuck/stale anyway)
sudo kubectl delete pvc loki-data -n monitoring

# 3. Force ArgoCD to recreate everything
sudo kubectl -n argocd patch application monitoring \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# 4. Watch for the PVC to rebind and pod to recover
sudo kubectl get pvc -n monitoring -w
```

> [!CAUTION]
> Deleting a PVC destroys all stored data. For Loki this means ingested logs are lost.
> A fresh PVC with `fsGroup: 10001` will have correct ownership from the start.

### Issue 12: Loki Still Crashing After ConfigMap Fix — Pod Not Restarted

**Symptoms:** After committing a fix to `loki-configmap.yaml`
(e.g. adding `delete_request_store: filesystem`), ArgoCD shows
`Sync=Synced` but `Health=Degraded`. Loki remains in
`CrashLoopBackOff` with the **old** config error.

**Root Cause:** ConfigMap changes don't automatically restart pods.
ArgoCD applied the updated `loki-configmap.yaml`, but the Loki
pod is still running with the old config cached in memory.
Kubernetes mounts ConfigMaps as volumes at pod startup — changing
a ConfigMap doesn't trigger a rollout.

**Fix (via SSM session on control plane):**

```bash
# Restart the Loki deployment to pick up the new ConfigMap
sudo kubectl rollout restart deployment/loki -n monitoring

# Watch it recover
sudo kubectl get pods -n monitoring -l app=loki -w
```

This creates a new pod that mounts the updated ConfigMap.

> [!TIP]
> A common pattern to automate ConfigMap-triggered restarts is
> adding a checksum annotation to the Deployment pod template:
> `checksum/config: {{ include (print $.Template.BasePath
> "/loki-configmap.yaml") . | sha256sum }}`
> This forces a rollout whenever the ConfigMap content changes.

### Issue 13: New Loki Pod Stuck in Pending After Rollout Restart

**Symptoms:** After `kubectl rollout restart`, the new Loki pod
stays in `Pending` while the old pod remains `Running`:

```text
loki-6d78d44d94-qbcx6   1/1  Running  8 (6m ago)  17m
loki-7d56fd9bd9-w9m7s   0/1  Pending  0           21s
```

**Root Cause:** The `loki-data` PVC uses `local-path` storage
with `ReadWriteOnce` (RWO) access mode, meaning only **one pod
can mount it at a time**. The rolling update strategy creates the
new pod *before* terminating the old one, causing a deadlock —
the new pod can't mount the PVC until the old one releases it.

**Fix (via SSM session on control plane):**

```bash
# Delete the old pod holding the PVC
sudo kubectl delete pod <old-pod-name> -n monitoring

# The new pod should transition to Running
sudo kubectl get pods -n monitoring -l app=loki -w
```

> [!TIP]
> For deployments with RWO volumes, consider setting the
> Deployment strategy to `Recreate` instead of `RollingUpdate`.
> This terminates the old pod before creating the new one,
> avoiding the PVC deadlock entirely.

> [!NOTE]
> **Resolved.** After deleting the old pod, the new Loki pod
> started successfully and the monitoring ArgoCD application
> reached `Synced + Healthy`.

---

### Issue 14: RWO PVC Deadlocks on Rolling Updates — Recreate Strategy Fix

**Symptom:** Pods using RWO (ReadWriteOnce) PersistentVolumeClaims
(Prometheus, Loki, Grafana, Tempo) get stuck in `Pending` or
`CrashLoopBackOff` during rolling updates.

**Root Cause:** The default `RollingUpdate` strategy creates the new
pod before terminating the old one. With RWO volumes, the new pod
cannot mount the PVC while the old pod still holds it.

**Fix:** Set the Deployment strategy to `Recreate` in all four
stateful deployments:

```yaml
spec:
  strategy:
    type: Recreate
```

**Files changed:**
- `prometheus-deployment.yaml`
- `loki-deployment.yaml`
- `grafana-deployment.yaml`
- `tempo-deployment.yaml`

**What this means going forward:** On every config change or image
update, Kubernetes will terminate the old pod first, then create the
new one. Brief downtime (~10–15s) during rollouts, but no more stuck
`Pending` pods or TSDB lock conflicts.

> [!NOTE]
> **Resolved.** All four deployments now use `Recreate` strategy.

---

### Issue 15: Prometheus CrashLoopBackOff — TSDB Lock Conflict

**Symptom:** After a rolling update, the new Prometheus pod starts
successfully but the old pod enters `CrashLoopBackOff` with:

```
Fatal error: opening storage failed: lock DB directory: resource temporarily unavailable
```

**Root Cause:** The new pod acquired the TSDB lock on the
`/prometheus` data directory. The old pod (from the previous
ReplicaSet) keeps trying to start but cannot acquire the lock.

**Diagnosis:**

```bash
# Check pod status
sudo kubectl get pods -n monitoring -l app=prometheus

# Check logs for the crashing pod
sudo kubectl logs <crashing-pod-name> -n monitoring --tail=20
```

**Fix:** Delete the old pod from the previous ReplicaSet:

```bash
sudo kubectl delete pod <old-prometheus-pod-name> -n monitoring
```

**Verify:**

```bash
# Check pods are running
sudo kubectl get pods -n monitoring

# Check service endpoints are populated
sudo kubectl get endpoints grafana prometheus -n monitoring

# Check ArgoCD sync status
sudo kubectl get application monitoring -n argocd
```

> [!TIP]
> This issue is permanently prevented by Issue 14's `Recreate`
> strategy fix. With `Recreate`, the old pod is terminated before
> the new one starts, so no lock conflict occurs.

> [!NOTE]
> ArgoCD may show `Progressing` health status while the old
> crashing pod exists. Deleting it resolves the health check
> and ArgoCD should flip to `Synced + Healthy`.

---

### Issue 16: Traefik IngressRoute Returns 504 — NetworkPolicy Blocks hostNetwork Traffic

**Symptom:** After creating IngressRoutes for Grafana and Prometheus,
`curl http://localhost/grafana` and `curl http://localhost/prometheus`
return `504 Gateway Timeout`.

**Root Cause:** Traefik runs with `hostNetwork: true`, so its traffic
comes from the **node IP**, not a pod IP. The NetworkPolicy's
`namespaceSelector: {}` rules only match pod-to-pod traffic — they
silently block host-network traffic from reaching monitoring services.

**Diagnosis:**

```bash
# Test from inside the cluster (pod-to-pod, bypasses hostNetwork issue)
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://grafana.monitoring.svc.cluster.local:3000/api/health
```

If this returns `200`, the NetworkPolicy is blocking Traefik.

**Fix:** Change `namespaceSelector` to `ipBlock: 0.0.0.0/0` for
ports 3000 (Grafana) and 9090 (Prometheus) in `network-policy.yaml`:

```yaml
# Grafana — allow from any IP (including hostNetwork nodes)
- from:
    - ipBlock:
        cidr: 0.0.0.0/0
  ports:
    - port: 3000
      protocol: TCP
# Prometheus — allow from any IP (including hostNetwork nodes)
- from:
    - ipBlock:
        cidr: 0.0.0.0/0
  ports:
    - port: 9090
      protocol: TCP
```

**Verify after ArgoCD syncs:**

```bash
# Wait for sync
sudo kubectl get application monitoring -n argocd -w

# Test endpoints
curl -s -o /dev/null -w "%{http_code}" http://localhost/grafana
curl -s -o /dev/null -w "%{http_code}" http://localhost/prometheus
```

> [!IMPORTANT]
> This pattern applies to **any** service that needs to receive
> traffic from Traefik (or any hostNetwork pod). Standard
> `namespaceSelector` rules will not match — you must use
> `ipBlock` rules instead.

> [!NOTE]
> **Resolved.** After updating the NetworkPolicy, both Grafana
> and Prometheus became accessible via Traefik IngressRoutes.

---

### Issue 17: ArgoCD Sync Fails — Recreate Strategy Rejects Leftover rollingUpdate Settings

**Symptom:** ArgoCD sync fails with:

```
Deployment.apps "grafana" is invalid: spec.strategy.rollingUpdate:
Forbidden: may not be specified when strategy `type` is 'Recreate'
```

This error appears for all four stateful deployments (Grafana,
Loki, Prometheus, Tempo).

**Root Cause:** When Kubernetes has an existing `RollingUpdate`
deployment, adding `type: Recreate` doesn't automatically remove
the `rollingUpdate` settings. Kubernetes rejects the apply because
both `type: Recreate` and `rollingUpdate` config cannot coexist.

**Fix:** Explicitly null out `rollingUpdate` in the deployment
templates:

```yaml
spec:
  strategy:
    type: Recreate
    rollingUpdate: null
```

**Files changed:**
- `prometheus-deployment.yaml`
- `loki-deployment.yaml`
- `grafana-deployment.yaml`
- `tempo-deployment.yaml`

**Workarounds while waiting for ArgoCD sync:**

Scale down the old crashing ReplicaSet directly:

```bash
sudo kubectl scale replicaset <old-replicaset-name> \
  -n monitoring --replicas=0
```

Or force ArgoCD to refresh and re-read Git:

```bash
sudo kubectl -n argocd patch application monitoring \
  --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'
```

> [!NOTE]
> Scaling down the old ReplicaSet manually may not persist
> because ArgoCD's reconciliation loop (`selfHeal: true`) will
> restore it. The permanent fix requires the `rollingUpdate: null`
> in Git.

**Why `rollingUpdate: null` still failed:**

The monitoring ArgoCD application has auto-sync enabled:

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
  syncOptions:
    - ServerSideApply=true
```

Despite using `ServerSideApply=true`, the `rollingUpdate: null`
in the Helm-rendered YAML didn't clear the existing `rollingUpdate`
field from the live deployment. Kubernetes still saw both
`type: Recreate` and the leftover `rollingUpdate` config, rejecting
the apply.

**Definitive fix — delete the deployments for a clean CREATE:**

```bash
# Delete all four stateful deployments
sudo kubectl delete deployment grafana loki prometheus tempo \
  -n monitoring

# ArgoCD (selfHeal: true) detects missing resources and
# recreates them via CREATE (not PATCH), avoiding the conflict
sudo kubectl get application monitoring -n argocd -w
sudo kubectl get pods -n monitoring -w
```

This works because a `CREATE` operation builds the resource from
scratch — there is no existing `rollingUpdate` field to conflict
with. ArgoCD auto-sync will detect the missing deployments and
recreate them within ~1 minute.

> [!NOTE]
> **Resolved.** After deleting the four deployments, ArgoCD
> auto-synced and recreated them with the `Recreate` strategy.
> No more `rollingUpdate` conflicts.

---

## Glossary

| Term | Definition |
|---|---|
| **ArgoCD** | GitOps continuous delivery tool — syncs Kubernetes manifests from Git to the cluster |
| **Calico** | Open-source networking and network security solution for Kubernetes (CNI plugin) |
| **ClusterIP** | An internal-only IP address assigned to a Kubernetes Service, reachable only from within the cluster |
| **CNI (Container Network Interface)** | Plugin standard that configures pod networking in Kubernetes |
| **ConfigMap** | Kubernetes resource for storing non-sensitive configuration data as key-value pairs |
| **DaemonSet** | Kubernetes workload that ensures one pod runs on every node (or every matching node) |
| **Deployment** | Kubernetes workload that manages a set of identical pods via ReplicaSets |
| **Endpoints** | List of pod IPs that a Service routes traffic to |
| **Grafana** | Open-source observability platform for visualization and dashboards |
| **Helm** | Kubernetes package manager — templates and deploys YAML manifests as versioned charts |
| **Init Container** | A container that runs before the main containers in a pod, used for setup tasks |
| **Kube State Metrics** | Exports Kubernetes object states (pods, deployments, nodes) as Prometheus metrics |
| **Liveness Probe** | Periodic health check — if it fails, Kubernetes restarts the container |
| **Local-Path Provisioner** | Rancher's lightweight storage provisioner — creates PersistentVolumes on the node's local disk |
| **Loki** | Log aggregation system from Grafana Labs — like Prometheus, but for logs |
| **Node Exporter** | Prometheus exporter for host-level metrics (CPU, memory, disk, network) |
| **NodeSelector** | Pod scheduling constraint — only schedule the pod on nodes with matching labels |
| **PersistentVolumeClaim (PVC)** | A request for storage — binds to a PersistentVolume provided by a StorageClass |
| **Prometheus** | Open-source time-series database and monitoring system — scrapes metrics from targets |
| **Promtail** | Log collection agent from Grafana Labs — ships logs to Loki |
| **Readiness Probe** | Periodic health check — if it fails, Kubernetes removes the pod from Service traffic |
| **ReplicaSet** | Controller that ensures the desired number of pod replicas are running |
| **ResourceQuota** | Namespace-level constraint on total CPU, memory, and object counts |
| **SSM Automation** | AWS Systems Manager capability for running multi-step runbooks on EC2 instances |
| **StorageClass** | Defines how PersistentVolumes are created (provisioner, reclaim policy, binding mode) |
| **Tempo** | Distributed tracing backend from Grafana Labs — stores and queries trace data |
