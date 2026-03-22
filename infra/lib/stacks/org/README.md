# Org Stacks

> Governance tier — cross-account resources deployed to the AWS root/management account.

## Stacks

| Stack | File | Purpose |
| :---- | :--- | :------ |
| **DNS Role** | `dns-role-stack.ts` | Cross-account IAM role for ACM DNS validation via Route 53 |

## How It Works

The DNS Role stack creates an IAM role in the **root account** (where Route 53 hosted zones live) that can be assumed by the **workload account** (where ACM certificates are requested). This enables automated DNS validation for ACM certificates without manually creating Route 53 records.

```mermaid
sequenceDiagram
    participant WL as Workload Account
    participant ROOT as Root Account
    participant R53 as Route 53

    WL->>ROOT: sts:AssumeRole (with externalId)
    ROOT-->>WL: Temporary credentials
    WL->>R53: route53:ChangeResourceRecordSets
    R53-->>WL: CNAME record created
    Note over WL: ACM validates certificate
```

## Deployment

Deployed via a dedicated workflow (`deploy-org.yml`) using the root account's OIDC role. This stack is deployed independently from all other projects.
