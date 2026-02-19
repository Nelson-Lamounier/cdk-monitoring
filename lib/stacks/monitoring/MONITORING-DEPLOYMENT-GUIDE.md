# Monitoring Stack — Production Deployment Guide

> **Last updated:** 2026-02-18
> **Stacks:** `StorageStack` → `SsmStack` → `ComputeStack`
> **Region:** `eu-west-1` | **Account:** `607700977986`

This guide documents the full deployment lifecycle for the monitoring infrastructure (Prometheus, Grafana, Loki, Tempo, Promtail, Node Exporter, GitHub Actions Exporter). It covers architecture, prerequisites, deployment order, KMS encryption, SSM configuration, and troubleshooting lessons learned from production incidents.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites & SSM Parameters](#2-prerequisites--ssm-parameters)
3. [Stack Deployment Order](#3-stack-deployment-order)
4. [KMS EBS Encryption — Permissions & Troubleshooting](#4-kms-ebs-encryption--permissions--troubleshooting)
5. [CloudFormation Signal Timing & User-Data Ordering](#5-cloudformation-signal-timing--user-data-ordering)
6. [Docker Compose Readiness in SSM Documents](#6-docker-compose-readiness-in-ssm-documents)
7. [GitHub Actions Exporter — PAT Token Setup](#7-github-actions-exporter--pat-token-setup)
8. [Smoke Tests](#8-smoke-tests)
9. [Full Pipeline Deployment Checklist](#9-full-pipeline-deployment-checklist)
10. [Troubleshooting Reference](#10-troubleshooting-reference)
11. [Useful Commands](#11-useful-commands)

---

## 1. Architecture Overview

The monitoring stack runs on a **singleton EC2 instance** (Auto Scaling Group with `maxCapacity: 1`) in a public subnet, configured for **SSM-only access** (no SSH, no public ingress). All access to Grafana and Prometheus is via SSM port forwarding.

### Stack Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CDK App (factory.ts)                        │
└─────────────────────────────────────────────────────────────────────┘
        │                    │                      │
        ▼                    ▼                      ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
│ StorageStack │   │    SsmStack       │   │      ComputeStack        │
│              │   │                  │   │                          │
│ • EBS Volume │   │ • SSM Document   │   │ • Launch Template        │
│ • KMS Key    │   │ • S3 Scripts     │   │ • Auto Scaling Group     │
│ • DLM Policy │   │ • IAM Policy     │   │ • Security Group         │
│ • Lifecycle  │   │ • SSM Params     │   │ • SSM Association        │
│   Lambda     │   │                  │   │ • IAM Roles/Permissions  │
└──────────────┘   └──────────────────┘   └──────────────────────────┘
        │                    │                      │
        │          SSM Discovery Parameters         │
        └─────────────────── ↑ ─────────────────────┘
                    (no cross-stack exports)
```

### Container Services (docker-compose)

| Service                     | Port                     | Purpose                       |
| --------------------------- | ------------------------ | ----------------------------- |
| **Prometheus**              | 9090                     | Metrics collection & alerting |
| **Grafana**                 | 3000                     | Visualization & dashboards    |
| **Loki**                    | 3100                     | Log aggregation               |
| **Tempo**                   | 3200 (HTTP), 4317 (gRPC) | Distributed tracing           |
| **Promtail**                | 9080                     | Log shipping to Loki          |
| **Node Exporter**           | 9100                     | Host metrics                  |
| **GitHub Actions Exporter** | 9101                     | CI/CD pipeline metrics        |

---

## 2. Prerequisites & SSM Parameters

Before deploying the monitoring stack to production, ensure these SSM parameters exist:

### Required SSM Parameters

| Parameter Path                       | Type   | Purpose           | Created By                                 |
| ------------------------------------ | ------ | ----------------- | ------------------------------------------ |
| `/{prefix}/ssm/document-name`        | String | SSM document name | SsmStack                                   |
| `/{prefix}/ssm/scripts-bucket-name`  | String | S3 scripts bucket | SsmStack                                   |
| `/{prefix}/ssm/execution-policy-arn` | String | IAM policy ARN    | SsmStack                                   |
| `/{prefix}/loki/endpoint`            | String | Loki push URL     | ComputeStack (placeholder), SSM doc (real) |
| `/{prefix}/tempo/endpoint`           | String | Tempo OTLP URL    | ComputeStack (placeholder), SSM doc (real) |
| `/{prefix}/security-group/id`        | String | Monitoring SG ID  | ComputeStack                               |

> **Note:** `{prefix}` = `monitoring-production` for prod, `monitoring-development` for dev.

### Manual Prerequisites (one-time setup)

| Parameter Path                              | Type         | Purpose                              | How to Create                                                |
| ------------------------------------------- | ------------ | ------------------------------------ | ------------------------------------------------------------ |
| `/{prefix}/github/api-token`                | SecureString | GitHub PAT for Actions Exporter      | See [Section 7](#7-github-actions-exporter--pat-token-setup) |
| `/{prefix}/prometheus/metrics-bearer-token` | SecureString | Bearer token for Prometheus scraping | Auto-created by SSM Document                                 |

### Environment Variables / Secrets

| Name                     | Source                  | Used By                        |
| ------------------------ | ----------------------- | ------------------------------ |
| `GRAFANA_ADMIN_PASSWORD` | GitHub Actions secret   | SSM document → `.env` file     |
| `AWS_OIDC_ROLE`          | GitHub Actions secret   | OIDC federation for deployment |
| `AWS_ACCOUNT_ID`         | GitHub Actions variable | CDK synthesis                  |

---

## 3. Stack Deployment Order

Stacks must be deployed in dependency order:

```
1. StorageStack  →  Creates EBS volume + KMS key
2. SsmStack      →  Creates SSM document + S3 scripts + IAM policy
3. ComputeStack  →  Creates ASG/EC2 (depends on StorageStack + SsmStack)
```

The **ComputeStack** has explicit `addDependency()` on both `StorageStack` and `SsmStack`. The pipeline workflow (`_deploy-monitoring.yml`) deploys them in the correct order.

> [!IMPORTANT]
> If you change the **SSM document** (e.g., Docker readiness logic), you must redeploy the **SsmStack** before the ComputeStack for changes to take effect.

---

## 4. KMS EBS Encryption — Permissions & Troubleshooting

### Background

Production uses a **customer-managed KMS key** (`createKmsKeys: true`) for EBS volume encryption. The `StorageStack` creates this key and passes it to `ComputeStack` via the factory:

```typescript
// factory.ts
const computeStack = new MonitoringComputeStack(scope, id, {
  ebsEncryptionKey: storageStack.encryptionKey, // KMS key ref
  // ...
});
```

### Required KMS Permissions

The EC2 instance role needs these KMS permissions to **attach an encrypted EBS volume**:

| Permission                            | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `kms:CreateGrant`                     | Required by EC2 to delegate decryption to the EBS subsystem |
| `kms:Decrypt`                         | Decrypt the volume's data encryption key                    |
| `kms:DescribeKey`                     | Validate the key exists and is enabled                      |
| `kms:GenerateDataKeyWithoutPlaintext` | Generate wrapped DEK for new writes                         |
| `kms:ReEncryptFrom`                   | Re-encrypt data during volume operations                    |
| `kms:ReEncryptTo`                     | Re-encrypt data during volume operations                    |

These are granted conditionally in `compute-stack.ts`:

```typescript
if (props.ebsEncryptionKey) {
  props.ebsEncryptionKey.grant(
    this.instanceRole,
    "kms:CreateGrant",
    "kms:Decrypt",
    "kms:DescribeKey",
    "kms:GenerateDataKeyWithoutPlaintext",
    "kms:ReEncryptFrom",
    "kms:ReEncryptTo",
  );
}
```

### Incident: `CREATE_FAILED` — Missing KMS Permissions

**Symptom:** ASG CREATE_FAILED, CloudFormation receives 0/1 SUCCESS signals.

**Root Cause:** The user-data script's `attachEbsVolume()` step failed because the instance role did not have `kms:CreateGrant` permission on the customer-managed KMS key. Without this, the EC2 API returns:

```
VolumeInUse / Client.CustomerKeyHasBeenRevoked:
Volume vol-xxx is encrypted with KMS key arn:aws:kms:...,
which is not accessible.
```

**Why `kms:CreateGrant` is critical:** When EC2 attaches an encrypted EBS volume, it creates a KMS grant to delegate cryptographic operations to the EBS subsystem. This is an AWS-internal mechanism — EC2 needs `kms:CreateGrant` to set this up, even though the actual decryption happens inside EBS.

**Fix:** Added KMS permissions via `key.grant()` (see code above). Committed as:

```
fix(compute): grant KMS permissions for encrypted EBS volume attachment
```

> [!CAUTION]
> Development environments with `createKmsKeys: false` use the **AWS-managed EBS key** (`aws/ebs`), which does not require explicit `kms:CreateGrant`. This means KMS permission issues only surface in production.

### Verification

After deploying the fix, verify the EBS volume attachment works:

```bash
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "AWS-RunShellScript" \
  --parameters '{"commands":["lsblk","mountpoint -q /data && echo mounted || echo NOT mounted","df -h /data"]}' \
  --region eu-west-1 --profile prod-account
```

---

## 5. CloudFormation Signal Timing & User-Data Ordering

### User-Data Execution Order

The user-data script is built via `UserDataBuilder` with a deliberate ordering:

```
1. updateSystem()         — dnf update
2. installAwsCli()        — AWS CLI v2
3. attachEbsVolume()      — Attach + mount encrypted EBS to /data
4. sendCfnSignal()        — Tell CloudFormation "I'm healthy" ← SIGNAL HERE
5. installDocker()        — dnf install docker + Compose v2 plugin
6. addCompletionMarker()  — Success banner
```

### Why cfn-signal is BEFORE Docker Install

```typescript
// compute-stack.ts — ORDERING comment
// cfn-signal is sent after critical infrastructure
// (system update, AWS CLI, EBS attach) but BEFORE Docker install.
// This prevents Docker/dnf failures from blocking the cfn-signal,
// which would cause CREATE_FAILED with 0 SUCCESS signals.
```

**Rationale:** Docker installation can fail (network issues, dnf mirror down). If `sendCfnSignal()` were after `installDocker()`, a Docker install failure would prevent the signal from ever being sent, causing CloudFormation to wait until timeout (default 15 min) and then roll back the entire stack — including the EBS volume attachment that succeeded.

By placing `sendCfnSignal` after the critical infrastructure steps (system update, AWS CLI, EBS mount) but before Docker, we ensure:

- ✅ CloudFormation considers the stack healthy after EBS is attached
- ✅ Docker install failures don't cause stack rollback
- ⚠️ The SSM Association must handle the Docker readiness gap (see Section 6)

### How Application Configuration Happens

Application setup (downloading docker-compose, starting containers) is **NOT** done in user-data. Instead, it's handled by the **SSM State Manager Association**:

```typescript
// compute-stack.ts
new ssm.CfnAssociation(this, 'SsmConfigAssociation', {
    name: ssmDocumentName,
    targets: [{ key: 'tag:aws:autoscaling:groupName', values: [...] }],
    applyOnlyAtCronInterval: false,  // Run immediately on registration
});
```

When the instance registers with SSM Agent (after cfn-signal), the Association fires and runs the SSM document which:

1. Downloads monitoring stack from S3
2. Configures `.env` file with Grafana password + metrics token
3. Waits for Docker + Compose to be ready
4. Runs `docker compose up -d`
5. Registers Loki/Tempo endpoints in SSM
6. Configures GitHub Actions exporter (if token exists)

---

## 6. Docker Compose Readiness in SSM Documents

### Incident: `docker compose up -d` — "unknown shorthand flag: 'd'"

**Symptom:** SSM document's `StartMonitoringStack` step succeeds at detecting Docker, but `docker compose up -d` fails with:

```
unknown shorthand flag: 'd' in -d
```

**Root Cause:** The Docker readiness loop only checked for:

```bash
until command -v docker && docker info; do ...
```

This passed as soon as `dnf install -y docker` completed, but the **Docker Compose v2 plugin** (downloaded from GitHub via curl in `installDocker()`) had not been installed yet. Without the Compose plugin, `docker compose` is not a valid Docker subcommand, and Docker interprets `compose` incorrectly.

**Timeline of the race condition:**

```
T=0     User-data starts
T=30s   EBS attached, cfn-signal sent
T=35s   SSM Association fires (instance registered with SSM Agent)
T=40s   SSM document starts, begins Docker wait loop
T=45s   dnf install docker completes → 'command -v docker' passes
T=45s   'docker info' passes → Docker wait loop exits
T=45s   'docker compose up -d' FAILS — Compose plugin not installed yet
T=55s   user-data finishes downloading Compose plugin from GitHub (too late)
```

**Fix:** Updated the wait condition in `ssm-stack.ts` to also check for Compose:

```bash
# Before (broken):
until command -v docker && docker info; do

# After (fixed):
until command -v docker && docker info && docker compose version; do
```

Also increased timeout from 180s → 300s to account for Compose download time.

**Committed as:**

```
fix(ssm): wait for Docker Compose plugin before starting monitoring stack
```

> [!WARNING]
> If you modify the SSM document in `ssm-stack.ts`, you must redeploy the SsmStack (`yarn cli deploy -p monitoring -s ssm`) for the updated document to be published. Then either re-run the SSM Association or deploy a fresh ComputeStack.

---

## 7. GitHub Actions Exporter — PAT Token Setup

### Overview

The `github-actions-exporter` container polls the GitHub API for workflow run metrics and exposes them as Prometheus metrics on port `9101`. It requires a GitHub Personal Access Token (PAT) to authenticate.

### Incident: Container Restart Loop — Missing Token

**Symptom:** Smoke tests report `1 container(s) in restart loop`. Prometheus shows `github-actions` target DOWN.

**Container logs:**

```
authenticating with Github App
Error: Client creation failed.authentication failed:
could not read private key: open : no such file or directory
```

**Root Cause:** The `docker-compose.yml` passes `GITHUB_TOKEN=${GITHUB_TOKEN:-}` to the container. The SSM document's Step 5 (`ConfigureGitHubActionsExporter`) fetches the token from SSM parameter `/{prefix}/github/api-token` and writes it to `.env`. However, **the SSM parameter did not exist in production**, so:

1. `GITHUB_TOKEN=""` was written to `.env`
2. The exporter received an empty token
3. It fell back to **GitHub App authentication** (which requires a private key file)
4. No private key file exists → crash → restart loop

### Fix: Create the SSM Parameter

1. **Generate a GitHub PAT** (Fine-grained token or Classic):
   - Go to **GitHub → Settings → Developer settings → Personal access tokens**
   - **Fine-grained token** (recommended):
     - Repository access: `Nelson-Lamounier/cdk-monitoring`, `Nelson-Lamounier/PortfolioWebsite`
     - Permissions: `Actions` → **Read-only**
   - **Classic token** (alternative):
     - Scope: `repo` (or `public_repo` for public repos)

2. **Store the token in SSM Parameter Store:**

   ```bash
   aws ssm put-parameter \
     --name "/monitoring-production/github/api-token" \
     --value "github_pat_XXXXXXXXXXXX" \
     --type SecureString \
     --region eu-west-1 \
     --profile prod-account
   ```

3. **Restart the exporter** (or re-run the SSM document):

   ```bash
   aws ssm send-command \
     --instance-ids "<instance-id>" \
     --document-name "monitoring-production-configure-monitoring-stack" \
     --region eu-west-1 --profile prod-account
   ```

4. **Verify** the container is running with PAT authentication:

   ```bash
   # Check container logs
   docker logs github-actions-exporter --tail 5
   # Expected: "authenticating with Github Token" (NOT "Github App")
   ```

### IAM Permissions

The SSM execution policy already includes `ssm:GetParameter` for the GitHub token path:

```typescript
// ssm-stack.ts
new iam.PolicyStatement({
  sid: "SsmReadGitHubToken",
  actions: ["ssm:GetParameter"],
  resources: [
    `arn:aws:ssm:${this.region}:${this.account}:parameter/${namePrefix}/github/api-token`,
  ],
});
```

### Token Rotation

When the PAT expires, update the SSM parameter and re-run the SSM document:

```bash
aws ssm put-parameter \
  --name "/monitoring-production/github/api-token" \
  --value "github_pat_NEW_TOKEN_HERE" \
  --type SecureString \
  --overwrite \
  --region eu-west-1 --profile prod-account

# Re-run SSM document to pick up new token
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "monitoring-production-configure-monitoring-stack" \
  --region eu-west-1 --profile prod-account
```

---

## 8. Smoke Tests

The smoke test script (`scripts/monitoring/smoke-test.sh`) validates the monitoring stack across 6 categories:

| Category                     | Checks                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| **1. Container Health**      | All 7 containers running (github-actions-exporter is optional)             |
| **2. HTTP Endpoints**        | Grafana, Prometheus, Loki, Tempo, Node Exporter, Promtail respond with 200 |
| **3. Grafana Validation**    | 4+ datasources connected, 9+ dashboards provisioned                        |
| **4. Prometheus Validation** | Targets UP, scrape jobs active, alert rules loaded, query API functional   |
| **5. Data Pipeline**         | Loki log streams, Promtail targets, Tempo status                           |
| **6. Infrastructure**        | EBS mount, disk usage, Docker health, no restart loops                     |

### Expected Healthy Output

```
Results: 36 passed, 0 failed, 1 warnings
All smoke tests passed!
```

The `github-actions` Prometheus target warning is expected during initial deployment (the exporter may be rate-limited by GitHub API).

### Running Smoke Tests Manually

```bash
# Via SSM Run Command
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "AWS-RunShellScript" \
  --parameters '{"commands":["aws s3 cp s3://monitoring-production-scripts-607700977986-eu-west-1/smoke-test.sh /tmp/smoke-test.sh && chmod +x /tmp/smoke-test.sh && /tmp/smoke-test.sh"]}' \
  --timeout-seconds 600 \
  --region eu-west-1 --profile prod-account

# Check results
aws ssm get-command-invocation \
  --command-id "<command-id>" \
  --instance-id "<instance-id>" \
  --region eu-west-1 --profile prod-account
```

---

## 9. Full Pipeline Deployment Checklist

### First-Time Production Deployment

- [ ] **VPC exists**: Shared VPC named `shared-vpc-production` is deployed
- [ ] **KMS key awareness**: Production uses customer-managed KMS for EBS encryption
- [ ] **GitHub Secrets configured**: `AWS_OIDC_ROLE`, `GRAFANA_ADMIN_PASSWORD`
- [ ] **GitHub Variables configured**: `AWS_ACCOUNT_ID`
- [ ] **SSM parameter created**: `/monitoring-production/github/api-token` with valid PAT
- [ ] Deploy **StorageStack**: Creates EBS volume + KMS key
- [ ] Deploy **SsmStack**: Creates SSM document + S3 scripts bucket
- [ ] Deploy **ComputeStack**: Creates ASG/EC2, triggers SSM Association
- [ ] **Wait for SSM Association** to complete (~2-5 min after instance launch)
- [ ] **Run smoke tests** to validate all services

### Subsequent Deployments

- [ ] Push changes to `main` branch (triggers `deploy-monitoring-prod.yml`)
- [ ] Pipeline runs: Synthesis → Security Scan → Storage → SSM → Compute → Smoke Tests
- [ ] Verify pipeline completes with all smoke tests passing

### After SSM Document Changes

When modifying `ssm-stack.ts` (e.g., Docker readiness, new SSM steps):

- [ ] Deploy **SsmStack** to publish updated document
- [ ] Either:
  - [ ] Re-run SSM Association on existing instance, OR
  - [ ] Deploy **ComputeStack** to trigger fresh instance with new SSM config

---

## 10. Troubleshooting Reference

### Problem: ASG `CREATE_FAILED` — 0/1 SUCCESS Signals

| Check                       | Command                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| View user-data log          | `aws ssm send-command ... '{"commands":["cat /var/log/user-data.log"]}'` |
| Check EBS attachment        | `aws ssm send-command ... '{"commands":["lsblk","df -h /data"]}'`        |
| Check CloudFormation events | `aws cloudformation describe-stack-events --stack-name <stack>`          |

**Common causes:**

- Missing KMS permissions for encrypted EBS → See [Section 4](#4-kms-ebs-encryption--permissions--troubleshooting)
- EBS volume in wrong AZ → Verify `volumeAz` matches subnet
- Security group blocking IMDS → Ensure IMDS v2 is accessible

### Problem: Services Not Starting (Smoke Test Timeout)

| Check                     | Command                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| Docker status             | `systemctl is-active docker`                                                      |
| Docker Compose available? | `docker compose version`                                                          |
| Container status          | `docker ps -a`                                                                    |
| SSM Association status    | `aws ssm list-associations --association-filter-list "key=Name,value=<doc-name>"` |

**Common causes:**

- Docker Compose plugin not installed → See [Section 6](#6-docker-compose-readiness-in-ssm-documents)
- SSM Association hasn't run yet → Wait 2-5 min after instance launch
- S3 scripts not accessible → Check instance role has `s3:GetObject` permission

### Problem: Container in Restart Loop

| Check                | Command                                                 |
| -------------------- | ------------------------------------------------------- |
| Which container?     | `docker ps -a --format "table {{.Names}}\t{{.Status}}"` |
| Container logs       | `docker logs <container-name> --tail 30`                |
| `.env` file contents | `cat /opt/monitoring/.env`                              |

**Common causes:**

- `github-actions-exporter` → Missing/invalid GitHub PAT → See [Section 7](#7-github-actions-exporter--pat-token-setup)
- `grafana` → Missing `GRAFANA_ADMIN_PASSWORD` in `.env`
- `loki`/`tempo` → Data directory permissions on `/data`

### Problem: Grafana Datasource Connectivity Failed

| Check                | Command                                                          |
| -------------------- | ---------------------------------------------------------------- |
| Service ports        | `docker ps --format "table {{.Names}}\t{{.Ports}}"`              |
| Network connectivity | `docker exec grafana wget -qO- http://prometheus:9090/-/healthy` |
| Docker network       | `docker network inspect monitoring_monitoring`                   |

### Problem: SSM Association Not Triggering

```bash
# Check association status
aws ssm describe-association \
  --association-id "<association-id>" \
  --region eu-west-1 --profile prod-account

# Manually trigger SSM document
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "monitoring-production-configure-monitoring-stack" \
  --region eu-west-1 --profile prod-account
```

---

## 11. Useful Commands

### SSM Port Forwarding (Access Grafana Locally)

```bash
aws ssm start-session \
  --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}' \
  --region eu-west-1 --profile prod-account

# Then open http://localhost:3000 in your browser
```

### Check Instance Status

```bash
# Find instance ID from ASG
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "monitoring-production-asg" \
  --query "AutoScalingGroups[0].Instances[0].InstanceId" \
  --output text --region eu-west-1 --profile prod-account

# Check SSM connectivity
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=<instance-id>" \
  --region eu-west-1 --profile prod-account
```

### Re-Run SSM Document (Reconfigure Stack)

```bash
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "monitoring-production-configure-monitoring-stack" \
  --region eu-west-1 --profile prod-account
```

### View All Container Logs

```bash
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "AWS-RunShellScript" \
  --parameters '{"commands":["docker ps -a","docker compose -f /opt/monitoring/docker-compose.yml logs --tail 20"]}' \
  --region eu-west-1 --profile prod-account
```

### Force EBS Volume Reattachment

```bash
aws ssm send-command \
  --instance-ids "<instance-id>" \
  --document-name "AWS-RunShellScript" \
  --parameters '{"commands":["lsblk","df -h /data","cat /var/log/user-data.log | grep -i ebs"]}' \
  --region eu-west-1 --profile prod-account
```
