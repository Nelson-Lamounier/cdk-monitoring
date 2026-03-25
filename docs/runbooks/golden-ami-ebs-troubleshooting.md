# Golden AMI & EBS Lifecycle — Troubleshooting Runbook

> **Purpose**: Diagnose Golden AMI pipeline failures, cloud-init breakage,
> EBS detachment timeouts, and ASG update hangs.

**Last Updated:** 2026-03-25
**Operator:** Solo — infrastructure owner

---

## CloudWatch Log Groups Reference

All log groups use the `k8s` name prefix (configurable via `namePrefix`
prop in CDK stacks). Replace `<env>` with `development`, `staging`, or
`production`.

### Compute & Instance Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/ec2/k8s/instances` | CloudWatch Agent (user-data) | Instance bootstrap stdout/stderr, cloud-init output, cfn-signal result |

### Lambda Function Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/aws/lambda/k8s-ebs-detach-lifecycle` | EBS Detach Lifecycle Lambda | Volume detachment events, lifecycle hook completion, error traces |

### SSM Automation Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/ssm/k8s/<env>/bootstrap` | SSM Automation (bootstrap doc) | Step-by-step bootstrap output for control-plane and worker nodes |
| `/ssm/k8s/<env>/deploy` | SSM Automation (deploy doc) | Application deployment script output (secrets, ArgoCD config) |
| `/ssm/k8s/<env>/drift` | SSM Automation (drift enforcement) | Node drift detection and remediation output |

### Image Builder Logs

| Log Group | Source | Content |
| :--- | :--- | :--- |
| `/aws/imagebuilder/*` | EC2 Image Builder | AMI bake logs — component install and validate phases |

> [!TIP]
> Image Builder logs are created automatically by the service. Search for
> log groups starting with `/aws/imagebuilder/` to find the active pipeline.

---

## Quick Diagnostics

### 1. Check Cloud-Init Status on a Running Instance

```bash
# Via SSM Session Manager
aws ssm start-session --target <instance-id> \
  --region eu-west-1 --profile dev-account

# Inside the instance
cloud-init status --long
cat /var/log/cloud-init-output.log | tail -100
```

### 2. Check cfn-signal Was Sent

```bash
# Inside the instance
grep cfn-signal /var/log/cloud-init-output.log
```

If absent, cloud-init failed before reaching the cfn-signal step.

### 3. Query EBS Detach Lambda Logs

```bash
aws logs tail "/aws/lambda/k8s-ebs-detach-lifecycle" \
  --since 1h --format short \
  --region eu-west-1 --profile dev-account
```

### 4. Query Instance Bootstrap Logs

```bash
aws logs tail "/ec2/k8s/instances" \
  --since 1h --format short \
  --region eu-west-1 --profile dev-account
```

### 5. Query SSM Bootstrap Logs

```bash
# Control-plane + worker bootstrap output
aws logs tail "/ssm/k8s/development/bootstrap" \
  --since 2h --format short \
  --region eu-west-1 --profile dev-account

# Or use the justfile shortcut
just ssm-bootstrap-logs
```

---

## Common Failure Scenarios

### Scenario 1: ASG Stuck on `UPDATE_IN_PROGRESS` — cfn-signal Never Received

**Symptoms:**

- CloudFormation shows `UPDATE_IN_PROGRESS` on the ASG for >15 minutes
- Instance is running but `cloud-init status` shows `error` or `degraded`

**Root Cause:** cloud-init failed, so user-data never completed and
`cfn-signal` was never sent.

**Diagnosis:**

```bash
# 1. Get the new instance ID
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names k8s-dev-ctrl-asg \
  --query "AutoScalingGroups[0].Instances[*].InstanceId" \
  --region eu-west-1 --profile dev-account

# 2. Check cloud-init
aws ssm start-session --target <instance-id> \
  --region eu-west-1 --profile dev-account
# Then: cloud-init status --long
# Then: cat /var/log/cloud-init-output.log | tail -200

# 3. Check instance log group
aws logs tail "/ec2/k8s/instances" --since 30m --format short \
  --region eu-west-1 --profile dev-account
```

**Resolution:**

- If caused by Python version issue: the virtualenv fix in
  `build-golden-ami-component.ts` resolves this — re-bake the AMI
- If caused by missing packages: check the Image Builder validate phase logs

### Scenario 2: EBS Volume Not Detached on Instance Replacement

**Symptoms:**

- Old EBS volume stuck in `in-use` state after instance termination
- New instance cannot attach the volume

**Diagnosis:**

```bash
# 1. Check Lambda logs for detachment events
aws logs tail "/aws/lambda/k8s-ebs-detach-lifecycle" \
  --since 1h --format short \
  --region eu-west-1 --profile dev-account

# 2. Check volume state
aws ec2 describe-volumes \
  --filters "Name=tag:ManagedBy,Values=MonitoringStack" \
  --query "Volumes[*].[VolumeId,State,Attachments[0].InstanceId]" \
  --output table \
  --region eu-west-1 --profile dev-account
```

**Resolution:**

- If Lambda didn't fire: check EventBridge rule in the console
  (`k8s-ebs-detach-rule`)
- If Lambda errored: check the error trace in the Lambda log group
- Manual force-detach as last resort:
  ```bash
  aws ec2 detach-volume --volume-id <vol-id> --force \
    --region eu-west-1 --profile dev-account
  ```

### Scenario 3: Golden AMI Bake Fails — Validate Phase

**Symptoms:**

- Image Builder pipeline shows `FAILED` status
- AMI SSM parameter not updated

**Diagnosis:**

```bash
# 1. Check Image Builder build status
aws imagebuilder list-image-pipeline-images \
  --image-pipeline-arn <pipeline-arn> \
  --query "imageSummaryList[0].[state.status,state.reason]" \
  --region eu-west-1 --profile dev-account

# 2. Check Image Builder logs
aws logs filter-log-events \
  --log-group-name-prefix "/aws/imagebuilder/" \
  --filter-pattern "FATAL" \
  --start-time $(date -v-2H +%s)000 \
  --region eu-west-1 --profile dev-account
```

**Resolution:**

- Run the local unit test to catch YAML anti-patterns:
  ```bash
  just test-ami-build
  ```
- Fix the component YAML in `build-golden-ami-component.ts`
- Re-trigger the pipeline via CDK deploy

### Scenario 4: System Python Overridden — cloud-init Package Import Errors

**Symptoms:**

- `cloud-init status` shows `error`
- `/var/log/cloud-init.log` contains `ModuleNotFoundError` or
  `ImportError` for packages like `jsonschema`, `configobj`

**Root Cause:** `alternatives --set python3 python3.11` was used, which
hijacks the system Python 3.9 that cloud-init depends on.

**Diagnosis (on the instance):**

```bash
python3 --version
# If this shows 3.11, the system python has been overridden

# Check cloud-init can import its dependencies
python3 -c "import cloudinit; print(cloudinit.__version__)"
```

**Resolution:**

The fix is already in place: the AMI now uses `/opt/k8s-venv` instead
of `alternatives`. Re-bake the AMI to pick up the fix. Verify locally:

```bash
just test-ami-build
```

---

## EventBridge Rules Reference

| Rule | Event Source | Target | Purpose |
| :--- | :--- | :--- | :--- |
| `k8s-ebs-detach-rule` | `aws.autoscaling` (EC2 Instance-terminate Lifecycle Action) | EBS Detach Lambda | Gracefully detach EBS volumes before instance termination |
| EIP Failover rule | `aws.autoscaling` (EC2 Instance Launch Successful) | EIP Failover Lambda | Auto-associate Elastic IP to new instances |

---

## Source Files

| File | Purpose |
| :--- | :--- |
| `infra/lib/stacks/kubernetes/control-plane-stack.ts` | EBS detach Lambda, EventBridge rules, instance log group |
| `infra/lib/stacks/kubernetes/golden-ami-stack.ts` | Image Builder pipeline and component configuration |
| `infra/lib/constructs/compute/utils/build-golden-ami-component.ts` | Component YAML generation (virtualenv, validate phase) |
| `infra/lib/constructs/ssm/automation-document.ts` | SSM Automation documents (PATH prepend, bootstrap steps) |
| `infra/tests/unit/constructs/compute/build-golden-ami-component.test.ts` | Unit tests — anti-pattern detection (17 checks) |

---

## Related Runbooks

- [SSM Automation — Deployment & Redeployment](./ssm-automation-deployment.md)
- [Bootstrap Deadlock — CCM Recovery](./bootstrap-deadlock-ccm.md)
- [Cross-AZ Disaster Recovery](./cross-az-recovery.md)

---

*Commands and paths above are real values from the cdk-monitoring repository.*
