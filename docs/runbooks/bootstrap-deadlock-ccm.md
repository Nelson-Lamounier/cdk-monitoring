# Bootstrap Deadlock Runbook — AWS Cloud Controller Manager

> **Scenario**: ArgoCD and CoreDNS pods are stuck `Pending` after cluster
> bootstrap. All nodes have the `node.cloudprovider.kubernetes.io/uninitialized`
> taint, preventing any pod scheduling.

**Last Updated:** 2026-03-25
**Operator:** Solo — infrastructure owner

---

## Background

Kubernetes nodes started with `--cloud-provider=external` receive the
`node.cloudprovider.kubernetes.io/uninitialized=true:NoSchedule` taint
automatically. Only the AWS Cloud Controller Manager (CCM) removes this
taint after initialising the node's cloud provider metadata.

### The Deadlock

Prior to the permanent fix (step 4b in `control_plane.py`), the CCM was
deployed exclusively via ArgoCD (sync-wave 2). This created a circular
dependency:

```
kubelet starts with --cloud-provider=external
  → nodes tainted with 'uninitialized'
    → ArgoCD pods can't schedule (taint blocks them)
      → CCM never deployed (it's an ArgoCD Application)
        → taint never removed → deadlock
```

### The Permanent Fix

`control_plane.py` step 4b (`step_install_ccm`) now installs the CCM via
Helm **before** ArgoCD bootstrap, breaking the cycle. ArgoCD adopts the
Helm release on subsequent syncs via the `aws-cloud-controller-manager`
Application (sync-wave 2, `selfHeal: true`).

---

## Diagnosis

### 1. Confirm the Deadlock Symptoms

```bash
# Connect to control plane via SSM
just k8s-tunnel-auto

# Check for Pending pods
kubectl get pods -A --field-selector=status.phase=Pending

# Check for the uninitialized taint
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
# Expected deadlock output: node.cloudprovider.kubernetes.io/uninitialized
```

### 2. Confirm CCM Is Not Running

```bash
kubectl get pods -n kube-system | grep cloud-controller
# Empty output = CCM not deployed

helm list -n kube-system | grep aws-cloud-controller
# Empty output = Helm release not present
```

### 3. Check ArgoCD Status

```bash
kubectl get pods -n argocd
# All pods showing Pending = confirms deadlock
```

---

## Recovery — Manual Fix (if step 4b hasn't run)

If the cluster is already in the deadlock state (code hasn't been updated
or the pipeline hasn't re-run), apply this manual fix:

### 1. Install CCM via Helm

```bash
# Add the Helm repo
helm repo add aws-cloud-controller-manager \
  https://kubernetes.github.io/cloud-provider-aws
helm repo update

# Create values file
cat <<'EOF' > /tmp/ccm-values.yaml
args:
  - --v=2
  - --cloud-provider=aws
  - --configure-cloud-routes=false
nodeSelector:
  node-role.kubernetes.io/control-plane: ""
tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - key: node.cloudprovider.kubernetes.io/uninitialized
    value: "true"
    effect: NoSchedule
hostNetworking: true
EOF

# Install the CCM
helm upgrade --install aws-cloud-controller-manager \
  aws-cloud-controller-manager/aws-cloud-controller-manager \
  --namespace kube-system \
  --values /tmp/ccm-values.yaml \
  --wait --timeout 120s
```

### 2. Verify Taint Removal

```bash
# Watch for taint removal (should happen within 30s)
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
# The 'uninitialized' taint should be gone

# CCM pod should be Running
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-cloud-controller-manager
```

### 3. Verify Pods Start Scheduling

```bash
# ArgoCD pods should transition from Pending → Running
kubectl get pods -n argocd -w

# CoreDNS should start
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

---

## Recovery — Trigger Automated Fix (preferred)

If the code change (step 4b) is merged but the cluster is already stuck:

### Option A: Re-run the Pipeline

```bash
# Trigger the SSM automation workflow via GitHub Actions
gh workflow run _deploy-ssm-automation.yml \
  --ref main \
  -f environment=development
```

The pipeline syncs the updated `control_plane.py` to S3, then triggers
SSM Automation on the control plane. Step 4b will install the CCM
and step 7 will bootstrap ArgoCD.

### Option B: Re-run Control Plane Bootstrap Manually

```bash
# On the control plane (via SSM session):
# Remove the CCM marker to allow re-run
rm -f /etc/kubernetes/.ccm-installed

# Re-run the bootstrap
python3 /data/k8s-bootstrap/boot/steps/control_plane.py
```

---

## Verification

```bash
# 1. CCM pod is Running
kubectl get pods -n kube-system | grep aws-cloud-controller
# EXPECTED: aws-cloud-controller-manager-xxxxx   1/1   Running

# 2. No 'uninitialized' taint on any node
kubectl describe nodes | grep -A5 Taints:
# EXPECTED: only the control-plane NoSchedule taint

# 3. ArgoCD pods are Running
kubectl get pods -n argocd
# EXPECTED: all 7 pods Running

# 4. CoreDNS is Running
kubectl get pods -n kube-system -l k8s-app=kube-dns
# EXPECTED: 2/2 Running

# 5. ArgoCD UI is accessible
curl -sk https://ops.nelsonlamounier.com/argocd/ | head -5
# EXPECTED: HTML response (not connection refused)
```

---

## Recovery Timeline

| Phase | Duration | Notes |
|:---|:---:|:---|
| Diagnose deadlock | 2 min | Confirm Pending pods + taint |
| Install CCM (manual) | 3 min | Helm install + repo add |
| Taint removal | 30s | CCM processes node automatically |
| ArgoCD starts | 2 min | Pods schedule + containers pull |
| Full platform sync | 10 min | ArgoCD syncs all wave 0–5 apps |
| **Total** | **~15 min** | Manual intervention |

---

## Prevention

This deadlock is prevented by `step_install_ccm()` in `control_plane.py`
(step 4b), which installs the CCM via Helm before ArgoCD bootstrap.

The step is **idempotent** — guarded by the marker file
`/etc/kubernetes/.ccm-installed`. On re-runs, it skips if the CCM is
already installed.

## Source Files

- `kubernetes-app/k8s-bootstrap/boot/steps/control_plane.py` — Bootstrap sequence with step 4b (`step_install_ccm`)
- `kubernetes-app/platform/argocd-apps/aws-cloud-controller-manager.yaml` — ArgoCD Application manifest (adopts the Helm release)
- `kubernetes-app/k8s-bootstrap/system/argocd/bootstrap_argocd.py` — ArgoCD bootstrap script (step 7)
- `.github/workflows/_deploy-ssm-automation.yml` — Pipeline that syncs bootstrap scripts and triggers SSM

---

*Commands and paths above are real values from the cdk-monitoring repository.*
