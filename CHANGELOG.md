# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project loosely follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bedrock AI content pipeline — 4 Lambda agents (Research, Writer, QA, Publisher) orchestrated via Step Functions
- Knowledge Base drift detection in CI pipeline (`kb-drift-check` job)
- KB staleness audit workflow (monthly schedule)
- `/kb-sync` agent workflow for AI-driven documentation synchronisation
- Custom CI Docker image (`ghcr.io/nelson-lamounier/cdk-monitoring/ci`) for reproducible builds
- `cdk-governance-aspects` workspace for reusable CDK compliance aspects
- MCP server ecosystem (`mcp-infra-server`, `mcp-portfolio-docs`, `mcp-infra-diagram`)
- Frontend observability with Grafana Faro Web SDK + Alloy collector
- Real User Monitoring (RUM) Grafana dashboard
- 33 custom Checkov security rules for IaC validation

### Changed

- Migrated from ECS Fargate to self-managed Kubernetes (kubeadm) on EC2
- Decoupled Bedrock infrastructure from `bedrock-publisher` monolith into `bedrock-applications/` workspace
- Replaced interactive CLI with `justfile` task runner (2,190 lines)
- Consolidated frontend deployment scripts into `frontend-ops/` workspace
- Migrated Grafana dashboard queries from `| json` to `| logfmt` parser for Faro/Alloy compatibility
- Upgraded to Yarn 4.12 with PnP
- Upgraded to Node.js 22 (via `.nvmrc`)

### Removed

- `bedrock-publisher/` — legacy monolithic Bedrock integration (replaced by `bedrock-applications/`)
- Duplicate root-level `scripts/` for frontend operations (canonical copies in `frontend-ops/`)

### Fixed

- CloudFront 504 timeouts caused by in-cluster K8s API server unreachability
- ArgoCD Redis `secret-init` CrashLoopBackOff during bootstrap
- RUM dashboard "No Data" caused by log parser mismatch (`json` vs `logfmt`)

### Security

- OIDC authentication for all GitHub Actions workflows (no long-lived AWS credentials)
- CDK-Nag compliance across 4 packs (AwsSolutions, HIPAA, NIST 800-53, PCI DSS)
- All third-party GitHub Actions pinned to full commit SHAs
- Infrastructure identifiers masked in CI logs via `::add-mask::`

## [1.0.0] — 2025-07-01

### Added

- Initial monorepo architecture with Abstract Factory pattern
- Core CDK infrastructure: VPC, EKS/kubeadm, NLB, CloudFront, S3, DynamoDB
- CI/CD pipeline with GitHub Actions (lint, typecheck, build, test, synth, security scan)
- Helm chart validation (lint, template, kubeconform)
- K8s bootstrap system (ArgoCD, cert-manager, etcd DR, TLS persistence)
- Integration test framework for live AWS infrastructure validation
- SSM Parameter Store-based service discovery
