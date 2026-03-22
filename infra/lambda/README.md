# Lambda Functions

> Serverless handlers deployed as part of CDK stacks. Each Lambda is bundled with esbuild via `NodejsFunction` (TypeScript) or `Code.fromAsset` (Python).

## Functions

| Function | Directory | Stack | Purpose |
| :------- | :-------- | :---- | :------ |
| **DNS Validation** | `dns/` | Org | Cross-account Route 53 record creation for ACM DNS validation |
| **EBS Detach** | `ebs-detach/` | Kubernetes | Lifecycle hook — detaches EBS volumes before instance termination |
| **ECR Deploy** | `ecr-deploy/` | Kubernetes | EventBridge trigger — redeploys ECS service on new image push |
| **EIP Failover** | `eip-failover/` | Kubernetes | Lifecycle hook — migrates Elastic IP between old and new instances |
| **Subscriptions** | `subscriptions/` | Kubernetes API | Email subscription CRUD for the newsletter API |
| **Self-Healing Agent** | `self-healing/` | SelfHealing | Bedrock ConverseCommand agent — agentic pipeline remediation |

## Shared Utilities

- [`cfn-response.ts`](cfn-response.ts) — CloudFormation custom resource response helper (shared across all Custom Resource-backed Lambdas)

## Conventions

- **One directory per function** — each directory contains its handler, types, and tests
- **esbuild bundling** — CDK's `NodejsFunction` handles bundling; no manual build step
- **Typed handlers** — all handlers use typed event interfaces

