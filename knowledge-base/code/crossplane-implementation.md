# Crossplane Implementation — Platform Engineering

**Project:** cdk-monitoring
**Last Updated:** 2026-03-23

## Architecture

Crossplane extends the Kubernetes API with custom resource definitions (XRDs) that provision AWS resources through the same GitOps pipeline as application workloads. The platform uses a two-layer IaC model: CDK for foundation infrastructure, Crossplane for application-tier resources.

```
Developer writes:                         Platform delivers:
  EncryptedBucket claim (10 lines YAML)     → S3 bucket with SSE-S3, versioning,
                                               lifecycle, public access block
  MonitoredQueue claim (10 lines YAML)      → SQS queue with DLQ, CloudWatch alarms,
                                               encryption, retention policy
```

## Decision Reasoning

1. **Golden-path abstraction** — XRDs expose only 3-4 parameters per resource type (`bucketName`, `retentionDays`, `environment`). Security defaults (encryption, public access block, DLQ) are enforced in the Composition — developers cannot create non-compliant resources. This is the same "paved road" pattern used by platform teams at Spotify and Zalando.

2. **CDK manages Crossplane IAM** — The `CrossplaneIamConstruct` (`infra/lib/constructs/iam/crossplane-iam-construct.ts`) creates a least-privilege IAM role scoped to specific AWS resource ARNs. CDK-nag validates the role at synth time. This keeps foundation-level IAM control in CDK while Crossplane operates within the granted permissions.

3. **Custom API group** — Resources use `platform.nelsonlamounier.com/v1alpha1` as the API group, making it clear these are platform-provided XRDs, not raw AWS resources. Claims use developer-friendly names (`EncryptedBucket` not `Bucket`).

## Key Components

### XRDs (Composite Resource Definitions)

| XRD | Claim Kind | Parameters | AWS Resources Created |
|---|---|---|---|
| `XEncryptedBucket` | `EncryptedBucket` | bucketName, retentionDays, environment | S3 Bucket + Versioning + SSE + PublicAccessBlock + Lifecycle |
| `XMonitoredQueue` | `MonitoredQueue` | queueName, maxRetries, environment | SQS Queue + DLQ + CloudWatch Alarm + Encryption |

### Provider Configuration

| Component | File | Purpose |
|---|---|---|
| AWS Providers | `crossplane-providers.yaml` | Upbound AWS providers (S3, SQS, IAM) |
| Provider Config | `provider-config.yaml` | Default AWS credential config (instance profile) |
| IAM Construct | `crossplane-iam-construct.ts` | CDK-managed least-privilege role |
| CDK Stack | `crossplane-stack.ts` | Provisions IAM foundation |

### Deployment Pipeline

Crossplane components deploy via ArgoCD sync-waves:
```
Wave 0: Crossplane core (crossplane.yaml)
Wave 1: Crossplane providers (crossplane-providers.yaml)
Wave 2: Crossplane XRDs (crossplane-xrds.yaml)
Wave 3: Workloads that create claims (golden-path-service, etc.)
```

## Challenges Encountered

- **CRD timing** — Crossplane providers took 60-90 seconds to install their CRDs after pod startup. XRD Compositions referencing those CRDs failed if deployed too early. Solved with ArgoCD sync-wave staggering and `skipCRDValidation: true` during initial sync.
- **Credential bootstrapping** — Without EKS/IRSA, Crossplane needs AWS credentials in-cluster. Solved by using the EC2 instance profile via `DeploymentRuntimeConfig` instead of storing credentials as Kubernetes Secrets.
- **CDK-nag compliance for IAM** — The Crossplane IAM role needed wildcard permissions for S3 bucket creation (can't know bucket names in advance). Solved by scoping wildcards to a specific resource prefix (`crossplane-shared-*`) and adding CDK-nag suppression with justification.

## Transferable Skills Demonstrated

- **Platform engineering** — designing golden-path abstractions that expose simple developer APIs while enforcing security defaults. This is the core pattern for internal developer platforms (IDPs) adopted by organisations scaling beyond 10 development teams.
- **Kubernetes API extensions** — building custom XRDs and Compositions that extend the K8s API with domain-specific resources. Applicable to any team building K8s-native platform services.
- **Two-layer IaC governance** — CDK (foundation) + Crossplane (application) with clear ownership boundaries. This separation prevents infrastructure stack growth and gives application teams self-service without compromising security.

## Source Files

- `kubernetes-app/platform/charts/crossplane-xrds/chart/templates/x-encrypted-bucket.yaml` — S3 XRD + Composition (219 lines)
- `kubernetes-app/platform/charts/crossplane-xrds/chart/templates/x-monitored-queue.yaml` — SQS XRD + Composition
- `kubernetes-app/platform/argocd-apps/crossplane-providers.yaml` — Provider deployment
- `kubernetes-app/platform/charts/crossplane-providers/manifests/provider-config.yaml` — Credential config
- `infra/lib/constructs/iam/crossplane-iam-construct.ts` — CDK IAM role
- `infra/lib/stacks/shared/crossplane-stack.ts` — CDK stack