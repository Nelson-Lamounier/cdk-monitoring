# Makefile Reference (Legacy)

> [!NOTE]
> **Prefer the TypeScript CLI**: The Makefile is being deprecated in favor of the TypeScript CLI.
> Use `yarn cli <command>` for all operations. See CLI help: `yarn cli --help`

---

This document provides a comprehensive reference for all available Makefile targets in the `cdk-monitoring` project.

## Quick Start

```bash
# List all available stacks
make list-all

# Synthesise and save templates to cdk-outputs/
make synth-monitoring-all

# Deploy all monitoring stacks
make deploy-monitoring-all

# Check environment configuration
make check-env
```

## Configuration

| Variable         | Default       | Description                             |
| ---------------- | ------------- | --------------------------------------- |
| `ENVIRONMENT`    | `dev`         | Target environment (dev, staging, prod) |
| `AWS_PROFILE`    | `dev-account` | AWS CLI profile to use                  |
| `AWS_REGION`     | `eu-west-1`   | AWS region for deployment               |
| `AWS_ACCOUNT_ID` | _(empty)_     | AWS account ID (required for bootstrap) |

### Override Examples

```bash
# Deploy to production
make ENVIRONMENT=prod deploy-monitoring-all

# Use different AWS profile
make AWS_PROFILE=prod-account deploy-monitoring-all

# Combine overrides
make ENVIRONMENT=staging AWS_PROFILE=staging-account synth-monitoring-all
```

---

## Stack Architecture

### Monitoring Project

| Stack                                 | Description                                  |
| ------------------------------------- | -------------------------------------------- |
| `Monitoring-VpcStack-{env}`           | VPC with public/private subnets, NAT Gateway |
| `Monitoring-SecurityGroupStack-{env}` | Security group with ingress rules            |
| `Monitoring-EbsStack-{env}`           | Encrypted EBS volume for data persistence    |
| `Monitoring-ComputeStack-{env}`       | EC2 or ASG for Grafana/Prometheus            |

### NextJS Project

| Stack                          | Description                         |
| ------------------------------ | ----------------------------------- |
| `NextJS-EcrStack-{env}`        | ECR repository for container images |
| `NextJS-EcsClusterStack-{env}` | ECS Fargate cluster with ALB        |

---

## Command Reference

### List Stacks

| Command                | Description                        |
| ---------------------- | ---------------------------------- |
| `make list-monitoring` | List all Monitoring project stacks |
| `make list-nextjs`     | List all NextJS project stacks     |
| `make list-all`        | List all project stacks            |

### Synthesise (Monitoring)

All synth commands save YAML templates to `cdk-outputs/` for easy review.

| Command                         | Description                     |
| ------------------------------- | ------------------------------- |
| `make synth-monitoring-all`     | Synth all monitoring stacks     |
| `make synth-monitoring-vpc`     | Synth VPC stack only            |
| `make synth-monitoring-sg`      | Synth Security Group stack only |
| `make synth-monitoring-ebs`     | Synth EBS stack only            |
| `make synth-monitoring-compute` | Synth Compute stack only        |

### Synthesise (NextJS)

| Command                     | Description                  |
| --------------------------- | ---------------------------- |
| `make synth-nextjs-all`     | Synth all NextJS stacks      |
| `make synth-nextjs-ecr`     | Synth ECR stack only         |
| `make synth-nextjs-cluster` | Synth ECS Cluster stack only |

### Diff (Show Changes)

| Command                        | Description                |
| ------------------------------ | -------------------------- |
| `make diff-monitoring-all`     | Diff all monitoring stacks |
| `make diff-monitoring-vpc`     | Diff VPC stack             |
| `make diff-monitoring-sg`      | Diff Security Group stack  |
| `make diff-monitoring-ebs`     | Diff EBS stack             |
| `make diff-monitoring-compute` | Diff Compute stack         |
| `make diff-nextjs-all`         | Diff all NextJS stacks     |
| `make diff-nextjs-ecr`         | Diff ECR stack             |
| `make diff-nextjs-cluster`     | Diff ECS Cluster stack     |

### Deploy

| Command                          | Description                             |
| -------------------------------- | --------------------------------------- |
| `make deploy-monitoring-all`     | Deploy all monitoring stacks (in order) |
| `make deploy-monitoring-vpc`     | Deploy VPC stack                        |
| `make deploy-monitoring-sg`      | Deploy Security Group stack             |
| `make deploy-monitoring-ebs`     | Deploy EBS stack                        |
| `make deploy-monitoring-compute` | Deploy Compute stack                    |
| `make deploy-nextjs-all`         | Deploy all NextJS stacks                |
| `make deploy-nextjs-ecr`         | Deploy ECR stack                        |
| `make deploy-nextjs-cluster`     | Deploy ECS Cluster stack                |

### Destroy

> ⚠️ **Warning**: Destroy commands delete AWS resources. Use with caution.

| Command                           | Description                                              |
| --------------------------------- | -------------------------------------------------------- |
| `make destroy-monitoring-all`     | Destroy all monitoring stacks (prompts for confirmation) |
| `make destroy-monitoring-compute` | Destroy Compute stack                                    |
| `make destroy-monitoring-ebs`     | Destroy EBS stack                                        |
| `make destroy-monitoring-sg`      | Destroy Security Group stack                             |
| `make destroy-monitoring-vpc`     | Destroy VPC stack                                        |
| `make destroy-nextjs-all`         | Destroy all NextJS stacks                                |
| `make destroy-nextjs-ecr`         | Destroy ECR stack                                        |
| `make destroy-nextjs-cluster`     | Destroy ECS Cluster stack                                |

---

## Testing & Quality

| Command                      | Description                    |
| ---------------------------- | ------------------------------ |
| `make test`                  | Run all tests                  |
| `make test-unit`             | Run unit tests only            |
| `make test-watch`            | Run tests in watch mode        |
| `make test-coverage`         | Run tests with coverage report |
| `make test-update-snapshots` | Update Jest snapshots          |

## Linting & Build

| Command          | Description                  |
| ---------------- | ---------------------------- |
| `make lint`      | Run ESLint (max-warnings 0)  |
| `make lint-fix`  | Run ESLint with auto-fix     |
| `make build`     | Build TypeScript             |
| `make typecheck` | Run TypeScript type checking |
| `make audit`     | Run security audit           |

## Code Health

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `make health`      | Run lint + build + test              |
| `make find-unused` | Find unused files and exports (knip) |
| `make deps-check`  | Check dependency rule violations     |

## Utilities

| Command            | Description                            |
| ------------------ | -------------------------------------- |
| `make install`     | Install dependencies                   |
| `make clean`       | Clean build artifacts                  |
| `make check-env`   | Verify environment and AWS credentials |
| `make bootstrap`   | Bootstrap CDK in AWS account           |
| `make tree`        | Show directory structure               |
| `make tree-source` | Show TypeScript source structure       |

---

## Deployment Workflow

### First-Time Setup

```bash
# 1. Install dependencies
make install

# 2. Build TypeScript
make build

# 3. Check environment
make check-env

# 4. Bootstrap CDK (if not done)
make bootstrap AWS_ACCOUNT_ID=123456789012

# 5. Deploy all stacks
make deploy-monitoring-all
```

### Daily Development

```bash
# Review changes before deploying
make diff-monitoring-all

# Synth and review templates
make synth-monitoring-all
cat cdk-outputs/Monitoring-ComputeStack-dev.yaml

# Deploy specific stack
make deploy-monitoring-compute

# Run tests
make test
```

### Production Deployment

```bash
# Always diff first
make ENVIRONMENT=prod diff-monitoring-all

# Deploy with prod profile
make ENVIRONMENT=prod AWS_PROFILE=prod-account deploy-monitoring-all
```

---

## Output Directory

After running `synth-*` commands, CloudFormation YAML templates are saved to:

```
cdk-outputs/
├── Monitoring-VpcStack-dev.yaml
├── Monitoring-SecurityGroupStack-dev.yaml
├── Monitoring-EbsStack-dev.yaml
├── Monitoring-ComputeStack-dev.yaml
├── NextJS-EcrStack-dev.yaml
└── NextJS-EcsClusterStack-dev.yaml
```

This allows for easy review and comparison without navigating `cdk.out/`.

---

## Troubleshooting

### AWS Credentials Invalid

```bash
# Check current credentials
make check-env

# Reconfigure AWS CLI
aws configure --profile dev-account
```

### Stack Not Found

Ensure you're using the correct `ENVIRONMENT`:

```bash
# List available stacks
make list-monitoring

# Use correct environment
make ENVIRONMENT=staging list-monitoring
```

### CDK Bootstrap Required

```bash
# Bootstrap with account ID
make bootstrap AWS_ACCOUNT_ID=123456789012
```
