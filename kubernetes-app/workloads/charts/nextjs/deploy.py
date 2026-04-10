#!/usr/bin/env python3
"""Create Next.js Kubernetes resources (Secret + ConfigMap) from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.
Resolves parameters from SSM Parameter Store and creates/updates:
  - ``nextjs-secrets``  K8s Secret  — sensitive auth values only
  - ``nextjs-config``   K8s ConfigMap — non-sensitive config (table names, ARNs, region)

Helm chart deployment is handled by ArgoCD. The Traefik IngressRoute
is created/updated by Step 5 of this script (sole owner).

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

    # Bedrock Agent: resolve API URL, API key, revalidation secret, and
    # pipeline ARNs.  All calls go through resolve_secrets() so logging,
    # env-override, and error-handling follow a single path.
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
    bedrock_prefix = f"/bedrock-{cfg.short_env}"
    bedrock_secrets = resolve_secrets(
        ssm_client,
        bedrock_prefix,
        _BEDROCK_AGENT_PARAMS,
        client_error_cls=client_error_cls,
    )
    secrets.update(bedrock_secrets)

    # BFF service URLs — dedicated helper ensures a single resolution path
    # and consistent in-cluster fallback for both admin-api and public-api.
    bff = resolve_bff_urls(ssm_client, cfg.short_env, client_error_cls)
    secrets["PUBLIC_API_URL"] = bff.public_api_url

    # Derived config: SSM prefix for Bedrock parameters.
    # Used by publish-draft API route to locate infrastructure.
    # NOTE: This is non-sensitive — injected via ConfigMap, not Secret.
    secrets["SSM_BEDROCK_PREFIX"] = bedrock_prefix

    # DynamoDB GSI names — constants matching CDK ai-content-stack.ts.
    # Explicitly injected rather than relying on fallback defaults in
    # the frontend code (dynamodb-articles.ts).
    # NOTE: These are constants — injected via ConfigMap, not Secret.
    secrets["DYNAMODB_GSI1_NAME"] = "gsi1-status-date"
    secrets["DYNAMODB_GSI2_NAME"] = "gsi2-tag-date"

    return secrets


# ---------------------------------------------------------------------------
# App-specific: K8s resource creation (Secret + ConfigMap)
#
# Separation rationale:
#   _NEXTJS_SECRET_KEYS  — values requiring encryption at rest; stored in an
#                          Opaque K8s Secret (base64-encoded by the API server).
#   _NEXTJS_CONFIG_KEYS  — non-sensitive config strings (table names, bucket
#                          names, ARNs, constants); stored in a plain ConfigMap.
#
# The Rollout template uses:
#   envFrom:
#     - secretRef:    { name: nextjs-secrets }
#     - configMapRef: { name: nextjs-config  }
# ---------------------------------------------------------------------------

_NEXTJS_SECRET_KEYS = [
    # Auth — always sensitive
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "AUTH_COGNITO_USER_POOL_ID",
    "AUTH_COGNITO_ID",
    "AUTH_COGNITO_ISSUER",
    "AUTH_COGNITO_DOMAIN",
    # API credentials — always sensitive
    "BEDROCK_AGENT_API_KEY",
    "REVALIDATION_SECRET",
    # API Gateway URL for subscriptions (contains account ID in hostname)
    "NEXT_PUBLIC_API_URL",
]

_NEXTJS_CONFIG_KEYS = [
    # Non-sensitive infrastructure references — safe to store in ConfigMap
    "DYNAMODB_TABLE_NAME",
    "DYNAMODB_GSI1_NAME",
    "DYNAMODB_GSI2_NAME",
    "ASSETS_BUCKET_NAME",
    "BEDROCK_AGENT_API_URL",
    "SSM_BEDROCK_PREFIX",
    "PUBLISH_LAMBDA_ARN",
    "STRATEGIST_TABLE_NAME",
    "STRATEGIST_TRIGGER_ARN",
    # BFF: public-api base URL — used by /api/resume/active proxy route
    "PUBLIC_API_URL",
]


def create_nextjs_k8s_resources(v1: object, cfg: NextjsConfig) -> None:
    """Create or update the nextjs-secrets K8s Secret and nextjs-config ConfigMap.

    Splits resolved SSM parameters into two K8s objects:
    - ``nextjs-secrets`` (Opaque Secret)  — auth tokens, API keys, Cognito config.
    - ``nextjs-config``  (ConfigMap)       — table names, bucket name, ARNs, region.

    Both are consumed by the Rollout via ``envFrom`` (secretRef + configMapRef).
    The pod environment is identical to before — only the K8s backing object changes.

    Args:
        v1: Kubernetes ``CoreV1Api`` instance.
        cfg: Next.js deployment configuration with resolved secrets.
    """
    log_info("=== Creating Kubernetes resources ===")
    ensure_namespace(v1, cfg.namespace)

    # --- Secret (sensitive auth values only) ---
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

    if secret_data:
        upsert_secret(v1, "nextjs-secrets", cfg.namespace, secret_data)
        log_info("nextjs-secrets created/updated", keys=len(secret_data))
    else:
        log_warn("No secrets resolved — skipping secret creation")

    # --- ConfigMap (non-sensitive config values) ---
    config_data: dict[str, str] = {}
    for key in _NEXTJS_CONFIG_KEYS:
        value = cfg.secrets.get(key, "")
        if value:
            config_data[key] = value

    # AWS_DEFAULT_REGION is needed by the AWS SDK default credential chain.
    # Stored in ConfigMap (not Secret) — region is not a sensitive value.
    config_data["AWS_DEFAULT_REGION"] = cfg.aws_region

    if config_data:
        upsert_configmap(v1, "nextjs-config", cfg.namespace, config_data)
        log_info("nextjs-config created/updated", keys=len(config_data))
    else:
        log_warn("No config values resolved — skipping ConfigMap creation")


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

    # Step 4: Create Kubernetes Secret + ConfigMap
    create_nextjs_k8s_resources(v1, cfg)

    # Step 5: Create / Update the Traefik IngressRoute with the real CloudFront secret
    #
    # ── OWNERSHIP MODEL ──────────────────────────────────────────────────────────
    # deploy.py is the SOLE owner of the 'nextjs' IngressRoute.
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

        # History is ordered oldest to newest — latest version is last.
        latest = history[-1]
        origin_secret = latest["Value"]
        latest_version = latest.get("Version", "?")
        latest_time = latest["LastModifiedDate"]
        now = datetime.now(timezone.utc)

        # ── Version-alignment log ─────────────────────────────────────────────
        # This version number MUST match the version that the Edge stack's
        # AwsCustomResource deployed to CloudFront.  If they diverge (e.g.
        # because the SSM parameter was overwritten between the Edge deploy and
        # this deploy.py run), the origin secret embedded in the IngressRoute
        # will not match the value CloudFront is sending in X-CloudFront-Origin-Secret,
        # causing 403s.  Check the CloudFormation events for ReadCloudfrontOriginSecret
        # to confirm which version it resolved.
        log_info(
            "Resolved latest CloudFront origin secret version",
            ssm_path=cf_secret_path,
            ssm_version=latest_version,
            last_modified=latest_time.isoformat() if hasattr(latest_time, "isoformat") else str(latest_time),
            total_versions=len(history),
        )

        # If there are at least 2 versions and the latest rotation was < 20 min ago,
        # use a regex OR pattern to allow both secrets temporarily (zero-downtime rotation).
        if len(history) >= 2 and (now - latest_time).total_seconds() < 20 * 60:
            previous_secret = history[-2]["Value"]
            previous_version = history[-2].get("Version", "?")
            old_escaped = re.escape(previous_secret)
            new_escaped = re.escape(origin_secret)
            origin_secret = f"{old_escaped}|{new_escaped}"
            log_info(
                "Secret rotated recently. Using dual-secret regex for zero-downtime.",
                previous_version=previous_version,
                latest_version=latest_version,
                minutes_since_rotation=round((now - latest_time).total_seconds() / 60, 1),
            )
        else:
            log_info(
                "Using single origin secret.",
                ssm_version=latest_version,
            )

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

        custom_api = client.CustomObjectsApi(v1.api_client)

        # ── 5a: Build the IngressRoute manifest ──────────────────────────────────
        # Compose: optional Host() + PathPrefix + HeaderRegexp(real secret).
        host_clause = f"Host(`{ingress_host}`) && " if ingress_host else ""
        match_rule = (
            f"{host_clause}PathPrefix(`/`) && "
            f"HeaderRegexp(`X-CloudFront-Origin-Secret`, `{origin_secret}`)"
        )
        ingressroute_manifest = {
            "apiVersion": "traefik.io/v1alpha1",
            "kind": "IngressRoute",
            "metadata": {
                "name": "nextjs",
                "namespace": "nextjs-app",
                "labels": {"app": "nextjs", "managed-by": "deploy.py"},
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
                        "services": [{"name": "nextjs", "port": 3000}],
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
                namespace="nextjs-app",
                plural="ingressroutes",
                name="nextjs",
            )
            custom_api.patch_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="nextjs-app",
                plural="ingressroutes",
                name="nextjs",
                body={"spec": ingressroute_manifest["spec"]},
            )
            log_info(
                "Updated IngressRoute 'nextjs' with current origin secret.",
                host=ingress_host,
                match_preview=match_rule[:120],
            )
        except ApiException as api_err:
            if api_err.status == 404:
                custom_api.create_namespaced_custom_object(
                    group="traefik.io",
                    version="v1alpha1",
                    namespace="nextjs-app",
                    plural="ingressroutes",
                    body=ingressroute_manifest,
                )
                log_info(
                    "Created IngressRoute 'nextjs' (Day-0 first deploy).",
                    host=ingress_host,
                    match_preview=match_rule[:120],
                )
            else:
                raise
        # ── 5b-preview: Create-or-update the Blue/Green preview IngressRoute ──────
        # The preview IngressRoute (nextjs-preview) also gates on ingress.enabled in
        # the Helm chart — since we set ingress.enabled=false, deploy.py owns this too.
        # The preview route does NOT require the CloudFront secret: it matches on
        # X-Preview: true header at priority 100, routing to the preview ReplicaSet.
        # This enables Blue/Green testing without affecting production traffic.
        preview_match_rule = (
            f"{host_clause}PathPrefix(`/`) && Header(`X-Preview`, `true`)"
        )
        preview_manifest = {
            "apiVersion": "traefik.io/v1alpha1",
            "kind": "IngressRoute",
            "metadata": {
                "name": "nextjs-preview",
                "namespace": "nextjs-app",
                "labels": {"app": "nextjs", "managed-by": "deploy.py"},
            },
            "spec": {
                "entryPoints": ["websecure"],
                "routes": [
                    {
                        "match": preview_match_rule,
                        "kind": "Rule",
                        "priority": 100,
                        "services": [{"name": "nextjs-preview", "port": 3000}],
                    }
                ],
                "tls": {},
            },
        }
        try:
            custom_api.get_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="nextjs-app",
                plural="ingressroutes",
                name="nextjs-preview",
            )
            custom_api.patch_namespaced_custom_object(
                group="traefik.io",
                version="v1alpha1",
                namespace="nextjs-app",
                plural="ingressroutes",
                name="nextjs-preview",
                body={"spec": preview_manifest["spec"]},
            )
            log_info("Updated IngressRoute 'nextjs-preview'.", host=ingress_host)
        except ApiException as preview_err:
            if preview_err.status == 404:
                custom_api.create_namespaced_custom_object(
                    group="traefik.io",
                    version="v1alpha1",
                    namespace="nextjs-app",
                    plural="ingressroutes",
                    body=preview_manifest,
                )
                log_info("Created IngressRoute 'nextjs-preview' (Day-0).", host=ingress_host)
            else:
                raise

        # ── 5c: Verification read-back ─────────────────────────────────────────
        # Re-read the live IngressRoute to confirm the apply persisted.
        verify_ir = custom_api.get_namespaced_custom_object(
            group="traefik.io",
            version="v1alpha1",
            namespace="nextjs-app",
            plural="ingressroutes",
            name="nextjs",
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
