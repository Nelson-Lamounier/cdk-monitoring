---
title: "Kubernetes Bootstrap System Scripts"
doc_type: implementation
domain: kubernetes
tags:
  - bootstrap
  - argocd
  - tls
  - etcd
  - disaster-recovery
  - python
  - shell
  - ssm
  - deploy-helpers
  - certificate
  - troubleshooting
related_docs:
  - kubernetes/bootstrap-pipeline.md
  - kubernetes/adrs/argocd-over-flux.md
  - kubernetes/runbooks/instance-terminated.md
  - operations/ci-cd-implementation.md
last_updated: "2026-04-10"
author: Nelson Lamounier
status: accepted
---

# Kubernetes Bootstrap System Scripts

**Date:** 2026-03-25
**Audience:** Developer
**Style:** Implementation Walkthrough

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Boot Scripts — Modular Architecture](#boot-scripts--modular-architecture-boot)
4. [Component Reference](#component-reference)
5. [Language Decisions](#language-decisions)
6. [IAM Requirements](#iam-requirements)
7. [Local Development Setup](#local-development-setup)
8. [Test Suites](#test-suites)
9. [Deploy Helpers Framework](#deploy-helpers-framework-deploy_helpers)
10. [Application Deploy Scripts](#application-deploy-scripts)
11. [Source Files](#source-files)

## Overview

The `kubernetes-app/k8s-bootstrap/system/` directory contains day-1 infrastructure scripts and Kubernetes manifests deployed to the control plane via S3 → SSM RunCommand. These scripts execute **before** ArgoCD can reconcile, bridging the gap between a bare EC2 instance and a fully operational Kubernetes cluster.

The system comprises four subsystems:

- **ArgoCD Bootstrap** — installs the GitOps engine (vendored manifests, App-of-Apps pattern)
- **TLS Certificate Persistence** — backs up and restores Let's Encrypt certificates across instance replacements
- **Disaster Recovery** — automated hourly etcd snapshots to S3 with server-side encryption
- **systemd Timer Management** — installs and enables the etcd backup timer on the control plane

## Architecture

### Bootstrap Execution Order

The SSM Automation document executes these steps in sequence on the control plane EC2 instance:

```text
1. persist-tls-cert.py --restore     → Restore TLS certs from SSM Parameter Store
2. bootstrap-argocd.sh               → Install ArgoCD + root Applications
3. install-etcd-backup-timer.sh      → Enable hourly etcd backup timer
4. persist-tls-cert.py --backup      → Back up newly issued certificates to SSM
```

All steps are idempotent — safe to re-run without side effects. The scripts are synced from S3 at the start of each SSM Automation execution via `aws s3 sync`.

## Boot Scripts — Modular Architecture (`boot/`)

The `kubernetes-app/k8s-bootstrap/boot/` directory contains the core node
bootstrap scripts executed by SSM Automation. These were refactored from two
monolithic files (`control_plane.py` at 1,431 lines, `worker.py` at 641 lines)
into independently testable step modules.

### Package Structure

```text
boot/steps/
├── boot_helpers/config.py    # BootConfig dataclass — env var consolidation
├── common.py                 # StepRunner, logging, AMI validation
├── cp/                       # 10 control plane step modules
│   ├── ebs_volume.py         # Format + mount launch-template data volume
│   ├── dr_restore.py         # Restore etcd snapshot + certs from S3
│   ├── kubeadm_init.py       # kubeadm init + DNS + cert backup
│   ├── calico.py             # Install Calico CNI
│   ├── ccm.py                # AWS Cloud Controller Manager (Helm)
│   ├── kubectl_access.py     # Configure kubectl for ubuntu / root
│   ├── s3_sync.py            # Sync manifests from S3
│   ├── argocd.py             # Trigger ArgoCD bootstrap
│   ├── verify.py             # Cluster health verification
│   └── etcd_backup.py        # Install etcd backup systemd timer
├── wk/                       # 3 worker step modules
│   ├── join_cluster.py       # kubeadm join with CA re-join logic
│   ├── eip.py                # Associate Elastic IP
│   └── stale_pvs.py          # Clean stale PersistentVolumes
├── control_plane.py          # SSM entry point (delegates to cp.main())
└── worker.py                 # SSM entry point (delegates to wk.main())
```

### BootConfig Dataclass

All environment variables scattered across the original monoliths are now
consolidated into `boot_helpers/config.py`:

```python
from boot_helpers.config import BootConfig
cfg = BootConfig.from_env()
print(cfg.ssm_prefix)   # /k8s/development
```

Key fields: `ssm_prefix`, `aws_region`, `k8s_version`, `data_dir`, `pod_cidr`,
`service_cidr`, `api_dns_name`, `s3_bucket`, `calico_version`,
`environment`, `join_max_retries`, `join_retry_interval`.

### Import Collision Resolution

Both `system/argocd/helpers/config.py` (exporting `Config`) and the boot
`helpers/config.py` (exporting `BootConfig`) created a Python module name
collision. Fix: the boot version was renamed to `boot_helpers/`, eliminating
the ambiguity. The `pyproject.toml` pythonpath now safely includes both
`system/argocd` and `boot/steps`.

### Idempotency

Every step uses the `StepRunner` context manager which creates marker files
under `/var/run/k8s-bootstrap/` (e.g. `step-03-kubeadm-init.done`). Steps
are skipped on retry if the marker exists; markers are removed on failure.

### Boot Test Suite (35 Tests)

Located at `tests/boot/`, fully mocked and runs offline in ~0.1 seconds:

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test_config.py` | 7 | BootConfig defaults, env overrides, properties |
| `test_ebs_volume.py` | 11 | NVMe device resolution, volume state, format + mount |
| `test_join_cluster.py` | 9 | CA hash, CA mismatch + reset, endpoint resolution |
| `test_stale_pvs.py` | 8 | Node discovery, stale PV detection, error handling |

### Data Flow

```text
┌──────────────┐     S3 sync      ┌───────────────────┐
│  S3 Bucket   │ ──────────────── │  Control Plane    │
│  /k8s-       │                  │  EC2 Instance     │
│  bootstrap/  │                  │                   │
└──────────────┘                  │  /data/k8s-       │
                                  │  bootstrap/       │
                                  │  system/          │
                                  └───────────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
            persist-tls-cert.py  bootstrap-argocd.sh  etcd-backup.sh
                    │                    │                    │
                    ▼                    ▼                    ▼
            SSM Parameter Store   kubectl apply        S3 dr-backups/
            (SecureString)        (vendored YAML)      (AES256 SSE)
```

## Component Reference

### ArgoCD Bootstrap (`system/argocd/`)

| File | Purpose |
|------|---------|
| `bootstrap_argocd.py` | Python orchestrator: apply vendored manifests → wait for rollout → configure admin credentials → create root Applications |
| `bootstrap-argocd.sh` | SSM RunCommand entry point — sources `/etc/profile.d/k8s-env.sh` and invokes the Python orchestrator |
| `install.yaml` | Pinned, vendored ArgoCD manifests (~1.8 MB). Vendored because the cluster has no ingress or DNS at bootstrap time |
| `platform-root-app.yaml` | Root Application targeting `platform/` Helm charts (Prometheus, Grafana, Loki, Tempo, Traefik) |
| `workloads-root-app.yaml` | Root Application targeting `workloads/` Helm charts (portfolio site, APIs) |
| `default-project.yaml` | Default AppProject with restricted permissions |
| `repo-secret.yaml` | Templated GitHub repository credentials |
| `ingress.yaml` | Traefik IngressRoute for ArgoCD UI |
| `webhook-ingress.yaml` | Traefik IngressRoute for GitHub webhook receiver |

### TLS Certificate Persistence (`system/cert-manager/`)

| File | Purpose |
|------|---------|
| `persist-tls-cert.py` | Backs up Kubernetes TLS Secrets to SSM SecureString parameters; restores them on the next bootstrap before cert-manager starts |
| `cluster-issuer.yaml` | Let's Encrypt ACME ClusterIssuer (production and staging endpoints) |
| `ops-certificate.yaml` | Wildcard Certificate resource for `*.ops.<domain>` |

**Backup workflow:** `kubectl get secret → jsonpath data → boto3 ssm put_parameter (SecureString)`

**Restore workflow:** `boto3 ssm get_parameter → tempfile write → kubectl create secret`

Supports both `kubernetes.io/tls` and `Opaque` Secret types (the latter for ACME account keys).

### Disaster Recovery (`system/dr/`)

| File | Purpose |
|------|---------|
| `etcd-backup.sh` | Takes an etcd snapshot via `etcdctl` (with container fallback via `crictl`), verifies with `etcdutl`, uploads to S3 with `--sse AES256`, prunes backups older than 168 snapshots (7 days × 24 hourly) |
| `install-etcd-backup-timer.sh` | Creates a systemd service and timer unit, enables with `Persistent=true` and `RandomizedDelaySec=300` |

**Snapshot path:** `/var/lib/etcd/snapshots/` — uses the host-visible path because kubeadm's etcd static pod mounts `/var/lib/etcd` as a hostPath volume. This ensures the host's `aws s3 cp` command can read the snapshot file created by the containerised `etcdctl`.

**S3 layout:**

```text
s3://<bucket>/dr-backups/etcd/
├── 20260325-100609.db        # Timestamped snapshots
├── 20260325-110612.db
└── latest.db                 # In-bucket copy of the most recent snapshot
```

### Supporting Manifests

| File | Purpose |
|------|---------|
| `argocd-notifications/notifications-cm.yaml` | Slack and GitHub notification templates for ArgoCD sync events |
| `traefik/traefik-values.yaml` | Helm values: DaemonSet mode, hostNetwork, Prometheus metrics, OTLP tracing to Tempo |
| `priority-classes.yaml` | `system-critical` and `workload-standard` PriorityClass definitions |

## Language Decisions

### Python for `persist-tls-cert.py` and `bootstrap_argocd.py`

- `boto3` SDK provides structured AWS API calls with typed error codes (`ParameterNotFound`, `AccessDeniedException`) via `botocore.exceptions.ClientError`
- JSON parsing and base64 encoding for Kubernetes Secret data payloads
- `try/except` error handling is more robust than shell exit code inspection
- Functions are unit-testable with `pytest` and `unittest.mock`

### Shell for `etcd-backup.sh` and `install-etcd-backup-timer.sh`

- System-level tool orchestration: `systemctl`, `crictl`, `etcdctl`, `etcdutl`, `aws s3 cp`
- Heredoc syntax for inline systemd unit file generation
- More portable in container and static pod execution environments
- No Python runtime dependency for the etcd backup critical path

## IAM Requirements

The control plane instance role (`control-plane-stack.ts`) requires:

| Permission | Resource Pattern | Purpose |
|---|---|---|
| `s3:GetObject` | `<bucket>/*` | Download bootstrap scripts from S3 |
| `s3:PutObject` | `<bucket>/dr-backups/*` | Upload etcd snapshots |
| `s3:DeleteObject` | `<bucket>/dr-backups/*` | Prune old snapshots |
| `ssm:PutParameter` | `/k8s/*/tls/*` | Store TLS certificate backups |
| `ssm:GetParameter` | `/k8s/*/tls/*` | Restore TLS certificates at bootstrap |
| `secretsmanager:GetSecretValue` | `k8s/*` | Crossplane cloud credentials |

## Local Development Setup

### Python Environment

```bash
cd kubernetes-app/k8s-bootstrap
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

The `[dev]` extra from `pyproject.toml` installs: `pytest`, `pytest-mock`, `pyyaml`, `ruff`.

### justfile Recipes

| Recipe | Purpose |
|--------|---------|
| `just bootstrap-pytest <args>` | Run pytest from the k8s-bootstrap package root |
| `just bootstrap-sync` | Upload local scripts to S3 |
| `just bootstrap-pull <instance-id>` | Pull scripts from S3 onto an instance via SSM |
| `just cert-test <instance-id>` | Dry-run TLS cert persistence on an instance |
| `just etcd-test <instance-id> [run]` | Check prerequisites or execute a full etcd backup |
| `just deploy-test-local` | Run 35 mocked deploy unit tests locally |
| `just deploy-test-live <id> <app>` | SSM RunCommand test on live instance (dry-run default) |

## Test Suites

### System Tests (`tests/system/`) — 55 Tests

The test suite runs fully offline — no AWS credentials or Kubernetes cluster required.

#### `test_persist_tls_cert.py` — 15 Unit Tests

Tests the Python TLS certificate persistence script using mocked `subprocess.run` (kubectl) and `boto3` (SSM) calls.

**Coverage areas:**
- SSM parameter path construction (prefix and secret name)
- Backup: success, secret not found, dry-run mode, empty data, SSM `ClientError`
- Restore: secret already exists, dry-run mode, TLS type success, Opaque type success, SSM `ParameterNotFound`
- Missing fields: `tls.crt`, `tls.key`, empty data object

**Key implementation detail:** The script's hyphenated filename (`persist-tls-cert.py`) cannot be imported via standard Python `import`. Tests use `importlib.util.spec_from_file_location()` to load it dynamically.

#### `test_dr_scripts.py` — 40 Static Validation Tests

Validates shell scripts and YAML manifests without execution.

**Shell script validation:**
- `bash -n` syntax checking (catches typos without executing the script)
- `set -euo pipefail` strict mode assertion
- Content assertions: host-visible snapshot paths, S3 SSE encryption flags, etcdctl resolution function, etcd certificate validation, cleanup logic

**YAML manifest validation:**
- `yaml.safe_load_all()` parseability for all `.yaml` files under `system/`
- Kubernetes `kind` field presence (Helm values files are excluded via heuristic detection)
- systemd unit creation in timer installer script

### Boot Tests (`tests/boot/`) — 35 Tests

Fully mocked unit tests for the node bootstrap step modules. See the Boot Scripts section above for details.

### Deploy Tests (`tests/deploy/`) — 35 Tests

Fully mocked unit tests for the `deploy_helpers` framework and app-specific deployment scripts. All tests use `unittest.mock` to simulate AWS/K8s environments — no credentials or cluster required.

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test_config.py` | 10 | `DeployConfig` defaults, environment variable overrides, banner output |
| `test_k8s.py` | 7 | Namespace creation (idempotent), secret upsert (create and replace), base64 encoding |
| `test_ssm.py` | 7 | SSM parameter resolution, env override detection, placeholder filtering, error handling |
| `test_nextjs_deploy.py` | 11 | `NextjsConfig` derivation, DynamoDB/Bedrock fallback, assets bucket override |

**Key testing patterns:**
- `@patch.dict(os.environ, ...)` to inject environment variables without leaking state
- `unittest.mock.MagicMock` simulating `boto3.client("ssm")` and `kubernetes.client.CoreV1Api`
- `importlib.util.spec_from_file_location` to load the nextjs `deploy.py` module across the monorepo directory boundary

### Running Tests

```bash
# All 135 tests across all suites
just bootstrap-pytest

# System tests only (~4 seconds)
just bootstrap-pytest tests/system/

# Boot tests only (~0.1 seconds)
just bootstrap-pytest tests/boot/

# Deploy tests only (~0.04 seconds)
just deploy-test-local

# Single test by name
just bootstrap-pytest tests/deploy/ -k "test_dynamodb_bedrock_fallback"
```

### CI Integration

The `test-k8s-bootstrap` job in `ci.yml` runs the full 135-test Python suite on every PR:

1. Installs `pyproject.toml[dev]` dependencies into the CI venv
2. Executes `just bootstrap-pytest` (fully offline, all calls mocked)
3. Reports results to the CI summary and failure-check gate

Run via: `just ci-bootstrap-pytest`

## Deploy Helpers Framework (`deploy_helpers/`)

The `deploy_helpers/` package provides a shared framework for application-level Kubernetes secret deployment scripts. It was refactored from duplicated logic across `nextjs/deploy.py` (408 lines) and `monitoring/deploy.py` (343 lines), reducing total lines by ~40% while improving observability and testability.

### Motivation

Before the refactoring, both deploy scripts independently implemented:
- SSM Parameter Store resolution with environment overrides
- Kubernetes namespace creation and secret upsert logic
- S3 sync for re-pulling manifests before deployment
- Configuration from environment variables
- Subprocess execution with error handling

This led to ~200 lines of duplicated code, inconsistent error handling, and no structured logging.

### Package Structure

```text
deploy_helpers/
├── __init__.py       # Package docstring and exports
├── bff.py            # BFF service URL resolution (admin-api + public-api)
├── config.py         # DeployConfig base dataclass
├── logging.py        # Structured JSON logging (CloudWatch-friendly)
├── runner.py         # Subprocess wrapper with timing and exit codes
├── ssm.py            # SSM Parameter Store secret resolution
├── k8s.py            # Kubernetes namespace and secret idempotent operations
└── s3.py             # S3 sync wrapper for manifest re-pull
```

### Module Reference

#### `config.py` — Base Configuration

`DeployConfig` is a `@dataclass` populated exclusively from environment variables. App-specific scripts subclass it to add their own fields.

| Field | Env Var | Default | Purpose |
|-------|---------|---------|---------|
| `ssm_prefix` | `SSM_PREFIX` | `/k8s/development` | SSM parameter path prefix |
| `aws_region` | `AWS_REGION` | `eu-west-1` | AWS region for API calls |
| `kubeconfig` | `KUBECONFIG` | `/etc/kubernetes/admin.conf` | Path to the kubeconfig file |
| `s3_bucket` | `S3_BUCKET` | *(empty)* | S3 bucket for re-sync (optional) |
| `s3_key_prefix` | `S3_KEY_PREFIX` | `k8s` | S3 key prefix |
| `namespace` | — | `default` | Target Kubernetes namespace |
| `dry_run` | — | `False` | Print config and exit without changes |

#### `logging.py` — Structured JSON Logging

Emits one JSON object per line to stdout, parsed natively by CloudWatch Logs when SSM RunCommand output is streamed. Mirrors the pattern from `boot/steps/common.py`.

```json
{"timestamp":"2026-03-25T12:00:00+00:00","level":"INFO","message":"Resolving from SSM","env_var":"DYNAMODB_TABLE_NAME","ssm_path":"/nextjs/development/dynamodb-table-name"}
```

Functions: `log_info()`, `log_warn()`, `log_error()`.

#### `ssm.py` — SSM Parameter Resolution

Generic resolver mapping SSM parameter names to environment variable names. Key features:
- **Environment override detection**: Checks `os.getenv()` before calling SSM, skipping AWS rounds if the value is already set
- **Placeholder filtering**: Treats values like `${VAR_NAME}` and `__VAR_NAME__` as unresolved placeholders
- **Graceful error handling**: Logs `ParameterNotFound` as a warning rather than crashing

#### `bff.py` — BFF Service URL Resolution

Resolves the public base URLs for `admin-api` and `public-api` from SSM Parameter Store. Both parameters are seeded by `KubernetesEdgeStack` (CDK) during infrastructure deployment.

```text
/bedrock-{short_env}/admin-api-url  → ADMIN_API_URL
/bedrock-{short_env}/public-api-url → PUBLIC_API_URL
```

If either parameter is missing (e.g. before the edge stack has run), the function falls back to in-cluster Kubernetes Service DNS:
- `admin-api`: `http://admin-api.admin-api:3002`
- `public-api`: `http://public-api.public-api:3001`

Returns a frozen `BffUrls` dataclass. All resolution goes through `resolve_secrets()` for consistent logging and env-override behaviour.

```python
bff = resolve_bff_urls(ssm_client, short_env="dev", client_error_cls=ClientError)
secrets["PUBLIC_API_URL"] = bff.public_api_url
```

#### `k8s.py` — Kubernetes Operations

Lazy-loads the `kubernetes` Python client (importable only on the control plane). Provides:
- `load_k8s(kubeconfig)` → returns a `CoreV1Api` instance
- `ensure_namespace(v1, name)` → creates namespace if not found (404 → create, else no-op)
- `upsert_secret(v1, name, namespace, data)` → creates or replaces an Opaque secret (409 → replace)
- `upsert_configmap(v1, name, namespace, data)` → creates or replaces a ConfigMap (409 → replace)

All operations are idempotent — safe to re-run without side effects.

#### `runner.py` — Subprocess Execution

Wraps `subprocess.run` with:
- Structured JSON log lines for every command (start, success, failure, timeout)
- Duration tracking (`time.monotonic()`)
- Configurable `check` (raise `SystemExit` on failure), `timeout`, and `capture` modes
- Returns a `CmdResult` dataclass with `returncode`, `stdout`, `stderr`, `command`, `duration_seconds`

#### `s3.py` — S3 Sync

Wraps `aws s3 sync` CLI (no boto3 equivalent for sync). After sync, makes all `.sh` files executable via `Path.chmod()`.

### Import Resolution

Deploy scripts live in `workloads/charts/nextjs/` and `platform/charts/monitoring/`, outside the `k8s-bootstrap/` package. Import resolution is handled by dynamic `sys.path` injection:

```python
_BOOTSTRAP_DIR = os.environ.get(
    "DEPLOY_HELPERS_PATH",
    str(Path(__file__).resolve().parents[2] / "k8s-bootstrap"),
)
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)
```

- **On EC2**: resolves to `/data/k8s-bootstrap/` (scripts synced from S3)
- **Locally**: resolves via relative path traversal from the script location
- **Override**: set `DEPLOY_HELPERS_PATH` environment variable for custom installations

### Relationship to `boot_helpers/`

Both `deploy_helpers` and `boot_helpers` serve as shared frameworks, but address different bootstrap phases:

| Framework | Phase | Entry Point | Purpose |
|-----------|-------|-------------|---------|
| `boot_helpers/` | Day-1 node bootstrap | `boot/steps/cp/`, `boot/steps/wk/` | kubeadm, EBS, CNI, cloud controller |
| `deploy_helpers/` | Day-2 application deployment | `**/deploy.py` | SSM → K8s Secret, S3 re-sync |

Both emit structured JSON logging and follow the same dataclass pattern (`BootConfig` vs `DeployConfig`) with `@classmethod from_env()` constructors.

### SSM Document Consolidation

Both Next.js and monitoring secrets are now deployed via a single consolidated
`k8s-deploy-secrets` SSM Automation document (replacing the former separate
`nextjs-secrets` and `monitoring-secrets` documents). The document name is
resolved from a single SSM parameter: `/k8s/<env>/deploy/secrets-doc-name`.

The CI pipeline's `_post-bootstrap-config.yml` triggers the document twice
via a single `deploy-secrets` job (Step 1: Next.js, Step 2: Monitoring).

## Application Deploy Scripts

### Next.js Deploy (`workloads/charts/nextjs/deploy.py`)

Resolves SSM parameters and creates two Kubernetes resources in `nextjs-app`:
- `nextjs-secrets` — Opaque Secret containing auth tokens, API keys, and Cognito configuration
- `nextjs-config` — ConfigMap containing non-sensitive infrastructure references (table names, bucket names, ARNs)

**Secret / ConfigMap split rationale:**

| K8s Object | Contents |
|------------|----------|
| `nextjs-secrets` | `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_COGNITO_*`, `BEDROCK_AGENT_API_KEY`, `REVALIDATION_SECRET`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FARO_ENABLED` |
| `nextjs-config` | `DYNAMODB_TABLE_NAME`, `DYNAMODB_GSI1_NAME`, `DYNAMODB_GSI2_NAME`, `ASSETS_BUCKET_NAME`, `BEDROCK_AGENT_API_URL`, `SSM_BEDROCK_PREFIX`, `PUBLISH_LAMBDA_ARN`, `STRATEGIST_TABLE_NAME`, `STRATEGIST_TRIGGER_ARN`, `PUBLIC_API_URL`, `AWS_DEFAULT_REGION` |

Both objects are consumed by the Argo Rollout via `envFrom` (secretRef + configMapRef), so the pod environment is unchanged.

**App-specific logic:**
- `NextjsConfig` subclass with `environment_name`, `short_env`, and `frontend_ssm_prefix` derived properties
- `FRONTEND_SECRET_MAP` — auth, S3, DynamoDB, and API gateway SSM parameters
- DynamoDB/Bedrock fallback: resolves from `frontend_ssm_prefix` first, falls back to `/bedrock-{env}/content-table-name`
- Assets bucket override: replaces generic S3 bucket with Bedrock-specific variant if present
- **BFF URL injection**: calls `resolve_bff_urls()` to obtain `PUBLIC_API_URL` from `/bedrock-{env}/public-api-url` (seeded by `KubernetesEdgeStack`); injected into ConfigMap for use by the `/api/resume/active` proxy route

**Step 5 — Traefik IngressRoute management (deploy.py owned):**

The `ingress.enabled: false` flag in `values.yaml` ensures ArgoCD never renders or manages the `nextjs` IngressRoute. `deploy.py` is the **sole owner**:

1. Reads `cloudfront-origin-secret` history from SSM (`/k8s/{env}/cloudfront-origin-secret`)
2. During secret rotation (< 20 min): builds a dual-secret regex `OLD|NEW` for zero-downtime
3. Derives `Host()` match rule from `NEXTAUTH_URL` for defence-in-depth
4. Creates the `nextjs` and `nextjs-preview` IngressRoutes on Day-0, patches them on subsequent deploys
5. Performs a verification read-back: exits with code 1 if the placeholder `^PLACEHOLDER_NEVER_MATCHES$` is detected after apply

> **Do NOT set `ingress.enabled: true`** — this transfers ownership to ArgoCD, which will overwrite the runtime-injected origin secret on every sync.

### Monitoring Deploy (`platform/charts/monitoring/deploy.py`)

Resolves 4 SSM parameters and creates two Kubernetes Secrets: `grafana-credentials` and `github-actions-exporter-credentials` in the `monitoring` namespace.

**App-specific logic preserved after refactoring:**
- `MonitoringConfig` subclass with monitoring-specific namespace default
- `SSM_SECRET_MAP` — 4 parameters: Grafana admin password, GitHub token, webhook token, GitHub org
- Split secret creation: Grafana and GitHub exporter credentials are separate Secrets
- GitHub exporter has an additional `GITHUB_WEBHOOK_TOKEN` field

**Refactoring result:** 343 → 202 lines (41% reduction).

### Live Testing via SSM

The `deploy-test-live` justfile recipe enables on-instance validation:

```bash
# Dry-run (default) — prints resolved config, no K8s changes
just deploy-test-live <instance-id> nextjs

# Full deployment on live instance
just deploy-test-live <instance-id> nextjs --no-dry-run

# Monitoring stack
just deploy-test-live <instance-id> monitoring
```

**SSM command flow:**
1. `aws s3 sync` — pull latest scripts from S3 to `/data/`
2. `cd /data/k8s-bootstrap && pip install -e .` — install deploy_helpers
3. `python3 /data/<app-path>/deploy.py [--dry-run]` — run deploy script

Output is captured to `logs/deploy-<app>-<timestamp>.log`.

## Source Files

> This document was derived from the following source files:

- `kubernetes-app/k8s-bootstrap/system/cert-manager/persist-tls-cert.py` *(Python — TLS persistence)*
- `kubernetes-app/k8s-bootstrap/system/dr/etcd-backup.sh` *(shell — etcd snapshots)*
- `kubernetes-app/k8s-bootstrap/system/dr/install-etcd-backup-timer.sh` *(shell — systemd timer)*
- `kubernetes-app/k8s-bootstrap/system/argocd/bootstrap_argocd.py` *(Python — ArgoCD orchestrator)*
- `kubernetes-app/k8s-bootstrap/system/argocd/bootstrap-argocd.sh` *(shell — SSM entry point)*
- `kubernetes-app/k8s-bootstrap/boot/steps/boot_helpers/config.py` *(Python — BootConfig dataclass)*
- `kubernetes-app/k8s-bootstrap/boot/steps/cp/__init__.py` *(Python — CP step orchestrator)*
- `kubernetes-app/k8s-bootstrap/boot/steps/wk/__init__.py` *(Python — worker step orchestrator)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/__init__.py` *(Python — framework package)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/bff.py` *(Python — BFF URL resolution from SSM)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/config.py` *(Python — DeployConfig dataclass)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/logging.py` *(Python — structured JSON logging)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/runner.py` *(Python — subprocess wrapper)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/ssm.py` *(Python — SSM resolution)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/k8s.py` *(Python — K8s namespace/secret + ConfigMap helpers)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/s3.py` *(Python — S3 sync wrapper)*
- `kubernetes-app/workloads/charts/nextjs/deploy.py` *(Python — Next.js secret deployment)*
- `kubernetes-app/platform/charts/monitoring/deploy.py` *(Python — monitoring secret deployment)*
- `kubernetes-app/k8s-bootstrap/tests/deploy/` *(Python — 35 mocked unit tests)*
- `kubernetes-app/k8s-bootstrap/tests/boot/` *(Python — 35 mocked boot tests)*
- `kubernetes-app/k8s-bootstrap/tests/system/test_persist_tls_cert.py` *(Python — unit tests)*
- `kubernetes-app/k8s-bootstrap/tests/system/test_dr_scripts.py` *(Python — static validation)*
- `kubernetes-app/k8s-bootstrap/pyproject.toml` *(Python — project configuration)*
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` *(CDK — IAM grants)*
- `infra/lib/constructs/ssm/automation-document.ts` *(CDK — SSM document builder)*
- `infra/tests/integration/kubernetes/s3-bootstrap-artefacts.integration.test.ts` *(integration test — S3 artefact verification)*
- `.github/workflows/_deploy-ssm-automation.yml` *(workflow — 6-phase deployment)*
- `.github/workflows/_post-bootstrap-config.yml` *(workflow — consolidated secrets deployment)*

---

*Updated from source file analysis — 2026-04-06.*

## Local Control Plane Troubleshooter

A comprehensive TypeScript diagnostic script is available at `scripts/local/control-plane-troubleshoot.ts` for investigating and recovering from control plane bootstrap failures after ASG replacement. It runs locally via `npx tsx` and executes remote diagnostics on the EC2 instance via SSM RunCommand.

### Diagnostic Phases

| Phase | Coverage |
|-------|----------|
| **1. Infrastructure** | SSM parameters, EC2 instance state, EBS volumes, ASG health |
| **2. Automation** | SSM Automation execution history, step-level failure analysis |
| **3. DR & Certs** | Certificate SANs vs current IP, PKI restore state, bootstrap run_summary.json, kubeadm-config podSubnet |
| **4. Kubernetes** | API /healthz, node registration, Calico/Tigera, kubelet TLS errors, static pods, Helm releases |
| **5. Repair** | Optional `--fix`: cert regeneration, podSubnet patch, operator restart, taint removal |

### Usage

```bash
# Diagnose only
npx tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account

# Diagnose and auto-fix
npx tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account --fix

# Skip K8s checks (instance unreachable)
npx tsx scripts/local/control-plane-troubleshoot.ts --profile dev-account --skip-k8s
```

All output is file-logged to `scripts/local/diagnostics/.troubleshoot-logs/` for post-mortem analysis.

## Troubleshooting

### API Server Certificate SAN Mismatch After DR Restore

**What happened:** After ASG replacement, kubelet failed to register with `x509: certificate is valid for <old-IP>, not <new-IP>`. The node remained in `NotReady` state.

**Why:** `_reconstruct_control_plane()` restored `/etc/kubernetes/pki/apiserver.crt` from S3 backup without validating that the SANs matched the new instance's private IP.

**Fix:** Added SAN comparison logic (`openssl x509 -noout -text` + IP extraction) in `_reconstruct_control_plane()`. If the current IP is missing, `_renew_apiserver_cert()` is called to regenerate the certificate.

### Missing podSubnet Causes Calico Degraded State

**What happened:** After DR restore, tigera-operator entered `Degraded` status: `the provided networking.podSubnet field is empty`.

**Why:** `kubeadm init phase upload-config kubeadm` was called without `--pod-network-cidr`, so the `kubeadm-config` ConfigMap lacked the `podSubnet` field.

**Fix:** Added `--pod-network-cidr={POD_CIDR}` flag to the upload-config command in `_reconstruct_control_plane()`.

## Transferable Skills Demonstrated

- **Infrastructure as Code scripting** — Python + Bash automation for cluster lifecycle
- **Certificate management** — TLS persistence and rotation via SSM SecureString
- **Disaster recovery** — etcd snapshot backup/restore to S3
- **GitOps bootstrapping** — ArgoCD ApplicationSet installation and sync-wave ordering
- **Shell engineering** — idempotent scripts with error handling, logging, and retry logic

## Summary

This document provides an implementation walkthrough of the day-1 bootstrap system scripts in `k8s-bootstrap/system/`: ArgoCD vendored manifest bootstrap, TLS certificate persistence via SSM SecureString, automated hourly etcd snapshots to S3, the boot/ modular step architecture (10 CP + 3 worker modules), the deploy_helpers framework for application-level K8s secret deployment, and the local TypeScript control plane troubleshooter for diagnosing/repairing ASG replacement failures.

## Keywords

bootstrap, argocd, tls, etcd, disaster-recovery, python, shell, ssm, deploy-helpers, persist-tls-cert, systemd, pytest, certificate, x509, san, calico, podsubnet, troubleshoot, control-plane-troubleshoot
