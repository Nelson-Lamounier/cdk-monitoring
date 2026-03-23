# Frontend Integration — Infrastructure & Deployment

## Overview

The Next.js portfolio frontend is a separate application repository deployed into the Kubernetes cluster via ArgoCD. This document covers the **infrastructure integration layer** — the CDK-managed resources, deployment pipeline, and service mesh that connect the frontend to the AWS backend.

> **Scope:** This document does not cover React components, UI styling, or Next.js application code. It focuses on the infrastructure seams that make deployment, runtime, and operations work.

## Architecture

```
Browser → Route 53 (dev.nelsonlamounier.com)
    ↓
CloudFront (us-east-1) — HTTPS termination, WAF, security headers
    ├── Default behaviour → EIP origin (HTTP_ONLY) → Traefik → Next.js pod
    ├── /_next/static/*   → S3 OAC origin (immutable assets, 1yr TTL)
    ├── /_next/data/*     → S3 OAC origin (ISR data files)
    ├── /images/*         → S3 OAC origin (article images)
    └── /api/*            → EIP origin (no caching)
    ↓
EIP (52.18.73.218, eu-west-1) → Traefik DaemonSet (hostNetwork)
    ↓
Next.js Pod (nextjs-app namespace)
    → API Gateway (subscription/article APIs) → Lambda → DynamoDB/SES/S3
```

### CI/CD Flow
```
GitHub (frontend repo) → CI Pipeline → ECR (nextjs-frontend)
    ↓
ArgoCD Image Updater → Auto-detect new SHA tag → Git writeback
    ↓
ArgoCD Application (sync-wave 5) → Helm render → K8s manifests
    ↓
K8s Namespace: nextjs-app
    ├── Deployment (1 replica, 50m–250m CPU, 64Mi–256Mi)
    ├── Service
    ├── NetworkPolicy (Traefik ingress only)
    └── PodDisruptionBudget
```

## CDK Evidence

### Reusable API Gateway Construct
- **File:** `infra/lib/constructs/networking/api/api-gateway.ts`
- Creates a REST API Gateway with built-in CloudWatch logging (JSON structured access logs), CORS, stage-level throttling, request validation, and Lambda integration helpers.
- Uses path-caching to avoid CDK's nested resource chaining pain point.
- Explicit CloudWatch IAM role creation handles the `@aws-cdk/aws-apigateway:disableCloudWatchRole` feature flag.

### NextJS Configuration (Data-Driven)
- **File:** `infra/lib/config/nextjs.ts`
- Single source of truth for all Next.js infrastructure configuration across 3 environments (development, staging, production).
- Covers: Lambda allocations, ECS task definitions, API Gateway throttle, CloudFront cache policies, DynamoDB billing mode, S3 versioning, CORS origins, health check timing, and deployment strategies.
- Environment variables resolved lazily via `fromEnv()` to support dotenv loading order.

### Edge Stack (us-east-1)
- **File:** `infra/lib/stacks/kubernetes/edge-stack.ts` (746 lines)
- **Must deploy in us-east-1** — CloudFront and WAF-CloudFront scope require it.
- Creates ACM certificate with cross-account DNS validation via Lambda custom resource.
- Creates WAF WebACL with AWS managed rules (IP reputation, rate limiting) and optional IP allowlist for pre-launch access restriction.
- Creates CloudFront distribution with dual-origin architecture:
  - **EIP origin** — HTTP_ONLY to Traefik (self-signed cert doesn't match domain). Includes `X-CloudFront-Origin` custom header for origin bypass mitigation.
  - **S3 origin** — Origin Access Control (OAC) for static assets.
- Cross-region SSM readers (AwsCustomResource) fetch EIP address and S3 bucket name from eu-west-1.
- EIP converted to AWS EC2 public DNS hostname (`ec2-x-x-x-x.eu-west-1.compute.amazonaws.com`) because CloudFront rejects raw IP addresses.
- Timestamp-based physicalResourceId forces fresh SSM reads on every deploy.

### CloudFront Construct (Reusable)
- **File:** `infra/lib/constructs/networking/cloudfront.ts` (460 lines)
- Configurable cache behaviors, security headers policy (HSTS, X-Frame-Options, XSS-Protection, Referrer-Policy), optional access logging with lifecycle management, optional WAF integration.
- Override: false on all security headers — preserves origin headers when set, safe for reusable constructs.
- Production warnings for missing logging or WAF.

### Cache Policies

| Policy | TTL Strategy | Compression | Use Case |
|:---|:---|:---|:---|
| Static Assets | 1 year default, no headers/cookies | Gzip + Brotli | `/_next/static/*`, `/images/*` |
| Dynamic Content | ISR default, honours origin `Cache-Control` | Gzip + Brotli | `/_next/data/*`, default behaviour |
| No Cache | Disabled | Off | `/api/*` routes |

### Live Resources (from SSM Discovery)

| Resource | ID / Value | Purpose |
|:---|:---|:---|
| CloudFront Distribution | `d2iqxxxxxxxxxxx` | CDN + edge security |
| WAF WebACL | `k8s-cloudfront-waf-development` | Rate limiting + IP reputation |
| ACM Certificate | `dev.nelsonlamounier.com` | TLS at CloudFront edge |
| ECR Repository | `nextjs-frontend` | Container image registry |
| Current Image | `nextjs-frontend:ad68821e` | SHA-tagged immutable image |
| API Gateway | `7np9dpvnbf.execute-api.eu-west-1.amazonaws.com/api/` | Subscription + article APIs |
| DynamoDB Table | `bedrock-dev-ai-content` | Published article storage |
| S3 Assets Bucket | `nextjs-article-assets-development` | Static article images/media |
| Domain | `nelsonlamounier.com` | Production domain |

## ArgoCD Deployment Pattern

### Application Definition
- **File:** `kubernetes-app/workloads/argocd-apps/nextjs.yaml`
- **Sync Wave:** 5 (after platform observability and cluster utilities)
- **Source:** Helm chart at `kubernetes-app/workloads/charts/nextjs/chart/`
- **Values:** `nextjs-values.yaml` (environment-specific overrides)
- **Sync Policy:** Automated prune + selfHeal, `CreateNamespace=true`, `ServerSideApply=true`

### ArgoCD Image Updater
- **Strategy:** `newest-build` (most recently built image by timestamp)
- **Tag Filter:** `regexp:^[0-9a-f]{7,40}$` (SHA-format tags only)
- **Write-Back:** Commits `.argocd-source-nextjs.yaml` to Git (`develop` branch) so selfHeal enforces the updated tag instead of reverting it.
- **Effect:** Pushing a new image to ECR from CI automatically triggers a K8s rollout — zero manual intervention.

### Kubernetes Resource Allocations
- **Replicas:** 1 (development)
- **CPU:** 50m requests / 250m limits
- **Memory:** 64Mi requests / 256Mi limits
- **HPA:** Disabled in development, max 2 replicas
- **Resource Quota:** 750m CPU / 768Mi memory (namespace level)
- **PDB:** Enabled

## Request Flow (End-to-End)

```
1.  Browser → Route 53 DNS (dev.nelsonlamounier.com)
2.  → CloudFront (us-east-1) — HTTPS termination, WAF filtering
3.    ├── Static assets (/_next/static/*, /images/*)
4.    │   → S3 OAC origin (eu-west-1) — 1yr cache TTL
5.    ├── Dynamic pages (default behaviour)
6.    │   → EIP origin (HTTP_ONLY, X-CloudFront-Origin header)
7.    │   → ec2-52-18-73-218.eu-west-1.compute.amazonaws.com:80
8.    │   → Traefik DaemonSet (hostNetwork, route matching)
9.    │   → Next.js Pod (SSR, ISR)
10.   └── API routes (/api/*)
11.       → EIP origin (no caching)
12.       → Traefik → Next.js API handler
13.         → API Gateway (7np9dpvnbf) — throttling, CORS, validation
14.           → Lambda (256MB, 30s timeout)
15.             → DynamoDB: bedrock-dev-ai-content (article reads)
16.             → SES (subscription verification emails)
17.             → S3: nextjs-article-assets-development (image serving)
```

## Decision Reasoning

- **CloudFront over direct EIP access** — Provides edge caching, TLS termination with ACM (free), WAF protection, security headers, and Brotli compression. Without CloudFront, every request would traverse the internet to eu-west-1 unprotected.
- **Dual-origin architecture** — Static assets served from S3 via OAC (no public bucket), dynamic content from EIP via HTTP_ONLY. Separates caching strategies per content type.
- **HTTP_ONLY to EIP origin** — Traefik's self-signed cert doesn't match the domain. Instead of adding complexity with a matching cert, CloudFront terminates TLS at the edge and uses HTTP to the origin. Origin bypass is mitigated by the `X-CloudFront-Origin` custom header.
- **EIP DNS hostname conversion** — CloudFront rejects raw IP addresses as origins. The stack converts `1.2.3.4` to `ec2-1-2-3-4.eu-west-1.compute.amazonaws.com`. Requires `enableDnsHostnames=true` on the VPC.
- **Cross-region SSM readers** — Edge stack in us-east-1 reads EIP and bucket name from eu-west-1 SSM via `AwsCustomResource`. Timestamp-based physicalResourceId forces fresh reads on every deploy.
- **WAF IP allowlist for pre-launch** — `RESTRICT_ACCESS=false` in GitHub Environment variables opens the site. No code change, commit, or PR needed. Just a pipeline re-run.
- **K8s over Vercel** — Deploying Next.js on self-managed K8s instead of Vercel demonstrates container orchestration, Helm chart authoring, and Traefik ingress configuration. The cost difference is minimal at this scale, but the operational learning is substantial.
- **ArgoCD Image Updater over CI-triggered kubectl** — Git-based writeback ensures the cluster state is always reconcilable from Git. No imperative `kubectl set image` commands that break GitOps.
- **API Gateway over direct Lambda URLs** — Provides stage-level throttling (100 rps dev / 1000 rps prod), structured access logging, request validation, and CORS configuration without custom middleware.
- **Reusable constructs** — CloudFront (460 lines), API Gateway (480 lines), WAF, ACM — all extraction-ready for multi-project reuse. Avoids repeating boilerplate across stacks.
- **Separated configuration** — `config/nextjs.ts` centralises all environment-specific values. Stacks consume config, never hardcode. Enables new environments in minutes.

## Challenges Encountered

- **CloudFront 504 timeouts** — In-cluster K8s API server unreachability caused CloudFront to return 504 errors. Root cause was the EIP origin health check failing when Traefik was not yet running. Solved by tuning `connectionAttempts` and `readTimeout` in the origin config.
- **Cross-region SSM parameter ordering** — Edge stack must deploy after base stack writes EIP SSM parameter. Without the CI/CD dependency chain (`deploy-data → deploy-base → deploy-edge`), the AwsCustomResource fails with `ParameterNotFound`.
- **CloudWatch logging IAM collisions** — Multiple API Gateway stacks in the same account compete for the `AWS::ApiGateway::Account` resource. Solved with explicit IAM role creation + `DependsOn` from Stage.
- **ArgoCD Image Updater tag filtering** — Without the SHA regex filter (`^[0-9a-f]{7,40}$`), the updater would pick up `latest` tags pushed by local Docker builds, causing unintended rollouts.
- **CORS without wildcards** — Replaced `*` CORS origins with explicit URL lists per environment. Requires synchronisation between CDK config and frontend deployment URL, but eliminates the security risk.

## Transferable Skills Demonstrated

- **Full-stack deployment pipeline** — CI → ECR → ArgoCD Image Updater → K8s rollout. Applicable to any containerised application deployment.
- **Multi-region edge architecture** — CloudFront (us-east-1) + origin (eu-west-1) with cross-region SSM parameter sharing. Demonstrates global CDN architecture patterns.
- **WAF-managed access control** — IP allowlisting via environment variables for pre-launch gating. Zero-downtime go-live without code changes.
- **GitOps image promotion** — Git writeback pattern ensures the deployed image tag is always auditable and rollbackable from version control.
- **Data-driven infrastructure** — Single configuration file drives Lambda, ECS, API Gateway, CloudFront, and DynamoDB settings across 3 environments. Demonstrates composable IaC patterns.
- **Reusable CDK constructs** — CloudFront, API Gateway, WAF, ACM — all parameterised and extraction-ready. Applicable to any multi-environment AWS project.
- **API Gateway as a service facade** — Throttling, logging, validation, and CORS in a reusable construct. Applicable to any serverless API architecture.
