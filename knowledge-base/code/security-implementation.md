# Security & Compliance Implementation

**Project:** cdk-monitoring
**Last Updated:** 2026-03-22

## IAM — Least-Privilege Policies

### Control Plane IAM Role

The control plane EC2 instance role (`control-plane-stack.ts`) grants only the permissions needed:
- SSM: Managed instance registration (Systems Manager agent)
- EBS: `ec2:AttachVolume`, `ec2:DetachVolume` on the persistent data volume
- S3: `s3:GetObject` on the scripts bucket (bootstrap manifests)
- Route 53: `route53:ChangeResourceRecordSets` on the private hosted zone (k8s.internal)
- KMS: `kms:Decrypt`, `kms:GenerateDataKey` for CloudWatch log encryption
- CloudWatch: `logs:CreateLogStream`, `logs:PutLogEvents` for instance logs

### Crossplane IAM

The `CrossplaneIamConstruct` (`infra/lib/constructs/iam/crossplane-iam-construct.ts`) creates IRSA-style service account bindings for Crossplane providers, scoped to specific AWS resource ARNs.

### CDK Bootstrap Role

The CDK bootstrap execution role is configured with explicit permissions in `infra/scripts/bootstrap/environment-deployment.sh`, including CloudTrail, Bedrock, and all required service permissions for stack deployments.

## GuardDuty

GuardDuty is enabled via the `Shared-SecurityBaseline` stack (`infra/lib/stacks/shared/security-baseline-stack.ts`):

```typescript
// security-baseline-stack.ts
new guardduty.CfnDetector(this, 'GuardDutyDetector', {
    enable: true,
    dataSources: {
        s3Logs: { enable: true },
        kubernetes: { auditLogs: { enable: false } }, // Not EKS
        malwareProtection: {
            scanEc2InstanceWithFindings: {
                ebsVolumes: true,
            },
        },
    },
});
```

GuardDuty Kubernetes audit logs are disabled because this is a self-managed cluster (not EKS). EBS malware scanning is enabled for the EC2 instances.

## KMS Encryption

- **CloudWatch Logs:** KMS key created in `base-stack.ts` with auto-rotation enabled. All log groups use this key.
- **EBS Volumes:** Encrypted with AWS-managed keys by default via Launch Template configuration.
- **S3 Buckets:** Server-side encryption with `S3_MANAGED` keys. The `S3BucketConstruct` enforces encryption, versioning, and public access block.

## IMDSv2 Enforcement

All EC2 instances enforce IMDSv2 (Instance Metadata Service v2) via Launch Template:

```typescript
// LaunchTemplateConstruct
metadataOptions: {
    httpTokens: 'required',      // IMDSv2 enforced
    httpEndpoint: 'enabled',
    httpPutResponseHopLimit: 2,   // Allows containers to access IMDS
}
```

The hop limit is set to 2 (not 1) because Kubernetes pods need to access instance metadata for the ECR credential provider.

## CDK-nag Compliance

The `CdkNagAspect` (`infra/lib/aspects/cdk-nag-aspect.ts`) applies the `AwsSolutions` pack to every stack at synthesis time. Any finding without an explicit suppression blocks the build.

Suppressions require justification strings:

```typescript
NagSuppressions.addStackSuppressions(this, [
    {
        id: 'AwsSolutions-L1',
        reason: 'NODEJS_22_X is the latest LTS runtime as of 2026-03',
    },
]);
```

## Kubernetes NetworkPolicies

The golden-path-service Helm chart includes a NetworkPolicy template (`kubernetes-app/workloads/charts/golden-path-service/chart/templates/networkpolicy.yaml`) that restricts pod ingress to only the Traefik ingress controller namespace.

## SSM-Only Access (No SSH)

All EC2 instances are configured with `ssmOnlyAccess: true`. There are no SSH key pairs, no port 22 security group rules. All instance access is through AWS Systems Manager Session Manager, which provides:
- IAM-authenticated sessions (no shared SSH keys)
- Audit logging to CloudWatch
- Port forwarding for kubectl access to the K8s API (TCP 6443)

## Source Files

- `infra/lib/stacks/shared/security-baseline-stack.ts` — GuardDuty, CloudTrail
- `infra/lib/aspects/cdk-nag-aspect.ts` — AwsSolutions pack enforcement
- `infra/lib/constructs/iam/crossplane-iam-construct.ts` — Crossplane IAM
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` — IAM role, IMDSv2
- `infra/lib/constructs/compute/launch-template.ts` — IMDSv2, encrypted EBS
- `infra/lib/constructs/storage/s3-bucket.ts` — S3 encryption, public access block
- `kubernetes-app/workloads/charts/golden-path-service/chart/templates/networkpolicy.yaml` — K8s NetworkPolicy