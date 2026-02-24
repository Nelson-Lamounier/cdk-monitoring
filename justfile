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
# CDK COMMANDS (call npx cdk directly — no interactive CLI layer)
# =============================================================================

# Synthesize CDK stacks (e.g., just synth monitoring development)
[group('cdk')]
synth project environment *ARGS:
    npx cdk synth --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Deploy CDK stacks (e.g., just deploy monitoring development)
[group('cdk')]
deploy project environment *ARGS:
    npx cdk deploy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Show diff between local and deployed stacks
[group('cdk')]
diff project environment *ARGS:
    npx cdk diff --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Destroy CDK stacks (with CDK's built-in confirmation)
[group('cdk')]
destroy project environment *ARGS:
    npx cdk destroy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# List all CDK stacks for a project
[group('cdk')]
list project environment *ARGS:
    npx cdk list \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Bootstrap CDK in an AWS account
[group('cdk')]
bootstrap account profile *ARGS:
    cdk bootstrap aws://{{account}}/eu-west-1 \
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
# Covers: monitoring (3 stacks), k8s (4 stacks), nextjs (multi-stack).
# Called by: .github/workflows/ci.yml → validate-cdk job
[group('ci')]
ci-synth-validate:
    #!/usr/bin/env bash
    set -euo pipefail
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
    # k8s stacks: Compute (EC2/ASG/EBS) + Edge (CloudFront/WAF/ACM)
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
    echo "✓ CDK synthesis validation complete (all projects)"

# CI synth: synthesize + output stack names (e.g., just ci-synth kubernetes development)
# Used by deployment pipelines to get ordered stack names for targeted deploys.
# Called by: .github/workflows/_deploy-monitoring.yml, _deploy-nextjs.yml
[group('ci')]
ci-synth project environment:
    npx tsx scripts/deployment/synthesize-ci.ts {{project}} {{environment}}

# CI preflight: validate inputs, verify credentials and bootstrap
[group('ci')]
ci-preflight *ARGS:
    npx tsx scripts/deployment/preflight-checks.ts {{ARGS}}

# CI deploy: deploy a specific stack (e.g., just ci-deploy K8s-Compute-development)
[group('ci')]
ci-deploy *ARGS:
    npx tsx scripts/deployment/deploy.ts {{ARGS}}

# CI rollback: rollback a failed deployment
[group('ci')]
ci-rollback *ARGS:
    npx tsx scripts/deployment/rollback.ts {{ARGS}}

# CI drift detection
[group('ci')]
ci-drift *ARGS:
    npx tsx scripts/deployment/drift-detection.ts {{ARGS}}

# CI diagnose: diagnose a failed CloudFormation stack deployment
[group('ci')]
ci-diagnose *ARGS:
    npx tsx scripts/deployment/diagnose-stack.ts {{ARGS}}

# CI collect-outputs: retrieve and save CDK stack outputs
[group('ci')]
ci-collect-outputs *ARGS:
    npx tsx scripts/deployment/collect-outputs.ts {{ARGS}}

# CI deploy-summary: generate per-stack deployment summary
[group('ci')]
ci-deploy-summary *ARGS:
    npx tsx scripts/deployment/deploy-summary.ts {{ARGS}}

# CI deploy-manifests: deploy K8s manifests via SSM Run Command
# Usage: just ci-deploy-manifests monitoring development
#        just ci-deploy-manifests nextjs production --region eu-west-1
[group('ci')]
ci-deploy-manifests *ARGS:
    npx tsx scripts/deployment/deploy-manifests.ts {{ARGS}}

# CI verify deployment
[group('ci')]
ci-verify *ARGS:
    npx tsx scripts/deployment/verify-deployment.ts {{ARGS}}

# CI smoke tests (NextJS ECS)
[group('ci')]
ci-smoke *ARGS:
    npx tsx scripts/deployment/smoke-tests-nextjs.ts {{ARGS}}

# CI smoke tests (NextJS K8s)
[group('ci')]
ci-smoke-kubernetes *ARGS:
    npx tsx scripts/deployment/smoke-tests-nextjs-kubernetes.ts {{ARGS}}

# CI smoke tests (Monitoring K8s)
[group('ci')]
ci-smoke-monitoring-kubernetes *ARGS:
    npx tsx scripts/deployment/smoke-tests-monitoring-kubernetes.ts {{ARGS}}

# CI smoke tests (Kubernetes Infrastructure — full kubeadm deployment)
[group('ci')]
ci-smoke-kubernetes-infra *ARGS:
    npx tsx scripts/deployment/smoke-tests-kubernetes.ts {{ARGS}}

# CI fetch boot logs from CloudWatch (failure diagnostics)
[group('ci')]
ci-fetch-boot-logs *ARGS:
    npx tsx scripts/deployment/fetch-boot-logs.ts {{ARGS}}

# CI sync S3 assets
[group('ci')]
ci-sync-assets *ARGS:
    npx tsx scripts/deployment/sync-assets-ci.ts {{ARGS}}

# CI get stack names
[group('ci')]
ci-stack-names *ARGS:
    npx tsx scripts/deployment/get-stack-names.ts {{ARGS}}

# CI deployment summary (generates GitHub step summary)
# Called by: all _deploy-*.yml workflows → summary job
[group('ci')]
ci-summary *ARGS:
    npx tsx scripts/deployment/deployment-summary.ts {{ARGS}}

# CI verify NextJS deployment (ECS health, ALB, endpoints)
# Called by: .github/workflows/_deploy-nextjs.yml → verify job
[group('ci')]
ci-verify-nextjs *ARGS:
    npx tsx scripts/deployment/verify-nextjs.ts {{ARGS}}

# =============================================================================
# TESTING
# =============================================================================

# Run all tests
[group('test')]
test *ARGS:
    yarn test {{ARGS}}

# Run stack unit tests only (used by CI)
# Targets: tests/unit/stacks/ — covers all CDK stack snapshot + assertion tests.
# Called by: .github/workflows/ci.yml → test-stacks job
[group('test')]
test-stacks:
    yarn test tests/unit/stacks

# Run tests in watch mode
[group('test')]
test-watch:
    yarn test:watch

# Run tests with coverage
[group('test')]
test-coverage:
    yarn test:coverage

# Run unit tests only
[group('test')]
test-unit:
    yarn test:unit

# Run a specific test file (e.g., just test-file tests/unit/stacks/k8s/edge-stack.test.ts)
[group('test')]
test-file path:
    CDK_BUNDLING_STACKS='[]' npx jest {{path}} --no-coverage

# =============================================================================
# CODE QUALITY
# =============================================================================

# Run ESLint
[group('quality')]
lint:
    yarn lint

# Run ESLint with auto-fix
[group('quality')]
lint-fix:
    yarn lint:fix

# TypeScript type checking (no emit)
[group('quality')]
typecheck:
    yarn typecheck

# Full health check (lint + unused + deps)
[group('quality')]
health:
    yarn health

# CI health check (stricter output)
[group('quality')]
health-ci:
    yarn health:ci

# Validate dependency rules (local — interactive output)
# Uses dependency-cruiser to enforce architectural boundaries.
[group('quality')]
deps-check:
    yarn deps:check

# Validate dependency rules (CI — stricter err-long output)
# Called by: .github/workflows/ci.yml → deps-check job
[group('quality')]
deps-check-ci:
    yarn deps:check:ci

# Find unused exports
[group('quality')]
find-unused:
    yarn find:unused

# CDK validation (synth + nag)
[group('quality')]
lint-cdk:
    yarn lint:cdk

# Run security audit on dependencies
[group('quality')]
audit *ARGS:
    yarn npm audit --all --recursive --no-deprecations --severity high {{ARGS}}

# Validate synthesized CloudFormation templates with cfn-lint
[group('quality')]
validate:
    #!/usr/bin/env bash
    if [ ! -d "cdk.out" ]; then
      echo "❌ cdk.out/ not found. Run 'just synth <project> <env>' first."
      exit 1
    fi
    templates=$(ls cdk.out/*.template.json 2>/dev/null | wc -l)
    echo "ℹ Found ${templates} CloudFormation templates"
    cfn-lint "cdk.out/**/*.template.json"

# Run Checkov IaC security scan against synthesized templates
[group('quality')]
security-scan *ARGS:
    #!/usr/bin/env bash
    if [ ! -d "cdk.out" ]; then
      echo "❌ cdk.out/ not found. Run 'just synth <project> <env>' first."
      exit 1
    fi
    mkdir -p security-reports
    checkov --directory cdk.out --framework cloudformation --compact --quiet \
      -o cli -o json --output-file-path security-reports {{ARGS}}

# =============================================================================
# KUBERNETES
# =============================================================================

# Sync Grafana dashboards to S3
[group('k8s')]
k8s-dashboards *ARGS:
    npx tsx scripts/deployment/sync-dashboards.ts {{ARGS}}

# Reconfigure monitoring stack via SSM
[group('k8s')]
k8s-reconfigure *ARGS:
    npx tsx scripts/deployment/reconfigure-monitoring.ts {{ARGS}}

# Trigger Golden AMI build (Image Builder)
[group('k8s')]
k8s-build-golden-ami env="development" region="eu-west-1":
    npx tsx scripts/deployment/build-golden-ami.ts {{env}} --region {{region}}

# =============================================================================
# CROSS-ACCOUNT & OPS (delegates to standalone scripts)
# =============================================================================

# Deploy CrossAccountDnsRoleStack to root account (one-time setup)
[group('ops')]
setup-dns-role profile hosted-zone-ids trusted-account-ids *ARGS:
    npx tsx scripts/deployment/setup-dns-role.ts \
      --profile {{profile}} \
      --hosted-zone-ids {{hosted-zone-ids}} \
      --trusted-account-ids {{trusted-account-ids}} \
      {{ARGS}}

# Get CrossAccountDnsRoleStack outputs (role ARN)
[group('ops')]
get-dns-role profile *ARGS:
    npx tsx scripts/deployment/get-dns-role.ts \
      --profile {{profile}} \
      {{ARGS}}

# Deploy Steampipe cross-account ReadOnly roles
[group('ops')]
deploy-steampipe-roles monitoring-account *ARGS:
    npx tsx scripts/deployment/deploy-steampipe-roles.ts \
      --monitoring-account {{monitoring-account}} \
      {{ARGS}}

# Sync monitoring configs to S3 + EC2
[group('ops')]
sync-configs *ARGS:
    npx tsx scripts/deployment/sync-monitoring-configs.ts {{ARGS}}

# =============================================================================
# DOCUMENTATION
# =============================================================================

# Generate TypeDoc API docs
[group('docs')]
docs:
    yarn docs

# Serve API docs locally
[group('docs')]
docs-serve:
    yarn docs:serve

# Generate all dependency graphs
[group('docs')]
deps-graph:
    yarn deps:graphs

# =============================================================================
# UTILITIES
# =============================================================================

# Build TypeScript
[group('util')]
build:
    yarn build

# Clean build artifacts
[group('util')]
clean:
    rm -rf cdk.out dist .cache

# Delete backup files
[group('util')]
clean-backups:
    find . \( -name '*.backup' -o -name '*.bak' -o -name '*.backup.ts' \) -not -path './node_modules/*' -delete

# Install dependencies
[group('util')]
install:
    yarn install
