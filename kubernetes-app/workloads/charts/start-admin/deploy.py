#!/usr/bin/env python3
"""Create Start-Admin Kubernetes resources (Secret + ConfigMap) from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.
Resolves parameters from SSM Parameter Store and creates/updates:
  - ``start-admin-secrets``  K8s Secret   — sensitive auth values only
  - ``start-admin-config``   K8s ConfigMap — non-sensitive config (table names, ARNs, region)

Helm chart deployment is handled by ArgoCD. The Traefik IngressRoute
is created/updated by Step 5 of this script (sole owner).

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

from deploy_helpers.bff import resolve_bff_urls
from deploy_helpers.config import DeployConfig
from deploy_helpers.k8s import ensure_namespace, load_k8s, upsert_configmap, upsert_secret
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

    # Bedrock Agent & Pipeline: resolve Lambda ARNs, API URL, and API key
    # needed by the admin dashboard.  All calls go through resolve_secrets()
    # so logging, env-override, and error-handling follow a single path.
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
    bedrock_prefix = f"/bedrock-{cfg.short_env}"
    bedrock_secrets = resolve_secrets(
        ssm_client,
        bedrock_prefix,
        _BEDROCK_ADMIN_PARAMS,
        client_error_cls=client_error_cls,
    )
    secrets.update(bedrock_secrets)

    # BFF service URLs — dedicated helper ensures a single resolution path
    # and consistent in-cluster fallback for both admin-api and public-api.
    bff = resolve_bff_urls(ssm_client, cfg.short_env, client_error_cls)
    secrets["ADMIN_API_URL"] = bff.admin_api_url

    # Derived config: SSM prefix for Bedrock parameters.
    # Used by the admin UI to locate pipeline infrastructure.
    secrets["SSM_BEDROCK_PREFIX"] = bedrock_prefix

    # DynamoDB GSI names — constants matching CDK ai-content-stack.ts.
    secrets["DYNAMODB_GSI1_NAME"] = "gsi1-status-date"
    secrets["DYNAMODB_GSI2_NAME"] = "gsi2-tag-date"

    return secrets


# ---------------------------------------------------------------------------
# App-specific: K8s resource creation (Secret + ConfigMap)
#
# Separation rationale:
#   _ADMIN_SECRET_KEYS  — values requiring encryption at rest; stored in an
#                         Opaque K8s Secret (base64-encoded by the API server).
#   _ADMIN_CONFIG_KEYS  — non-sensitive config strings (table names, bucket
#                         names, ARNs, constants); stored in a plain ConfigMap.
#
# The Rollout template uses:
#   envFrom:
#     - secretRef:    { name: start-admin-secrets }
#     - configMapRef: { name: start-admin-config  }
# ---------------------------------------------------------------------------

_ADMIN_SECRET_KEYS = [
    # Auth — always sensitive (Cognito tokens, API credentials)
    "COGNITO_USER_POOL_ID",
    "COGNITO_CLIENT_ID",
    "COGNITO_ISSUER_URL",
    "COGNITO_DOMAIN",
    "BEDROCK_AGENT_API_KEY",
    "REVALIDATION_SECRET",
]

_ADMIN_CONFIG_KEYS = [
    # Non-sensitive infrastructure references — safe to store in ConfigMap
    "DYNAMODB_TABLE_NAME",
    "DYNAMODB_GSI1_NAME",
    "DYNAMODB_GSI2_NAME",
    "ASSETS_BUCKET_NAME",
    "BEDROCK_AGENT_API_URL",
    "SSM_BEDROCK_PREFIX",
    "PUBLISH_LAMBDA_ARN",
    "ARTICLE_TRIGGER_ARN",
    "STRATEGIST_TABLE_NAME",
    "STRATEGIST_TRIGGER_ARN",
    # BFF: admin-api base URL — used by start-admin fetch() calls after migration
    "ADMIN_API_URL",
]


def create_admin_k8s_resources(v1: object, cfg: StartAdminConfig) -> None:
    """Create or update the start-admin-secrets K8s Secret and start-admin-config ConfigMap.

    Splits resolved SSM parameters into two K8s objects:
    - ``start-admin-secrets`` (Opaque Secret)  — Cognito auth and API credentials.
    - ``start-admin-config``  (ConfigMap)       — table names, bucket name, ARNs, region.

    Both are consumed by the Rollout via ``envFrom`` (secretRef + configMapRef).
    The pod environment is identical to before — only the K8s backing object changes.

    Args:
        v1: Kubernetes ``CoreV1Api`` instance.
        cfg: Start-Admin deployment configuration with resolved secrets.
    """
    log_info("=== Creating Kubernetes resources ===")
    ensure_namespace(v1, cfg.namespace)

    # --- Secret (sensitive auth values only) ---
    secret_data: dict[str, str] = {}
    for key in _ADMIN_SECRET_KEYS:
        value = cfg.secrets.get(key, "")
        if value:
            secret_data[key] = value

    if secret_data:
        upsert_secret(v1, "start-admin-secrets", cfg.namespace, secret_data)
        log_info("start-admin-secrets created/updated", keys=len(secret_data))
    else:
        log_warn("No secrets resolved — skipping secret creation")

    # --- ConfigMap (non-sensitive config values) ---
    config_data: dict[str, str] = {}
    for key in _ADMIN_CONFIG_KEYS:
        value = cfg.secrets.get(key, "")
        if value:
            config_data[key] = value

    # AWS_DEFAULT_REGION is needed by the AWS SDK default credential chain.
    # Stored in ConfigMap (not Secret) — region is not a sensitive value.
    config_data["AWS_DEFAULT_REGION"] = cfg.aws_region

    if config_data:
        upsert_configmap(v1, "start-admin-config", cfg.namespace, config_data)
        log_info("start-admin-config created/updated", keys=len(config_data))
    else:
        log_warn("No config values resolved — skipping ConfigMap creation")


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

    # Step 4: Create Kubernetes Secret + ConfigMap
    create_admin_k8s_resources(v1, cfg)

    # Step 5: Create / Update the Traefik IngressRoute with the real CloudFront secret
    #
    # ── OWNERSHIP MODEL ──────────────────────────────────────────────────────────
    # deploy.py is the SOLE owner of the 'start-admin' IngressRoute.
    # The Helm chart sets ingress.enabled=false so ArgoCD never renders or
    # manages this resource — eliminating the race condition where ArgoCD
    # sync re-rendered the IngressRoute with the ^PLACEHOLDER_NEVER_MATCHES$
    # default on every git push or 3-minute auto-sync cycle.
    #
    # On first deploy (Day-0) deploy.py CREATES the IngressRoute.
    # On all subsequent deploys it UPDATES the match rule in-place.
    # ArgoCD is not contacted anywhere in this step.
    #
    # FAILURE POLICY: any error is FATAL (sys.exit(1)).
    # The only legitimate skip is when the SSM parameter does not exist yet
    # (true Day-0 before a CloudFront distribution has been provisioned).
    try:
        from kubernetes import client  # noqa: PLC0415 — deferred import (optional dep)
        from kubernetes.client.rest import ApiException
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
        # Start-admin shares the same domain as the nextjs app, so we read
        # NEXTAUTH_URL from the shared /nextjs/{env}/auth/nextauth-url SSM prefix.
        ingress_host = ""
        nextauth_ssm = f"{cfg.frontend_ssm_prefix}/auth/nextauth-url"
        try:
            resp = ssm_client.get_parameter(Name=nextauth_ssm, WithDecryption=True)
            nextauth_url = resp["Parameter"]["Value"]
            parsed = urlparse(nextauth_url)
            ingress_host = parsed.hostname or ""
            log_info("Derived ingress host from NEXTAUTH_URL", host=ingress_host)
        except client_error_cls:
            log_warn("NEXTAUTH_URL not available — Host() rule will be skipped")

        custom_api = client.CustomObjectsApi(v1.api_client)

        # ── 5a: Build the IngressRoute manifest ──────────────────────────────────
        # Compose: optional Host() + PathPrefix(/admin) + HeaderRegexp(real secret).
        # PathPrefix(/admin) takes priority over nextjs PathPrefix(/) via Traefik's
        # longest-prefix-match resolution — no priority annotation needed.
        host_clause = f"Host(`{ingress_host}`) && " if ingress_host else ""
        match_rule = (
            f"{host_clause}PathPrefix(`/admin`) && "
            f"HeaderRegexp(`X-CloudFront-Origin-Secret`, `{origin_secret}`)"
        )
        ingressroute_manifest = {
            "apiVersion": "traefik.io/v1alpha1",
            "kind": "IngressRoute",
            "metadata": {
                "name": "start-admin",
                "namespace": "start-admin",
                "labels": {"app": "start-admin", "managed-by": "deploy.py"},
            },
            "spec": {
                # CloudFront sends origin requests on HTTPS/443 — websecure is
                # Traefik's name for the port-443 entrypoint. tls:{} enables
                # Traefik's built-in TLS termination for this route.
                "entryPoints": ["websecure"],
                "routes": [
                    {
                        "match": match_rule,
                        "kind": "Rule",
                        "services": [{"name": "start-admin", "port": 5001}],
                    }
                ],
                "tls": {},
            },
        }

        # ── 5b: Create-or-update (apply) the IngressRoute ──────────────────────
        # GET first: 200 → PATCH in-place.  404 → CREATE (Day-0 first deploy).
        try:
            custom_api.get_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="start-admin",
                plural="ingressroutes",
                name="start-admin",
            )
            custom_api.patch_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="start-admin",
                plural="ingressroutes",
                name="start-admin",
                body={"spec": ingressroute_manifest["spec"]},
            )
            log_info(
                "Updated IngressRoute 'start-admin' with current origin secret.",
                host=ingress_host,
                match_preview=match_rule[:120],
            )
        except ApiException as api_err:
            if api_err.status == 404:
                custom_api.create_namespaced_custom_object(
                    group="traefik.io",
                    version="v1alpha1",
                    namespace="start-admin",
                    plural="ingressroutes",
                    body=ingressroute_manifest,
                )
                log_info(
                    "Created IngressRoute 'start-admin' (Day-0 first deploy).",
                    host=ingress_host,
                    match_preview=match_rule[:120],
                )
            else:
                raise

        # ── 5b-preview: Create-or-update the Blue/Green preview IngressRoute ───
        # The preview IngressRoute (start-admin-preview) does NOT require the
        # CloudFront secret: it matches on X-Preview: true header at priority 100,
        # routing to the preview ReplicaSet for Blue/Green testing.
        preview_match_rule = (
            f"{host_clause}PathPrefix(`/admin`) && Header(`X-Preview`, `true`)"
        )
        preview_manifest = {
            "apiVersion": "traefik.io/v1alpha1",
            "kind": "IngressRoute",
            "metadata": {
                "name": "start-admin-preview",
                "namespace": "start-admin",
                "labels": {"app": "start-admin", "managed-by": "deploy.py"},
            },
            "spec": {
                "entryPoints": ["websecure"],
                "routes": [
                    {
                        "match": preview_match_rule,
                        "kind": "Rule",
                        "priority": 100,
                        "services": [{"name": "start-admin-preview", "port": 5001}],
                    }
                ],
                "tls": {},
            },
        }
        try:
            custom_api.get_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="start-admin",
                plural="ingressroutes",
                name="start-admin-preview",
            )
            custom_api.patch_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="start-admin",
                plural="ingressroutes",
                name="start-admin-preview",
                body={"spec": preview_manifest["spec"]},
            )
            log_info("Updated IngressRoute 'start-admin-preview'.", host=ingress_host)
        except ApiException as preview_err:
            if preview_err.status == 404:
                custom_api.create_namespaced_custom_object(
                    group="traefik.io",
                    version="v1alpha1",
                    namespace="start-admin",
                    plural="ingressroutes",
                    body=preview_manifest,
                )
                log_info("Created IngressRoute 'start-admin-preview' (Day-0).", host=ingress_host)
            else:
                raise

        # ── 5c: Verification read-back ─────────────────────────────────────────
        # Re-read the live IngressRoute to confirm the apply persisted.
        verify_ir = custom_api.get_namespaced_custom_object(
            group="traefik.io",
            version="v1alpha1",
            namespace="start-admin",
            plural="ingressroutes",
            name="start-admin",
        )
        verify_match = (
            verify_ir.get("spec", {})
                      .get("routes", [{}])[0]
                      .get("match", "")
        )
        _PLACEHOLDER = "^PLACEHOLDER_NEVER_MATCHES$"
        if _PLACEHOLDER in verify_match or not verify_match:
            log_error(
                "Verification FAILED: IngressRoute match rule is invalid after apply.",
                match=verify_match,
            )
            sys.exit(1)

        log_info(
            "Verification PASSED: IngressRoute is active with real origin secret.",
            match_preview=verify_match[:120],
        )

    except client_error_cls as e:
        # SSM ClientError means the CloudFront origin secret parameter does not exist
        # yet — legitimate skip on Day-0 before a CloudFront distribution is deployed.
        log_warn(
            "CloudFront origin secret not found in SSM — skipping IngressRoute apply.",
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
            "FATAL: Failed to apply IngressRoute with CloudFront Origin Secret.",
            error=str(e),
        )
        sys.exit(1)

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
