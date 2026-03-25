# Runbook: EC2 Instance Terminated Unexpectedly

**Last Updated:** 2026-03-22
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