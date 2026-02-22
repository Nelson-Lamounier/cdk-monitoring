# @format
# justfile — Task runner for cdk-monitoring
#
# Usage:
#   just              List all recipes
#   just synth        CDK synth (interactive)
#   just deploy       CDK deploy (interactive)
#   just test         Run all tests
#
# Prerequisites:
#   brew install just
#
# This file wraps the existing TypeScript CLI (scripts/deployment/cli.ts)
# and npm scripts. No infrastructure code is duplicated here.

# Default recipe — show help
default:
    @just --list --unsorted

# =============================================================================
# CDK COMMANDS (Interactive — delegates to yarn cli)
# =============================================================================

# Synthesize CDK stacks (interactive or with args)
[group('cdk')]
synth *ARGS:
    yarn cli synth {{ARGS}}

# Deploy CDK stacks
[group('cdk')]
deploy *ARGS:
    yarn cli deploy {{ARGS}}

# Show diff between local and deployed stacks
[group('cdk')]
diff *ARGS:
    yarn cli diff {{ARGS}}

# Destroy CDK stacks (with safety prompts)
[group('cdk')]
destroy *ARGS:
    yarn cli destroy {{ARGS}}

# List all CDK stacks
[group('cdk')]
list *ARGS:
    yarn cli list {{ARGS}}

# Bootstrap CDK in an AWS account
[group('cdk')]
bootstrap *ARGS:
    yarn cli bootstrap {{ARGS}}

# =============================================================================
# CI SCRIPTS (Non-interactive — used by GitHub Actions)
# =============================================================================

# CI synth: synthesize + output stack names (e.g., just ci-synth k8s development)
[group('ci')]
ci-synth project environment:
    npx tsx scripts/deployment/synthesize-ci.ts {{project}} {{environment}}

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

# CI verify deployment
[group('ci')]
ci-verify *ARGS:
    npx tsx scripts/deployment/verify-deployment.ts {{ARGS}}

# CI smoke tests (NextJS)
[group('ci')]
ci-smoke *ARGS:
    npx tsx scripts/deployment/smoke-tests-nextjs.ts {{ARGS}}

# CI sync S3 assets
[group('ci')]
ci-sync-assets *ARGS:
    npx tsx scripts/deployment/sync-assets-ci.ts {{ARGS}}

# CI get stack names
[group('ci')]
ci-stack-names *ARGS:
    npx tsx scripts/deployment/get-stack-names.ts {{ARGS}}

# =============================================================================
# TESTING
# =============================================================================

# Run all tests
[group('test')]
test *ARGS:
    yarn test {{ARGS}}

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
    npx jest {{path}} --no-coverage

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

# Find unused exports
[group('quality')]
find-unused:
    yarn find:unused

# CDK validation (synth + nag)
[group('quality')]
lint-cdk:
    yarn lint:cdk

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

# Cross-account DNS role setup
[group('util')]
setup-dns-role *ARGS:
    yarn cli setup-dns-role {{ARGS}}

# Get DNS role ARN
[group('util')]
get-dns-role *ARGS:
    yarn cli get-dns-role {{ARGS}}
