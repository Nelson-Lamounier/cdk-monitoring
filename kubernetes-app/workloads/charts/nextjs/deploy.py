#!/usr/bin/env python3
"""Create Next.js Kubernetes secrets from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.
Resolves secrets from SSM Parameter Store and creates/updates the
nextjs-secrets K8s Secret. Helm chart deployment is handled by ArgoCD.

Usage:
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides:
    MANIFESTS_DIR          — path to nextjs manifests dir  (default: /data/workloads/charts/nextjs)
    SSM_PREFIX             — SSM parameter path            (default: /k8s/development)
    FRONTEND_SSM_PREFIX    — frontend SSM prefix           (auto-derived from SSM_PREFIX)
    AWS_REGION             — AWS region                    (default: eu-west-1)
    KUBECONFIG             — kubeconfig path               (default: /etc/kubernetes/admin.conf)
    S3_BUCKET              — re-sync from S3               (optional)
    S3_KEY_PREFIX          — S3 key prefix                 (default: k8s)
"""

from __future__ import annotations

import base64
import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Third-party imports are loaded lazily in _load_dependencies() so that
# --dry-run works on dev machines without boto3/kubernetes installed.
boto3 = None
ClientError = None
k8s_client = None
k8s_config = None

# CDK flatName() uses shortEnv() abbreviations for resource prefixes.
# This map mirrors infra/lib/config/environments.ts → shortEnv().
SHORT_ENV_MAP: dict[str, str] = {
    "development": "dev",
    "staging": "stg",
    "production": "prd",
}


def _load_dependencies() -> None:
    """Import third-party libraries. Called once from main() before real work."""
    global boto3, ClientError, k8s_client, k8s_config

    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError
    from kubernetes import client as _k8s_client
    from kubernetes import config as _k8s_config

    boto3 = _boto3
    ClientError = _ClientError
    k8s_client = _k8s_client
    k8s_config = _k8s_config


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("nextjs-deploy")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
@dataclass
class Config:
    """Deployment configuration sourced from environment variables."""

    manifests_dir: str = field(
        default_factory=lambda: os.getenv("MANIFESTS_DIR", "/data/workloads/charts/nextjs")
    )
    ssm_prefix: str = field(
        default_factory=lambda: os.getenv("SSM_PREFIX", "/k8s/development")
    )
    aws_region: str = field(
        default_factory=lambda: os.getenv("AWS_REGION", "eu-west-1")
    )
    kubeconfig: str = field(
        default_factory=lambda: os.getenv("KUBECONFIG", "/etc/kubernetes/admin.conf")
    )
    s3_bucket: str = field(
        default_factory=lambda: os.getenv("S3_BUCKET", "")
    )
    s3_key_prefix: str = field(
        default_factory=lambda: os.getenv("S3_KEY_PREFIX", "k8s")
    )

    namespace: str = "nextjs-app"
    dry_run: bool = False

    # Resolved at runtime
    secrets: dict[str, str] = field(default_factory=dict)

    @property
    def frontend_ssm_prefix(self) -> str:
        """Derive frontend SSM prefix: /k8s/development → /nextjs/development."""
        override = os.getenv("FRONTEND_SSM_PREFIX", "")
        if override:
            return override
        env = self.ssm_prefix.rsplit("/", 1)[-1]
        return f"/nextjs/{env}"

    def print_banner(self) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        log.info("=== Next.js Secret Deployment ===")
        log.info("Manifests:    %s", self.manifests_dir)
        log.info("SSM prefix:   %s", self.ssm_prefix)
        log.info("Frontend SSM: %s", self.frontend_ssm_prefix)
        log.info("Region:       %s", self.aws_region)
        log.info("Triggered:    %s", now)
        log.info("")


# ---------------------------------------------------------------------------
# Step 1: S3 sync (thin CLI wrapper — s3 sync has no boto3 equivalent)
# ---------------------------------------------------------------------------
def sync_from_s3(cfg: Config) -> None:
    """Re-sync manifests directory from S3 when S3_BUCKET is set."""
    if not cfg.s3_bucket:
        return

    log.info("=== Step 1: Re-syncing manifests from S3 ===")
    # Sync to parent of manifests_dir (e.g. /data/k8s/apps/)
    sync_dir = str(Path(cfg.manifests_dir).parent.parent)
    src = f"s3://{cfg.s3_bucket}/{cfg.s3_key_prefix}/"

    _run_cmd(
        ["aws", "s3", "sync", src, f"{sync_dir}/", "--region", cfg.aws_region],
        check=True,
    )

    # Make scripts executable
    for sh in Path(sync_dir).rglob("*.sh"):
        sh.chmod(sh.stat().st_mode | 0o111)

    log.info("✓ Manifests synced from %s", src)
    log.info("")


# ---------------------------------------------------------------------------
# Step 2: Resolve secrets from SSM
# ---------------------------------------------------------------------------
FRONTEND_SECRET_MAP = {
    "dynamodb-table-name": "DYNAMODB_TABLE_NAME",
    "assets-bucket-name": "ASSETS_BUCKET_NAME",
    "api-gateway-url": "NEXT_PUBLIC_API_URL",
}


def resolve_ssm_secrets(cfg: Config) -> dict[str, str]:
    """Fetch secrets from SSM Parameter Store using boto3.

    Resolves frontend application secrets from FRONTEND_SSM_PREFIX and
    the ECR repository URI from SSM_PREFIX.

    For the DynamoDB table name, falls back to the Bedrock SSM path
    (/bedrock-{env}/content-table-name) if the legacy nextjs path is
    not found — the table is now consolidated in AiContentStack.

    Returns a dict of env_var_name → value for all resolved secrets.
    """
    log.info("=== Step 2: Resolving secrets from SSM ===")

    ssm = boto3.client("ssm", region_name=cfg.aws_region)
    secrets: dict[str, str] = {}

    # Frontend application secrets
    for param_name, env_var in FRONTEND_SECRET_MAP.items():
        # Check for environment override
        existing = os.getenv(env_var, "")
        if existing and existing != f"${{{env_var}}}":
            log.info("  ✓ %s: using environment override", env_var)
            secrets[env_var] = existing
            continue

        ssm_path = f"{cfg.frontend_ssm_prefix}/{param_name}"
        log.info("  → Resolving %s from SSM: %s", env_var, ssm_path)

        try:
            resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
            value = resp["Parameter"]["Value"]
            secrets[env_var] = value
            log.info("  ✓ %s: resolved from SSM", env_var)
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code == "ParameterNotFound":
                log.warning("  ⚠ %s: not found in SSM (%s)", env_var, ssm_path)

                # Fallback: DynamoDB table is now in AiContentStack
                # CDK flatName() abbreviates: development→dev, production→prd
                # Try /bedrock-{short_env}/content-table-name
                if env_var == "DYNAMODB_TABLE_NAME":
                    full_env = cfg.ssm_prefix.rsplit("/", 1)[-1]
                    short = SHORT_ENV_MAP.get(full_env, full_env)
                    bedrock_path = f"/bedrock-{short}/content-table-name"
                    log.info("  → Fallback: trying Bedrock SSM path: %s", bedrock_path)
                    try:
                        resp = ssm.get_parameter(Name=bedrock_path, WithDecryption=True)
                        value = resp["Parameter"]["Value"]
                        secrets[env_var] = value
                        log.info("  ✓ %s: resolved from Bedrock SSM path", env_var)
                    except ClientError as inner_exc:
                        inner_code = inner_exc.response["Error"]["Code"]
                        log.warning("  ⚠ %s: Bedrock fallback also failed (%s)", env_var, inner_code)
            else:
                log.warning("  ⚠ %s: SSM error (%s)", env_var, code)



    log.info("")
    return secrets


# ---------------------------------------------------------------------------
# Step 3: Create/update Kubernetes secrets (pre-Helm)
# ---------------------------------------------------------------------------
def create_k8s_secrets(
    v1: k8s_client.CoreV1Api,
    cfg: Config,
) -> None:
    """Create or update Kubernetes Secrets from resolved SSM values.

    Uses an idempotent upsert pattern: try create, on 409 Conflict → replace.
    Created BEFORE Helm so the Deployment pods can mount secrets immediately.
    """
    log.info("=== Step 3: Creating Kubernetes secrets ===")

    # Ensure namespace exists
    _ensure_namespace(v1, cfg.namespace)

    secrets = cfg.secrets
    secret_data: dict[str, str] = {}

    for env_var in ["DYNAMODB_TABLE_NAME", "ASSETS_BUCKET_NAME", "NEXT_PUBLIC_API_URL"]:
        value = secrets.get(env_var, "")
        if value:
            secret_data[env_var] = value

    # AWS_REGION is always needed for SDK calls — inject from config
    secret_data["AWS_REGION"] = cfg.aws_region

    if secret_data:
        _upsert_secret(
            v1,
            name="nextjs-secrets",
            namespace=cfg.namespace,
            data=secret_data,
        )
        log.info("  ✓ nextjs-secrets created/updated (%d keys)", len(secret_data))
    else:
        log.warning("  ⚠ No secrets resolved — skipping secret creation")

    log.info("")


def _ensure_namespace(v1: k8s_client.CoreV1Api, namespace: str) -> None:
    """Create the namespace if it doesn't exist."""
    try:
        v1.read_namespace(name=namespace)
    except k8s_client.ApiException as exc:
        if exc.status == 404:
            v1.create_namespace(
                body=k8s_client.V1Namespace(
                    metadata=k8s_client.V1ObjectMeta(name=namespace)
                )
            )
            log.info("  ✓ Namespace '%s' created", namespace)
        else:
            raise


def _upsert_secret(
    v1: k8s_client.CoreV1Api,
    name: str,
    namespace: str,
    data: dict[str, str],
) -> None:
    """Create or replace a Kubernetes Secret (idempotent)."""
    encoded = {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=name, namespace=namespace),
        type="Opaque",
        data=encoded,
    )
    try:
        v1.create_namespaced_secret(namespace=namespace, body=secret)
    except k8s_client.ApiException as exc:
        if exc.status == 409:
            v1.replace_namespaced_secret(name=name, namespace=namespace, body=secret)
        else:
            raise





# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run_cmd(
    cmd: list[str],
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a shell command, streaming output to stdout."""
    log.debug("  $ %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=False, text=True, check=False)
    if check and result.returncode != 0:
        log.error("Command failed (exit %d): %s", result.returncode, " ".join(cmd))
        raise SystemExit(result.returncode)
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    cfg = Config()

    # Handle --dry-run flag
    if "--dry-run" in sys.argv:
        cfg.dry_run = True
        cfg.print_banner()
        log.info("=== DRY RUN — no changes will be made ===")
        log.info("  manifests_dir:    %s", cfg.manifests_dir)
        log.info("  ssm_prefix:       %s", cfg.ssm_prefix)
        log.info("  frontend_ssm:     %s", cfg.frontend_ssm_prefix)
        log.info("  aws_region:       %s", cfg.aws_region)
        log.info("  kubeconfig:       %s", cfg.kubeconfig)
        log.info("  s3_bucket:        %s", cfg.s3_bucket or "(none)")
        log.info("  namespace:        %s", cfg.namespace)
        return

    # Load third-party dependencies (boto3, kubernetes)
    _load_dependencies()

    cfg.print_banner()

    # Step 1: S3 sync
    sync_from_s3(cfg)

    # Load kubeconfig for K8s API calls
    os.environ["KUBECONFIG"] = cfg.kubeconfig
    k8s_config.load_kube_config(config_file=cfg.kubeconfig)
    v1 = k8s_client.CoreV1Api()

    # Step 2: Resolve secrets from SSM
    cfg.secrets = resolve_ssm_secrets(cfg)

    # Step 3: Create Kubernetes secrets
    create_k8s_secrets(v1, cfg)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log.info("")
    log.info("✓ Next.js secrets deployed successfully (%s)", now)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("\n✗ Deployment interrupted")
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as exc:
        log.error("✗ Deployment failed: %s", exc, exc_info=True)
        sys.exit(1)
