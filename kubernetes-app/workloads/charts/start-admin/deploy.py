#!/usr/bin/env python3
"""Create Start-Admin Kubernetes secrets from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.
Resolves secrets from SSM Parameter Store and creates/updates the
start-admin-secrets K8s Secret. Helm chart deployment is handled by ArgoCD.

Usage:
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides:
    MANIFESTS_DIR          — path to start-admin manifests dir  (default: /data/workloads/charts/start-admin)
    SSM_PREFIX             — SSM parameter path                 (default: /k8s/development)
    FRONTEND_SSM_PREFIX    — frontend SSM prefix                (auto-derived from SSM_PREFIX)
    AWS_REGION             — AWS region                         (default: eu-west-1)
    KUBECONFIG             — kubeconfig path                    (default: /etc/kubernetes/admin.conf)
    S3_BUCKET              — re-sync from S3                    (optional)
    S3_KEY_PREFIX          — S3 key prefix                      (default: k8s)
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Ensure deploy_helpers is importable from the k8s-bootstrap directory.
# On EC2: /data/k8s-bootstrap/deploy_helpers/
# Locally: relative to this file's grandparent (kubernetes-app/k8s-bootstrap/)
_BOOTSTRAP_DIR = os.environ.get(
    "DEPLOY_HELPERS_PATH",
    str(Path(__file__).resolve().parents[2] / "k8s-bootstrap"),
)
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

from deploy_helpers.config import DeployConfig
from deploy_helpers.k8s import ensure_namespace, load_k8s, upsert_secret
from deploy_helpers.logging import log_info, log_warn
from deploy_helpers.s3 import sync_from_s3
from deploy_helpers.ssm import resolve_secrets

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# CDK flatName() uses shortEnv() abbreviations for resource prefixes.
# This map mirrors infra/lib/config/environments.ts → shortEnv().
SHORT_ENV_MAP: dict[str, str] = {
    "development": "dev",
    "staging": "stg",
    "production": "prd",
}

# Standard SSM parameters shared with the nextjs app (same Cognito pool).
# Keys are SSM parameter suffixes under /nextjs/{env}; values are env var names.
ADMIN_SECRET_MAP: dict[str, str] = {
    "dynamodb-table-name": "DYNAMODB_TABLE_NAME",
    "assets-bucket-name": "ASSETS_BUCKET_NAME",
    # Cognito authentication (shared pool — no NextAuth)
    "auth/cognito-user-pool-id": "COGNITO_USER_POOL_ID",
    "auth/cognito-client-id": "COGNITO_CLIENT_ID",
    "auth/cognito-issuer-url": "COGNITO_ISSUER_URL",
    "auth/cognito-domain": "COGNITO_DOMAIN",
}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class StartAdminConfig(DeployConfig):
    """Start-Admin-specific deployment configuration.

    Extends ``DeployConfig`` with the ``MANIFESTS_DIR`` and
    ``FRONTEND_SSM_PREFIX`` fields used for start-admin secret resolution.
    """

    manifests_dir: str = field(
        default_factory=lambda: os.getenv(
            "MANIFESTS_DIR", "/data/workloads/charts/start-admin"
        ),
    )
    namespace: str = "start-admin"

    @property
    def frontend_ssm_prefix(self) -> str:
        """Derive frontend SSM prefix: /k8s/development → /nextjs/development.

        Start-admin reads from the same SSM prefix as the nextjs app
        because they share the same Cognito user pool.
        """
        override = os.getenv("FRONTEND_SSM_PREFIX", "")
        if override:
            return override
        env = self.ssm_prefix.rsplit("/", 1)[-1]
        return f"/nextjs/{env}"

    @property
    def environment_name(self) -> str:
        """Extract environment name from ssm_prefix (e.g. 'development')."""
        return self.ssm_prefix.rsplit("/", 1)[-1]

    @property
    def short_env(self) -> str:
        """Short environment abbreviation for CDK resource names."""
        return SHORT_ENV_MAP.get(self.environment_name, self.environment_name)


# ---------------------------------------------------------------------------
# App-specific: SSM resolution with Bedrock fallbacks
# ---------------------------------------------------------------------------

def _load_boto3() -> tuple:
    """Lazily import boto3 and ClientError.

    Returns:
        Tuple of (boto3_module, ClientError_class).
    """
    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError

    return _boto3, _ClientError


def resolve_admin_secrets(cfg: StartAdminConfig, ssm_client: object, client_error_cls: type) -> dict[str, str]:
    """Resolve Start-Admin application secrets from SSM.

    Uses the generic ``resolve_secrets`` helper for the standard map,
    then applies app-specific fallback logic:

    1. **DynamoDB table**: Falls back to ``/bedrock-{env}/content-table-name``
       if the legacy nextjs path is not found.
    2. **Assets bucket**: Overrides with ``/bedrock-{env}/assets-bucket-name``
       since article MDX content now lives in the Bedrock data bucket.
    3. **Bedrock Lambda ARNs**: Resolves pipeline function ARNs for
       admin publish/trigger/version-history actions.

    Args:
        cfg: Start-Admin deployment configuration.
        ssm_client: boto3 SSM client instance.
        client_error_cls: botocore ``ClientError`` class.

    Returns:
        Dict of env_var_name → value for all resolved secrets.
    """
    log_info("=== Resolving secrets from SSM ===")

    secrets = resolve_secrets(
        ssm_client,
        cfg.frontend_ssm_prefix,
        ADMIN_SECRET_MAP,
        client_error_cls=client_error_cls,
    )

    # Fallback: DynamoDB table is now in AiContentStack
    if "DYNAMODB_TABLE_NAME" not in secrets:
        bedrock_path = f"/bedrock-{cfg.short_env}/content-table-name"
        log_info("Trying Bedrock fallback for DynamoDB", ssm_path=bedrock_path)
        try:
            resp = ssm_client.get_parameter(Name=bedrock_path, WithDecryption=True)
            secrets["DYNAMODB_TABLE_NAME"] = resp["Parameter"]["Value"]
            log_info("Resolved from Bedrock SSM path", env_var="DYNAMODB_TABLE_NAME")
        except client_error_cls:
            log_warn("Bedrock fallback also failed", env_var="DYNAMODB_TABLE_NAME")

    # Override: Assets bucket now points to Bedrock data bucket
    bedrock_assets_path = f"/bedrock-{cfg.short_env}/assets-bucket-name"
    try:
        resp = ssm_client.get_parameter(Name=bedrock_assets_path, WithDecryption=True)
        bedrock_value = resp["Parameter"]["Value"]
        prev = secrets.get("ASSETS_BUCKET_NAME", "<unset>")
        if prev != bedrock_value:
            log_info(
                "Overriding ASSETS_BUCKET_NAME with Bedrock source of truth",
                previous=prev,
                new_value=bedrock_value,
            )
            secrets["ASSETS_BUCKET_NAME"] = bedrock_value
    except client_error_cls:
        log_info("No Bedrock assets-bucket-name override found; using resolved value")

    # Bedrock Agent & Pipeline: resolve Lambda ARNs, API URL, API key,
    # and revalidation secret needed by the admin dashboard.
    _BEDROCK_ADMIN_PARAMS: dict[str, str] = {
        "api-url": "BEDROCK_AGENT_API_URL",
        "agent-api-key": "BEDROCK_AGENT_API_KEY",
        "revalidation-secret": "REVALIDATION_SECRET",
        "pipeline-publish-function-arn": "PUBLISH_LAMBDA_ARN",
        "pipeline-trigger-function-arn": "ARTICLE_TRIGGER_ARN",
        # Job Strategist pipeline
        "strategist-table-name": "STRATEGIST_TABLE_NAME",
        "strategist-trigger-function-arn": "STRATEGIST_TRIGGER_ARN",
    }
    for param_suffix, env_var in _BEDROCK_ADMIN_PARAMS.items():
        bedrock_path = f"/bedrock-{cfg.short_env}/{param_suffix}"
        log_info("Resolving Bedrock param", env_var=env_var, ssm_path=bedrock_path)
        try:
            resp = ssm_client.get_parameter(Name=bedrock_path, WithDecryption=True)
            secrets[env_var] = resp["Parameter"]["Value"]
            log_info("Resolved Bedrock param", env_var=env_var)
        except client_error_cls:
            log_warn("Bedrock param not found", env_var=env_var, ssm_path=bedrock_path)

    # Derived config: SSM prefix for Bedrock parameters.
    # Used by the admin UI to locate pipeline infrastructure.
    secrets["SSM_BEDROCK_PREFIX"] = f"/bedrock-{cfg.short_env}"

    # DynamoDB GSI names — constants matching CDK ai-content-stack.ts.
    secrets["DYNAMODB_GSI1_NAME"] = "gsi1-status-date"
    secrets["DYNAMODB_GSI2_NAME"] = "gsi2-tag-date"

    return secrets


# ---------------------------------------------------------------------------
# App-specific: K8s secret creation
# ---------------------------------------------------------------------------

_ADMIN_SECRET_KEYS = [
    "DYNAMODB_TABLE_NAME",
    "DYNAMODB_GSI1_NAME",
    "DYNAMODB_GSI2_NAME",
    "ASSETS_BUCKET_NAME",
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_ISSUER_URL",
    "COGNITO_DOMAIN",
    "BEDROCK_AGENT_API_URL",
    "BEDROCK_AGENT_API_KEY",
    "REVALIDATION_SECRET",
    "SSM_BEDROCK_PREFIX",
    "PUBLISH_LAMBDA_ARN",
    "ARTICLE_TRIGGER_ARN",
    # Job Strategist pipeline
    "STRATEGIST_TABLE_NAME",
    "STRATEGIST_TRIGGER_ARN",
]


def create_admin_k8s_secrets(v1: object, cfg: StartAdminConfig) -> None:
    """Create or update the start-admin-secrets Kubernetes Secret.

    Args:
        v1: Kubernetes ``CoreV1Api`` instance.
        cfg: Start-Admin deployment configuration with resolved secrets.
    """
    log_info("=== Creating Kubernetes secrets ===")
    ensure_namespace(v1, cfg.namespace)

    secret_data: dict[str, str] = {}
    for key in _ADMIN_SECRET_KEYS:
        value = cfg.secrets.get(key, "")
        if value:
            secret_data[key] = value

    # AWS_REGION is always needed for SDK calls — inject from config
    secret_data["AWS_REGION"] = cfg.aws_region

    if secret_data:
        upsert_secret(v1, "start-admin-secrets", cfg.namespace, secret_data)
        log_info("start-admin-secrets created/updated", keys=len(secret_data))
    else:
        log_warn("No secrets resolved — skipping secret creation")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Entry point for Start-Admin secret deployment."""
    cfg = StartAdminConfig.from_env()

    # Handle --dry-run flag
    if "--dry-run" in sys.argv:
        cfg.dry_run = True
        cfg.print_banner("Start-Admin Secret Deployment — DRY RUN")
        log_info("Dry run configuration", **{
            "manifests_dir": cfg.manifests_dir,
            "frontend_ssm": cfg.frontend_ssm_prefix,
            "kubeconfig": cfg.kubeconfig,
            "s3_bucket": cfg.s3_bucket or "(none)",
        })
        return

    # Load third-party dependencies
    boto3_mod, client_error_cls = _load_boto3()

    cfg.print_banner("Start-Admin Secret Deployment")

    # Step 1: S3 sync (optional)
    if cfg.s3_bucket:
        sync_dir = str(Path(cfg.manifests_dir).parent.parent)
        sync_from_s3(cfg.s3_bucket, cfg.s3_key_prefix, sync_dir, cfg.aws_region)

    # Step 2: Load Kubernetes client
    v1 = load_k8s(cfg.kubeconfig)

    # Step 3: Resolve secrets from SSM
    ssm_client = boto3_mod.client("ssm", region_name=cfg.aws_region)
    cfg.secrets = resolve_admin_secrets(cfg, ssm_client, client_error_cls)

    # Step 4: Create Kubernetes secrets
    create_admin_k8s_secrets(v1, cfg)

    log_info("Start-Admin secrets deployed successfully")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log_info("Deployment interrupted")
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as exc:
        from deploy_helpers.logging import log_error

        log_error("Deployment failed", error=str(exc))
        sys.exit(1)
