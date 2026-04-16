#!/usr/bin/env python3
"""Create wiki-mcp Kubernetes resources from SSM parameters.

Called by the Config Orchestrator (SM-B) on the control-plane instance.

Creates/updates:
  - wiki-mcp           Namespace
  - wiki-mcp-config    ConfigMap  — WIKI_S3_BUCKET (derived from environment)
  - wiki-mcp-basicauth Secret     — htpasswd users file (from SSM SecureString)

Credential model
----------------
  AWS SDK credentials: EC2 Instance Profile (IMDS) — no K8s secrets.
  wiki-mcp-basicauth:  Opaque Secret; users key is an htpasswd-format string
                       generated once by the operator and stored in SSM at:
                         /wiki-mcp/htpasswd-users   (SecureString)

Operator one-time setup (run once before first deploy)
------------------------------------------------------
  1. Generate the htpasswd hash and store in SSM:
       htpasswd -nb mcp <password> > /tmp/wiki_users.txt
       aws ssm put-parameter \\
         --name /wiki-mcp/htpasswd-users \\
         --value "$(cat /tmp/wiki_users.txt)" \\
         --type SecureString

  2. Store the Lambda auth header in SSM:
       aws ssm put-parameter \\
         --name /wiki-mcp/basicauth-header \\
         --value "Basic $(echo -n 'mcp:<password>' | base64)" \\
         --type SecureString

  Both parameters are long-lived. Re-run only during credential rotation.

SSM paths read by this script
------------------------------
  /wiki-mcp/htpasswd-users      — htpasswd string for Traefik basicAuth middleware
                                   (SecureString; required — skip secret creation if absent)

SSM paths NOT read here (used by other consumers)
--------------------------------------------------
  /wiki-mcp/basicauth-header    — Lambda reads this at runtime (CloudFormation resolves it
                                   at stack synth via {{resolve:ssm-secure:...}})

Usage
-----
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides
---------------------
    SSM_PREFIX       — SSM prefix for cluster info  (default: /k8s/development)
    AWS_REGION       — AWS region                   (default: eu-west-1)
    KUBECONFIG       — kubeconfig path              (default: /etc/kubernetes/admin.conf)
    S3_BUCKET        — re-sync scripts from S3      (optional)
    S3_KEY_PREFIX    — S3 key prefix                (default: k8s)
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Ensure deploy_helpers is importable from the k8s-bootstrap directory.
# On EC2:  /data/k8s-bootstrap/deploy_helpers/
# Locally: relative to this file's grandparent (kubernetes-app/k8s-bootstrap/)
_BOOTSTRAP_DIR = os.environ.get(
    "DEPLOY_HELPERS_PATH",
    str(Path(__file__).resolve().parents[2] / "k8s-bootstrap"),
)
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

from deploy_helpers.config import DeployConfig
from deploy_helpers.k8s import ensure_namespace, load_k8s, upsert_configmap, upsert_secret
from deploy_helpers.logging import log_info, log_warn
from deploy_helpers.s3 import sync_from_s3

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: CDK flatName() short environment abbreviations (mirrors environments.ts shortEnv()).
SHORT_ENV_MAP: dict[str, str] = {
    "development": "dev",
    "staging":     "stg",
    "production":  "prd",
}

#: SSM path for the htpasswd users file (SecureString, operator-populated).
#: Value format: "mcp:$apr1$..." (output of `htpasswd -nb mcp <password>`)
_HTPASSWD_SSM_PATH = "/wiki-mcp/htpasswd-users"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass
class WikiMcpConfig(DeployConfig):
    """wiki-mcp-specific deployment configuration.

    Extends DeployConfig with the namespace field.
    The K8s resources are always created in the ``wiki-mcp`` namespace.
    """

    namespace: str = "wiki-mcp"

    @property
    def environment_name(self) -> str:
        """Extract environment name from ssm_prefix (e.g. 'development')."""
        return self.ssm_prefix.rsplit("/", 1)[-1]

    @property
    def short_env(self) -> str:
        """Short environment abbreviation for CDK resource names."""
        return SHORT_ENV_MAP.get(self.environment_name, self.environment_name)

    @property
    def kb_bucket_name(self) -> str:
        """Knowledge base S3 bucket name — CDK-deterministic, no SSM lookup.

        CDK AiContentStack names the bucket: bedrock-{short_env}-kb-data
        Matches: kubernetes-app/workloads/charts/wiki-mcp/chart/values.yaml
                 env.WIKI_S3_BUCKET configMapKeyRef: wiki-mcp-config/WIKI_S3_BUCKET
        """
        return f"bedrock-{self.short_env}-kb-data"


# ---------------------------------------------------------------------------
# boto3 lazy loader
# ---------------------------------------------------------------------------


def _load_boto3() -> tuple:
    """Lazily import boto3 and ClientError.

    Returns:
        Tuple of (boto3_module, ClientError_class).
    """
    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError

    return _boto3, _ClientError


# ---------------------------------------------------------------------------
# SSM resolution
# ---------------------------------------------------------------------------


def _resolve_htpasswd(ssm_client: object, client_error_cls: type) -> str | None:
    """Fetch the htpasswd users string from SSM.

    The operator pre-populates /wiki-mcp/htpasswd-users once:
      htpasswd -nb mcp <password> > /tmp/users.txt
      aws ssm put-parameter --name /wiki-mcp/htpasswd-users \\
        --value "$(cat /tmp/users.txt)" --type SecureString

    Returns None (with a warning) when the parameter is absent — first-run
    before the operator has seeded the secret. The ConfigMap is still created;
    the Secret creation is skipped.

    Args:
        ssm_client: boto3 SSM client.
        client_error_cls: botocore ClientError class.

    Returns:
        htpasswd string (e.g. ``mcp:$apr1$...``) or None.
    """
    log_info("Fetching htpasswd users from SSM", ssm_path=_HTPASSWD_SSM_PATH)
    try:
        resp = ssm_client.get_parameter(Name=_HTPASSWD_SSM_PATH, WithDecryption=True)
        value = resp["Parameter"]["Value"].strip()
        log_info("Resolved htpasswd users", ssm_path=_HTPASSWD_SSM_PATH)
        return value
    except client_error_cls:
        log_warn(
            "htpasswd-users not found in SSM — wiki-mcp-basicauth Secret will NOT be created. "
            "Run operator setup to seed /wiki-mcp/htpasswd-users before traffic is routed.",
            ssm_path=_HTPASSWD_SSM_PATH,
        )
        return None


# ---------------------------------------------------------------------------
# K8s resource creation
# ---------------------------------------------------------------------------


def create_wiki_mcp_k8s_resources(
    v1: object,
    cfg: WikiMcpConfig,
    htpasswd_users: str | None,
) -> None:
    """Create or update wiki-mcp namespace, ConfigMap, and optional Secret.

    Resources created:
      wiki-mcp-config     ConfigMap — WIKI_S3_BUCKET (non-sensitive)
      wiki-mcp-basicauth  Secret    — users key (htpasswd format, for Traefik basicAuth)

    The Secret creation is skipped when ``htpasswd_users`` is None (parameter
    not yet seeded). The pod will start but Traefik will reject all requests
    until the Secret is created and the pod restarts.

    Args:
        v1: Kubernetes CoreV1Api instance.
        cfg: wiki-mcp deployment configuration.
        htpasswd_users: Pre-generated htpasswd string from SSM, or None.
    """
    log_info("=== Creating Kubernetes resources for wiki-mcp ===")

    # ── Namespace ────────────────────────────────────────────────────────────
    ensure_namespace(v1, cfg.namespace)

    # ── ConfigMap ────────────────────────────────────────────────────────────
    # WIKI_S3_BUCKET is derived from the environment — CDK deterministic name.
    # Not sensitive: safe to store in a ConfigMap.
    config_data = {"WIKI_S3_BUCKET": cfg.kb_bucket_name}
    upsert_configmap(v1, "wiki-mcp-config", cfg.namespace, config_data)
    log_info(
        "wiki-mcp-config created/updated",
        WIKI_S3_BUCKET=cfg.kb_bucket_name,
    )

    # ── Secret ───────────────────────────────────────────────────────────────
    # The basicAuth secret holds the htpasswd-format users file consumed by the
    # Traefik BasicAuth middleware.  Equivalent to:
    #   kubectl create secret generic wiki-mcp-basicauth \
    #     --from-literal=users="$(htpasswd -nb mcp <pwd>)" -n wiki-mcp
    #
    # Skipped (with a warning) when the SSM parameter hasn't been seeded yet.
    if htpasswd_users:
        upsert_secret(v1, "wiki-mcp-basicauth", cfg.namespace, {"users": htpasswd_users})
        log_info("wiki-mcp-basicauth created/updated")
    else:
        log_warn(
            "wiki-mcp-basicauth Secret SKIPPED — /wiki-mcp/htpasswd-users not in SSM. "
            "Traefik BasicAuth middleware will reject all requests to /wiki-mcp until "
            "the Secret is created and wiki-mcp pods are restarted.",
        )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    """Main entrypoint for wiki-mcp deploy script.

    Steps:
      1. Optionally sync scripts from S3 (S3_BUCKET env var).
      2. Fetch htpasswd users string from SSM.
      3. Create/update K8s ConfigMap and Secret.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Deploy wiki-mcp K8s resources from SSM")
    parser.add_argument("--dry-run", action="store_true", help="Print resolved config and exit")
    args = parser.parse_args()

    cfg = WikiMcpConfig()

    # Step 1: Optional S3 sync
    if cfg.s3_bucket:
        log_info("Syncing scripts from S3", bucket=cfg.s3_bucket)
        sync_from_s3(cfg.s3_bucket, cfg.s3_key_prefix, cfg.manifests_dir if hasattr(cfg, "manifests_dir") else "/data/app-deploy/wiki-mcp", cfg.aws_region)

    boto3, ClientError = _load_boto3()
    ssm_client = boto3.client("ssm", region_name=cfg.aws_region)

    # Step 2: Fetch htpasswd from SSM
    htpasswd_users = _resolve_htpasswd(ssm_client, ClientError)

    if args.dry_run:
        log_info("=== DRY RUN — no K8s resources created ===")
        log_info("ConfigMap wiki-mcp-config", WIKI_S3_BUCKET=cfg.kb_bucket_name)
        if htpasswd_users:
            log_info("Secret wiki-mcp-basicauth", users_preview=htpasswd_users[:20] + "...")
        else:
            log_warn("Secret wiki-mcp-basicauth will be SKIPPED — SSM param absent")
        return

    # Step 3: Create/update K8s resources
    v1 = load_k8s(cfg.kubeconfig)
    create_wiki_mcp_k8s_resources(v1, cfg, htpasswd_users)

    log_info("=== wiki-mcp deploy complete ===")


if __name__ == "__main__":
    main()
