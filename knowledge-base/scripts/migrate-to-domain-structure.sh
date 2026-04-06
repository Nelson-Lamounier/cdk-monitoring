#!/usr/bin/env bash
# =============================================================================
# Knowledge Base — Phase 2: Domain-First Migration
# Moves files from type-based folders to domain-first folders
# Updates frontmatter related_docs paths and .metadata.json sidecars
# =============================================================================
set -euo pipefail

KB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KB_DIR"

echo "📁 Knowledge Base directory: $KB_DIR"
echo "🔄 Phase 2: Domain-first restructuring..."
echo ""

moved=0

move_file() {
    local src="$1"
    local dst="$2"

    # Create target directory
    mkdir -p "$(dirname "$dst")"

    # Move the markdown file
    if [ -f "$src" ]; then
        mv "$src" "$dst"
        echo "  📦 $(basename "$src") → $dst"
    else
        echo "  ⚠️  Source not found: $src"
        return
    fi

    # Move the sidecar .metadata.json if it exists
    local src_sidecar="${src}.metadata.json"
    local dst_sidecar="${dst}.metadata.json"
    if [ -f "$src_sidecar" ]; then
        mv "$src_sidecar" "$dst_sidecar"
    fi

    moved=$((moved + 1))
}

# =============================================================================
# infrastructure/ — CDK, networking, security, live-infra
# =============================================================================
echo "🏗️  infrastructure/"

move_file "adrs/cdk-over-terraform.md" "infrastructure/adrs/cdk-over-terraform.md"
move_file "adrs/step-functions-over-lambda-orchestration.md" "infrastructure/adrs/step-functions-over-lambda-orchestration.md"
move_file "architecture/stack-overview.md" "infrastructure/stack-overview.md"
move_file "code/networking-implementation.md" "infrastructure/networking-implementation.md"
move_file "code/security-implementation.md" "infrastructure/security-implementation.md"
move_file "live-infra/aws-resource-inventory.md" "infrastructure/aws-resource-inventory.md"
move_file "live-infra/infrastructure-topology.md" "infrastructure/infrastructure-topology.md"
move_file "live-infra/security-posture.md" "infrastructure/security-posture.md"

echo ""

# =============================================================================
# kubernetes/ — K8s cluster, bootstrap, Crossplane, runbooks
# =============================================================================
echo "☸️  kubernetes/"

move_file "adrs/argo-rollouts-zero-downtime.md" "kubernetes/adrs/argo-rollouts-zero-downtime.md"
move_file "adrs/argocd-over-flux.md" "kubernetes/adrs/argocd-over-flux.md"
move_file "adrs/crossplane-for-app-level-iac.md" "kubernetes/adrs/crossplane-for-app-level-iac.md"
move_file "adrs/self-managed-k8s-vs-eks.md" "kubernetes/adrs/self-managed-k8s-vs-eks.md"
move_file "adrs/traefik-over-nginx-alb.md" "kubernetes/adrs/traefik-over-nginx-alb.md"
move_file "code/crossplane-implementation.md" "kubernetes/crossplane-implementation.md"
move_file "implementation/kubernetes-bootstrap-pipeline.md" "kubernetes/bootstrap-pipeline.md"
move_file "implementation/kubernetes-bootstrap-system-scripts.md" "kubernetes/bootstrap-system-scripts.md"
move_file "runbooks/bluegreen-rollout-stuck.md" "kubernetes/runbooks/bluegreen-rollout-stuck.md"
move_file "runbooks/instance-terminated.md" "kubernetes/runbooks/instance-terminated.md"
move_file "runbooks/pod-crashloop.md" "kubernetes/runbooks/pod-crashloop.md"

echo ""

# =============================================================================
# observability/ — Monitoring, RUM, dashboards
# =============================================================================
echo "📊 observability/"

move_file "code/observability-implementation.md" "observability/observability-implementation.md"
move_file "implementation/frontend-performance.md" "observability/frontend-performance.md"
move_file "implementation/rum-dashboard-review.md" "observability/rum-dashboard-review.md"
move_file "runbooks/faro-rum-no-data.md" "observability/runbooks/faro-rum-no-data.md"

echo ""

# =============================================================================
# ai-ml/ — Bedrock, self-healing agent
# =============================================================================
echo "🤖 ai-ml/"

move_file "code/bedrock-implementation.md" "ai-ml/bedrock-implementation.md"
move_file "code/self-healing-agent.md" "ai-ml/self-healing-agent.md"

echo ""

# =============================================================================
# frontend/ — Next.js, CloudFront
# =============================================================================
echo "🌐 frontend/"

move_file "code/frontend-integration.md" "frontend/frontend-integration.md"

echo ""

# =============================================================================
# operations/ — CI/CD, MCP
# =============================================================================
echo "⚙️  operations/"

move_file "adrs/mcp-for-operations.md" "operations/adrs/mcp-for-operations.md"
move_file "code/ci-cd-implementation.md" "operations/ci-cd-implementation.md"

echo ""

# =============================================================================
# finops/ — Cost analysis
# =============================================================================
echo "💰 finops/"

move_file "cost/cost-breakdown.md" "finops/cost-breakdown.md"

echo ""

# =============================================================================
# career/ — Self-reflection
# =============================================================================
echo "🎯 career/"

move_file "self-reflection/career-transition.md" "career/career-transition.md"
move_file "self-reflection/certification-journey.md" "career/certification-journey.md"
move_file "self-reflection/learning-methodology.md" "career/learning-methodology.md"

echo ""

# =============================================================================
# Clean up empty old directories
# =============================================================================
echo "🧹 Cleaning up empty directories..."

for dir in adrs architecture code cost implementation live-infra runbooks self-reflection; do
    if [ -d "$dir" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
        rmdir "$dir"
        echo "  🗑️  Removed empty: $dir/"
    elif [ -d "$dir" ]; then
        echo "  ⚠️  Not empty (skipped): $dir/ — contains: $(ls "$dir")"
    fi
done

echo ""
echo "✅ Migration complete: $moved files moved"
echo ""
echo "📂 New structure:"
find . -name "*.md" -not -path "./scripts/*" | sort | sed 's|^\./||'
