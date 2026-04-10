---
title: "BFF API Services (public-api and admin-api)"
doc_type: implementation
domain: frontend
tags:
  - bff
  - hono
  - public-api
  - admin-api
  - express
  - kubernetes
  - dynamodb
  - cors
  - dockerised
  - ssm
related_docs:
  - frontend/frontend-integration.md
  - infrastructure/networking-implementation.md
  - kubernetes/bootstrap-system-scripts.md
  - infrastructure/stacks/kubernetes-base-stack.md
last_updated: "2026-04-10"
author: Nelson Lamounier
status: accepted
---

# BFF API Services (`public-api` and `admin-api`)

**Date:** 2026-04-10
**Audience:** Developer
**Style:** Implementation Reference

## Overview

The `api/` monorepo workspace contains two Backend-for-Frontend (BFF) services that sit between the Kubernetes workloads and AWS data stores (DynamoDB, Secrets Manager). Before this pattern, frontend pods (`nextjs-app`, `start-admin`) called DynamoDB directly — requiring them to carry IAM execution roles with DynamoDB permissions. The BFF migration moves all data-plane access into dedicated API services, reducing the blast radius of any single frontend compromise.

```text
Before:
  CloudFront → Traefik → nextjs-app pod → DynamoDB (direct)

After:
  CloudFront → Traefik → nextjs-app pod → public-api pod → DynamoDB
                       → start-admin pod → admin-api pod → DynamoDB / Secrets Manager
```

## Services

### `public-api` — Unauthenticated Read-Only API

**Port:** `3001` (override via `PORT` env var)
**Namespace:** `public-api`
**Framework:** [Hono](https://hono.dev/) on Node.js (`@hono/node-server`)

#### Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Liveness probe — returns `{ status: "ok" }` |
| `GET` | `/api/articles` | List published articles (paginated, optional `?tag=` filter) |
| `GET` | `/api/articles/:slug` | Fetch a single article by slug |
| `GET` | `/api/tags` | List all unique article tags |
| `GET` | `/api/resumes/active` | Return currently active résumé; `204` if none configured |

All routes are **unauthenticated** — this is a public read-only API serving portfolio visitor traffic.

#### Caching

The `/api/resumes/active` route sets `Cache-Control: public, s-maxage=300, stale-while-revalidate=600` so CloudFront caches responses at the edge for up to 5 minutes.

#### DynamoDB Access Pattern

Resumes live in the **Strategist table** (`STRATEGIST_TABLE_NAME`):

```
Scan:
  FilterExpression: entityType = RESUME AND isActive = true AND sk = METADATA
```

The table is small (< 20 items) so a Scan is acceptable. DynamoDB-internal keys (`pk`, `sk`, `gsi1pk`, `gsi1sk`, `entityType`) are stripped before the response is sent to the public caller.

#### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `DYNAMODB_TABLE_NAME` | `public-api-config` ConfigMap | Content table for articles/tags |
| `STRATEGIST_TABLE_NAME` | `public-api-config` ConfigMap | Strategist table for résumés |
| `AWS_DEFAULT_REGION` | `public-api-config` ConfigMap | AWS SDK region |
| `PORT` | Optional | HTTP listen port (default: `3001`) |

No AWS credentials are configured in code — the SDK v3 default credential provider resolves them via the EC2 Instance Profile (IMDS).

#### CORS

Configured globally for:
- `https://nelsonlamounier.com` (production)
- `http://localhost:3000` (local dev)

Methods: `GET`, `HEAD`, `OPTIONS`. Credentials: `false`.

---

### `admin-api` — Authenticated Admin API

**Port:** `3002` (override via `PORT` env var)
**Namespace:** `admin-api`
**Framework:** Hono on Node.js

#### Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/api/articles` | List all articles (including drafts) |
| `GET` | `/api/articles/:slug` | Fetch a single article (any status) |
| `POST` | `/api/articles` | Create a new article |
| `PUT` | `/api/articles/:slug` | Update an article |
| `DELETE` | `/api/articles/:slug` | Delete an article |
| `GET` | `/api/articles/:slug/publish` | Trigger publish pipeline |

Admin routes require authentication — validated via the Cognito JWT (passed from `start-admin` server functions, never exposed to the browser).

#### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `DYNAMODB_TABLE_NAME` | `admin-api-config` ConfigMap | Content table |
| `COGNITO_USER_POOL_ID` | `admin-api-secrets` Secret | JWT validation |
| `COGNITO_CLIENT_ID` | `admin-api-secrets` Secret | JWT audience |
| `AWS_DEFAULT_REGION` | `admin-api-config` ConfigMap | AWS SDK region |

---

## BFF URL Discovery

BFF service URLs are **not hardcoded** in frontend configuration. The `KubernetesEdgeStack` (CDK) seeds the public URLs into SSM Parameter Store after each edge deployment:

```text
/bedrock-{short_env}/public-api-url  → https://nelsonlamounier.com/api (via CloudFront)
/bedrock-{short_env}/admin-api-url   → https://admin.nelsonlamounier.com/api (or in-cluster)
```

`deploy.py` calls `resolve_bff_urls()` from `deploy_helpers/bff.py` to read these values, then injects them into the workload ConfigMaps:
- `PUBLIC_API_URL` → `nextjs-config` ConfigMap → used by `/api/resume/active` proxy route
- `ADMIN_API_URL` → `start-admin-config` ConfigMap → used by server-side data fetching

**In-cluster fallback** (applied when SSM parameter is missing, e.g. before the edge stack has run):
- `public-api`: `http://public-api.public-api:3001`
- `admin-api`: `http://admin-api.admin-api:3002`

---

## Deployment

Both services are deployed via the standard Helm chart workflow managed by ArgoCD. The CI pipeline builds and pushes images to ECR, ArgoCD reconciles the Rollout.

### Image Build

Handled by `.github/workflows/_build-push-image.yml`. ECR repository names follow the `{short_env}-public-api` / `{short_env}-admin-api` convention, seeded into SSM by `SharedInfraStack`.

### Kubernetes Resources

Each service follows the same resource pattern as the existing `nextjs` chart:

```text
Namespace:     public-api  /  admin-api
Deployment:    Argo Rollout (Blue/Green)
Service:       ClusterIP on port 3001 / 3002
Config:        {app}-config  ConfigMap  (non-sensitive)
Secrets:       {app}-secrets Opaque Secret (sensitive)
HPA:           min 1, max 3 replicas
```

The `deploy.py` script for each BFF service follows the same pattern as `nextjs/deploy.py` — resolving SSM parameters into a Kubernetes Secret + ConfigMap pair during CI deployment.

### Pre-flight Check in CI

The `_deploy-kubernetes.yml` workflow includes a `verify-bff-ecr` job that checks for the SSM-published ECR repository names before proceeding with the Helm deployment. This prevents the Rollout from starting with a missing image.

> **Runbook:** If `verify-bff-ecr` fails, the `SharedInfraStack` has not been deployed. Run `deploy-shared.yml` first.

---

## IAM Grants

Managed by `KubernetesAppIamStack` — a separate CDK stack that decouples application IAM from compute infrastructure. The stack conditionally grants:

- DynamoDB read/write on the content and strategist tables
- S3 read on the assets bucket
- Secrets Manager read for admin API credentials

Grants are attached to the worker node instance role, consumed by pods via the EC2 Instance Profile on the node. No pod-level IAM role or IRSA is required.

---

## Testing

Test files live alongside source:
- `api/public-api/__tests__/routes/` — Jest unit tests per route
- `api/admin-api/src/routes/*.test.ts` — Jest unit tests

Tests mock `@aws-sdk/lib-dynamodb` to avoid requiring live AWS credentials.

## Source Files

> This document was derived from the following source files:

- `api/public-api/src/index.ts` *(Hono entry point — route assembly)*
- `api/public-api/src/routes/articles.ts` *(articles list + detail)*
- `api/public-api/src/routes/tags.ts` *(tag list)*
- `api/public-api/src/routes/resumes.ts` *(active résumé — DynamoDB Scan)*
- `api/public-api/src/routes/health.ts` *(liveness probe)*
- `api/admin-api/src/index.ts` *(admin Hono entry point)*
- `api/admin-api/src/routes/articles.test.ts` *(Jest unit tests)*
- `api/public-api/__tests__/routes/resumes.test.ts` *(Jest unit tests)*
- `kubernetes-app/k8s-bootstrap/deploy_helpers/bff.py` *(BFF URL resolver)*
- `infra/lib/stacks/kubernetes/app-iam-stack.ts` *(IAM grants)*

---

*Created from source file analysis — 2026-04-10.*

## Keywords

bff, hono, public-api, admin-api, dynamodb, cors, kubernetes, ssm, iam, instance-profile, configmap, resume, articles, tags, argocd, ecr, cloudfront, edge-stack
