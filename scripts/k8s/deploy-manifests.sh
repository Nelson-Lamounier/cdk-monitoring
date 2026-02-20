#!/usr/bin/env bash
# @format
# deploy-manifests.sh — Deploy monitoring stack to k3s
#
# This script is executed by the k3s instance UserData after k3s is
# installed and kubectl is configured. It:
#   1. Substitutes secret placeholders with real values from SSM
#   2. Applies all manifests via kustomize
#   3. Waits for pods to reach Ready state
#
# Usage:
#   ./deploy-manifests.sh [--manifests-dir DIR] [--ssm-prefix PREFIX]
#
# Environment variables (optional overrides):
#   MANIFESTS_DIR      Path to manifests directory (default: /data/k8s/manifests)
#   SSM_PREFIX         SSM parameter prefix (default: /k8s/development)
#   GRAFANA_ADMIN_PASSWORD   Override Grafana admin password
#   GITHUB_TOKEN             Override GitHub token for GH Actions Exporter

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MANIFESTS_DIR="${MANIFESTS_DIR:-/data/k8s/manifests}"
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"

echo "=== k8s Monitoring Stack Deployment ==="
echo "Manifests: ${MANIFESTS_DIR}"
echo "SSM prefix: ${SSM_PREFIX}"
echo ""

# ---------------------------------------------------------------------------
# 1. Resolve secrets from SSM (if not already set via env)
# ---------------------------------------------------------------------------
resolve_secret() {
    local param_name="$1"
    local env_var="$2"
    local current_value="${!env_var:-}"

    if [ -n "$current_value" ] && [ "$current_value" != "__${env_var}__" ]; then
        echo "  ✓ ${env_var}: using environment override"
        return
    fi

    local ssm_path="${SSM_PREFIX}/${param_name}"
    echo "  → Resolving ${env_var} from SSM: ${ssm_path}"

    local value
    value=$(aws ssm get-parameter \
        --name "${ssm_path}" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text \
        --region "${AWS_REGION}" 2>/dev/null || echo "")

    if [ -n "$value" ]; then
        export "${env_var}=${value}"
        echo "  ✓ ${env_var}: resolved from SSM"
    else
        echo "  ⚠ ${env_var}: not found in SSM, using placeholder"
    fi
}

echo "Resolving secrets..."
resolve_secret "grafana-admin-password" "GRAFANA_ADMIN_PASSWORD"
resolve_secret "github-token" "GITHUB_TOKEN"
echo ""

# ---------------------------------------------------------------------------
# 2. Substitute secret placeholders in manifests
# ---------------------------------------------------------------------------
echo "Substituting secret placeholders..."

# Grafana admin password
if [ -n "${GRAFANA_ADMIN_PASSWORD:-}" ]; then
    sed -i "s|__GRAFANA_ADMIN_PASSWORD__|${GRAFANA_ADMIN_PASSWORD}|g" \
        "${MANIFESTS_DIR}/grafana/secret.yaml"
    echo "  ✓ Grafana admin password injected"
fi

# GitHub token
if [ -n "${GITHUB_TOKEN:-}" ]; then
    sed -i "s|__GITHUB_TOKEN__|${GITHUB_TOKEN}|g" \
        "${MANIFESTS_DIR}/github-actions-exporter/deployment.yaml"
    echo "  ✓ GitHub token injected"
fi

echo ""

# ---------------------------------------------------------------------------
# 3. Apply manifests via kustomize
# ---------------------------------------------------------------------------
echo "Applying manifests..."
kubectl apply -k "${MANIFESTS_DIR}"
echo ""
echo "✓ All manifests applied"
echo ""

# ---------------------------------------------------------------------------
# 4. Wait for pods to be ready
# ---------------------------------------------------------------------------
echo "Waiting for pods (timeout: ${WAIT_TIMEOUT}s)..."

# Core deployments
DEPLOYMENTS="prometheus grafana loki tempo github-actions-exporter steampipe"
for deploy in $DEPLOYMENTS; do
    echo "  → Waiting for deployment/${deploy}..."
    kubectl rollout status "deployment/${deploy}" \
        -n monitoring \
        --timeout="${WAIT_TIMEOUT}s" 2>/dev/null || {
        echo "  ⚠ deployment/${deploy} not ready within timeout"
    }
done

# DaemonSets
DAEMONSETS="promtail node-exporter"
for ds in $DAEMONSETS; do
    echo "  → Waiting for daemonset/${ds}..."
    kubectl rollout status "daemonset/${ds}" \
        -n monitoring \
        --timeout="${WAIT_TIMEOUT}s" 2>/dev/null || {
        echo "  ⚠ daemonset/${ds} not ready within timeout"
    }
done

echo ""

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo "=== Deployment Summary ==="
echo ""
kubectl get pods -n monitoring -o wide
echo ""
kubectl get svc -n monitoring
echo ""
echo "=== Access ==="
echo "  Grafana:    http://localhost:3000 (port-forward) or via Traefik on EIP"
echo "  Prometheus: kubectl port-forward svc/prometheus 9090:9090 -n monitoring"
echo "  Loki:       kubectl port-forward svc/loki 3100:3100 -n monitoring"
echo ""
echo "✓ Monitoring stack deployment complete"
