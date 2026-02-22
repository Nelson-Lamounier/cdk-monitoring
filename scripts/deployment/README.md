# CDK Infrastructure CLI

A TypeScript-based CLI for CDK deployments. Provides interactive prompts, typed configuration, and a single source of truth for stack definitions.

## Quick Start

```bash
# Interactive mode - prompts for project and stacks
yarn cli deploy

# Direct mode - specify options via flags
yarn cli deploy -p nextjs -e development -a
yarn cli destroy -p nextjs -e development -s data
```

## Just Commands (Recommended)

[Just](https://github.com/casey/just) provides a thin CLI layer over the TypeScript scripts. Install once: `brew install just`.

```bash
# List all available recipes
just

# CDK operations
just synth -p k8s -e development
just deploy -p nextjs -e staging -a
just diff -p monitoring -e production
just destroy -p nextjs -s data

# Testing
just test                    # All tests
just test-file tests/unit/stacks/k8s/edge-stack.test.ts
just test-coverage           # With coverage report

# Code quality
just lint                    # ESLint
just typecheck               # tsc --noEmit
just health                  # lint + unused + deps

# CI scripts (same as pipeline)
just ci-synth k8s development
just ci-deploy K8s-Compute-development

# Kubernetes
just k8s-dashboards          # Sync Grafana dashboards
just k8s-reconfigure         # Reconfigure monitoring via SSM
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
| `--project`     | `-p`  | Project ID (monitoring, nextjs, org)                              |
| `--stack`       | `-s`  | Stack ID (vpc, data, compute, networking, application, api, edge) |
| `--environment` | `-e`  | Environment (development, staging, production)                    |
| `--profile`     |       | AWS profile to use                                                |
| `--all`         | `-a`  | Apply to all stacks                                               |

## Examples

```bash
# Deploy all NextJS stacks to development
yarn cli deploy -p nextjs -e development -a

# Synth specific stack
yarn cli synth -p monitoring -s vpc

# Deploy specific consolidated stack
yarn cli deploy -p nextjs -s data       # Data layer (DynamoDB, S3) - ECR is in Shared stack
yarn cli deploy -p nextjs -s compute    # Compute layer (ECS cluster, IAM)
yarn cli deploy -p nextjs -s networking # Networking (ALB, security groups)
yarn cli deploy -p nextjs -s application # Application (ECS service)
yarn cli deploy -p nextjs -s api        # API Gateway layer

# Destroy with specific AWS profile
yarn cli destroy -p nextjs -s application --profile dev-account

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
yarn cli deploy -p nextjs -e development -a \
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

## SSM Secrets Configuration

The NextJS project requires these SSM parameters:

**From Shared Stack:**

| Parameter                           | Created By   | Description         |
| ----------------------------------- | ------------ | ------------------- |
| `/shared/ecr/{env}/repository-uri`  | Shared Stack | ECR repository URI  |
| `/shared/ecr/{env}/repository-name` | Shared Stack | ECR repository name |
| `/shared/ecr/{env}/repository-arn`  | Shared Stack | ECR repository ARN  |

**From Data Stack:**

| Parameter                           | Created By | Description     |
| ----------------------------------- | ---------- | --------------- |
| `/nextjs/{env}/dynamodb-table-name` | Data Stack | Table name      |
| `/nextjs/{env}/assets-bucket-name`  | Data Stack | S3 bucket name  |
| `/nextjs/{env}/aws-region`          | Data Stack | AWS region      |
| `/nextjs/{env}/auth-url`            | Data Stack | NextAuth URL    |
| `/nextjs/{env}/auth-secret`         | Data Stack | NextAuth secret |

Deploy data stack with:

```bash
export NEXTAUTH_URL="https://dev.nelsonlamounier.com"
export NEXTAUTH_SECRET="$(openssl rand -base64 32)"
yarn cli deploy -p nextjs -e development -s data
```

## GitHub Actions Integration

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Development
        run: yarn cli deploy -p nextjs -a -e development --yes
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```
