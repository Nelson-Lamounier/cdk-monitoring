# SSM Automation Runtime — Integration Test Review

> Pipeline step: `verify-ssm-automation` in [_deploy-ssm-automation.yml](../../.github/workflows/_deploy-ssm-automation.yml)

---

## 1. Purpose

Validates two focused concerns for each K8s bootstrap role:

1. **Instance Targeting** — the SSM Automation document ran on the correct EC2 instance (matched by `k8s:bootstrap-role` tag)
2. **Instance Health** — each instance is running, EC2 status checks pass, and SSM Agent is online

All assertions pass **vacuously** when no instances or executions exist (e.g. first deploy).

---

## 2. Pipeline Position

| Attribute | Value |
|---|---|
| **Job name** | `verify-ssm-automation` |
| **Pipeline** | `_deploy-ssm-automation.yml` (Pipeline 2 — bootstrap & runtime) |
| **Depends on** | `trigger-bootstrap` |
| **Container** | `ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest` |
| **Timeout** | 10 minutes |

---

## 3. Bootstrap Roles Tested

| Role | EC2 Tag Value | SSM Doc Param |
|---|---|---|
| Control Plane | `control-plane` | `/k8s/{env}/bootstrap/control-plane-doc-name` |
| App Worker | `app-worker` | `/k8s/{env}/bootstrap/app-worker-doc-name` |
| Mon Worker | `mon-worker` | `/k8s/{env}/bootstrap/mon-worker-doc-name` |
| ArgoCD Worker | `argocd-worker` | `/k8s/{env}/bootstrap/argocd-worker-doc-name` |

---

## 4. Data Fetch Layer (`beforeAll`)

All AWS API calls in `beforeAll`. Zero API calls inside `it()` blocks.

| # | API Call | Purpose |
|---|---|---|
| 1 | `EC2:DescribeInstances` ×4 | Find running instance per `k8s:bootstrap-role` tag |
| 2 | `EC2:DescribeInstanceStatus` ×4 | Get instance + system status checks |
| 3 | `SSM:DescribeInstanceInformation` ×4 | Get SSM Agent ping status |
| 4 | `SSM:GetParameter` ×4 | Resolve automation document name per role |
| 5 | `SSM:DescribeAutomationExecutions` ×4 | Get target instance from latest execution |

---

## 5. Assertions

### Targeting (×4 roles)

| Test | Assertion | Vacuous Condition |
|---|---|---|
| *should have targeted the instance tagged with the correct role* | Automation `InstanceId` == EC2 instance ID | No execution or no instance |

### Health (×4 roles)

| Test | Assertion | Vacuous Condition |
|---|---|---|
| *should have a running EC2 instance* | State == `running` | No instance |
| *should have passing EC2 status checks* | Instance + System status == `ok` | No instance |
| *should have SSM Agent online* | PingStatus == `Online` | No instance |

**Total: 16 tests** (4 targeting + 12 health), all conditional on instance existence.
