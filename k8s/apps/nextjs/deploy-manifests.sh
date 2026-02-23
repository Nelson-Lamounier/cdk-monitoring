#!/usr/bin/env bash
# @format
# deploy-manifests.sh — Deploy Next.js application to Kubernetes
#
# Deploys the Next.js K8s manifests to the nextjs-app namespace. Can be invoked:
#   1. By UserData during first boot (after S3 sync)
#   2. By SSM Run Command from CI/CD pipeline (re-syncs from S3)
#
# Steps:
#   1. (Optional) Re-sync manifests from S3 (when S3_BUCKET is set)
#   2. Resolve secrets from SSM (DynamoDB table, S3 bucket, API URL)
#   3. Apply all manifests via kustomize
#   4. Create/update Kubernetes secrets (post-apply)
#   5. Wait for deployment rollout
#
# Environment variables:
#   MANIFESTS_DIR      Path to nextjs manifests dir (default: /data/k8s/apps/nextjs)
#   SSM_PREFIX         SSM parameter prefix (default: /k8s/development)
#   AWS_REGION         AWS region (default: eu-west-1)
#   KUBECONFIG         Path to kubeconfig (default: /etc/kubernetes/admin.conf)
#   S3_BUCKET          S3 bucket to re-sync from (optional — set by CI/CD)
#   S3_KEY_PREFIX      S3 key prefix (default: k8s)
#   FRONTEND_SSM_PREFIX  SSM prefix for frontend params (default: /frontend/development)
#   WAIT_TIMEOUT       Pod readiness timeout in seconds (default: 300)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MANIFESTS_DIR="${MANIFESTS_DIR:-/data/k8s/apps/nextjs}"
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
S3_BUCKET="${S3_BUCKET:-}"
S3_KEY_PREFIX="${S3_KEY_PREFIX:-k8s}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"

# Derive frontend SSM prefix from SSM_PREFIX
# /k8s/development → development → /frontend/development
K8S_ENV="${SSM_PREFIX##*/}"
FRONTEND_SSM_PREFIX="${FRONTEND_SSM_PREFIX:-/frontend/${K8S_ENV}}"

export KUBECONFIG

echo "=== Next.js Application Deployment ==="
echo "Manifests: ${MANIFESTS_DIR}"
echo "SSM prefix: ${SSM_PREFIX}"
echo "Frontend SSM prefix: ${FRONTEND_SSM_PREFIX}"
echo "Region:     ${AWS_REGION}"
echo "Triggered:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# ---------------------------------------------------------------------------
# 1. Re-sync from S3 (CI/CD mode — when S3_BUCKET is set)
# ---------------------------------------------------------------------------
if [ -n "${S3_BUCKET}" ]; then
    echo "=== Step 1: Re-syncing manifests from S3 ==="
    K8S_DIR=$(dirname "$(dirname "${MANIFESTS_DIR}")")
    aws s3 sync "s3://${S3_BUCKET}/${S3_KEY_PREFIX}/" "${K8S_DIR}/" --region "${AWS_REGION}"
    find "${K8S_DIR}" -name '*.sh' -exec chmod +x {} +
    echo "✓ Manifests synced from s3://${S3_BUCKET}/${S3_KEY_PREFIX}/"
    echo ""
fi

# ---------------------------------------------------------------------------
# 2. Resolve secrets from SSM
#
# Next.js needs:
#   DYNAMODB_TABLE_NAME  → /frontend/{env}/dynamodb/table-name
#   ASSETS_BUCKET_NAME   → /frontend/{env}/s3/assets-bucket-name
#   NEXT_PUBLIC_API_URL  → /frontend/{env}/api/gateway-url
# ---------------------------------------------------------------------------
resolve_secret() {
    local param_name="$1"
    local env_var="$2"
    local current_value="${!env_var:-}"

    if [ -n "$current_value" ] && [ "$current_value" != "\${${env_var}}" ]; then
        echo "  ✓ ${env_var}: using environment override"
        return
    fi

    local ssm_path="${FRONTEND_SSM_PREFIX}/${param_name}"
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
        echo "  ⚠ ${env_var}: not found in SSM (${ssm_path})"
    fi
}

echo "=== Step 2: Resolving secrets from SSM ==="
resolve_secret "dynamodb/table-name" "DYNAMODB_TABLE_NAME"
resolve_secret "s3/assets-bucket-name" "ASSETS_BUCKET_NAME"
resolve_secret "api/gateway-url" "NEXT_PUBLIC_API_URL"
echo ""

# ---------------------------------------------------------------------------
# 3. Apply manifests via kustomize
# ---------------------------------------------------------------------------
echo "=== Step 3: Applying manifests ==="

# Show diff before applying (informational)
echo "--- kubectl diff (preview) ---"
kubectl diff -k "${MANIFESTS_DIR}" 2>/dev/null || true
echo "--- end diff ---"
echo ""

kubectl apply --server-side --force-conflicts -k "${MANIFESTS_DIR}"
echo ""
echo "✓ All Next.js manifests applied"
echo ""

# ---------------------------------------------------------------------------
# 4. Create/update Kubernetes secrets (post-apply, always wins)
#
# Using kubectl create --dry-run=client | kubectl apply is idempotent.
# Applied AFTER kustomize so our secrets overwrite placeholder values.
# ---------------------------------------------------------------------------
echo "=== Step 4: Creating Kubernetes secrets ==="

SECRET_ARGS=""
if [ -n "${DYNAMODB_TABLE_NAME:-}" ]; then
    SECRET_ARGS="${SECRET_ARGS} --from-literal=DYNAMODB_TABLE_NAME=${DYNAMODB_TABLE_NAME}"
fi
if [ -n "${ASSETS_BUCKET_NAME:-}" ]; then
    SECRET_ARGS="${SECRET_ARGS} --from-literal=ASSETS_BUCKET_NAME=${ASSETS_BUCKET_NAME}"
fi
if [ -n "${NEXT_PUBLIC_API_URL:-}" ]; then
    SECRET_ARGS="${SECRET_ARGS} --from-literal=NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}"
fi

if [ -n "${SECRET_ARGS}" ]; then
    kubectl create secret generic nextjs-secrets \
        ${SECRET_ARGS} \
        --namespace nextjs-app \
        --dry-run=client -o yaml | kubectl apply -f -
    echo "  ✓ nextjs-secrets secret created/updated"
else
    echo "  ⚠ No secrets resolved — skipping secret creation"
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Wait for deployment rollout
# ---------------------------------------------------------------------------
echo "=== Step 5: Waiting for rollout (timeout: ${WAIT_TIMEOUT}s) ==="

echo "  → Waiting for deployment/nextjs..."
kubectl rollout status "deployment/nextjs" \
    -n nextjs-app \
    --timeout="${WAIT_TIMEOUT}s" 2>/dev/null || {
    echo "  ⚠ deployment/nextjs not ready within timeout"
}

echo ""

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------
echo "=== Deployment Summary ==="
echo ""
kubectl get pods -n nextjs-app -o wide
echo ""
kubectl get svc -n nextjs-app
echo ""
echo "=== Access ==="
echo "  Next.js: Via Traefik Ingress on EIP (port 80/443)"
echo "  kubectl port-forward svc/nextjs 3000:80 -n nextjs-app"
echo ""
echo "✓ Next.js application deployment complete ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))"
