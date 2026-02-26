#!/usr/bin/env python3
"""Deploy monitoring stack via Helm thin chart.

Called by the SSM State Manager association on the control plane instance.
Resolves secrets from SSM, deploys the Helm chart, and waits for readiness.

Usage:
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides:
    CHART_DIR     — path to Helm chart  (default: /data/app-deploy/monitoring/chart)
    ENVIRONMENT   — values override     (default: development)
    SSM_PREFIX    — SSM parameter path  (default: /k8s/development)
    AWS_REGION    — AWS region          (default: eu-west-1)
    KUBECONFIG    — kubeconfig path     (default: /etc/kubernetes/admin.conf)
    S3_BUCKET     — re-sync from S3     (optional)
    WAIT_TIMEOUT  — readiness timeout   (default: 300)
"""

from __future__ import annotations

import base64
import logging
import os
import subprocess
import sys
import time
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
k8s_stream = None


def _load_dependencies() -> None:
    """Import third-party libraries. Called once from main() before real work."""
    global boto3, ClientError, k8s_client, k8s_config, k8s_stream

    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError
    from kubernetes import client as _k8s_client
    from kubernetes import config as _k8s_config
    from kubernetes.stream import stream as _k8s_stream

    boto3 = _boto3
    ClientError = _ClientError
    k8s_client = _k8s_client
    k8s_config = _k8s_config
    k8s_stream = _k8s_stream

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("monitoring-deploy")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
@dataclass
class Config:
    """Deployment configuration sourced from environment variables."""

    chart_dir: str = field(
        default_factory=lambda: os.getenv(
            "CHART_DIR",
            # Backward compat: old SSM docs pass MANIFESTS_DIR (kustomize era).
            # Derive chart path from it: .../manifests → .../chart
            str(Path(os.getenv("MANIFESTS_DIR", "/data/app-deploy/monitoring/manifests")).parent / "chart")
            if os.getenv("MANIFESTS_DIR")
            else "/data/app-deploy/monitoring/chart",
        )
    )
    environment: str = field(
        default_factory=lambda: os.getenv("ENVIRONMENT", "development")
    )
    ssm_prefix: str = field(
        default_factory=lambda: os.getenv("SSM_PREFIX", "/k8s/development")
    )
    aws_region: str = field(
        default_factory=lambda: os.getenv("AWS_REGION", "eu-west-1")
    )
    kubeconfig: str = field(
        default_factory=lambda: os.getenv(
            "KUBECONFIG", "/etc/kubernetes/admin.conf"
        )
    )
    s3_bucket: str = field(
        default_factory=lambda: os.getenv("S3_BUCKET", "")
    )
    s3_key_prefix: str = field(
        default_factory=lambda: os.getenv(
            "S3_KEY_PREFIX", "app-deploy/monitoring"
        )
    )
    wait_timeout: int = field(
        default_factory=lambda: int(os.getenv("WAIT_TIMEOUT", "300"))
    )
    release_name: str = "monitoring-stack"
    namespace: str = "monitoring"
    dry_run: bool = False

    # Resolved at runtime
    secrets: dict[str, str] = field(default_factory=dict)

    @property
    def values_file(self) -> Path:
        return Path(self.chart_dir) / f"values-{self.environment}.yaml"

    def print_banner(self) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        log.info("=== k8s Monitoring Stack Deployment (Helm/Python) ===")
        log.info("Chart:       %s", self.chart_dir)
        log.info("Environment: %s", self.environment)
        log.info("SSM prefix:  %s", self.ssm_prefix)
        log.info("Region:      %s", self.aws_region)
        log.info("Triggered:   %s", now)
        log.info("")


# ---------------------------------------------------------------------------
# Step 1: S3 sync  (thin CLI wrapper — s3 sync has no boto3 equivalent)
# ---------------------------------------------------------------------------
def sync_from_s3(cfg: Config) -> None:
    """Re-sync chart directory from S3 when S3_BUCKET is set."""
    if not cfg.s3_bucket:
        return

    log.info("=== Step 1: Re-syncing chart from S3 ===")
    sync_dir = str(Path(cfg.chart_dir).parent)
    src = f"s3://{cfg.s3_bucket}/{cfg.s3_key_prefix}/"

    _run_cmd(
        ["aws", "s3", "sync", src, f"{sync_dir}/", "--region", cfg.aws_region],
        check=True,
    )

    # Make scripts executable
    for sh in Path(sync_dir).rglob("*.sh"):
        sh.chmod(sh.stat().st_mode | 0o111)

    log.info("✓ Chart synced from %s", src)
    log.info("")


# ---------------------------------------------------------------------------
# Step 1b: Clean stale nodes
# ---------------------------------------------------------------------------
def clean_stale_nodes(v1: k8s_client.CoreV1Api) -> None:
    """Remove NotReady nodes left from previous terminated instances.

    kubeadm stores cluster state on the persistent EBS volume.
    Old etcd data may still contain node registrations from terminated
    instances. These stale nodes cause DaemonSets to schedule pods on
    dead nodes and block PVC binding.
    """
    log.info("=== Step 1b: Cleaning stale nodes ===")

    nodes = v1.list_node().items
    ready_nodes: list[str] = []
    stale_nodes: list[str] = []

    for node in nodes:
        name = node.metadata.name
        is_ready = _node_is_ready(node)
        if is_ready:
            ready_nodes.append(name)
        else:
            stale_nodes.append(name)

    log.info(
        "  Current Ready node(s): %s",
        ", ".join(ready_nodes) if ready_nodes else "none",
    )

    if stale_nodes:
        for name in stale_nodes:
            log.info("  → Deleting stale node: %s", name)
            try:
                v1.delete_node(
                    name=name,
                    body=k8s_client.V1DeleteOptions(
                        grace_period_seconds=0,
                    ),
                )
            except k8s_client.ApiException as exc:
                if exc.status != 404:
                    log.warning("  ⚠ Failed to delete node %s: %s", name, exc.reason)
        log.info("✓ Stale nodes cleaned")
    else:
        log.info("✓ No stale nodes found")

    log.info("")


def _node_is_ready(node: k8s_client.V1Node) -> bool:
    """Check if a node has condition Ready=True."""
    if not node.status or not node.status.conditions:
        return False
    for cond in node.status.conditions:
        if cond.type == "Ready":
            return cond.status == "True"
    return False


# ---------------------------------------------------------------------------
# Step 2: Resolve secrets from SSM
# ---------------------------------------------------------------------------
SSM_SECRET_MAP = {
    "grafana-admin-password": "GRAFANA_ADMIN_PASSWORD",
    "github-token": "GITHUB_TOKEN",
}


def resolve_ssm_secrets(cfg: Config) -> dict[str, str]:
    """Fetch secrets from SSM Parameter Store using boto3.

    Returns a dict of env_var_name → value for all resolved secrets.
    If a value already exists as a non-placeholder env var, it is preserved.
    """
    log.info("=== Step 2: Resolving secrets from SSM ===")

    ssm = boto3.client("ssm", region_name=cfg.aws_region)
    secrets: dict[str, str] = {}

    for param_name, env_var in SSM_SECRET_MAP.items():
        # Check for environment override
        existing = os.getenv(env_var, "")
        if existing and existing != f"__{env_var}__":
            log.info("  ✓ %s: using environment override", env_var)
            secrets[env_var] = existing
            continue

        ssm_path = f"{cfg.ssm_prefix}/{param_name}"
        log.info("  → Resolving %s from SSM: %s", env_var, ssm_path)

        try:
            resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
            value = resp["Parameter"]["Value"]
            secrets[env_var] = value
            log.info("  ✓ %s: resolved from SSM", env_var)
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code == "ParameterNotFound":
                log.warning("  ⚠ %s: not found in SSM, skipping", env_var)
            else:
                log.warning("  ⚠ %s: SSM error (%s), skipping", env_var, code)

    log.info("")
    return secrets


# ---------------------------------------------------------------------------
# Step 2b: Create Kubernetes secrets
# ---------------------------------------------------------------------------
def create_k8s_secrets(
    v1: k8s_client.CoreV1Api,
    cfg: Config,
) -> None:
    """Create or update Kubernetes Secrets from resolved SSM values.

    Uses an idempotent upsert pattern: try create, on 409 Conflict → replace.
    """
    log.info("=== Step 2b: Creating Kubernetes secrets ===")

    # Ensure namespace exists
    _ensure_namespace(v1, cfg.namespace)

    secrets = cfg.secrets

    # Grafana credentials
    grafana_pw = secrets.get("GRAFANA_ADMIN_PASSWORD")
    if grafana_pw:
        _upsert_secret(
            v1,
            name="grafana-credentials",
            namespace=cfg.namespace,
            data={"admin-user": "admin", "admin-password": grafana_pw},
        )
        log.info("  ✓ grafana-credentials secret created/updated")

    # GitHub Actions Exporter credentials
    gh_token = secrets.get("GITHUB_TOKEN")
    if gh_token:
        _upsert_secret(
            v1,
            name="github-actions-exporter-credentials",
            namespace=cfg.namespace,
            data={"github-token": gh_token},
        )
        log.info("  ✓ github-actions-exporter-credentials secret created/updated")

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
# Step 3: Deploy via Helm
# ---------------------------------------------------------------------------
def deploy_helm_chart(cfg: Config) -> None:
    """Run helm upgrade --install for the monitoring chart."""
    log.info("=== Step 3: Deploying monitoring chart ===")

    cmd = [
        "helm",
        "upgrade",
        "--install",
        cfg.release_name,
        cfg.chart_dir,
        "--namespace",
        cfg.namespace,
        "--create-namespace",
        "--wait",
        "--timeout",
        f"{cfg.wait_timeout}s",
    ]

    values_file = cfg.values_file
    if values_file.exists():
        cmd.extend(["-f", str(values_file)])
        log.info("  Using values override: %s", values_file)

    _run_cmd(cmd, check=True)

    log.info("")
    log.info("✓ Helm release '%s' deployed", cfg.release_name)
    log.info("")


# ---------------------------------------------------------------------------
# Step 4: Verify pod readiness
# ---------------------------------------------------------------------------
DEPLOYMENTS = [
    "prometheus",
    "grafana",
    "loki",
    "tempo",
    "kube-state-metrics",
    "github-actions-exporter",
    "steampipe",
]
DAEMONSETS = ["promtail", "node-exporter"]


def verify_pod_readiness(
    apps_v1: k8s_client.AppsV1Api,
    cfg: Config,
) -> None:
    """Wait for all Deployments and DaemonSets to reach ready state."""
    log.info("=== Step 4: Verifying pod readiness ===")

    for name in DEPLOYMENTS:
        _wait_for_deployment(apps_v1, name, cfg.namespace, cfg.wait_timeout)

    for name in DAEMONSETS:
        _wait_for_daemonset(apps_v1, name, cfg.namespace, cfg.wait_timeout)

    log.info("")


def _wait_for_deployment(
    apps_v1: k8s_client.AppsV1Api,
    name: str,
    namespace: str,
    timeout: int,
) -> None:
    """Poll a Deployment until all replicas are available or timeout."""
    log.info("  → Checking deployment/%s...", name)
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        try:
            dep = apps_v1.read_namespaced_deployment(name=name, namespace=namespace)
            status = dep.status
            desired = dep.spec.replicas or 1
            available = status.available_replicas or 0
            updated = status.updated_replicas or 0

            if available >= desired and updated >= desired:
                log.info("  ✓ deployment/%s ready (%d/%d)", name, available, desired)
                return
        except k8s_client.ApiException as exc:
            if exc.status == 404:
                pass  # Not created yet — keep waiting
            else:
                log.warning("  ⚠ deployment/%s: API error %s", name, exc.reason)

        time.sleep(5)

    log.warning("  ⚠ deployment/%s not ready within %ds timeout", name, timeout)


def _wait_for_daemonset(
    apps_v1: k8s_client.AppsV1Api,
    name: str,
    namespace: str,
    timeout: int,
) -> None:
    """Poll a DaemonSet until all pods are scheduled and ready or timeout."""
    log.info("  → Checking daemonset/%s...", name)
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        try:
            ds = apps_v1.read_namespaced_daemon_set(name=name, namespace=namespace)
            status = ds.status
            desired = status.desired_number_scheduled or 0
            ready = status.number_ready or 0

            if desired > 0 and ready >= desired:
                log.info("  ✓ daemonset/%s ready (%d/%d)", name, ready, desired)
                return
        except k8s_client.ApiException as exc:
            if exc.status == 404:
                pass
            else:
                log.warning("  ⚠ daemonset/%s: API error %s", name, exc.reason)

        time.sleep(5)

    log.warning("  ⚠ daemonset/%s not ready within %ds timeout", name, timeout)


# ---------------------------------------------------------------------------
# Step 4b: Reset Grafana admin password
# ---------------------------------------------------------------------------
def reset_grafana_password(
    v1: k8s_client.CoreV1Api,
    cfg: Config,
) -> None:
    """Reset Grafana admin password via grafana-cli exec.

    Grafana persists the admin password in its internal SQLite database
    on the PVC. The GF_SECURITY_ADMIN_PASSWORD env var only takes effect
    on first boot. This step forces the password from SSM into Grafana's
    database on every deploy.
    """
    password = cfg.secrets.get("GRAFANA_ADMIN_PASSWORD")
    if not password:
        return

    log.info("=== Step 4b: Resetting Grafana admin password ===")

    # Find the Grafana pod (retry up to 30s for pod startup)
    pod_name = _find_pod_with_retry(
        v1, cfg.namespace, label_selector="app=grafana", timeout=30
    )

    if not pod_name:
        log.warning("  ⚠ No Grafana pod found — skipping password reset")
        log.info("")
        return

    try:
        resp = k8s_stream(
            v1.connect_get_namespaced_pod_exec,
            pod_name,
            cfg.namespace,
            command=[
                "grafana-cli",
                "admin",
                "reset-admin-password",
                password,
            ],
            stderr=True,
            stdin=False,
            stdout=True,
            tty=False,
        )
        log.info("  ✓ Grafana admin password reset")
        log.debug("  grafana-cli output: %s", resp)
    except Exception as exc:
        log.warning(
            "  ⚠ grafana-cli reset failed (pod may still be starting): %s", exc
        )

    log.info("")


def _find_pod_with_retry(
    v1: k8s_client.CoreV1Api,
    namespace: str,
    label_selector: str,
    timeout: int = 30,
) -> Optional[str]:
    """Find a running pod by label selector, retrying until timeout."""
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        pods = v1.list_namespaced_pod(
            namespace=namespace, label_selector=label_selector
        )
        for pod in pods.items:
            if pod.status.phase == "Running":
                return pod.metadata.name
        time.sleep(3)

    return None


# ---------------------------------------------------------------------------
# Step 5: Summary
# ---------------------------------------------------------------------------
def print_summary(cfg: Config) -> None:
    """Print deployment summary — pods, services, and DNS endpoints."""
    log.info("=== Deployment Summary ===")
    log.info("")

    _run_cmd(
        ["kubectl", "get", "pods", "-n", cfg.namespace, "-o", "wide"],
        check=False,
    )
    log.info("")
    _run_cmd(
        ["kubectl", "get", "svc", "-n", cfg.namespace],
        check=False,
    )
    log.info("")

    ns = cfg.namespace
    log.info("=== In-cluster Service Discovery ===")
    log.info("  Loki:       http://loki.%s.svc.cluster.local:3100", ns)
    log.info("  Tempo gRPC: http://tempo.%s.svc.cluster.local:4317", ns)
    log.info("  Tempo HTTP: http://tempo.%s.svc.cluster.local:4318", ns)
    log.info("  Prometheus: http://prometheus.%s.svc.cluster.local:9090", ns)
    log.info("")
    log.info("=== Access ===")
    log.info("  Grafana:    kubectl port-forward svc/grafana 3000:3000 -n %s", ns)
    log.info("  Prometheus: kubectl port-forward svc/prometheus 9090:9090 -n %s", ns)
    log.info("")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log.info("✓ Monitoring stack deployment complete (%s)", now)


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
        log.info("  chart_dir:    %s", cfg.chart_dir)
        log.info("  environment:  %s", cfg.environment)
        log.info("  values_file:  %s (exists: %s)", cfg.values_file, cfg.values_file.exists())
        log.info("  ssm_prefix:   %s", cfg.ssm_prefix)
        log.info("  aws_region:   %s", cfg.aws_region)
        log.info("  kubeconfig:   %s", cfg.kubeconfig)
        log.info("  s3_bucket:    %s", cfg.s3_bucket or "(none)")
        log.info("  wait_timeout: %ds", cfg.wait_timeout)
        log.info("  release_name: %s", cfg.release_name)
        log.info("  namespace:    %s", cfg.namespace)
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
    apps_v1 = k8s_client.AppsV1Api()

    # Step 1b: Clean stale nodes
    clean_stale_nodes(v1)

    # Step 2: Resolve secrets from SSM
    cfg.secrets = resolve_ssm_secrets(cfg)

    # Step 2b: Create Kubernetes secrets
    create_k8s_secrets(v1, cfg)

    # Step 3: Deploy via Helm
    deploy_helm_chart(cfg)

    # Step 4: Verify pod readiness
    verify_pod_readiness(apps_v1, cfg)

    # Step 4b: Reset Grafana password
    reset_grafana_password(v1, cfg)

    # Step 5: Summary
    print_summary(cfg)


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
