# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-03-19

### Added

#### Infrastructure
- **4 project factories** — Monitoring, Next.js, Shared, Org
- **12+ CDK stacks** across 3 environments (dev, staging, production)
- **Abstract Factory Pattern** — slim `app.ts` entry point delegating to project factories
- **Blueprint/Orchestrator separation** — reusable L3 constructs in `common/`, stack composition in `stacks/`
- **Three-Layer Configuration** — global defaults → environment personality → project-scoped config
- **SSM-Based Discovery** — cross-project resource sharing via `/{project}/{env}/type/name`

#### Security
- **33 custom Checkov rules** across 26 Python files (IAM, networking, compute, encryption, Lambda, storage)
- **CDK-Nag compliance** with 4 frameworks (AWS Solutions, HIPAA, NIST 800-53, PCI DSS)
- **CDK Governance Aspects** — published as [`@nelsonlamounier/cdk-governance-aspects`](https://www.npmjs.com/package/@nelsonlamounier/cdk-governance-aspects)
- **OIDC federation** — no static AWS credentials in GitHub Secrets
- **SLSA build provenance** attestation on deployments
- **Snyk integration** for open-source dependency and IaC scanning

#### Testing
- **20 unit test files** using Jest + CDK Assertions
- **1,150-line smoke test suite** with 9 live infrastructure checks
- **Custom ESLint rules** for test quality enforcement
- **5 reusable test fixtures**

#### CI/CD
- **19 GitHub Actions workflows** — CI, deploy, security scan, smoke tests, verification
- **Reusable workflow architecture** — composable `_deploy-*.yml` building blocks
- **Environment-scoped pipelines** with appropriate quality gates

#### Tooling
- **Interactive CLI** (`yarn cli`) — project/environment picker for all CDK operations
- **justfile** task runner — quality, security, deployment recipes
- **dependency-cruiser** architecture validation + SVG graph generation
- **TypeDoc** API documentation generation
- **Knip** unused export detection

#### Documentation
- **5 portfolio articles** (`.mdx`) covering factory pattern, deployment, security, testing, CI/CD
- **3 Architecture Decision Records** (CDK vs Terraform, self-managed K8s vs EKS, MCP for ops)
- **11 Kubernetes operations guides**
- **Operational runbooks** and troubleshooting documentation

### Recent Highlights

- `feat(alarm)` — CloudWatch alarm for auto-bootstrap Lambda failures with SNS notification
- `refactor(eip)` — migrated Elastic IP from control plane to app-worker (4 touchpoints → 1)
- `refactor(bootstrap)` — consolidated boot steps into `control_plane.py` and `worker.py`
- `fix(bootstrap)` — direct instance ID instead of SSM Targets (eliminated terminated instance timeouts)
- `refactor(ssm)` — split worker automation into app-worker and mon-worker runbooks
- `sec(workflow)` — least-privilege permissions and SLSA build provenance
- `fix(sns)` — enforce SSL on bootstrap alarm topic (AwsSolutions-SNS3)

[1.0.0]: https://github.com/Nelson-Lamounier/cdk-monitoring/releases/tag/v1.0.0
