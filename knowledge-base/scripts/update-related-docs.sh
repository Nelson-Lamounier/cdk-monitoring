#!/usr/bin/env bash
# =============================================================================
# Knowledge Base — Phase 2b: Update related_docs cross-references
# Updates the old type-based paths in related_docs to new domain-first paths
# =============================================================================
set -euo pipefail

KB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KB_DIR"

echo "📁 Knowledge Base directory: $KB_DIR"
echo "🔄 Updating related_docs cross-references..."
echo ""

# Path mapping: old → new
declare -A PATH_MAP=(
    # ADRs
    ["adrs/argo-rollouts-zero-downtime.md"]="kubernetes/adrs/argo-rollouts-zero-downtime.md"
    ["adrs/argocd-over-flux.md"]="kubernetes/adrs/argocd-over-flux.md"
    ["adrs/cdk-over-terraform.md"]="infrastructure/adrs/cdk-over-terraform.md"
    ["adrs/crossplane-for-app-level-iac.md"]="kubernetes/adrs/crossplane-for-app-level-iac.md"
    ["adrs/mcp-for-operations.md"]="operations/adrs/mcp-for-operations.md"
    ["adrs/self-managed-k8s-vs-eks.md"]="kubernetes/adrs/self-managed-k8s-vs-eks.md"
    ["adrs/step-functions-over-lambda-orchestration.md"]="infrastructure/adrs/step-functions-over-lambda-orchestration.md"
    ["adrs/traefik-over-nginx-alb.md"]="kubernetes/adrs/traefik-over-nginx-alb.md"

    # Architecture
    ["architecture/stack-overview.md"]="infrastructure/stack-overview.md"

    # Code
    ["code/bedrock-implementation.md"]="ai-ml/bedrock-implementation.md"
    ["code/ci-cd-implementation.md"]="operations/ci-cd-implementation.md"
    ["code/crossplane-implementation.md"]="kubernetes/crossplane-implementation.md"
    ["code/frontend-integration.md"]="frontend/frontend-integration.md"
    ["code/networking-implementation.md"]="infrastructure/networking-implementation.md"
    ["code/observability-implementation.md"]="observability/observability-implementation.md"
    ["code/security-implementation.md"]="infrastructure/security-implementation.md"
    ["code/self-healing-agent.md"]="ai-ml/self-healing-agent.md"

    # Cost
    ["cost/cost-breakdown.md"]="finops/cost-breakdown.md"

    # Implementation
    ["implementation/frontend-performance.md"]="observability/frontend-performance.md"
    ["implementation/kubernetes-bootstrap-pipeline.md"]="kubernetes/bootstrap-pipeline.md"
    ["implementation/kubernetes-bootstrap-system-scripts.md"]="kubernetes/bootstrap-system-scripts.md"
    ["implementation/rum-dashboard-review.md"]="observability/rum-dashboard-review.md"

    # Live-infra
    ["live-infra/aws-resource-inventory.md"]="infrastructure/aws-resource-inventory.md"
    ["live-infra/infrastructure-topology.md"]="infrastructure/infrastructure-topology.md"
    ["live-infra/security-posture.md"]="infrastructure/security-posture.md"

    # Runbooks
    ["runbooks/bluegreen-rollout-stuck.md"]="kubernetes/runbooks/bluegreen-rollout-stuck.md"
    ["runbooks/faro-rum-no-data.md"]="observability/runbooks/faro-rum-no-data.md"
    ["runbooks/instance-terminated.md"]="kubernetes/runbooks/instance-terminated.md"
    ["runbooks/pod-crashloop.md"]="kubernetes/runbooks/pod-crashloop.md"

    # Self-reflection
    ["self-reflection/career-transition.md"]="career/career-transition.md"
    ["self-reflection/certification-journey.md"]="career/certification-journey.md"
    ["self-reflection/learning-methodology.md"]="career/learning-methodology.md"
)

updated=0

# Find all markdown files
find "$KB_DIR" -name "*.md" -not -path "*/scripts/*" -not -name "README.md" | while read -r file; do
    changed=false

    for old_path in "${!PATH_MAP[@]}"; do
        new_path="${PATH_MAP[$old_path]}"

        if grep -q "$old_path" "$file" 2>/dev/null; then
            # Use sed to replace (handle macOS sed)
            if [[ "$(uname)" == "Darwin" ]]; then
                sed -i '' "s|$old_path|$new_path|g" "$file"
            else
                sed -i "s|$old_path|$new_path|g" "$file"
            fi
            changed=true
        fi
    done

    if [ "$changed" = true ]; then
        echo "  ✅ Updated refs in: $(echo "$file" | sed "s|$KB_DIR/||")"
    fi
done

echo ""
echo "✅ Cross-reference update complete"
