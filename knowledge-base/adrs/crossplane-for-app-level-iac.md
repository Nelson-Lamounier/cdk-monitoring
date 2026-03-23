# ADR: Crossplane for Application-Level IaC

**Date:** 2026-03-23
**Status:** Accepted

## Context

The platform needs to provision application-level AWS resources (S3 buckets, SQS queues) alongside workloads. Two approaches were evaluated: managing all AWS resources through CDK stacks, or introducing Crossplane for application-tier resources while CDK manages foundation infrastructure.

## Decision

I chose Crossplane XRDs for application-level AWS resources for three reasons:

1. **Same GitOps pipeline as workloads** — Application S3 buckets and SQS queues are declared as Kubernetes CRDs (`XEncryptedBucket`, `XMonitoredQueue`) in the same ArgoCD repository as the workloads that use them. A developer deploys their app and its storage in one `git push`, not across two separate pipelines (ArgoCD for app + CDK for infra).

2. **Golden-path abstraction** — XRDs expose only the parameters developers need (`bucketName`, `retentionDays`, `environment`). Security defaults (SSE-S3 encryption, public access block, versioning) are baked into the Composition — developers cannot create unencrypted buckets. This is a platform engineering pattern: complex AWS resources behind a simple developer-facing API.

3. **Clear separation of concerns** — CDK owns the foundation (VPC, SGs, KMS, NLB, IAM roles, EC2 instances). Crossplane owns the application tier (S3, SQS). This prevents CDK stacks from growing unboundedly as new workloads are added. Each workload's resources live with the workload, not in a shared CDK stack.

## Evidence

> Files in this repository that demonstrate this decision:

- `kubernetes-app/platform/charts/crossplane-xrds/chart/templates/x-encrypted-bucket.yaml` — XRD + Composition for production-ready S3 buckets (encryption, versioning, lifecycle, public access block)
- `kubernetes-app/platform/charts/crossplane-xrds/chart/templates/x-monitored-queue.yaml` — XRD + Composition for SQS queues with DLQ and CloudWatch alarms
- `kubernetes-app/platform/argocd-apps/crossplane-providers.yaml` — Crossplane AWS provider deployment
- `kubernetes-app/platform/charts/crossplane-providers/manifests/provider-config.yaml` — Provider credential config
- `infra/lib/constructs/iam/crossplane-iam-construct.ts` — CDK-managed IAM role for Crossplane (least-privilege, scoped to specific resource ARNs)
- `infra/lib/stacks/shared/crossplane-stack.ts` — CDK stack that provisions the Crossplane IAM foundation
- `kubernetes-app/platform/argocd-apps/workload-generator.yaml` — ApplicationSet that auto-discovers workloads

## Consequences

### Benefits

- **Developer self-service** — developers create AWS resources with a 10-line YAML claim, not a CDK PR to infrastructure code
- **Security by default** — XRD Compositions enforce encryption, public access blocks, and lifecycle policies. Developers cannot bypass these defaults
- **GitOps-native lifecycle** — application resources are created, updated, and deleted through ArgoCD sync, with full audit trail in Git
- **CDK stack isolation** — application-tier resources don't bloat foundation stacks. Each workload owns its resources

### Trade-offs

- **Crossplane operational overhead** — running Crossplane controllers (~300MB RAM) on the cluster adds resource consumption
- **Two IaC languages** — CDK (TypeScript) for foundation, Crossplane (YAML XRDs) for application tier. Engineers need to understand both
- **Provider maturity** — Crossplane AWS Upbound providers occasionally have API coverage gaps compared to CDK/CloudFormation
- **Credential management** — Crossplane needs AWS credentials in-cluster. Currently using instance profile via `DeploymentRuntimeConfig`, not IRSA (no EKS)

## Transferable Skills Demonstrated

- **Platform engineering** — designing golden-path abstractions (XRDs) that expose simple developer APIs while enforcing security defaults. This is the core pattern used by internal developer platforms at companies like Spotify and Zalando.
- **GitOps-native resource management** — managing AWS resources through the same ArgoCD pipeline as application deployments. Applicable to any team adopting GitOps for full-stack lifecycle management.
- **Separation of concerns** — splitting IaC across CDK (foundation) and Crossplane (application) layers to prevent monolithic stack growth. Demonstrates architectural thinking about ownership boundaries.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*