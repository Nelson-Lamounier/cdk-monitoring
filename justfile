# @format
# justfile — Task runner for cdk-monitoring
#
# Usage:
#   just              List all recipes
#   just synth kubernetes development
#   just deploy kubernetes development
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

# Synthesize CDK stacks (e.g., just synth kubernetes development)
[group('cdk')]
synth project environment *ARGS:
    cd infra && npx cdk synth --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      {{ARGS}}

# Deploy CDK stacks (e.g., just deploy kubernetes development)
[group('cdk')]
deploy project environment *ARGS:
    cd infra && npx cdk deploy --all \
      -c project={{project}} -c environment={{environment}} \
      --profile $(just _profile {{environment}}) \
      --require-approval never \
      {{ARGS}}

# Deploy a single CDK stack (e.g., just deploy-stack ArgocdWorker-development kubernetes development)
[group('cdk')]
deploy-stack stack project environment *ARGS:
    cd infra && npx cdk deploy {{stack}} --exclusively \
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
# Covers: k8s (8 stacks), bedrock (4 stacks), shared (1 stack).
# Called by: .github/workflows/ci.yml → validate-cdk job
[group('ci')]
ci-synth-validate:
    #!/usr/bin/env bash
    set -uo pipefail
    cd infra
    FAILURES=0

    echo "==========================================="
    echo "Validating K8s Project (dev)"
    echo "==========================================="
    if npx cdk synth -c project=kubernetes -c environment=dev -c adminAllowedIps=NONE --no-lookups --quiet; then
      echo "✓ K8s synth passed"
    else
      echo "✗ K8s synth FAILED"
      FAILURES=$((FAILURES + 1))
    fi

    echo ""
    echo "==========================================="
    echo "Validating Bedrock Project (dev)"
    echo "==========================================="
    if npx cdk synth -c project=bedrock -c environment=dev --no-lookups --quiet; then
      echo "✓ Bedrock synth passed"
    else
      echo "⚠ Bedrock synth failed (expected in container — no Docker daemon)"
      # Not counted as failure: Bedrock constructs require Docker for asset bundling
    fi

    echo ""
    echo "==========================================="
    echo "Validating Shared Project (dev)"
    echo "==========================================="
    if npx cdk synth -c project=shared -c environment=dev --no-lookups --quiet; then
      echo "✓ Shared synth passed"
    else
      echo "✗ Shared synth FAILED"
      FAILURES=$((FAILURES + 1))
    fi

    echo ""
    if [ "$FAILURES" -gt 0 ]; then
      echo "✗ CDK synthesis validation failed ($FAILURES project(s) failed)"
      exit 1
    fi
    echo "✓ CDK synthesis validation complete (all projects)"

# CI pipeline setup: validate account ID, resolve edge config, mask secrets
# Called by: .github/workflows/_deploy-kubernetes.yml → setup job
[group('ci')]
ci-pipeline-setup:
    npx tsx infra/scripts/ci/pipeline-setup.ts

# CI synth: synthesize + output stack names (e.g., just ci-synth kubernetes development)
# Used by deployment pipelines to get ordered stack names for targeted deploys.
# Called by: .github/workflows/_deploy-kubernetes.yml
[group('ci')]
ci-synth project environment:
    npx tsx infra/scripts/ci/synthesize.ts {{project}} {{environment}}

# CI preflight: validate inputs, verify credentials and bootstrap
[group('ci')]
ci-preflight *ARGS:
    npx tsx infra/scripts/ci/preflight-checks.ts {{ARGS}}

# CI rescue: detect and import orphaned CloudFormation resources before deploy
[group('ci')]
ci-cfn-rescue *ARGS:
    npx tsx infra/scripts/ci/cfn-import-rescue.ts {{ARGS}}

# CI deploy: deploy a specific stack (e.g., just ci-deploy ControlPlane-development)
[group('ci')]
ci-deploy *ARGS:
    npx tsx infra/scripts/cd/deploy.ts {{ARGS}}

# CI rollback: rollback a failed deployment
[group('ci')]
ci-rollback *ARGS:
    npx tsx infra/scripts/cd/diagnose-rollback.ts {{ARGS}} --mode rollback

# CI drift detection
[group('ci')]
ci-drift *ARGS:
    npx tsx infra/scripts/ci/drift-detection.ts {{ARGS}}

# CI log group audit: find empty CloudWatch log groups (no streams)
[group('ci')]
ci-log-audit *ARGS:
    npx tsx infra/scripts/ci/log-group-audit.ts {{ARGS}}

# CI security scan: run Checkov against synthesised CDK templates
# Blocks on CRITICAL/HIGH findings. Use --soft-fail for advisory mode.
# Called by: .github/workflows/ci.yml → iac-security-scan job
[group('ci')]
ci-security-scan *ARGS:
    npx tsx infra/scripts/ci/security-scan.ts {{ARGS}}



# CI diagnose: diagnose a failed CloudFormation stack deployment
[group('ci')]
ci-diagnose *ARGS:
    npx tsx infra/scripts/cd/diagnose-rollback.ts {{ARGS}} --mode diagnose

# CI failure report: aggregate multi-stack diagnostics for failed deployment
[group('ci')]
ci-failure-report *ARGS:
    npx tsx infra/scripts/cd/deployment-failure-report.ts {{ARGS}}

# CI sync-scripts: sync bootstrap and deploy scripts to S3
[group('ci')]
ci-sync-scripts *ARGS:
    npx tsx infra/scripts/cd/sync-bootstrap-scripts.ts {{ARGS}}

# CI trigger-bootstrap: trigger SSM Automation on K8s nodes
[group('ci')]
ci-trigger-bootstrap *ARGS:
    npx tsx infra/scripts/cd/trigger-bootstrap.ts {{ARGS}}

# CI observe-bootstrap: poll SSM Automation & stream CloudWatch logs
[group('ci')]
ci-observe-bootstrap *ARGS:
    npx tsx infra/scripts/cd/observe-bootstrap.ts {{ARGS}}

# CI deploy-monitoring-secrets: deploy monitoring secrets via SSM Automation
[group('ci')]
ci-deploy-monitoring-secrets *ARGS:
    npx tsx infra/scripts/cd/deploy-monitoring-secrets.ts {{ARGS}}

# CI deploy-nextjs-secrets: deploy Next.js secrets via SSM Automation
[group('ci')]
ci-deploy-nextjs-secrets *ARGS:
    npx tsx infra/scripts/cd/deploy-nextjs-secrets.ts {{ARGS}}

# CI finalize: collect outputs, write summary, save artifacts
[group('ci')]
ci-finalize-deployment *ARGS:
    npx tsx infra/scripts/cd/finalize.ts {{ARGS}}

# CI summary: generate pipeline-wide deployment summary
# Usage: just ci-summary kubernetes development
[group('ci')]
ci-summary *ARGS:
    npx tsx infra/scripts/cd/finalize.ts {{ARGS}} --mode pipeline-summary

# CI verify ArgoCD: poll ArgoCD API for sync status
# Usage: just ci-verify-argocd --environment development --region eu-west-1
[group('ci')]
ci-verify-argocd *ARGS:
    npx tsx infra/scripts/cd/verify-argocd-sync.ts {{ARGS}}

# CI ArgoCD health: quick reachability check via SSM send-command
# Usage: just ci-argocd-health --environment development --region eu-west-1
[group('ci')]
ci-argocd-health *ARGS:
    npx tsx infra/scripts/cd/verify-argocd-sync.ts --mode health {{ARGS}}

# CI deploy-manifests: deploy K8s manifests via SSM Run Command
# Usage: just ci-deploy-manifests kubernetes development --region eu-west-1
[group('ci')]
ci-deploy-manifests *ARGS:
    npx tsx kubernetes-app/platform/charts/monitoring/scripts/deploy-manifests.ts {{ARGS}}

# CI smoke tests (Kubernetes Infrastructure — full kubeadm deployment)
[group('ci')]
ci-smoke-kubernetes-infra *ARGS:
    npx tsx infra/scripts/validation/smoke-tests-kubernetes.ts {{ARGS}}

# CI fetch boot logs from CloudWatch (failure diagnostics)
[group('ci')]
ci-fetch-boot-logs *ARGS:
    npx tsx kubernetes-app/k8s-bootstrap/scripts/fetch-boot-logs.ts {{ARGS}}



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

# Run integration tests (post-deployment — calls real AWS APIs)
# Usage: just ci-integration-test kubernetes development
[group('ci')]
ci-integration-test project environment *ARGS:
    cd infra && CDK_ENV={{environment}} npx jest --config jest.integration.config.js --testPathPattern="tests/integration/{{project}}" {{ARGS}}

# Run integration tests locally (with AWS profile)
# Usage: just test-integration kubernetes development
[group('test')]
test-integration project environment *ARGS:
    cd infra && AWS_PROFILE=$(just _profile {{environment}}) CDK_ENV={{environment}} npx jest --config jest.integration.config.js --testPathPattern="tests/integration/{{project}}" {{ARGS}}

# Run frontend-ops tests (sync script + workflow validation)
# Usage: just test-frontend-ops
[group('test')]
test-frontend-ops *ARGS:
    npx jest --config frontend-ops/jest.config.js {{ARGS}}

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

# Run Snyk security scan (open-source deps + IaC)
# Requires SNYK_TOKEN environment variable (set in GitHub Secrets or local env).
# Free tier: unlimited tests for open-source projects, 300 IaC tests/month.
# Usage: just security-snyk
[group('quality')]
security-snyk *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v snyk &> /dev/null; then
      echo "→ Installing Snyk CLI…"
      npm install -g snyk
    fi
    echo "=== Snyk Open-Source (Dependencies) ==="
    snyk test --all-projects --severity-threshold=high {{ARGS}} || true
    echo ""
    echo "=== Snyk IaC (CloudFormation Templates) ==="
    if [ -d "infra/cdk.out" ]; then
      snyk iac test infra/cdk.out --severity-threshold=high {{ARGS}} || true
    else
      echo "⚠ infra/cdk.out/ not found. Run 'just synth <project> <env>' first."
    fi

# =============================================================================
# KUBERNETES
# =============================================================================

# Sync Grafana dashboards to S3
# TODO: sync-dashboards.ts does not exist yet — uncomment when implemented
# [group('k8s')]
# k8s-dashboards *ARGS:
#     npx tsx infra/scripts/pipeline/sync-dashboards.ts {{ARGS}}



# Trigger Golden AMI build (Image Builder)
[group('k8s')]
k8s-build-golden-ami env="development" region="eu-west-1":
    npx tsx kubernetes-app/infra-ami/scripts/build-golden-ami.ts {{env}} --region {{region}}

# Validate Grafana dashboard JSON files (syntax, schema, unique UIDs)
# Catches broken dashboards BEFORE Helm render or ArgoCD sync.
# Called by: .github/workflows/gitops-k8s-dev.yml → validate job
[group('k8s')]
validate-dashboards:
    npx tsx kubernetes-app/platform/charts/monitoring/scripts/validate-dashboards.ts

# Run dashboard validation test suite (per-file granularity)
# Uses node:test for IDE integration and detailed test reports.
[group('test')]
test-dashboards:
    npx tsx --test kubernetes-app/platform/charts/monitoring/tests/validate-dashboards.test.ts

# Validate all Helm charts (lint + template render)
# Catches rendering errors (broken delimiters, missing values) BEFORE ArgoCD sync.
# Called by: .github/workflows/gitops-k8s-dev.yml → validate job
[group('k8s')]
helm-validate-charts:
    #!/usr/bin/env bash
    set -euo pipefail
    ERRORS=0

    echo "=== Helm Chart Validation ==="
    echo ""

    # --- Next.js chart ---
    echo "--- Next.js chart ---"
    if helm lint kubernetes-app/workloads/charts/nextjs/chart \
         -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml 2>&1; then
      echo "  ✓ lint passed"
    else
      echo "  ✗ lint FAILED"
      ERRORS=$((ERRORS + 1))
    fi

    if helm template nextjs-app kubernetes-app/workloads/charts/nextjs/chart \
         -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml > /dev/null 2>&1; then
      echo "  ✓ template render passed"
    else
      echo "  ✗ template render FAILED"
      helm template nextjs-app kubernetes-app/workloads/charts/nextjs/chart \
        -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml 2>&1 || true
      ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # --- Monitoring chart ---
    echo "--- Monitoring chart ---"
    if helm lint kubernetes-app/platform/charts/monitoring/chart \
         -f kubernetes-app/platform/charts/monitoring/chart/values-development.yaml 2>&1; then
      echo "  ✓ lint passed"
    else
      echo "  ✗ lint FAILED"
      ERRORS=$((ERRORS + 1))
    fi

    if helm template monitoring-stack kubernetes-app/platform/charts/monitoring/chart \
         -f kubernetes-app/platform/charts/monitoring/chart/values-development.yaml > /dev/null 2>&1; then
      echo "  ✓ template render passed"
    else
      echo "  ✗ template render FAILED"
      helm template monitoring-stack kubernetes-app/platform/charts/monitoring/chart \
        -f kubernetes-app/platform/charts/monitoring/chart/values-development.yaml 2>&1 || true
      ERRORS=$((ERRORS + 1))
    fi
    echo ""

    # --- Golden Path Service chart ---
    echo "--- Golden Path Service chart ---"
    if helm lint kubernetes-app/workloads/charts/golden-path-service/chart \
         -f kubernetes-app/workloads/charts/golden-path-service/chart/values.yaml 2>&1; then
      echo "  ✓ lint passed"
    else
      echo "  ✗ lint FAILED"
      ERRORS=$((ERRORS + 1))
    fi

    if helm template golden-path kubernetes-app/workloads/charts/golden-path-service/chart \
         -f kubernetes-app/workloads/charts/golden-path-service/chart/values.yaml > /dev/null 2>&1; then
      echo "  ✓ template render passed"
    else
      echo "  ✗ template render FAILED"
      helm template golden-path kubernetes-app/workloads/charts/golden-path-service/chart \
        -f kubernetes-app/workloads/charts/golden-path-service/chart/values.yaml 2>&1 || true
      ERRORS=$((ERRORS + 1))
    fi
    echo ""

    if [ $ERRORS -gt 0 ]; then
      echo "✗ $ERRORS chart validations FAILED"
      exit 1
    fi
    echo "✓ All Helm charts validated successfully"

# Render templates and verify nodeSelector placement (workload=frontend)
[group('k8s')]
helm-verify-selectors:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== NextJS Chart ==="
    helm template nextjs-app \
      kubernetes-app/workloads/charts/nextjs/chart \
      -f kubernetes-app/workloads/charts/nextjs/chart/values.yaml \
      --namespace nextjs-app | grep -c "workload: frontend" | \
      xargs -I{} echo "  nodeSelector entries: {} (expected 1)"
    echo "Done."

# Check SourceDestCheck status on all K8s compute instances
# Filters by Stack tag to show only K8s nodes (control-plane, app-worker, mon-worker).
# SourceDestCheck must be false for Calico pod networking (required even with VXLANAlways).
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

# Disable SourceDestCheck on a specific EC2 instance
# Required for Kubernetes pod networking (Calico VXLAN encapsulation).
# Usage: just ec2-disable-source-dest-check i-069286d4c9098608b
[group('k8s')]
ec2-disable-source-dest-check instance-id region="eu-west-1" profile="dev-account":
    aws ec2 modify-instance-attribute \
      --instance-id {{instance-id}} \
      --no-source-dest-check \
      --region {{region}} \
      --profile {{profile}}

# Trigger SSM Automation — Control Plane bootstrap (7 steps)
# Runs: validateGoldenAMI → initKubeadm → installCalicoCNI → configureKubectl
#       → syncManifests → bootstrapArgoCD → verifyCluster
# Usage: just ssm-run-controlplane i-0f1491fd3dc63fd66
[group('k8s')]
ssm-run-controlplane instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/k8s/{{env}}"
    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "Starting control-plane bootstrap on {{instance-id}}..."
    EXEC_ID=$(aws ssm start-automation-execution \
      --document-name "k8s-{{env}}-bootstrap-control-plane" \
      --parameters "InstanceId={{instance-id}},SsmPrefix=${SSM_PREFIX},S3Bucket=${S3_BUCKET},Region={{region}}" \
      --region {{region}} --profile {{profile}} \
      --query "AutomationExecutionId" --output text)
    echo "Execution ID: ${EXEC_ID}"
    echo "Monitor:  just ssm-status ${EXEC_ID} {{region}} {{profile}}"

# Trigger SSM Automation — Worker node bootstrap (2 steps)
# Runs: validateGoldenAMI → joinCluster
# Run AFTER control-plane has completed (workers need join credentials).
# Usage: just ssm-run-worker i-071c910118e0c0beb
[group('k8s')]
ssm-run-worker instance-id env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/k8s/{{env}}"
    S3_BUCKET=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/scripts-bucket" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "Starting worker bootstrap on {{instance-id}}..."
    EXEC_ID=$(aws ssm start-automation-execution \
      --document-name "k8s-{{env}}-bootstrap-worker" \
      --parameters "InstanceId={{instance-id}},SsmPrefix=${SSM_PREFIX},S3Bucket=${S3_BUCKET},Region={{region}}" \
      --region {{region}} --profile {{profile}} \
      --query "AutomationExecutionId" --output text)
    echo "Execution ID: ${EXEC_ID}"
    echo "Monitor:  just ssm-status ${EXEC_ID} {{region}} {{profile}}"

# Check SSM Automation execution status and step progress
# Usage: just ssm-status <execution-id>
[group('k8s')]
ssm-status execution-id region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    aws ssm get-automation-execution \
      --automation-execution-id {{execution-id}} \
      --query "AutomationExecution.{Status:AutomationExecutionStatus,Steps:StepExecutions[*].{Step:StepName,Status:StepStatus,Start:ExecutionStartTime,End:ExecutionEndTime}}" \
      --output table \
      --region {{region}} --profile {{profile}}

# =============================================================================
# CROSS-ACCOUNT & OPS (delegates to standalone scripts)
# =============================================================================

# Deploy CrossAccountDnsRoleStack to root account (one-time setup)
# TODO: setup-dns-role.ts does not exist yet — uncomment when implemented
# [group('ops')]
# setup-dns-role profile hosted-zone-ids trusted-account-ids *ARGS:
#     npx tsx infra/scripts/pipeline/setup-dns-role.ts \
#       --profile {{profile}} \
#       --hosted-zone-ids {{hosted-zone-ids}} \
#       --trusted-account-ids {{trusted-account-ids}} \
#       {{ARGS}}

# Get CrossAccountDnsRoleStack outputs (role ARN)
# TODO: get-dns-role.ts does not exist yet — uncomment when implemented
# [group('ops')]
# get-dns-role profile *ARGS:
#     npx tsx infra/scripts/pipeline/get-dns-role.ts \
#       --profile {{profile}} \
#       {{ARGS}}

# Deploy Steampipe cross-account ReadOnly roles
# TODO: deploy-steampipe-roles.ts does not exist yet — uncomment when implemented
# [group('ops')]
# deploy-steampipe-roles monitoring-account *ARGS:
#     npx tsx infra/scripts/pipeline/deploy-steampipe-roles.ts \
#       --monitoring-account {{monitoring-account}} \
#       {{ARGS}}

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

# List k8s-bootstrap S3 contents (e.g., just list-k8s-bootstrap development eu-west-1 dev-account)
[group('ops')]
list-k8s-bootstrap env region profile:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Resolving scripts bucket from SSM /k8s/{{env}}/scripts-bucket…"
    BUCKET=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/scripts-bucket" \
      --query 'Parameter.Value' --output text \
      --region "{{region}}" \
      --profile "{{profile}}" 2>/dev/null || echo "")
    if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
      echo "✗ SSM parameter /k8s/{{env}}/scripts-bucket not found"
      exit 1
    fi
    BUCKET=$(echo "$BUCKET" | sed 's|^s3://||' | sed 's|/$||')
    echo "→ Listing s3://${BUCKET}/k8s-bootstrap/"
    echo ""
    aws s3 ls "s3://${BUCKET}/k8s-bootstrap/" \
      --recursive \
      --region "{{region}}" \
      --profile "{{profile}}"

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

# Sync platform + workloads charts to S3 (e.g., just sync-k8s-charts development dev-account)
[group('k8s')]
sync-k8s-charts environment="development" profile="dev-account":
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
    echo "→ Syncing platform charts → s3://${BUCKET}/platform/charts/"
    aws s3 sync kubernetes-app/platform/charts "s3://${BUCKET}/platform/charts/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    echo "→ Syncing workloads charts → s3://${BUCKET}/workloads/charts/"
    aws s3 sync kubernetes-app/workloads/charts "s3://${BUCKET}/workloads/charts/" \
      --delete --region eu-west-1 --profile "{{profile}}"
    PLATFORM_COUNT=$(aws s3 ls "s3://${BUCKET}/platform/charts/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    WORKLOADS_COUNT=$(aws s3 ls "s3://${BUCKET}/workloads/charts/" --recursive --profile "{{profile}}" | wc -l | tr -d ' ')
    echo "✓ Charts sync complete (platform: ${PLATFORM_COUNT}, workloads: ${WORKLOADS_COUNT} files on S3)"

# Sync ALL k8s content (bootstrap + charts) to S3
[group('k8s')]
sync-k8s-all environment="development" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "=== Syncing all K8s content to S3 ==="
    echo ""
    just sync-k8s-bootstrap "{{environment}}" "{{profile}}"
    echo ""
    just sync-k8s-charts "{{environment}}" "{{profile}}"
    echo ""
    echo "✓ All K8s content synced"

# Start an SSM session to an EC2 instance (e.g., just ec2-session i-09c7e747aad57520b dev-account)
[group('ops')]
ec2-session instance-id profile="dev-account":
    aws ssm start-session --target {{instance-id}} --profile {{profile}}

# Port-forward K8s API server (6443) via SSM tunnel
# Requires: local ~/.kube/config with server: https://127.0.0.1:6443
# Usage: just k8s-tunnel i-046a1035c0d593dc7
[group('k8s')]
k8s-tunnel instance-id region="eu-west-1" profile="dev-account":
    aws ssm start-session \
      --target {{instance-id}} \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
      --region {{region}} --profile {{profile}}

# Port-forward K8s API server — auto-resolves control plane instance ID from SSM
# Usage: just k8s-tunnel-auto
[group('k8s')]
k8s-tunnel-auto env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    INSTANCE_ID=$(aws ssm get-parameter \
      --name "/k8s/{{env}}/bootstrap/control-plane-instance-id" \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}})
    echo "→ Control plane instance: ${INSTANCE_ID}"
    echo "→ Opening tunnel to K8s API (port 6443)…"
    aws ssm start-session \
      --target "${INSTANCE_ID}" \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}' \
      --region {{region}} --profile {{profile}}

# Fetch kubeconfig from SSM and write to ~/.kube/config
# The control plane bootstrap stores a tunnel-ready kubeconfig in SSM
# after every kubeadm init (server address rewritten to 127.0.0.1:6443).
# Usage: just k8s-fetch-kubeconfig
[group('k8s')]
k8s-fetch-kubeconfig env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PATH="/k8s/{{env}}/kubeconfig"
    echo "→ Fetching kubeconfig from SSM: ${SSM_PATH}"
    KUBECONFIG_CONTENT=$(aws ssm get-parameter \
      --name "${SSM_PATH}" \
      --with-decryption \
      --query "Parameter.Value" --output text \
      --region {{region}} --profile {{profile}} 2>/dev/null || echo "")
    if [ -z "$KUBECONFIG_CONTENT" ]; then
      echo "✗ SSM parameter ${SSM_PATH} not found."
      echo "  The control plane bootstrap publishes this after kubeadm init."
      echo "  If the cluster was just rebuilt, wait for the bootstrap to complete."
      exit 1
    fi
    KUBE_DIR="$HOME/.kube"
    mkdir -p "$KUBE_DIR"
    if [ -f "$KUBE_DIR/config" ]; then
      BACKUP="$KUBE_DIR/config.backup.$(date +%Y%m%d%H%M%S)"
      cp "$KUBE_DIR/config" "$BACKUP"
      echo "→ Backed up existing config → $BACKUP"
    fi
    echo "$KUBECONFIG_CONTENT" > "$KUBE_DIR/config"
    chmod 600 "$KUBE_DIR/config"
    echo "✓ Kubeconfig written to $KUBE_DIR/config"
    echo ""
    echo "→ Validating connectivity (requires active SSM tunnel)…"
    if kubectl get nodes 2>/dev/null; then
      echo ""
      echo "✓ Cluster access restored successfully"
    else
      echo ""
      echo "⚠ kubectl failed — ensure the SSM tunnel is active:"
      echo "  just k8s-tunnel-auto"
    fi
# Requires: active SSM tunnel (just k8s-tunnel-auto), k8sgpt CLI, Bedrock auth configured
# Setup: k8sgpt auth add --backend amazonbedrock --model eu.anthropic.claude-sonnet-4-20250514-v1:0 --providerRegion eu-central-1
[group('k8s')]
k8s-diagnose environment="development":
    AWS_PROFILE=$(just _profile {{environment}}) k8sgpt analyze --explain --backend amazonbedrock

# Diagnose K8s cluster issues without AI (free — no Bedrock cost)
# Requires: active SSM tunnel (just k8s-tunnel-auto), k8sgpt CLI
[group('k8s')]
k8s-diagnose-raw:
    k8sgpt analyze

# Trigger an ad-hoc etcd backup via SSM Run Command
# Use before: maintenance, upgrades, Crossplane changes, or node recycling
# Backup → s3://<scripts-bucket>/dr-backups/etcd/<timestamp>.db
[group('k8s')]
k8s-etcd-backup env="development" region="eu-west-1" profile="dev-account":
    #!/usr/bin/env bash
    set -euo pipefail
    SSM_PREFIX="/k8s/{{env}}"
    INSTANCE_ID=$(aws ssm get-parameter \
      --name "${SSM_PREFIX}/bootstrap/control-plane-instance-id" \
      --region {{region}} --profile {{profile}} \
      --query 'Parameter.Value' --output text 2>/dev/null || true)
    if [[ -z "${INSTANCE_ID}" ]]; then
      echo "✗ Could not resolve control plane instance ID from SSM"
      exit 1
    fi
    echo "Triggering etcd backup on ${INSTANCE_ID}..."
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "${INSTANCE_ID}" \
      --document-name "AWS-RunShellScript" \
      --parameters 'commands=["sudo /usr/local/bin/etcd-backup.sh"]' \
      --region {{region}} --profile {{profile}} \
      --query 'Command.CommandId' --output text)
    echo "SSM Command: ${COMMAND_ID}"
    echo "Waiting for completion..."
    aws ssm wait command-executed \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --region {{region}} --profile {{profile}} 2>/dev/null || true
    aws ssm get-command-invocation \
      --command-id "${COMMAND_ID}" \
      --instance-id "${INSTANCE_ID}" \
      --region {{region}} --profile {{profile}} \
      --query '[Status, StandardOutputContent]' --output text

# Build the unified MCP infrastructure server (K8s + AWS diagnostics → dist/)
[group('mcp')]
mcp-build:
    cd mcp-servers/mcp-infra-server && yarn build

# Build all MCP server Docker images (multi-stage Alpine builds)
[group('mcp')]
mcp-docker-build:
    docker compose -f docker-compose.mcp.yml build

# Build a single MCP server Docker image
# Usage: just mcp-docker-build-one infra
#        just mcp-docker-build-one docs
#        just mcp-docker-build-one diagram
[group('mcp')]
mcp-docker-build-one name:
    docker compose -f docker-compose.mcp.yml build {{name}}

# Verify MCP handshake on all Docker images (initialize → response check)
[group('mcp')]
mcp-docker-test:
    #!/usr/bin/env bash
    set -euo pipefail
    INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}'
    ERRORS=0
    for IMAGE in mcp-infra-server mcp-portfolio-docs mcp-infra-diagram; do
      echo "--- Testing ${IMAGE} ---"
      RESPONSE=$(echo "${INIT}" | docker run -i --rm "${IMAGE}:latest" 2>/dev/null | head -1)
      if echo "${RESPONSE}" | grep -q '"serverInfo"'; then
        SERVER_NAME=$(echo "${RESPONSE}" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
        echo "  ✓ Handshake OK — server: ${SERVER_NAME}"
      else
        echo "  ✗ Handshake FAILED"
        echo "  Response: ${RESPONSE}"
        ERRORS=$((ERRORS + 1))
      fi
    done
    echo ""
    if [ $ERRORS -gt 0 ]; then
      echo "✗ ${ERRORS} handshake(s) FAILED"
      exit 1
    fi
    echo "✓ All MCP servers respond correctly"
    echo ""
    echo "=== Image Sizes ==="
    docker images | head -1 && docker images | grep mcp

# Discover SSM parameters for Next.js or Bedrock stacks
# Usage: just mcp-ssm-discover /nextjs/development
#        just mcp-ssm-discover /bedrock/development
[group('mcp')]
mcp-ssm-discover prefix environment="development":
    AWS_PROFILE=$(just _profile {{environment}}) aws ssm get-parameters-by-path \
      --path "{{prefix}}" \
      --recursive \
      --query "Parameters[].{Name:Name,Value:Value}" \
      --output table \
      --region eu-west-1

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

