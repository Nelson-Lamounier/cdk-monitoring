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

FRONTEND_SECRET_MAP: dict[str, str] = {
    "dynamodb-table-name": "DYNAMODB_TABLE_NAME",
    "assets-bucket-name": "ASSETS_BUCKET_NAME",
    "api-gateway-url": "NEXT_PUBLIC_API_URL",
    # Cognito + NextAuth.js admin authentication
    "auth/nextauth-secret": "NEXTAUTH_SECRET",
    "auth/nextauth-url": "NEXTAUTH_URL",
    "auth/cognito-user-pool-id": "AUTH_COGNITO_USER_POOL_ID",
    "auth/cognito-client-id": "AUTH_COGNITO_ID",
    "auth/cognito-issuer-url": "AUTH_COGNITO_ISSUER",
    "auth/cognito-domain": "AUTH_COGNITO_DOMAIN",
}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class NextjsConfig(DeployConfig):
    """Next.js-specific deployment configuration.

    Extends ``DeployConfig`` with the ``MANIFESTS_DIR`` and
    ``FRONTEND_SSM_PREFIX`` fields used for nextjs secret resolution.
    """

    manifests_dir: str = field(
        default_factory=lambda: os.getenv(
            "MANIFESTS_DIR", "/data/workloads/charts/nextjs"
        ),
    )
    namespace: str = "nextjs-app"

    @property
    def frontend_ssm_prefix(self) -> str:
        """Derive frontend SSM prefix: /k8s/development → /nextjs/development."""
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


def resolve_nextjs_secrets(cfg: NextjsConfig, ssm_client: object, client_error_cls: type) -> dict[str, str]:
    """Resolve Next.js application secrets from SSM.

    Uses the generic ``resolve_secrets`` helper for the standard map,
    then applies app-specific fallback logic:

    1. **DynamoDB table**: Falls back to ``/bedrock-{env}/content-table-name``
       if the legacy nextjs path is not found.
    2. **Assets bucket**: Overrides with ``/bedrock-{env}/assets-bucket-name``
       since article MDX content now lives in the Bedrock data bucket.

    Args:
        cfg: Next.js deployment configuration.
        ssm_client: boto3 SSM client instance.
        client_error_cls: botocore ``ClientError`` class.

    Returns:
        Dict of env_var_name → value for all resolved secrets.
    """
    log_info("=== Resolving secrets from SSM ===")

    secrets = resolve_secrets(
        ssm_client,
        cfg.frontend_ssm_prefix,
        FRONTEND_SECRET_MAP,
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

    # Assets bucket now points to Bedrock data bucket
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

    # Bedrock Agent: resolve API URL, API key, and revalidation secret.
    # api-url is a plain String; agent-api-key and revalidation-secret
    # are SecureStrings.
    #
    # Manual secret creation (one-time):
    #   aws ssm put-parameter \
    #     --name "/bedrock-dev/revalidation-secret" \
    #     --value "$(openssl rand -base64 32)" \
    #     --type SecureString
    _BEDROCK_AGENT_PARAMS: dict[str, str] = {
        "api-url": "BEDROCK_AGENT_API_URL",
        "agent-api-key": "BEDROCK_AGENT_API_KEY",
        "revalidation-secret": "REVALIDATION_SECRET",
        "pipeline-publish-function-arn": "PUBLISH_LAMBDA_ARN",
        # Job Strategist pipeline (Stacks 7 & 8)
        "strategist-table-name": "STRATEGIST_TABLE_NAME",
        "strategist-trigger-function-arn": "STRATEGIST_TRIGGER_ARN",
    }
    for param_suffix, env_var in _BEDROCK_AGENT_PARAMS.items():
        bedrock_path = f"/bedrock-{cfg.short_env}/{param_suffix}"
        log_info("Resolving Bedrock Agent param", env_var=env_var, ssm_path=bedrock_path)
        try:
            resp = ssm_client.get_parameter(Name=bedrock_path, WithDecryption=True)
            secrets[env_var] = resp["Parameter"]["Value"]
            log_info("Resolved Bedrock Agent param", env_var=env_var)
        except client_error_cls:
            log_warn("Bedrock Agent param not found", env_var=env_var, ssm_path=bedrock_path)

    # Derived config: SSM prefix for Bedrock parameters.
    # Used by publish-draft API route to locate infrastructure.
    secrets["SSM_BEDROCK_PREFIX"] = f"/bedrock-{cfg.short_env}"

    # DynamoDB GSI names — constants matching CDK ai-content-stack.ts.
    # Explicitly injected rather than relying on fallback defaults in
    # the frontend code (dynamodb-articles.ts).
    secrets["DYNAMODB_GSI1_NAME"] = "gsi1-status-date"
    secrets["DYNAMODB_GSI2_NAME"] = "gsi2-tag-date"

    return secrets


# ---------------------------------------------------------------------------
# App-specific: K8s secret creation
# ---------------------------------------------------------------------------

_NEXTJS_SECRET_KEYS = [
    "DYNAMODB_TABLE_NAME",
    "DYNAMODB_GSI1_NAME",
    "DYNAMODB_GSI2_NAME",
    "ASSETS_BUCKET_NAME",
    "NEXT_PUBLIC_API_URL",
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "AUTH_COGNITO_USER_POOL_ID",
    "AUTH_COGNITO_ID",
    "AUTH_COGNITO_ISSUER",
    "AUTH_COGNITO_DOMAIN",
    "BEDROCK_AGENT_API_URL",
    "BEDROCK_AGENT_API_KEY",
    "REVALIDATION_SECRET",
    "SSM_BEDROCK_PREFIX",
    "PUBLISH_LAMBDA_ARN",
    # Job Strategist pipeline
    "STRATEGIST_TABLE_NAME",
    "STRATEGIST_TRIGGER_ARN",
]


def create_nextjs_k8s_secrets(v1: object, cfg: NextjsConfig) -> None:
    """Create or update the nextjs-secrets Kubernetes Secret.

    Args:
        v1: Kubernetes ``CoreV1Api`` instance.
        cfg: Next.js deployment configuration with resolved secrets.
    """
    log_info("=== Creating Kubernetes secrets ===")
    ensure_namespace(v1, cfg.namespace)

    secret_data: dict[str, str] = {}
    for key in _NEXTJS_SECRET_KEYS:
        value = cfg.secrets.get(key, "")
        if value:
            secret_data[key] = value

    # NextAuth.js expects a client secret by default for OIDC providers.
    # Since we use a Public Client (`generateSecret: false`), we inject
    # a dummy string to bypass internal crash loops on boot.
    secret_data["AUTH_COGNITO_SECRET"] = "public-client-no-secret"

    # Enable Grafana Faro RUM
    secret_data["NEXT_PUBLIC_FARO_ENABLED"] = "true"

    # AWS_REGION is always needed for SDK calls — inject from config
    secret_data["AWS_REGION"] = cfg.aws_region

    if secret_data:
        upsert_secret(v1, "nextjs-secrets", cfg.namespace, secret_data)
        log_info("nextjs-secrets created/updated", keys=len(secret_data))
    else:
        log_warn("No secrets resolved — skipping secret creation")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Entry point for Next.js secret deployment."""
    cfg = NextjsConfig.from_env()

    # Handle --dry-run flag
    if "--dry-run" in sys.argv:
        cfg.dry_run = True
        cfg.print_banner("Next.js Secret Deployment — DRY RUN")
        log_info("Dry run configuration", **{
            "manifests_dir": cfg.manifests_dir,
            "frontend_ssm": cfg.frontend_ssm_prefix,
            "kubeconfig": cfg.kubeconfig,
            "s3_bucket": cfg.s3_bucket or "(none)",
        })
        return

    # Load third-party dependencies
    boto3_mod, client_error_cls = _load_boto3()

    cfg.print_banner("Next.js Secret Deployment")

    # Step 1: S3 sync (optional)
    if cfg.s3_bucket:
        sync_dir = str(Path(cfg.manifests_dir).parent.parent)
        sync_from_s3(cfg.s3_bucket, cfg.s3_key_prefix, sync_dir, cfg.aws_region)

    # Step 2: Load Kubernetes client
    v1 = load_k8s(cfg.kubeconfig)

    # Step 3: Resolve secrets from SSM
    ssm_client = boto3_mod.client("ssm", region_name=cfg.aws_region)
    cfg.secrets = resolve_nextjs_secrets(cfg, ssm_client, client_error_cls)

    # Step 4: Create Kubernetes secrets
    create_nextjs_k8s_secrets(v1, cfg)

    # Step 5: Inject CloudFront Origin Secret into Helm rendering parameters
    #
    # IMPORTANT: Failures here are treated as FATAL (sys.exit(1)) because a
    # silent failure leaves the Traefik IngressRoute with the placeholder regex
    # '^PLACEHOLDER_NEVER_MATCHES$', which causes CloudFront to receive 404 for
    # every request.  The only legitimate skip is when the SSM parameter does
    # not exist yet (Day-0 before a CloudFront distribution is deployed).
    try:
        from kubernetes import client  # noqa: PLC0415 — deferred import (optional dep)
        from datetime import datetime, timezone
        import re
        from urllib.parse import urlparse
        from deploy_helpers.logging import log_error

        cf_secret_path = f"/k8s/{cfg.environment_name}/cloudfront-origin-secret"
        log_info("Fetching CloudFront origin secret history", ssm_path=cf_secret_path)

        paginator = ssm_client.get_paginator("get_parameter_history")
        history = []
        for page in paginator.paginate(Name=cf_secret_path, WithDecryption=True):
            history.extend(page.get("Parameters", []))

        if not history:
            raise ValueError(f"No history found for {cf_secret_path}")

        # History is ordered oldest to newest.
        latest = history[-1]
        origin_secret = latest["Value"]

        latest_time = latest["LastModifiedDate"]
        now = datetime.now(timezone.utc)

        # If there are at least 2 versions and the latest rotation was < 20 min ago,
        # use a regex OR pattern to allow both secrets temporarily (zero-downtime rotation).
        if len(history) >= 2 and (now - latest_time).total_seconds() < 20 * 60:
            previous_secret = history[-2]["Value"]
            old_escaped = re.escape(previous_secret)
            new_escaped = re.escape(origin_secret)
            origin_secret = f"{old_escaped}|{new_escaped}"
            log_info(
                "Secret rotated recently. Using dual-secret regex for zero-downtime.",
                minutes_since_rotation=round((now - latest_time).total_seconds() / 60, 1),
            )
        else:
            log_info("Using single origin secret.")

        # Derive public hostname from NEXTAUTH_URL for Host() defence-in-depth.
        # NEXTAUTH_URL is already resolved in Step 3 (e.g. "https://nelsonlamounier.com").
        ingress_host = ""
        nextauth_url = cfg.secrets.get("NEXTAUTH_URL", "")
        if nextauth_url:
            parsed = urlparse(nextauth_url)
            ingress_host = parsed.hostname or ""
            log_info("Derived ingress host from NEXTAUTH_URL", host=ingress_host)
        else:
            log_warn("NEXTAUTH_URL not available — Host() rule will be skipped")

        # Build Helm parameter overrides for ArgoCD Application.
        helm_params = [
            {"name": "cloudfront.originSecret", "value": origin_secret, "forceString": True},
        ]
        if ingress_host:
            helm_params.append(
                {"name": "ingress.host", "value": ingress_host, "forceString": True}
            )

        custom_api = client.CustomObjectsApi(v1.api_client)
        patch = {
            "spec": {
                "source": {
                    "helm": {
                        "parameters": helm_params
                    }
                }
            }
        }
        custom_api.patch_namespaced_custom_object(
            group="argoproj.io",
            version="v1alpha1",
            namespace="argocd",
            plural="applications",
            name="nextjs",
            body=patch,
        )
        log_info("Patched ArgoCD nextjs Application with origin secret.", host=ingress_host)

        # ── Verification read-back ──────────────────────────────────────────────
        # Re-read the ArgoCD Application to confirm the patch was persisted.
        # This catches RBAC partial-write scenarios where the API returns 200
        # but the value was not actually stored.
        app = custom_api.get_namespaced_custom_object(
            group="argoproj.io",
            version="v1alpha1",
            namespace="argocd",
            plural="applications",
            name="nextjs",
        )
        written_params = (
            app.get("spec", {})
               .get("source", {})
               .get("helm", {})
               .get("parameters", [])
        )
        written_secret = next(
            (p.get("value", "") for p in written_params if p.get("name") == "cloudfront.originSecret"),
            None,
        )
        _PLACEHOLDER = "^PLACEHOLDER_NEVER_MATCHES$"
        if written_secret is None or written_secret == _PLACEHOLDER:
            log_error(
                "Verification FAILED: originSecret was not persisted in ArgoCD Application.",
                written=str(written_secret),
            )
            sys.exit(1)

        log_info(
            "Verification PASSED: originSecret is active in ArgoCD Application.",
            host=ingress_host,
        )

    except client_error_cls as e:
        # SSM ClientError means the CloudFront origin secret parameter does not exist
        # yet — legitimate skip on Day-0 before a CloudFront distribution is deployed.
        log_warn(
            "CloudFront origin secret not found in SSM — skipping injection.",
            error=str(e),
        )
    except SystemExit:
        # Re-raise sys.exit() calls from the verification block above.
        raise
    except Exception as e:  # noqa: BLE001
        # Any other exception (ImportError, API error, network timeout) is FATAL.
        # Swallowing this error was the root cause of silent CloudFront 404s.
        from deploy_helpers.logging import log_error  # noqa: PLC0415
        log_error(
            "FATAL: Failed to patch ArgoCD Application with CloudFront Origin Secret.",
            error=str(e),
        )
        sys.exit(1)

    log_info("Next.js secrets deployed successfully")


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
