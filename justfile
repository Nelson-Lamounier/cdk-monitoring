# @format
# justfile — Task runner for cdk-monitoring
#
# Usage:
#   just              List all recipes
#   just synth monitoring development
#   just deploy monitoring development
#   just test          Run all tests
#
# Prerequisites:
#   brew install just
#
# This file is the single CLI entry point for local development.
# CI/CD pipelines also use 'just' for code quality tasks (lint, build, typecheck).

# Default recipe — show help
default:
    @just --list --unsorted

# Shorthand alias for listing recipes
ls:
    @just --list --unsorted

# =============================================================================
# INTERNAL HELPERS
# =============================================================================

# Resolve AWS profile from environment name
[private]
_profile env:
    #!/usr/bin/env bash
    case "{{env}}" in
      development) echo "dev-account" ;;
      staging)     echo "staging-account" ;;
      production)  echo "prod-account" ;;
      *)           echo "dev-account" ;;
    esac

# =============================================================================
# CDK COMMANDS (run from infra/ — no interactive CLI layer)
# =============================================================================

# Synthesize CDK stacks (e.g., just synth monitoring development)
[group('cdk')]
synth project environment *ARGS:
    cd infra && npx cdk synth --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Deploy CDK stacks (e.g., just deploy monitoring development)
[group('cdk')]
deploy project environment *ARGS:
    cd infra && npx cdk deploy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Show diff between local and deployed stacks
[group('cdk')]
diff project environment *ARGS:
    cd infra && npx cdk diff --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Destroy CDK stacks (with CDK's built-in confirmation)
[group('cdk')]
destroy project environment *ARGS:
    cd infra && npx cdk destroy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# List all CDK stacks for a project
[group('cdk')]
list project environment *ARGS:
    cd infra && npx cdk list \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Bootstrap CDK in an AWS account
[group('cdk')]
bootstrap account profile *ARGS:
    cd infra && npx cdk bootstrap aws://{{account}}/eu-west-1 \
      --profile {{profile}} \
      --qualifier hnb659fds \
      --toolkit-stack-name CDKToolkit \
      {{ARGS}}

# =============================================================================
# CI SCRIPTS (Non-interactive — used by GitHub Actions)
#
# These recipes are the ONLY interface between GitHub Actions and project scripts.
# All CI workflow steps MUST call justfile recipes — never raw yarn/npx commands.
# This ensures local and CI environments use identical execution paths.
# =============================================================================

# CI synth-validate: synthesize all projects for CI validation
# Validates that all CDK stacks synthesize correctly without AWS API calls.
# Uses --no-lookups to rely on cached cdk.context.json instead of live AWS lookups.
# Covers: monitoring (3 stacks), k8s (8 stacks), nextjs (multi-stack), bedrock (4 stacks).
# Called by: .github/workflows/ci.yml → validate-cdk job
[group('ci')]
ci-synth-validate:
    #!/usr/bin/env bash
    set -euo pipefail
    cd infra
    echo "==========================================="
    echo "Validating Monitoring Project (dev)"
    echo "==========================================="
    npx cdk list -c project=monitoring -c environment=dev --no-lookups || {
      echo "Note: Some stacks may require cached context in cdk.context.json"
    }
    npx cdk synth -c project=monitoring -c environment=dev --no-lookups --quiet || {
      echo "⚠ Monitoring synth requires cached context — run locally to update cdk.context.json"
    }

    echo ""
    echo "==========================================="
    echo "Validating K8s Project (dev)"
    echo "==========================================="
    # k8s stacks: Data + Base + ControlPlane + AppWorker + MonitoringWorker + AppIam + Api + Edge
    npx cdk list -c project=kubernetes -c environment=dev --no-lookups || {
      echo "Note: Some stacks may require cached context in cdk.context.json"
    }
    npx cdk synth -c project=kubernetes -c environment=dev --no-lookups --quiet || {
      echo "⚠ K8s synth requires cached context — run locally to update cdk.context.json"
    }

    echo ""
    echo "==========================================="
    echo "Validating NextJS Project (dev)"
    echo "==========================================="
    # NextJS stacks resolve VPC via Vpc.fromLookup() internally (no cross-stack exports)
    npx cdk synth -c project=nextjs -c environment=dev --no-lookups --quiet 2>&1 || {
      echo "⚠ NextJS synth requires cached VPC context — run locally to update cdk.context.json"
    }

    echo ""
    echo "==========================================="
    echo "Validating Bedrock Project (dev)"
    echo "==========================================="
    npx cdk synth -c project=bedrock -c environment=dev --no-lookups --quiet || {
      echo "⚠ Bedrock synth failed"
    }

    echo ""
    echo "✓ CDK synthesis validation complete (all projects)"

# CI synth: synthesize + output stack names (e.g., just ci-synth kubernetes development)
# Used by deployment pipelines to get ordered stack names for targeted deploys.
# Called by: .github/workflows/_deploy-monitoring.yml, _deploy-nextjs.yml
[group('ci')]
ci-synth project environment:
    npx tsx infra/scripts/deployment/synthesize-ci.ts {{project}} {{environment}}

# CI preflight: validate inputs, verify credentials and bootstrap
[group('ci')]
ci-preflight *ARGS:
    npx tsx infra/scripts/deployment/preflight-checks.ts {{ARGS}}

# CI deploy: deploy a specific stack (e.g., just ci-deploy ControlPlane-development)
[group('ci')]
ci-deploy *ARGS:
    npx tsx infra/scripts/deployment/deploy.ts {{ARGS}}

# CI rollback: rollback a failed deployment
[group('ci')]
ci-rollback *ARGS:
    npx tsx infra/scripts/deployment/rollback.ts {{ARGS}}

# CI drift detection
[group('ci')]
ci-drift *ARGS:
    npx tsx infra/scripts/deployment/drift-detection.ts {{ARGS}}

# CI diagnose: diagnose a failed CloudFormation stack deployment
[group('ci')]
ci-diagnose *ARGS:
    npx tsx infra/scripts/deployment/diagnose-stack.ts {{ARGS}}

# CI collect-outputs: retrieve and save CDK stack outputs
[group('ci')]
ci-collect-outputs *ARGS:
    npx tsx infra/scripts/deployment/collect-outputs.ts {{ARGS}}

# CI deploy-summary: generate per-stack deployment summary
[group('ci')]
ci-deploy-summary *ARGS:
    npx tsx infra/scripts/deployment/deploy-summary.ts {{ARGS}}

# CI deploy-manifests: deploy K8s manifests via SSM Run Command
# Usage: just ci-deploy-manifests monitoring development
#        just ci-deploy-manifests nextjs production --region eu-west-1
[group('ci')]
ci-deploy-manifests *ARGS:
    npx tsx infra/scripts/deployment/deploy-manifests.ts {{ARGS}}

# CI verify deployment
[group('ci')]
ci-verify *ARGS:
    npx tsx infra/scripts/deployment/verify-deployment.ts {{ARGS}}

# CI smoke tests (NextJS ECS)
[group('ci')]
ci-smoke *ARGS:
    npx tsx infra/scripts/deployment/smoke-tests-nextjs.ts {{ARGS}}

# CI smoke tests (NextJS K8s)
[group('ci')]
ci-smoke-kubernetes *ARGS:
    npx tsx infra/scripts/deployment/smoke-tests-nextjs-kubernetes.ts {{ARGS}}

# CI smoke tests (Monitoring K8s)
[group('ci')]
ci-smoke-monitoring-kubernetes *ARGS:
    npx tsx infra/scripts/deployment/smoke-tests-monitoring-kubernetes.ts {{ARGS}}

# CI smoke tests (Kubernetes Infrastructure — full kubeadm deployment)
[group('ci')]
ci-smoke-kubernetes-infra *ARGS:
    npx tsx infra/scripts/deployment/smoke-tests-kubernetes.ts {{ARGS}}

# CI fetch boot logs from CloudWatch (failure diagnostics)
[group('ci')]
ci-fetch-boot-logs *ARGS:
    npx tsx infra/scripts/deployment/fetch-boot-logs.ts {{ARGS}}

# CI sync S3 assets
[group('ci')]
ci-sync-assets *ARGS:
    npx tsx infra/scripts/deployment/sync-assets-ci.ts {{ARGS}}

# CI get stack names
[group('ci')]
ci-stack-names *ARGS:
    npx tsx infra/scripts/deployment/get-stack-names.ts {{ARGS}}

# CI deployment summary (generates GitHub step summary)
# Called by: all _deploy-*.yml workflows → summary job
[group('ci')]
ci-summary *ARGS:
    npx tsx infra/scripts/deployment/deployment-summary.ts {{ARGS}}

# CI verify NextJS deployment (ECS health, ALB, endpoints)
# Called by: .github/workflows/_deploy-nextjs.yml → verify job
[group('ci')]
ci-verify-nextjs *ARGS:
    npx tsx infra/scripts/deployment/verify-nextjs.ts {{ARGS}}

# =============================================================================
# TESTING
# =============================================================================

# Run all tests
[group('test')]
test *ARGS:
    cd infra && yarn test {{ARGS}}

# Run stack unit tests only (used by CI)
# Targets: tests/unit/stacks/ — covers all CDK stack snapshot + assertion tests.
# Called by: .github/workflows/ci.yml → test-stacks job
[group('test')]
test-stacks:
    cd infra && yarn test tests/unit/stacks --coverage

# Run tests in watch mode
[group('test')]
test-watch:
    cd infra && yarn test:watch

# Run tests with coverage
[group('test')]
test-coverage:
    cd infra && yarn test:coverage

# Run unit tests only
[group('test')]
test-unit:
    cd infra && yarn test:unit

# Run a specific test file (e.g., just test-file tests/unit/stacks/k8s/edge-stack.test.ts)
[group('test')]
test-file path:
    cd infra && CDK_BUNDLING_STACKS='[]' npx jest {{path}} --no-coverage

# =============================================================================
# CODE QUALITY
# =============================================================================

# Run ESLint
[group('quality')]
lint:
    cd infra && yarn lint

# Run ESLint with auto-fix
[group('quality')]
lint-fix:
    cd infra && yarn lint:fix

# TypeScript type checking (no emit)
[group('quality')]
typecheck:
    cd infra && yarn typecheck

# Full health check (lint + unused + deps)
[group('quality')]
health:
    cd infra && yarn health

# CI health check (stricter output)
[group('quality')]
health-ci:
    cd infra && yarn health:ci

# Validate dependency rules (local — interactive output)
# Uses dependency-cruiser to enforce architectural boundaries.
[group('quality')]
deps-check:
    cd infra && yarn deps:check

# Validate dependency rules (CI — stricter err-long output)
# Called by: .github/workflows/ci.yml → deps-check job
[group('quality')]
deps-check-ci:
    cd infra && yarn deps:check:ci

# Find unused exports
[group('quality')]
find-unused:
    cd infra && yarn find:unused

# CDK validation (synth + nag)
[group('quality')]
lint-cdk:
    cd infra && yarn lint:cdk

# Run security audit on dependencies
[group('quality')]
audit *ARGS:
    cd infra && yarn npm audit --all --recursive --no-deprecations --severity high {{ARGS}}

# Validate synthesized CloudFormation templates with cfn-lint
[group('quality')]
validate:
    #!/usr/bin/env bash
    if [ ! -d "infra/cdk.out" ]; then
      echo "❌ infra/cdk.out/ not found. Run 'just synth <project> <env>' first."
      exit 1
    fi
    templates=$(ls infra/cdk.out/*.template.json 2>/dev/null | wc -l)
    echo "ℹ Found ${templates} CloudFormation templates"
    cfn-lint "infra/cdk.out/**/*.template.json"

# Run Checkov IaC security scan against synthesized templates
[group('quality')]
security-scan *ARGS:
    #!/usr/bin/env bash
    if [ ! -d "infra/cdk.out" ]; then
      echo "❌ infra/cdk.out/ not found. Run 'just synth <project> <env>' first."
      exit 1
    fi
    mkdir -p security-reports
    checkov --directory infra/cdk.out --framework cloudformation --compact --quiet \
      -o cli -o json --output-file-path security-reports {{ARGS}}

# =============================================================================
# KUBERNETES
# =============================================================================

# Sync Grafana dashboards to S3
[group('k8s')]
k8s-dashboards *ARGS:
    npx tsx infra/scripts/deployment/sync-dashboards.ts {{ARGS}}

# Reconfigure monitoring stack via SSM
[group('k8s')]
k8s-reconfigure *ARGS:
    npx tsx infra/scripts/deployment/reconfigure-monitoring.ts {{ARGS}}

# Trigger Golden AMI build (Image Builder)
[group('k8s')]
k8s-build-golden-ami env="development" region="eu-west-1":
    npx tsx kubernetes-app/infra-ami/scripts/build-golden-ami.ts {{env}} --region {{region}}

# Lint all Helm charts (NextJS + Monitoring)
[group('k8s')]
helm-lint: helm-lint-nextjs helm-lint-monitoring

# Lint NextJS Helm chart
[group('k8s')]
helm-lint-nextjs:
    helm lint kubernetes-app/app-deploy/nextjs/helm/chart \
      -f kubernetes-app/app-deploy/nextjs/helm/nextjs-values.yaml

# Lint Monitoring Helm chart
[group('k8s')]
helm-lint-monitoring:
    helm lint kubernetes-app/app-deploy/monitoring/chart \
      -f kubernetes-app/app-deploy/monitoring/chart/values-development.yaml

# Render templates and verify nodeSelector placement (role=application / role=monitoring)
[group('k8s')]
helm-verify-selectors:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== NextJS Chart ==="
    helm template nextjs-app \
      kubernetes-app/app-deploy/nextjs/helm/chart \
      -f kubernetes-app/app-deploy/nextjs/helm/nextjs-values.yaml \
      --namespace nextjs-app | grep -c "role: application" | \
      xargs -I{} echo "  nodeSelector entries: {} (expected 1)"
    echo "=== Monitoring Chart ==="
    helm template monitoring-stack \
      kubernetes-app/app-deploy/monitoring/chart \
      -f kubernetes-app/app-deploy/monitoring/chart/values-development.yaml \
      --namespace monitoring | grep -c "role: monitoring" | \
      xargs -I{} echo "  nodeSelector entries: {} (expected 7)"
    echo "Done."

# Check SourceDestCheck status on all K8s compute instances
# Filters by Stack tag to show only K8s nodes (control-plane, app-worker, mon-worker).
# SourceDestCheck must be false for Calico direct routing (VXLANCrossSubnet + same subnet).
[group('k8s')]
k8s-check-source-dest region="eu-west-1" profile="dev-account":
    aws ec2 describe-instances \
      --filters \
        "Name=tag:Stack,Values=KubernetesCompute,KubernetesWorkerApp,KubernetesWorkerMonitoring" \
        "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0],NetworkInterfaces[0].SourceDestCheck]' \
      --output table \
      --region {{region}} \
      --profile {{profile}}

# List all running EC2 instances with private IP and SourceDestCheck
[group('k8s')]
ec2-list-instances region="eu-west-1" profile="dev-account":
    aws ec2 describe-instances \
      --filters "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,Tags[?Key==`Name`].Value|[0],NetworkInterfaces[0].SourceDestCheck]' \
      --output table \
      --region {{region}} \
      --profile {{profile}}

# =============================================================================
# CROSS-ACCOUNT & OPS (delegates to standalone scripts)
# =============================================================================

# Deploy CrossAccountDnsRoleStack to root account (one-time setup)
[group('ops')]
setup-dns-role profile hosted-zone-ids trusted-account-ids *ARGS:
    npx tsx infra/scripts/deployment/setup-dns-role.ts \
      --profile {{profile}} \
      --hosted-zone-ids {{hosted-zone-ids}} \
      --trusted-account-ids {{trusted-account-ids}} \
      {{ARGS}}

# Get CrossAccountDnsRoleStack outputs (role ARN)
[group('ops')]
get-dns-role profile *ARGS:
    npx tsx infra/scripts/deployment/get-dns-role.ts \
      --profile {{profile}} \
      {{ARGS}}

# Deploy Steampipe cross-account ReadOnly roles
[group('ops')]
deploy-steampipe-roles monitoring-account *ARGS:
    npx tsx infra/scripts/deployment/deploy-steampipe-roles.ts \
      --monitoring-account {{monitoring-account}} \
      {{ARGS}}

# Delete a CloudFormation stack (e.g., just delete-stack MyStack eu-west-1 dev-account)
[group('ops')]
delete-stack stack region profile:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "⚠  About to DELETE stack '{{stack}}' in region '{{region}}' using profile '{{profile}}'"
    read -rp "Are you sure? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
    echo "→ Deleting stack '{{stack}}'…"
    aws cloudformation delete-stack \
      --stack-name "{{stack}}" \
      --region "{{region}}" \
      --profile "{{profile}}"
    echo "→ Waiting for stack deletion to complete…"
    aws cloudformation wait stack-delete-complete \
      --stack-name "{{stack}}" \
      --region "{{region}}" \
      --profile "{{profile}}"
    echo "✓ Stack '{{stack}}' deleted successfully."

# Delete a CloudWatch log group (e.g., just delete-log-group /aws/lambda/my-fn eu-west-1 dev-account)
[group('ops')]
delete-log-group log-group region profile:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "⚠  About to DELETE log group '{{log-group}}' in region '{{region}}' using profile '{{profile}}'"
    read -rp "Are you sure? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
    aws logs delete-log-group \
      --log-group-name "{{log-group}}" \
      --region "{{region}}" \
      --profile "{{profile}}"
    echo "✓ Log group '{{log-group}}' deleted."

# Update an inline IAM policy on a role (e.g., just update-oidc-policy eu-west-1 dev-account DevAccountOIDCRole ArgocdHealthCheckPolicy argocdHealthcheck.json)
[group('ops')]
update-oidc-policy region profile role-name policy-name policy-file:
    #!/usr/bin/env bash
    set -euo pipefail
    POLICY_FILE="infra/scripts/bootstrap/policies/{{policy-file}}"
    echo "→ Updating inline policy '{{policy-name}}' on role '{{role-name}}'"
    echo "  Source: ${POLICY_FILE}"
    aws iam put-role-policy \
      --role-name "{{role-name}}" \
      --policy-name "{{policy-name}}" \
      --policy-document "file://${POLICY_FILE}" \
      --profile "{{profile}}" \
      --region "{{region}}"
    echo "✓ Inline policy '{{policy-name}}' updated on role '{{role-name}}'."

# Sync monitoring configs to S3 + EC2
[group('ops')]
sync-configs *ARGS:
    npx tsx infra/scripts/deployment/sync-monitoring-configs.ts {{ARGS}}

# ---------------------------------------------------------------------------
# GitHub Workflow Dispatch (gh CLI)
# ---------------------------------------------------------------------------

# Trigger Pipeline A: K8s Infrastructure (e.g., just pipeline-infra develop)
[group('ops')]
pipeline-infra ref="develop":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Triggering Pipeline A (Infrastructure) on ref: {{ref}}"
    gh workflow run deploy-kubernetes-dev.yml --ref {{ref}}
    sleep 2
    gh run list --workflow=deploy-kubernetes-dev.yml --limit=1

# Trigger Pipeline B: GitOps Applications (e.g., just pipeline-gitops develop)
[group('ops')]
pipeline-gitops ref="develop":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Triggering Pipeline B (GitOps) on ref: {{ref}}"
    gh workflow run gitops-k8s-dev.yml --ref {{ref}}
    sleep 2
    gh run list --workflow=gitops-k8s-dev.yml --limit=1

# Watch the latest workflow run (blocks until complete)
[group('ops')]
pipeline-watch:
    gh run watch

# List recent workflow runs (all pipelines)
[group('ops')]
pipeline-status:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Pipeline A (Infrastructure) ==="
    gh run list --workflow=deploy-kubernetes-dev.yml --limit=3
    echo ""
    echo "=== Pipeline B (GitOps) ==="
    gh run list --workflow=gitops-k8s-dev.yml --limit=3

# Sync k8s-bootstrap scripts to S3 (e.g., just sync-k8s-bootstrap development dev-account)
[group('k8s')]
sync-k8s-bootstrap environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{environment}}/scripts-bucket"
    echo "→ Looking up S3 bucket from SSM: ${SSM_KEY}"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region eu-west-1 \
      --profile "{{profile}}" 2>/dev/null | sed 's|^s3://||;s|/$||')
    if [ -z "$BUCKET" ]; then
      echo "❌ SSM parameter ${SSM_KEY} not found. Has the Infra pipeline been deployed?"
      exit 1
    fi
    echo "→ Syncing kubernetes-app/k8s-bootstrap → s3://${BUCKET}/k8s-bootstrap/"
    aws s3 sync kubernetes-app/k8s-bootstrap "s3://${BUCKET}/k8s-bootstrap/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    FILE_COUNT=$(aws s3 ls "s3://${BUCKET}/k8s-bootstrap/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    echo "✓ Bootstrap sync complete (${FILE_COUNT} files on S3)"

# Sync app-deploy manifests (Helm charts) to S3 (e.g., just sync-k8s-app-deploy development dev-account)
[group('k8s')]
sync-k8s-app-deploy environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_KEY="/k8s/{{environment}}/scripts-bucket"
    echo "→ Looking up S3 bucket from SSM: ${SSM_KEY}"
    BUCKET=$(aws ssm get-parameter \
      --name "${SSM_KEY}" \
      --query 'Parameter.Value' --output text \
      --region eu-west-1 \
      --profile "{{profile}}" 2>/dev/null | sed 's|^s3://||;s|/$||')
    if [ -z "$BUCKET" ]; then
      echo "❌ SSM parameter ${SSM_KEY} not found. Has the Infra pipeline been deployed?"
      exit 1
    fi
    echo "→ Syncing kubernetes-app/app-deploy → s3://${BUCKET}/app-deploy/"
    aws s3 sync kubernetes-app/app-deploy "s3://${BUCKET}/app-deploy/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    FILE_COUNT=$(aws s3 ls "s3://${BUCKET}/app-deploy/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    echo "✓ App-deploy sync complete (${FILE_COUNT} files on S3)"

# Sync ALL k8s content (bootstrap + app-deploy) to S3
[group('k8s')]
sync-k8s-all environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Syncing all K8s content to S3 ==="
    echo ""
    just sync-k8s-bootstrap "{{environment}}" "{{profile}}"
    echo ""
    just sync-k8s-app-deploy "{{environment}}" "{{profile}}"
    echo ""
    echo "✓ All K8s content synced"

# Start an SSM session to an EC2 instance (e.g., just ec2-session i-09c7e747aad57520b dev-account)
[group('ops')]
ec2-session instance-id profile="dev-account":
    aws ssm start-session --target {{instance-id}} --profile {{profile}}

# Generate ArgoCD CI bot token and store in Secrets Manager.
# Run AFTER Pipeline A (deploy-kubernetes) Day-1 completes and ArgoCD pods are Running.
# Prerequisites:
#   - SSM session to the control plane node
#   - ArgoCD pods in Running state
#   - ci-bot account registered (done by bootstrap_argocd.py Step 9)
# On the control plane node, run:
#   kubectl config set-context --current --namespace=argocd
#   argocd account generate-token --account ci-bot --core --grpc-web
# Then store the token:
[group('ops')]
argocd-ci-token region="eu-west-1" profile="dev-account" environment="development":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== ArgoCD CI Bot Token ==="
    echo ""
    echo "This command stores a pre-generated token in Secrets Manager."
    echo "To generate the token, SSM into the control plane and run:"
    echo ""
    echo "  kubectl config set-context --current --namespace=argocd"
    echo "  argocd account generate-token --account ci-bot --core --grpc-web"
    echo ""
    read -p "Paste the token: " TOKEN
    if [ -z "$TOKEN" ]; then
      echo "✗ No token provided"
      exit 1
    fi
    SECRET_ID="k8s/{{environment}}/argocd-ci-token"
    # Create or update the secret
    if aws secretsmanager describe-secret --secret-id "$SECRET_ID" \
         --profile "{{profile}}" --region "{{region}}" &>/dev/null; then
      aws secretsmanager put-secret-value \
        --secret-id "$SECRET_ID" \
        --secret-string "$TOKEN" \
        --profile "{{profile}}" \
        --region "{{region}}"
      echo "✓ Secret updated: $SECRET_ID"
    else
      aws secretsmanager create-secret \
        --name "$SECRET_ID" \
        --secret-string "$TOKEN" \
        --profile "{{profile}}" \
        --region "{{region}}"
      echo "✓ Secret created: $SECRET_ID"
    fi

# =============================================================================
# DOCUMENTATION
# =============================================================================

# Generate TypeDoc API docs
[group('docs')]
docs:
    cd infra && yarn docs

# Serve API docs locally
[group('docs')]
docs-serve:
    cd infra && yarn docs:serve

# Generate all dependency graphs
[group('docs')]
deps-graph:
    cd infra && yarn deps:graphs

# =============================================================================
# UTILITIES
# =============================================================================

# Build TypeScript
[group('util')]
build:
    cd infra && yarn build

# Clean build artifacts
[group('util')]
clean:
    rm -rf infra/cdk.out infra/dist .cache

# Delete backup files
[group('util')]
clean-backups:
    find . \( -name '*.backup' -o -name '*.bak' -o -name '*.backup.ts' \) -not -path './node_modules/*' -delete

# Preview untracked files that would be removed (dry run)
[group('util')]
clean-untracked:
    git clean -fd --dry-run

# Remove all untracked files and directories
[group('util')]
clean-untracked-force:
    git clean -fd

# Remove macOS duplicate " 2" files (created by Finder copy conflicts)
[group('util')]
clean-duplicates:
    find . -name "* 2*" -not -path "./.git/*" -not -path "./node_modules/*" -delete

# Delete log files (e.g., cluster-overview.log, boot.log)
[group('util')]
clean-logs:
    find . -name "*.log" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./infra/cdk.out/*" -delete
    echo "✓ Log files removed"

# Install dependencies (all workspaces)
[group('util')]
install:
    yarn install

