#!/usr/bin/env bash
# @format
# bootstrap-argocd.sh — Bootstrap ArgoCD on Kubernetes
#
# Installs ArgoCD and configures it to watch the private GitHub repo.
# Run once during first boot (via user-data) after kubeadm cluster is ready.
#
# Prerequisites:
#   - Kubernetes cluster running with KUBECONFIG available
#   - Manifests synced from S3 to /data/k8s/
#   - SSM parameters available for GitHub token
#
# Steps:
#   1. Create argocd namespace
#   2. Resolve GitHub token from SSM
#   3. Create repo credentials secret
#   4. Install ArgoCD (non-HA, single-node)
#   5. Apply Application CRDs
#   6. Wait for ArgoCD server to be ready
#
# Environment variables:
#   SSM_PREFIX     SSM parameter prefix (default: /k8s/development)
#   AWS_REGION     AWS region (default: eu-west-1)
#   KUBECONFIG     Path to kubeconfig (default: /etc/kubernetes/admin.conf)
#   ARGOCD_DIR     Path to ArgoCD manifests (default: /data/k8s/system/argocd)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
KUBECONFIG="${KUBECONFIG:-/etc/kubernetes/admin.conf}"
ARGOCD_DIR="${ARGOCD_DIR:-/data/k8s-bootstrap/system/argocd}"

export KUBECONFIG

echo "=== ArgoCD Bootstrap ==="
echo "SSM prefix: ${SSM_PREFIX}"
echo "Region:     ${AWS_REGION}"
echo "ArgoCD dir: ${ARGOCD_DIR}"
echo "Triggered:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# ---------------------------------------------------------------------------
# 1. Create argocd namespace (if not exists)
# ---------------------------------------------------------------------------
echo "=== Step 1: Creating argocd namespace ==="
kubectl apply -f "${ARGOCD_DIR}/namespace.yaml"
echo "✓ argocd namespace ready"
echo ""

# ---------------------------------------------------------------------------
# 2. Resolve SSH Deploy Key from SSM
#
# Deploy Keys are read-only per-repo and don't grant access beyond
# the specific repository. Preferred over personal access tokens.
# ---------------------------------------------------------------------------
echo "=== Step 2: Resolving SSH Deploy Key from SSM ==="

DEPLOY_KEY="${DEPLOY_KEY:-}"
if [ -z "${DEPLOY_KEY}" ]; then
    SSM_PATH="${SSM_PREFIX}/deploy-key"
    echo "  → Resolving from SSM: ${SSM_PATH}"
    DEPLOY_KEY=$(aws ssm get-parameter \
        --name "${SSM_PATH}" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text \
        --region "${AWS_REGION}" 2>/dev/null || echo "")

    if [ -n "${DEPLOY_KEY}" ]; then
        echo "  ✓ SSH Deploy Key resolved from SSM"
    else
        echo "  ⚠ Deploy Key not found in SSM — ArgoCD won't be able to access private repo"
        echo "  ⚠ Store Deploy Key at: ${SSM_PATH}"
        echo "  ⚠ See: docs/kubernetes/bootstrap-vs-app-deploy-review.md for setup instructions"
    fi
else
    echo "  ✓ Using environment override"
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Create repo credentials secret (SSH Deploy Key, before ArgoCD install)
#
# ArgoCD picks up secrets with label argocd.argoproj.io/secret-type=repository
# on startup. Creating it before install ensures immediate repo access.
# Using SSH Deploy Key (read-only per-repo) instead of personal access token.
# ---------------------------------------------------------------------------
echo "=== Step 3: Creating repo credentials (SSH Deploy Key) ==="

if [ -n "${DEPLOY_KEY}" ]; then
    kubectl create secret generic repo-cdk-monitoring \
        --from-literal=type=git \
        --from-literal=url=git@github.com:Nelson-Lamounier/cdk-monitoring.git \
        --from-literal=sshPrivateKey="${DEPLOY_KEY}" \
        --namespace argocd \
        --dry-run=client -o yaml | \
    kubectl label -f - --local --dry-run=client -o yaml \
        argocd.argoproj.io/secret-type=repository | \
    kubectl apply -f -
    echo "  ✓ SSH Deploy Key repo credentials created"
else
    echo "  ⚠ Skipping — no Deploy Key available"
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Install ArgoCD (non-HA)
# ---------------------------------------------------------------------------
echo "=== Step 4: Installing ArgoCD ==="

kubectl apply -n argocd -f "${ARGOCD_DIR}/install.yaml"
echo "✓ ArgoCD core installed"
echo ""

# ---------------------------------------------------------------------------
# 5. Apply ArgoCD ingress + Application CRDs
# ---------------------------------------------------------------------------
echo "=== Step 5: Applying ingress and Application CRDs ==="

kubectl apply -f "${ARGOCD_DIR}/ingress.yaml"
kubectl apply -f "${ARGOCD_DIR}/applications/monitoring.yaml"
kubectl apply -f "${ARGOCD_DIR}/applications/nextjs.yaml"
echo "✓ Ingress and Application CRDs applied"
echo ""

# ---------------------------------------------------------------------------
# 6. Wait for ArgoCD server to be ready
# ---------------------------------------------------------------------------
echo "=== Step 6: Waiting for ArgoCD server ==="

ARGO_TIMEOUT="${ARGO_TIMEOUT:-300}"

echo "  → Waiting for argocd-server deployment..."
kubectl rollout status deployment/argocd-server \
    -n argocd \
    --timeout="${ARGO_TIMEOUT}s" 2>/dev/null || {
    echo "  ⚠ argocd-server not ready within ${ARGO_TIMEOUT}s"
}

echo "  → Waiting for argocd-repo-server deployment..."
kubectl rollout status deployment/argocd-repo-server \
    -n argocd \
    --timeout="${ARGO_TIMEOUT}s" 2>/dev/null || {
    echo "  ⚠ argocd-repo-server not ready within ${ARGO_TIMEOUT}s"
}

echo "  → Waiting for argocd-application-controller..."
kubectl rollout status statefulset/argocd-application-controller \
    -n argocd \
    --timeout="${ARGO_TIMEOUT}s" 2>/dev/null || {
    echo "  ⚠ argocd-application-controller not ready within ${ARGO_TIMEOUT}s"
}
echo ""

# ---------------------------------------------------------------------------
# 7. Install ArgoCD CLI
#
# The CLI is required for account management and token generation.
# Using --core flag allows direct Kubernetes access without API login.
# Downloaded at runtime (not baked into AMI) to avoid version drift.
# ---------------------------------------------------------------------------
echo "=== Step 7: Installing ArgoCD CLI ==="

ARGOCD_CLI_VERSION="${ARGOCD_CLI_VERSION:-v2.14.11}"
ARCH=$(uname -m)
case "${ARCH}" in
    x86_64)  CLI_ARCH="amd64" ;;
    aarch64) CLI_ARCH="arm64" ;;
    *)       CLI_ARCH="amd64" ;;
esac

ARGOCD_CLI_URL="https://github.com/argoproj/argo-cd/releases/download/${ARGOCD_CLI_VERSION}/argocd-linux-${CLI_ARCH}"
echo "  → Downloading ArgoCD CLI ${ARGOCD_CLI_VERSION} (${CLI_ARCH})..."

if curl -sSL -o /usr/local/bin/argocd "${ARGOCD_CLI_URL}" && chmod +x /usr/local/bin/argocd; then
    echo "  ✓ ArgoCD CLI installed: $(argocd version --client --short 2>/dev/null || echo "${ARGOCD_CLI_VERSION}")"
else
    echo "  ⚠ ArgoCD CLI install failed — skipping CI bot token generation"
    SKIP_CI_BOT="true"
fi
echo ""

# ---------------------------------------------------------------------------
# 8. Create CI bot account
#
# ArgoCD accounts are configured via the argocd-cm ConfigMap.
# The ci-bot account has apiKey capability (token generation only).
# RBAC grants read-only access to applications for CI verification.
#
# Using --core flag: direct Kubernetes access via KUBECONFIG,
# no need to authenticate to the ArgoCD API server.
# ---------------------------------------------------------------------------
echo "=== Step 8: Creating CI bot account ==="

if [ "${SKIP_CI_BOT:-}" != "true" ]; then
    # Register ci-bot account in argocd-cm (idempotent patch)
    kubectl patch configmap argocd-cm -n argocd --type merge -p '{
      "data": {
        "accounts.ci-bot": "apiKey"
      }
    }' 2>/dev/null && echo "  ✓ ci-bot account registered in argocd-cm" \
                   || echo "  ⚠ Failed to patch argocd-cm"

    # Grant ci-bot read-only RBAC (view applications, read logs)
    kubectl patch configmap argocd-rbac-cm -n argocd --type merge -p '{
      "data": {
        "policy.csv": "p, role:ci-readonly, applications, get, */*, allow\np, role:ci-readonly, applications, list, */*, allow\ng, ci-bot, role:ci-readonly"
      }
    }' 2>/dev/null && echo "  ✓ ci-bot RBAC policy applied (read-only)" \
                   || echo "  ⚠ Failed to patch argocd-rbac-cm"

    # Wait briefly for ArgoCD to pick up ConfigMap changes
    sleep 5
else
    echo "  ⚠ Skipping — ArgoCD CLI not available"
fi
echo ""

# ---------------------------------------------------------------------------
# 9. Generate API token & push to Secrets Manager
#
# Generates a long-lived API token for ci-bot and stores it in
# AWS Secrets Manager. The CI pipeline polls for this secret on Day 0
# and retrieves it instantly on Day 1+.
#
# Secret name: k8s/{env}/argocd-ci-token
# ---------------------------------------------------------------------------
echo "=== Step 9: Generating CI bot token ==="

if [ "${SKIP_CI_BOT:-}" != "true" ]; then
    K8S_ENV="${SSM_PREFIX##*/}"
    SECRET_NAME="k8s/${K8S_ENV}/argocd-ci-token"

    echo "  → Generating API token for ci-bot..."
    CI_TOKEN=$(argocd account generate-token \
        --account ci-bot \
        --core \
        --grpc-web 2>/dev/null || echo "")

    if [ -n "${CI_TOKEN}" ]; then
        echo "  ✓ API token generated"

        echo "  → Pushing token to Secrets Manager: ${SECRET_NAME}"
        # Try create first, fall back to update (idempotent)
        if aws secretsmanager create-secret \
            --name "${SECRET_NAME}" \
            --description "ArgoCD CI bot API token for pipeline verification" \
            --secret-string "${CI_TOKEN}" \
            --region "${AWS_REGION}" 2>/dev/null; then
            echo "  ✓ Secret created in Secrets Manager"
        elif aws secretsmanager update-secret \
            --secret-id "${SECRET_NAME}" \
            --secret-string "${CI_TOKEN}" \
            --region "${AWS_REGION}" 2>/dev/null; then
            echo "  ✓ Secret updated in Secrets Manager"
        else
            echo "  ⚠ Failed to store token in Secrets Manager"
        fi
    else
        echo "  ⚠ Token generation failed — CI pipeline will skip ArgoCD verification"
    fi
else
    echo "  ⚠ Skipping — ArgoCD CLI not available"
fi
echo ""

# ---------------------------------------------------------------------------
# 10. Summary
# ---------------------------------------------------------------------------
echo "=== ArgoCD Bootstrap Summary ==="
echo ""
kubectl get pods -n argocd -o wide
echo ""
kubectl get applications -n argocd 2>/dev/null || echo "  (Applications pending sync)"
echo ""

# Retrieve initial admin password
ADMIN_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
if [ -n "${ADMIN_PASSWORD}" ]; then
    echo "=== ArgoCD Admin Access ==="
    echo "  URL:      https://<eip>/argocd"
    echo "  User:     admin"
    echo "  Password: ${ADMIN_PASSWORD}"
    echo ""
    echo "  (Change the password after first login)"
fi

echo "✓ ArgoCD bootstrap complete ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))"
