# CDK Infrastructure CLI

A TypeScript-based CLI for CDK deployments. Provides interactive prompts, typed configuration, and a single source of truth for stack definitions.

## Quick Start

```bash
# Interactive mode - prompts for project and stacks
yarn cli deploy

# Direct mode - specify options via flags
yarn cli deploy -p kubernetes -e development -a
yarn cli destroy -p kubernetes -e development -s data
```

## Just Commands (Recommended)

[Just](https://github.com/casey/just) provides a thin CLI layer over the TypeScript scripts. Install once: `brew install just`.

```bash
# List all available recipes
just

# CDK operations
just synth -p kubernetes -e development
just deploy -p kubernetes -e staging -a
just diff -p bedrock -e production
just destroy -p kubernetes -s data

# Testing
just test                    # All tests
just test-file tests/unit/stacks/k8s/edge-stack.test.ts
just test-coverage           # With coverage report

# Code quality
just lint                    # ESLint
just typecheck               # tsc --noEmit
just health                  # lint + unused + deps

# CI scripts (same as pipeline)
just ci-synth kubernetes development
just ci-deploy K8s-Compute-development

# Kubernetes
just k8s-dashboards          # Sync Grafana dashboards
```

> **Note:** `yarn cli` commands remain fully functional. `just` is an optional wrapper.

## Commands

### CDK Operations

| Command            | Description                                      |
| ------------------ | ------------------------------------------------ |
| `yarn cli synth`   | Synthesise stacks → saves YAML to `cdk-outputs/` |
| `yarn cli deploy`  | Deploy stacks to AWS                             |
| `yarn cli diff`    | Show diff between local and deployed             |
| `yarn cli destroy` | Destroy stacks (with safety prompts)             |
| `yarn cli list`    | List all stacks                                  |

### Shortcuts (same as above)

| Command            | Description                |
| ------------------ | -------------------------- |
| `yarn cli:synth`   | Same as `yarn cli synth`   |
| `yarn cli:deploy`  | Same as `yarn cli deploy`  |
| `yarn cli:diff`    | Same as `yarn cli diff`    |
| `yarn cli:destroy` | Same as `yarn cli destroy` |
| `yarn cli:list`    | Same as `yarn cli list`    |

### Bootstrap & DNS Role Commands

| Command                   | Description                                   |
| ------------------------- | --------------------------------------------- |
| `yarn cli bootstrap`      | Bootstrap CDK in an AWS account               |
| `yarn cli setup-dns-role` | Deploy cross-account DNS role to root account |
| `yarn cli get-dns-role`   | Get existing DNS role ARN from stack outputs  |

### Utility Commands

| Command           | Description           |
| ----------------- | --------------------- |
| `yarn cli build`  | Build TypeScript      |
| `yarn cli test`   | Run tests             |
| `yarn cli lint`   | Run ESLint            |
| `yarn cli clean`  | Clean build artifacts |
| `yarn cli health` | Full health check     |

## CLI Flags

All CDK commands support these common flags:

| Flag            | Short | Description                                                       |
| --------------- | ----- | ----------------------------------------------------------------- |
| `--project`     | `-p`  | Project ID (kubernetes, bedrock, org, shared)                     |
| `--stack`       | `-s`  | Stack ID (vpc, data, compute, networking, application, api, edge) |
| `--environment` | `-e`  | Environment (development, staging, production)                    |
| `--profile`     |       | AWS profile to use                                                |
| `--all`         | `-a`  | Apply to all stacks                                               |

## Examples

```bash
# Deploy all Kubernetes stacks to development
yarn cli deploy -p kubernetes -e development -a

# Synth specific stack
yarn cli synth -p kubernetes -s data

# Deploy specific stack
yarn cli deploy -p kubernetes -s data       # Data layer (DynamoDB, S3)
yarn cli deploy -p kubernetes -s compute    # Compute (ControlPlane, Workers)
yarn cli deploy -p kubernetes -s edge       # CloudFront distribution (us-east-1)

# Destroy with specific AWS profile
yarn cli destroy -p kubernetes -s data --profile dev-account

# List all projects
yarn cli list --all
```

## Bootstrap Command

Bootstrap CDK in a new AWS account with custom IAM policy:

```bash
yarn cli bootstrap \
  --account 123456789012 \
  --region eu-west-1 \
  --profile dev-account
```

## Cross-Account DNS Setup

For CloudFront deployments with Route53 in a different account:

### 1. Deploy DNS Role to Root Account (One-Time)

```bash
yarn cli setup-dns-role \
  --profile management-account \
  --hosted-zone-ids Z04763221QPB6CZ9R77GM \
  --trusted-account-ids 771826808455
```

### 2. Get the Role ARN

```bash
yarn cli get-dns-role --profile management-account
```

### 3. Deploy with Cross-Account Role

```bash
yarn cli deploy -p kubernetes -e development -a \
  --domain-name=dev.nelsonlamounier.com \
  --hosted-zone-id=Z04763221QPB6CZ9R77GM \
  --cross-account-role-arn=arn:aws:iam::ROOT:role/Route53DnsValidationRole
```

## Project Structure

```
scripts/deployment/
├── cli.ts          # Main CLI entry point
├── deploy.ts       # Deploy command implementation
├── synth.ts        # Synth command implementation
├── stacks.ts       # Stack definitions (single source of truth)
├── exec.ts         # Shell execution wrapper
├── prompts.ts      # Interactive prompts
├── logger.ts       # Coloured console output
└── README.md       # This file
```

## SSM Parameters

**From Shared Stack:**

| Parameter                           | Created By   | Description         |
| ----------------------------------- | ------------ | ------------------- |
| `/shared/ecr/{env}/repository-uri`  | Shared Stack | ECR repository URI  |
| `/shared/ecr/{env}/repository-name` | Shared Stack | ECR repository name |
| `/shared/ecr/{env}/repository-arn`  | Shared Stack | ECR repository ARN  |

**From Kubernetes Stacks:**

| Parameter                                     | Created By        | Description             |
| --------------------------------------------- | ----------------- | ----------------------- |
| `/k8s/{env}/instance-id`                      | ControlPlane Stack | Control plane instance  |
| `/k8s/{env}/elastic-ip`                       | ControlPlane Stack | Elastic IP address      |
| `/k8s/{env}/security-group-id`                | Base Stack         | K8s security group      |
| `/k8s/{env}/scripts-bucket`                   | Base Stack         | S3 scripts bucket name  |
| `/k8s/{env}/cloudfront/distribution-domain`   | Edge Stack         | CloudFront domain       |
