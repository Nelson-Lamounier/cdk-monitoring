# Contributing

> This is a **solo portfolio project**. The contributing guidelines below document the development standards and workflow conventions used throughout the codebase.

---

## Prerequisites

| Tool | Version | Purpose |
|:-----|:--------|:--------|
| Node.js | 22+ (see `.nvmrc`) | Runtime |
| Yarn | 4.12+ (Corepack) | Package manager |
| [just](https://just.systems) | Latest | Task runner |
| AWS CDK CLI | `^2.232` | Infrastructure as Code |
| Python | 3.13+ | K8s bootstrap tooling |
| Docker | Latest | Containerisation |

## Getting Started

```bash
# Clone and install
git clone git@github.com:Nelson-Lamounier/cdk-monitoring.git
cd cdk-monitoring
corepack enable
yarn install

# Verify everything works
just lint
just typecheck
just build
just test-stacks
```

## Branch Naming

| Convention | Example |
|:-----------|:--------|
| Feature | `feat/short-description` |
| Bug fix | `fix/issue-description` |
| CI/CD | `ci/workflow-change` |
| Documentation | `docs/topic` |
| Refactor | `refactor/component-name` |

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `ci`, `chore`

**Scopes:** `infra`, `k8s`, `bedrock`, `frontend-ops`, `monitoring`, `ci`

**Examples:**
```
feat(infra): add Bedrock pipeline Step Functions orchestration
fix(k8s): resolve ArgoCD Redis CrashLoopBackOff during bootstrap
ci(workflows): pin CDK integ-runner to ^2.197.8
docs(kb): update monitoring stack architecture document
```

## Development Workflow

### 1. Task Runner

All operations go through the `justfile`. Never run raw commands when a recipe exists:

```bash
just --list              # See all available recipes
just lint                # ESLint (zero warnings allowed)
just typecheck           # TypeScript compiler check
just build               # Compile TypeScript
just test-stacks         # Run CDK stack unit tests
just test-frontend-ops   # Run frontend ops tests
just bootstrap-pytest    # Run K8s bootstrap Python tests
just ci-synth-validate   # Synthesise all CDK projects
just ci-security-scan    # Checkov IaC security scan
```

### 2. Code Quality Gates

All code must pass these checks before merging:

- **Zero ESLint warnings** (`--max-warnings 0`)
- **TypeScript strict mode** (`strict: true`, no `any`)
- **CDK-Nag compliance** (4 frameworks: AwsSolutions, HIPAA, NIST, PCI DSS)
- **Checkov security scan** (33 custom rules, blocks on CRITICAL/HIGH)
- **Dependency architecture validation** (dependency-cruiser)

### 3. Testing

```bash
# Unit tests (CDK stacks)
just test-stacks

# Integration tests (live AWS infrastructure)
just test-integration development

# K8s bootstrap tests (Python, fully offline)
just bootstrap-pytest

# Frontend ops tests
just test-frontend-ops
```

### 4. CDK Operations

```bash
# Synthesise a specific project
just synth monitoring development

# Deploy (requires AWS credentials)
just deploy monitoring development

# Diff against deployed stacks
just diff monitoring development
```

## Pull Request Process

1. Create a feature branch from `develop`
2. Make changes following the code standards above
3. Ensure all `just lint`, `just typecheck`, and `just test-stacks` pass locally
4. Push and create a PR targeting `develop`
5. CI pipeline runs automatically — all checks must pass
6. Squash-merge with a conventional commit message

## Knowledge Base

After making significant changes, run the KB sync workflow:

```bash
# Check for stale documentation
just kb-drift-check

# Or use the AI-driven sync:
# /kb-sync
```

## Code Style

- **UK English** for all user-facing text, logs, and documentation
- **JSDoc/TSDoc** on every function, interface, and class
- **Tailwind CSS** for UI styling
- **`import type`** for type-only imports
- **Named constants** — no magic values in assertions
