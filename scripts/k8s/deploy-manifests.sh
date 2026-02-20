#!/usr/bin/env bash
# @format
# deploy-manifests.sh — Deploy monitoring stack to k3s
#
# Deploys the k8s monitoring manifests to the k3s cluster. Can be invoked:
#   1. By UserData during first boot (after S3 sync)
#   2. By SSM Run Command from CI/CD pipeline (re-syncs from S3)
#
# Steps:
#   1. (Optional) Re-sync manifests from S3 (when S3_BUCKET is set)
#   2. Substitute secret placeholders with values from SSM
#   3. Apply all manifests via kustomize
#   4. Wait for pods to reach Ready state
#   5. Register Loki/Tempo endpoints in SSM for cross-stack discovery
#
# Environment variables:
#   MANIFESTS_DIR      Path to manifests directory (default: /data/k8s/manifests)
#   SSM_PREFIX         SSM parameter prefix (default: /k8s/development)
#   AWS_REGION         AWS region (default: eu-west-1)
#   KUBECONFIG         Path to kubeconfig (default: /data/k3s/server/cred/admin.kubeconfig)
#   S3_BUCKET          S3 bucket to re-sync from (optional — set by CI/CD)
#   S3_KEY_PREFIX      S3 key prefix (default: k8s)
#   GRAFANA_ADMIN_PASSWORD   Override Grafana admin password (skips SSM lookup)
#   GITHUB_TOKEN             Override GitHub token (skips SSM lookup)
#   WAIT_TIMEOUT       Pod readiness timeout in seconds (default: 300)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MANIFESTS_DIR="${MANIFESTS_DIR:-/data/k8s/manifests}"
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
KUBECONFIG="${KUBECONFIG:-/data/k3s/server/cred/admin.kubeconfig}"
S3_BUCKET="${S3_BUCKET:-}"
S3_KEY_PREFIX="${S3_KEY_PREFIX:-k8s}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"

export KUBECONFIG

echo "=== k8s Monitoring Stack Deployment ==="
echo "Manifests: ${MANIFESTS_DIR}"
echo "SSM prefix: ${SSM_PREFIX}"
echo "Region:     ${AWS_REGION}"
echo "Triggered:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# ---------------------------------------------------------------------------
# 1. Re-sync from S3 (CI/CD mode — when S3_BUCKET is set)
# ---------------------------------------------------------------------------
if [ -n "${S3_BUCKET}" ]; then
    echo "=== Step 1: Re-syncing manifests from S3 ==="
    K8S_DIR=$(dirname "${MANIFESTS_DIR}")
    aws s3 sync "s3://${S3_BUCKET}/${S3_KEY_PREFIX}/" "${K8S_DIR}/" --region "${AWS_REGION}"
    find "${K8S_DIR}" -name '*.sh' -exec chmod +x {} +
    echo "✓ Manifests synced from s3://${S3_BUCKET}/${S3_KEY_PREFIX}/"
    echo ""
fi

# ---------------------------------------------------------------------------
# 2. Resolve secrets from SSM (if not already set via env)
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

echo "=== Step 2: Resolving secrets ==="
resolve_secret "grafana-admin-password" "GRAFANA_ADMIN_PASSWORD"
resolve_secret "github-token" "GITHUB_TOKEN"
echo ""

# ---------------------------------------------------------------------------
# 3. Substitute secret placeholders in manifests
# ---------------------------------------------------------------------------
echo "=== Step 3: Substituting secret placeholders ==="

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
# 4. Apply manifests via kustomize
# ---------------------------------------------------------------------------
echo "=== Step 4: Applying manifests ==="

# Show diff before applying (informational)
echo "--- kubectl diff (preview) ---"
kubectl diff -k "${MANIFESTS_DIR}" 2>/dev/null || true
echo "--- end diff ---"
echo ""

kubectl apply -k "${MANIFESTS_DIR}"
echo ""
echo "✓ All manifests applied"
echo ""

# ---------------------------------------------------------------------------
# 5. Wait for pods to be ready
# ---------------------------------------------------------------------------
echo "=== Step 5: Waiting for pods (timeout: ${WAIT_TIMEOUT}s) ==="

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
# 6. Register Loki/Tempo endpoints in SSM (cross-stack discovery)
#
# ECS tasks (Next.js) discover Loki and Tempo via SSM parameters.
# NodePort services expose Loki (30100) and Tempo (30417) on the host IP,
# making them accessible from other instances in the same VPC.
# ---------------------------------------------------------------------------
echo "=== Step 6: Registering monitoring endpoints in SSM ==="

# Get instance private IP from IMDS v2
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || echo "")

if [ -n "${IMDS_TOKEN}" ]; then
    PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" \
        http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || echo "")

    if [ -n "${PRIVATE_IP}" ]; then
        LOKI_ENDPOINT="http://${PRIVATE_IP}:30100/loki/api/v1/push"
        TEMPO_ENDPOINT="http://${PRIVATE_IP}:30417"

        echo "  Loki endpoint:  ${LOKI_ENDPOINT}"
        echo "  Tempo endpoint: ${TEMPO_ENDPOINT}"

        aws ssm put-parameter \
            --name "${SSM_PREFIX}/loki/endpoint" \
            --value "${LOKI_ENDPOINT}" \
            --type "String" \
            --overwrite \
            --region "${AWS_REGION}" \
            && echo "  ✓ Loki endpoint registered in SSM" \
            || echo "  ⚠ Failed to register Loki endpoint"

        aws ssm put-parameter \
            --name "${SSM_PREFIX}/tempo/endpoint" \
            --value "${TEMPO_ENDPOINT}" \
            --type "String" \
            --overwrite \
            --region "${AWS_REGION}" \
            && echo "  ✓ Tempo endpoint registered in SSM" \
            || echo "  ⚠ Failed to register Tempo endpoint"
    else
        echo "  ⚠ Could not determine private IP — skipping SSM registration"
    fi
else
    echo "  ⚠ IMDS token unavailable — skipping SSM registration"
fi

echo ""

# ---------------------------------------------------------------------------
# 7. Summary
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
echo "✓ Monitoring stack deployment complete ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))"
