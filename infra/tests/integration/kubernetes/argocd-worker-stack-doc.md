# ArgoCD Worker Stack — Integration Test Review

> Pipeline step: `verify-argocd-worker-stack` in [_deploy-kubernetes.yml](../../.github/workflows/_deploy-kubernetes.yml)

---

## 1. Pipeline Position & Execution Mechanics

### Where it runs

| Attribute | Value |
|---|---|
| **Job name** | `verify-argocd-worker-stack` |
| **Depends on** | `deploy-argocd-worker` (ArgoCD worker stack must succeed) |
| **Gates downstream** | `deploy-appiam` (Application-tier IAM grants) |
| **Container** | `ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest` |
| **Timeout** | 10 minutes |

### How it runs

```
just ci-integration-test kubernetes/argocd-worker-stack $CDK_ENV --verbose
```

Expands to:

```bash
cd infra && CDK_ENV=$CDK_ENV npx jest \
  --config jest.integration.config.js \
  --testPathPattern="tests/integration/kubernetes/argocd-worker-stack" \
  --verbose
```

---

## 2. Test File Overview

**File**: `argocd-worker-stack.integration.test.ts`
**Lines**: 485 | **AWS SDK clients**: SSM, EC2, AutoScaling, CloudFormation, ELBv2

### SSM-Anchored Strategy

All resource identifiers are resolved from SSM parameters (`/k8s/<env>/...`) — the same parameters the CDK stack publishes. This guarantees the test validates the *exact* resources the stack created.

---

## 3. What the `beforeAll` Fetches

| # | API Call | Purpose | Timeout |
|---|---|---|---|
| 1 | `SSM:GetParametersByPath` (paginated) | Load all SSM parameters under `/k8s/<env>/` | Part of 120s `beforeAll` |
| 2 | `EC2:DescribeInstances` (with retry) | Find running ArgoCD worker instance by `tag:Name` | Up to 5 attempts × 15s backoff |

---

## 4. Test Assertions (14 tests, 6 describe blocks)

### 4a. EC2 Instance (4 tests)

| Test | Assertion |
|---|---|
| *should have a running argocd-worker instance* | Instance ID defined and starts with `i-` |
| *should be a Spot instance* | `InstanceLifecycle === 'spot'` |
| *should have Source/Dest Check disabled* | `SourceDestCheck === false` (required for Calico) |
| *should have an ASG with min=0, max=1, desired=1* | ASG capacity bounds match expected values |

### 4b. Security Group Attachment (2 tests)

| Test | Assertion |
|---|---|
| *should have Cluster Base SG attached* | SG ID from SSM is in instance's SG list |
| *should have Ingress SG attached* | Ingress SG ID from SSM is in instance's SG list |

### 4c. NLB Target Group Registration (2 tests)

Polls `DescribeTargetHealth` with retry (up to 10 attempts × 15s = ~2.5 min).

| Test | Assertion | Timeout |
|---|---|---|
| *should be registered with the HTTP target group* | Instance ID appears in HTTP TG targets | 180s |
| *should be registered with the HTTPS target group* | Instance ID appears in HTTPS TG targets | 180s |

### 4d. Cluster Base SG — Port Rules (4 tests)

| Test | Assertion |
|---|---|
| *should allow K8s API port 6443/tcp* | Ingress rule exists |
| *should allow kubelet API port 10250/tcp* | Ingress rule exists |
| *should allow VXLAN overlay port 4789/udp* | Ingress rule exists |
| *should allow CoreDNS port 53/udp* | Ingress rule exists |

### 4e. CloudFormation Outputs (2 tests)

| Test | Assertion |
|---|---|
| *should export ArgocdWorkerAsgName* | Output key present |
| *should export ArgocdWorkerInstanceRoleArn* | Output key present |

### 4f. Downstream Readiness (1 test)

Validates that all SSM parameters consumed by the ArgoCD worker stack are present and non-empty: `vpcId`, `securityGroupId`, `ingressSgId`, `kmsKeyArn`, `scriptsBucket`.

---

## 5. Gap Analysis

### Gap 1 — ASG test makes API call inside `it()` (Rule 1)

**Line 306–325**: The `should have an ASG with min=0, max=1, desired=1` test calls `DescribeAutoScalingGroupsCommand` inside the `it()` block. Per Rule 1, shared resources should be fetched in `beforeAll`.

**Impact**: If this test is run alongside other ASG tests in the future, the API call would be redundant. Currently a single test, so the impact is low.

> [!TIP]
> Move the `DescribeAutoScalingGroupsCommand` call into the `EC2 Instance` describe's `beforeAll`.

### Gap 2 — Non-null assertion `!` on line 295, 319, 321, 373, 386, 416, 449, 480 (Rule 2)

Multiple `!` assertions on API-response values:

| Line | Expression |
|---|---|
| 295 | `argocdWorker.instance.InstanceId!.startsWith('i-')` |
| 319 | `AutoScalingGroups!.length` |
| 321 | `AutoScalingGroups![0]` |
| 373, 386 | `argocdWorker.instance.InstanceId!` |
| 416 | `SecurityGroups![0].IpPermissions` |
| 449 | `Stacks![0].Outputs` |
| 480 | `value!.trim().length` |

Per Rule 2, these should use `requireParam`-style guards or be preceded by `expect(...).toBeDefined()` + narrowing. Some (319, 416, 449) are preceded by shape assertions, which is acceptable. Others (295, 373, 386, 480) are not.

### Gap 3 — Port numbers are unnamed constants (Rule 3)

Lines 419–433: Port numbers `6443`, `10250`, `4789`, `53` appear as inline literals. These are used in a single test each (not duplicated), so this is a minor deviation.

### Gap 4 — Cluster Base SG port rule test makes API call inside nested `beforeAll` (acceptable)

Line 409–417: The `DescribeSecurityGroupsCommand` call is in a describe-level `beforeAll`, which is correct per Rule 1. However, it uses `!` on `SecurityGroups![0]` without a preceding shape assertion (see Gap 2).

### Gap 5 — `as Environment` cast (Rule 4)

Line 59: `(process.env.CDK_ENV ?? 'development') as Environment` — same pattern as the SSM Automation test. Should use a `parseEnvironment` validator per Rule 4.

### Gap 6 — NLB polling tests make repeat API calls inside `it()` (Rule 1 deviation)

Lines 372–396: The `waitForTargetRegistration` helper is called inside `it()` blocks for the NLB tests. However, this is **intentional** — each test needs its own polling loop for a specific target group, and the retry behaviour with custom timeouts (180s) justifies the in-test API call. **Not a true violation** — the helper is module-level (Rule 10 compliance) and the polling is test-specific.

---

## 6. Summary

| Category | Assessment |
|---|---|
| **Pipeline gating** | ✅ Correctly gates `deploy-appiam` |
| **SSM-anchored strategy** | ✅ All resource IDs resolved from SSM parameters |
| **Resource caching** | ⚠️ ASG test calls API inside `it()` — should be in `beforeAll` |
| **Non-null assertions** | ⚠️ 8 instances of `!` — some without preceding shape assertion |
| **Named constants** | ⚠️ Port numbers as inline literals |
| **Environment parsing** | ⚠️ `as Environment` cast |
| **Helper scope** | ✅ All helpers at module level |
| **Retry/polling design** | ✅ Well-designed with configurable backoff for Spot instance + NLB registration |
| **Overall** | Solid test with good coverage. Gaps are minor code-quality deviations, not functional issues. |
