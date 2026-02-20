# CDK Multi-Project Infrastructure

> A production-grade AWS CDK monorepo managing **4 projects**, **12+ stacks**, and **3 environments** through the **Project Factory pattern** — with 33 custom Checkov security rules, CDK-Nag compliance across 4 frameworks, a 1,150-line post-deploy smoke test suite, and automated CI/CD via 19 GitHub Actions workflows.

---

## Why This Repository Exists

This repository consolidates all AWS infrastructure for a solo DevOps portfolio into a single CDK codebase. The alternative — separate repos per project — would duplicate VPC configurations, security groups, IAM policies, and CI/CD workflows across 4 projects. A monorepo with the **Abstract Factory pattern** shares common constructs while isolating project-specific stacks behind typed factory interfaces.

The key design decision: **every project is a factory** that registers with a central registry. The CDK entry point (`bin/app.ts`, 105 lines) is a slim orchestrator that parses `-c project=X -c environment=Y` from the command line, resolves the factory, and applies cross-cutting concerns (tagging, compliance, governance). No project-specific logic lives in `app.ts` — it delegates everything to the factory.

```bash
# Single entry point for all projects
npx cdk synth -c project=monitoring -c environment=dev
npx cdk synth -c project=nextjs -c environment=prod
npx cdk synth -c project=org -c environment=prod
```

---

## Projects

| Project        | Stacks | Description                                                      |
| :------------- | :----: | :--------------------------------------------------------------- |
| **Monitoring** |   3    | Prometheus + Grafana + Loki observability stack on EC2 with EBS  |
| **Next.js**    |   6    | ECS on EC2 application with CloudFront, API Gateway, DynamoDB    |
| **Shared**     |   1    | Foundation tier: VPC, ECR repositories, cross-project networking |
| **Org**        |   1    | Governance tier: cross-account DNS roles, root account resources |

### Monitoring Project (3 Stacks)

| Stack       | Resources                                                                    |
| :---------- | :--------------------------------------------------------------------------- |
| **Storage** | EBS volumes, S3 script bucket, KMS encryption                                |
| **SSM**     | SSM Run Command documents for instance configuration                         |
| **Compute** | EC2 instance, ASG, Launch Template, Security Groups, Prometheus/Grafana/Loki |

### Next.js Project (6 Stacks)

| Stack           | Resources                                              | Region      |
| :-------------- | :----------------------------------------------------- | :---------- |
| **Data**        | ECR, DynamoDB, S3 static assets, SSM secrets           | `eu-west-1` |
| **Compute**     | ECS Cluster, ASG, Launch Template, IAM roles           | `eu-west-1` |
| **Networking**  | ALB, Target Groups, Task Security Group                | `eu-west-1` |
| **Application** | ECS Task Definition, ECS Service, auto-deploy pipeline | `eu-west-1` |
| **API**         | API Gateway, Lambda functions, regional WAF            | `eu-west-1` |
| **Edge**        | ACM certificate, CloudFront, global WAF                | `us-east-1` |

---

## Architecture

### Design Principles

1. **Abstract Factory Pattern** — Each project implements `IProjectFactory` with a `createAllStacks()` method. The factory registry maps project names to factories. Adding a new project means implementing the interface and registering it.

2. **Blueprints vs. Orchestrators** — `lib/common/` contains environment-agnostic constructs (Blueprints) that focus on a single AWS resource. `lib/stacks/` contains Orchestrators that wire blueprints into functional stacks with dependency injection.

3. **Three-Layer Configuration** — Global baselines in `defaults.ts` (ports, regions), environment personality in `environments.ts` (cost-optimized dev vs. hardened prod), and project-scoped config in `lib/config/{project}/` (CPU, memory, retention).

4. **SSM-Based Discovery** — Cross-project resource sharing uses SSM Parameter Store with the `/{project}/{environment}/type/name` convention. Producers write physical IDs; consumers use `valueFromLookup()` during synthesis.

5. **Direct Stack References** — Within the same factory, stacks pass construct objects directly (not CloudFormation exports). This avoids unmanaged stack locks from `Fn.importValue`.

### Cross-Cutting Governance (CDK Aspects)

| Aspect                            | Scope        | Purpose                                                                    |
| :-------------------------------- | :----------- | :------------------------------------------------------------------------- |
| **TaggingAspect**                 | All stacks   | Enforces 5-key schema (Environment, Project, Owner, ManagedBy, CostCenter) |
| **EnforceReadOnlyDynamoDbAspect** | Next.js only | Blocks 8 DynamoDB write/admin actions on ECS task roles                    |
| **CDK-Nag (AWS Solutions)**       | All stacks   | Synthesis-time compliance validation                                       |

### Security Pipeline

| Layer          | Tool    | Details                                                         |
| :------------- | :------ | :-------------------------------------------------------------- |
| **Synthesis**  | CDK-Nag | 4 compliance packs (AWS Solutions, HIPAA, NIST 800-53, PCI DSS) |
| **Pre-Deploy** | Checkov | 33 custom Python checks across 26 files                         |
| **Deploy**     | CDK     | SLSA provenance tags + OIDC federation                          |

---

## Repository Structure

```
cdk-monitoring/
├── bin/
│   └── app.ts                  # CDK entry point (105 lines) — project/env routing
├── lib/
│   ├── aspects/                # Cross-cutting concerns (3 aspects)
│   │   ├── tagging-aspect.ts
│   │   ├── cdk-nag-aspect.ts
│   │   └── enforce-readonly-dynamodb-aspect.ts
│   ├── common/                 # Shared constructs (Blueprints)
│   │   ├── compute/            # EC2, ECS Cluster, ECS Task, Lambda
│   │   ├── networking/         # VPC, CloudFront, ALB, WAF
│   │   ├── security/           # IAM, Security Groups, ACM
│   │   ├── storage/            # S3, EBS, ECR, DynamoDB
│   │   ├── events/             # EventBridge rules
│   │   ├── iam/                # IAM constructs
│   │   └── ssm/                # SSM Parameter constructs
│   ├── config/                 # Configuration hierarchy
│   │   ├── defaults.ts         # Global baselines
│   │   ├── environments.ts     # Environment personality (dev/staging/prod)
│   │   ├── ssm-paths.ts        # SSM path conventions
│   │   ├── projects.ts         # Project registry config
│   │   ├── monitoring/         # Monitoring-specific config
│   │   └── nextjs/             # Next.js-specific config
│   ├── factories/              # Project Factory registry
│   │   ├── project-registry.ts # Factory lookup + registration
│   │   └── project-interfaces.ts # IProjectFactory interface
│   ├── projects/               # Project factory implementations
│   │   ├── monitoring/         # MonitoringFactory
│   │   ├── nextjs/             # NextJsFactory
│   │   ├── org/                # OrgFactory
│   │   └── shared/             # SharedFactory
│   ├── stacks/                 # Stack implementations (Orchestrators)
│   │   ├── monitoring/         # 3 stacks: Compute, Storage, SSM
│   │   ├── nextjs/             # 6 stacks: Data, Compute, Networking, Application, API, Edge
│   │   ├── org/                # 1 stack: DNS Role
│   │   └── shared/             # 1 stack: VPC
│   ├── shared/                 # Shared stack base classes
│   └── utilities/              # Helper utilities
├── lambda/                     # Lambda function handlers
│   ├── articles/               # Articles API Lambda
│   ├── dns/                    # Cross-account DNS validation
│   ├── ebs-detach/             # EBS volume lifecycle
│   ├── ecr-deploy/             # Auto-deploy from ECR push
│   ├── ecs-service-discovery/  # ECS Cloud Map integration
│   └── subscriptions/          # SNS subscription handlers
├── .checkov/
│   ├── config.yaml             # Checkov configuration
│   └── custom_checks/          # 33 custom Python security checks (26 files)
├── .github/workflows/          # 19 GitHub Actions workflows
│   ├── ci.yml                  #   CI pipeline (lint, test, synth, security scan)
│   ├── _deploy-monitoring.yml  #   Reusable: monitoring deployment
│   ├── _deploy-nextjs.yml      #   Reusable: Next.js deployment
│   ├── _deploy-stack.yml       #   Reusable: generic stack deployment
│   ├── _iac-security-scan.yml  #   Reusable: Checkov security scan
│   ├── _smoke-tests-nextjs.yml #   Reusable: post-deploy smoke tests
│   ├── _verify-stack.yml       #   Reusable: CloudFormation status verification
│   ├── deploy-*-dev.yml        #   Environment-specific triggers
│   ├── deploy-*-staging.yml
│   ├── deploy-*-prod.yml
│   └── sync-monitoring-configs.yml #   Monitoring config sync to S3 + EC2
├── scripts/
│   ├── deployment/             # 20 deployment scripts
│   │   ├── cli.ts              #   Interactive CLI (33,000 lines)
│   │   ├── smoke-tests-nextjs.ts # Post-deploy smoke tests (1,150 lines, 9 checks)
│   │   ├── drift-detection.ts  #   CloudFormation drift detection
│   │   ├── rollback.ts         #   Stack rollback automation
│   │   ├── sync-monitoring-configs.ts #   Monitoring config S3 sync + reload
│   │   ├── verify-deployment.ts
│   │   └── verify-nextjs.ts
│   ├── bootstrap/              # CDK bootstrapping scripts
│   └── monitoring/             # Monitoring instance scripts
├── tests/
│   ├── fixtures/               # 5 reusable test helpers (95 + 128 lines)
│   └── unit/                   # 20 test files across 4 domains
├── monitoring/                 # Grafana dashboards, Prometheus config
├── docs/
│   ├── portfolio/              # Portfolio article sources (.mdx)
│   ├── troubleshooting/        # Operational runbooks
│   └── *.svg                   # Dependency graphs (auto-generated)
└── docker/                     # Dockerfiles
```

---

## Quick Start

### Prerequisites

- Node.js (see `.nvmrc`)
- Yarn 4 (`corepack enable`)
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

### Installation

```bash
# Install dependencies
yarn install

# Build TypeScript
yarn build

# Run tests
yarn test
```

### Interactive CLI (Recommended)

The repository includes an interactive CLI that guides you through project selection, environment targeting, stack operations, and deployment:

```bash
yarn cli                    # Interactive mode — project/environment picker
yarn cli:synth              # Synthesize stacks
yarn cli:deploy             # Deploy stacks
yarn cli:diff               # Show changes vs. deployed
yarn cli:destroy            # Destroy stacks
yarn cli:list               # List all stacks
yarn cli:sync-configs       # Sync monitoring configs to S3 + EC2
```

### Direct CDK Commands

```bash
# Synthesize specific project + environment
npx cdk synth -c project=monitoring -c environment=dev
npx cdk synth -c project=nextjs -c environment=prod

# Deploy
npx cdk deploy -c project=nextjs -c environment=dev --all

# Diff
npx cdk diff -c project=monitoring -c environment=staging
```

---

## Testing

### Test Strategy (3 Layers)

| Layer            | Tool                  | Files | Scope                                       |
| :--------------- | :-------------------- | :---: | :------------------------------------------ |
| **Unit**         | Jest + CDK Assertions |  20   | CloudFormation template property validation |
| **Smoke**        | TypeScript + tsx      |   1   | 9 live infrastructure checks post-deploy    |
| **Verification** | Reusable workflow     |   1   | CloudFormation stack status gates           |

### Running Tests

```bash
# All unit tests
yarn test

# Watch mode
yarn test:watch

# With coverage
yarn test:coverage

# Specific domain
yarn test:vpc
```

### Test Organization

```
tests/
├── fixtures/           # createTestApp, createStackWithHelper, createMockVpc, etc.
└── unit/
    ├── common/         # Shared construct tests (ECS cluster, task definition, ECR)
    ├── factories/      # Project registry tests
    ├── lambda/         # Lambda handler tests (ACM DNS validation)
    ├── projects/       # Factory integration tests (full stack tree synthesis)
    ├── shared/         # Shared stack tests (VPC)
    └── stacks/         # Per-stack tests (monitoring + nextjs)
```

---

## Security

### Custom Checkov Rules (33 Checks)

The `.checkov/custom_checks/` directory contains 33 Python check classes across 26 files, organized by security domain:

| Category      | Checks | Examples                                   |
| :------------ | :----: | :----------------------------------------- |
| IAM           |   6    | Permissions boundary, no wildcard actions  |
| Networking    |   4    | No SSH ingress, scoped egress              |
| Compute       |   4    | IMDSv2 UserData, ASG health checks         |
| Encryption    |   3    | CMK enforcement, KMS rotation              |
| Observability |   3    | Log retention, encryption, deletion policy |
| Lambda        |   3    | DLQ, reserved concurrency, error alerting  |
| Network       |   3    | No auto-public IPs, endpoint policies      |
| Messaging     |   3    | SNS/SQS encryption, TLS enforcement        |
| Storage       |   2    | Backup validation, volume limits           |
| Secrets       |   2    | No hardcoded credentials                   |

### Severity Gating

- **Development/Staging**: LOW and MEDIUM findings are non-blocking warnings
- **Production**: CRITICAL and HIGH findings block the pipeline

### CDK-Nag Compliance

4 compliance packs available (AWS Solutions enabled by default):

- AWS Solutions (general best practices)
- HIPAA Security (healthcare compliance)
- NIST 800-53 R5 (federal security)
- PCI DSS 3.2.1 (payment card security)

---

## CI/CD Pipeline

### Workflow Architecture

| Workflow                      | Type     | Purpose                                  |
| :---------------------------- | :------- | :--------------------------------------- |
| `ci.yml`                      | Trigger  | Lint, test, synth, security scan on PR   |
| `_deploy-monitoring.yml`      | Reusable | Monitoring project deployment            |
| `_deploy-nextjs.yml`          | Reusable | Next.js project deployment (6 stacks)    |
| `_deploy-stack.yml`           | Reusable | Generic single-stack deployment          |
| `_iac-security-scan.yml`      | Reusable | Checkov scan with SARIF upload           |
| `_smoke-tests-nextjs.yml`     | Reusable | Post-deploy smoke tests (9 checks)       |
| `_verify-stack.yml`           | Reusable | CloudFormation status verification       |
| `deploy-*-{dev,staging,prod}` | Trigger  | Environment-specific deployment triggers |
| `sync-monitoring-configs.yml` | Trigger  | Monitoring config sync to S3 + EC2       |

### Authentication

All workflows use **OIDC federation** — no static AWS credentials stored in GitHub Secrets. The `AWS_OIDC_ROLE` secret contains the role ARN for `aws-actions/configure-aws-credentials`.

---

## Code Quality

```bash
# Linting
yarn lint                   # ESLint with max 50 warnings
yarn lint:fix               # Auto-fix lint issues
yarn typecheck              # TypeScript type checking (no emit)

# Health check (lint + unused exports + dependency rules)
yarn health

# Dependency analysis
yarn deps:check             # Validate architecture rules
yarn deps:graph             # Generate dependency graph (SVG)
yarn find:unused            # Find unused exports (Knip)

# Generate all dependency graphs
yarn deps:graphs            # Produces 5 SVGs + HTML report in docs/
```

---

## Documentation

### TypeDoc API Documentation

```bash
yarn docs                   # Full API docs → docs/api/
yarn docs:monitoring        # Monitoring stack → docs/monitoring/
yarn docs:compute           # Compute constructs → docs/compute/
yarn docs:nextjs            # Next.js stack → docs/nextjs/
yarn docs:serve             # Serve at localhost:3000
```

### Portfolio Articles

Portfolio articles documenting design decisions and implementation details are in `docs/portfolio/`:

| Article                                       | Topic                               |
| :-------------------------------------------- | :---------------------------------- |
| `cdk-project-factory-pattern.mdx`             | Project Factory architecture        |
| `nextjs-ecs-cloudfront-aws-deployment.mdx`    | Next.js 6-stack deployment          |
| `devsecops-pipeline-checkov-cdk-nag.mdx`      | Security pipeline (33 custom rules) |
| `automated-testing-verification-strategy.mdx` | 3-layer testing strategy            |
| `enterprise-cicd-pipeline-github-actions.mdx` | CI/CD pipeline architecture         |

### Operational Documentation

| Document                   | Location                       |
| :------------------------- | :----------------------------- |
| Troubleshooting runbooks   | `docs/troubleshooting/`        |
| DynamoDB schema reference  | `docs/DYNAMODB-SCHEMA.md`      |
| New service workflow guide | `docs/new-service-workflow.md` |
| CI/CD configuration guide  | `docs/ci-cd/`                  |
| GitHub repository config   | `GITHUB-CONFIG.md`             |
| Makefile reference         | `MAKEFILE.md`                  |

---

## Tech Stack

| Category             | Technology                                               |
| :------------------- | :------------------------------------------------------- |
| **IaC Framework**    | AWS CDK v2.232.1 (TypeScript 5.9.3)                      |
| **Language**         | TypeScript (constructs, tests, scripts, Lambda handlers) |
| **Testing**          | Jest 30.2.0 + ts-jest + CDK Assertions                   |
| **Security**         | Checkov (33 custom Python checks) + CDK-Nag (4 packs)    |
| **CI/CD**            | GitHub Actions (19 workflows, OIDC authentication)       |
| **Linting**          | ESLint 9 + TypeScript ESLint + custom local rules        |
| **Unused Detection** | Knip                                                     |
| **Architecture**     | dependency-cruiser (validation + graph generation)       |
| **Documentation**    | TypeDoc + portfolio .mdx articles                        |
| **Package Manager**  | Yarn 4.12.0                                              |
| **Runtime Scripts**  | tsx (TypeScript execution without compilation)           |
| **Lambda Bundling**  | esbuild                                                  |

---

## Environments

| Environment     | Purpose                       | Security Posture                      |
| :-------------- | :---------------------------- | :------------------------------------ |
| **Development** | Fast iteration, local testing | Non-blocking security warnings        |
| **Staging**     | Pre-production validation     | Non-blocking warnings, smoke tests    |
| **Production**  | Live traffic                  | CRITICAL/HIGH findings block pipeline |

---

## License

Private
