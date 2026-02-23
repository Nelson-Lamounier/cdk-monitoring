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
ARGOCD_DIR="${ARGOCD_DIR:-/data/k8s/system/argocd}"

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
# 2. Resolve GitHub token from SSM
# ---------------------------------------------------------------------------
echo "=== Step 2: Resolving GitHub token from SSM ==="

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ -z "${GITHUB_TOKEN}" ]; then
    SSM_PATH="${SSM_PREFIX}/github-token"
    echo "  → Resolving from SSM: ${SSM_PATH}"
    GITHUB_TOKEN=$(aws ssm get-parameter \
        --name "${SSM_PATH}" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text \
        --region "${AWS_REGION}" 2>/dev/null || echo "")

    if [ -n "${GITHUB_TOKEN}" ]; then
        echo "  ✓ GitHub token resolved from SSM"
    else
        echo "  ⚠ GitHub token not found in SSM — ArgoCD won't be able to access private repo"
        echo "  ⚠ Store token at: ${SSM_PATH}"
    fi
else
    echo "  ✓ Using environment override"
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Create repo credentials secret (before ArgoCD install)
#
# ArgoCD picks up secrets with label argocd.argoproj.io/secret-type=repository
# on startup. Creating it before install ensures immediate repo access.
# ---------------------------------------------------------------------------
echo "=== Step 3: Creating repo credentials ==="

if [ -n "${GITHUB_TOKEN}" ]; then
    kubectl create secret generic repo-cdk-monitoring \
        --from-literal=type=git \
        --from-literal=url=https://github.com/Nelson-Lamounier/cdk-monitoring.git \
        --from-literal=username=argocd \
        --from-literal=password="${GITHUB_TOKEN}" \
        --namespace argocd \
        --dry-run=client -o yaml | \
    kubectl label -f - --local --dry-run=client -o yaml \
        argocd.argoproj.io/secret-type=repository | \
    kubectl apply -f -
    echo "  ✓ Repo credentials created"
else
    echo "  ⚠ Skipping — no GitHub token available"
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
# 7. Summary
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
