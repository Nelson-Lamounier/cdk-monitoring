---
title: "EC2 Instance Terminated Unexpectedly"
doc_type: runbook
domain: kubernetes
tags:
  - ec2
  - asg
  - bootstrap
  - self-healing
  - step-functions
  - ssm-automation
  - eip-failover
  - tls
  - certificate
  - calico
  - kubeadm
related_docs:
  - infrastructure/adrs/step-functions-over-lambda-orchestration.md
  - kubernetes/bootstrap-pipeline.md
  - kubernetes/bootstrap-system-scripts.md
  - kubernetes/adrs/self-managed-k8s-vs-eks.md
last_updated: "2026-04-06"
author: Nelson Lamounier
status: accepted
---

# Runbook: EC2 Instance Terminated Unexpectedly

**Last Updated:** 2026-04-06
**Operator:** Solo — infrastructure owner

## Trigger

An EC2 Kubernetes node is terminated unexpectedly (ASG health check failure, Spot interruption, or manual error).

## Automatic Response

The infrastructure responds automatically through the bootstrap pipeline:

### 1. ASG Replacement

The Auto Scaling Group detects the instance loss and launches a replacement from the Launch Template:
- **Control plane:** ASG min=1, max=1 — replacement launches immediately
- **Workers:** ASG min=1, max=1 per worker role — replacement launches immediately
- Launch Template uses the latest Golden AMI from SSM path `/k8s/development/golden-ami/latest`

### 2. EventBridge → Step Functions Trigger

On ASG `EC2 Instance Launch Successful`, EventBridge triggers the Bootstrap Orchestrator Step Functions state machine (`infra/lib/constructs/ssm/bootstrap-orchestrator.ts`):

1. **Router Lambda** reads `k8s:bootstrap-role` tag from the ASG (values: `control-plane`, `app-worker`, `monitoring-worker`, `argocd-worker`)
2. Resolves the correct SSM Automation document name from SSM parameter store
3. Updates the instance-id SSM parameter for the role
4. Starts the SSM Automation document (`kubeadm init` or `kubeadm join`)
5. Polls for completion (30-second intervals, 15-minute timeout)

### 3. Control Plane Special Handling

If the terminated instance was the control plane, the orchestrator additionally:
- Triggers the EIP failover Lambda to associate the Elastic IP with the new instance
- Chains secrets deployment (Next.js + Monitoring secrets SSM Automation docs)
- Updates Route 53 private hosted zone A record (`k8s.internal`)
- Triggers worker CA re-join (workers need the new control plane's certificate authority)

### 4. SSM State Manager Drift Enforcement

After bootstrap, the SSM State Manager association (`infra/lib/constructs/ssm/node-drift-enforcement.ts`) runs every 30 minutes to enforce:
- **Kernel modules:** `overlay`, `br_netfilter`
- **Sysctl settings:** `net.bridge.bridge-nf-call-iptables`, `net.bridge.bridge-nf-call-ip6tables`, `net.ipv4.ip_forward`
- **Services:** `containerd`, `kubelet`

### 5. Local Diagnostic / Recovery Script

If the automatic recovery fails, use the TypeScript control plane troubleshooter to diagnose and optionally repair the instance from your local machine:

```bash
# Diagnose only
npx tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account

# Diagnose and auto-fix (cert regen, podSubnet patch, operator restart)
npx tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account --fix
```

The script runs 5 diagnostic phases (infrastructure → automation → DR/certs → Kubernetes → repair) via SSM and produces a colour-coded report with recommendations. All output is file-logged to `scripts/local/diagnostics/.troubleshoot-logs/`.

## Manual Verification

After automatic recovery completes (typically 8–12 minutes):

1. **Check ASG:** Verify replacement instance is `InService`
   ```bash
   aws autoscaling describe-auto-scaling-groups \
     --auto-scaling-group-names k8s-development-control-plane-asg \
     --query 'AutoScalingGroups[0].Instances[*].[InstanceId,LifecycleState]'
   ```

2. **Check Step Functions:** Verify bootstrap execution succeeded
   ```bash
   aws stepfunctions list-executions \
     --state-machine-arn arn:aws:states:eu-west-1:ACCOUNT:stateMachine:k8s-bootstrap-orchestrator \
     --status-filter SUCCEEDED --max-results 1
   ```

3. **Check cluster via SSM port-forward:**
   ```bash
   aws ssm start-session --target INSTANCE_ID \
     --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}'
   # In another terminal:
   kubectl get nodes
   kubectl get pods -A
   ```

4. **Check ArgoCD sync:**
   ```bash
   npx tsx infra/scripts/cd/verify-argocd-sync.ts
   ```

## Recovery Evidence

- **CloudWatch Dashboard:** `KubernetesObservabilityStack` dashboard shows ASG instance count, NLB healthy hosts
- **Step Functions Console:** Visual state machine execution showing each bootstrap step
- **ArgoCD UI:** `ops.nelsonlamounier.com/argocd` — all applications should show `Synced` and `Healthy`
- **CloudWatch Alarms:** Bootstrap failure alarm triggers SNS notification if automation fails

## Postmortem Template

| Field | Value |
|---|---|
| **Incident Date** | |
| **Detection Time** | ASG detects within ~60 seconds |
| **Bootstrap Start** | EventBridge triggers within ~30 seconds of ASG launch |
| **Recovery Time** | Typically 8–12 minutes (AMI boot + kubeadm + ArgoCD sync) |
| **Root Cause** | ASG health check / Spot interruption / manual |
| **Action Taken** | Automatic — no manual intervention required |

---

*Commands and paths above are real values from the cdk-monitoring repository.*

## Troubleshooting

### Control Plane Fails to Start After ASG Replacement

**What happened:** The ASG replaces the control plane instance. The S3 DR restore successfully recovers `/etc/kubernetes/pki` and `admin.conf`. However, the API server never starts, `kubectl` commands fail silently during bootstrap, and the automation attempts to renew the API server certificate, burning through the Let's Encrypt / AWS 5-certificates-per-week rate limit.

**Why:** The bootstrap scripts (`_handle_second_run()`) erroneously assumed that if `admin.conf` exists, the cluster is already running and only needs a DNS update. However, on ASG replacement, the root filesystem is fresh: there is no kubelet config, containerd isn't running, and static pod manifests (`/etc/kubernetes/manifests`) are missing. The certificate renewal was also unnecessary because the node's external IP changes, but TLS is validated against the internal DNS name (`k8s-api.k8s.internal`), which is already in the existing certificate's SAN list.

**Fix:** The logic was refactored to check for the existence of `kube-apiserver.yaml`. If missing (indicating a fresh root FS from an ASG replacement), it triggers a zero-cert-regeneration reconstruction flow `_reconstruct_control_plane()`. This flow executes targeted `kubeadm init phase` subcommands (kubeconfig, control-plane, etcd, kubelet-start) to reconstruct the control plane using the mathematically valid PKI recovered from S3, without hitting certificate limits. It also includes an automated RBAC repair for the `kubeadm:cluster-admins` cluster role binding if access is lost after reconstruction.

### API Server Certificate SAN Mismatch After ASG Replacement

**What happened:** After ASG replacement, kubelet logs showed `tls: failed to verify certificate: x509: certificate is valid for 10.96.0.1, 10.0.0.104, not 10.0.0.215`. The API server was running, but no nodes could register. All pods were stuck in `Pending`.

**Why:** The DR restore flow (`_reconstruct_control_plane()`) restored `/etc/kubernetes/pki/apiserver.crt` from the S3 backup. This certificate contained the **previous** instance's private IP in its Subject Alternative Names (SANs). The new instance had a different private IP (assigned by the VPC DHCP), so kubelet's TLS verification against the raw IP failed. The reconstruction code did not compare the cert SANs against the current instance's IP.

**Fix:** Added a SAN validation step in `_reconstruct_control_plane()` (line ~496 of `control_plane.py`). After restoring PKI from backup, the code now reads the certificate SANs using `openssl x509 -noout -text`, extracts IP addresses, and compares them against the current instance's private IP from IMDS. If the IP is missing from the SANs, it calls `_renew_apiserver_cert()` to regenerate the certificate with the correct IPs. A safety-net check was also added to `_handle_second_run()` for edge cases where the API server may be running with an invalid certificate.

### Missing podSubnet in kubeadm-config Causes Calico Degraded State

**What happened:** After ASG replacement, Calico pods remained in `0/1 Ready` state and the tigera-operator entered a `Degraded` status with the error: `the provided networking.podSubnet field is empty`.

**Why:** The `_reconstruct_control_plane()` function called `kubeadm init phase upload-config kubeadm` without the `--pod-network-cidr` flag. This meant the `kubeadm-config` ConfigMap in `kube-system` was recreated without the `networking.podSubnet` field. The Tigera operator reads this field to determine the IP pool for pod networking. Without it, the operator cannot configure Calico's IPAM, leaving the CNI uninitialised and the node in `NotReady` state.

**Fix:** Added `--pod-network-cidr={POD_CIDR}` (default `192.168.0.0/16`) to the `kubeadm init phase upload-config kubeadm` command in `_reconstruct_control_plane()` (line ~336 of `control_plane.py`). This ensures the ConfigMap always includes the `podSubnet` field, allowing the Tigera operator to initialise Calico correctly.

## Transferable Skills Demonstrated

- **Auto-healing infrastructure** — designing self-recovery workflows with Step Functions and SSM
- **AWS event-driven architecture** — EventBridge rules for EC2 state change notifications
- **Kubernetes node lifecycle** — handling node drain, cordon, and rejoin procedures
- **Disaster recovery** — automated cluster reconstitution from golden AMI baselines

## Summary

This runbook documents the automatic self-healing response when a Kubernetes EC2 node is terminated: ASG replacement → EventBridge → Step Functions bootstrap orchestration → SSM Automation (kubeadm init/join). Covers control plane special handling (EIP failover, secrets chaining, worker CA re-join) and manual verification steps.

## Keywords

ec2, asg, bootstrap, self-healing, step-functions, ssm-automation, eip-failover, kubeadm, recovery, eventbridge, tls, certificate, x509, san, calico, tigera, podsubnet, control-plane-troubleshoot
