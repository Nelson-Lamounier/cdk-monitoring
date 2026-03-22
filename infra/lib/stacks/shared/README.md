# Shared Stacks

> Foundation tier — cross-project infrastructure shared by all projects in the monorepo.

## Stacks

| Stack | File | Purpose |
| :---- | :--- | :------ |
| **Crossplane** | `crossplane-stack.ts` | Crossplane IRSA roles and policies for K8s-native AWS resource management |
| **FinOps** | `finops-stack.ts` | Cost allocation tags, budgets, and anomaly detection |
| **Security Baseline** | `security-baseline-stack.ts` | Account-level security: Config rules, GuardDuty, Access Analyser |

## Design Decisions

- **No VPC here** — VPC is created by the Kubernetes base stack to keep networking co-located with compute
- **Cross-Project** — these stacks apply to all projects, deployed once per environment
- **Account-Level** — security baseline and FinOps operate at the AWS account level, not project level
