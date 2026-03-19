# Documentation Index

> Navigate the documentation by domain. Each section links to the relevant guide.

---

## Architecture Decision Records

| ADR | Decision |
|:----|:---------|
| [CDK Over Terraform](adrs/cdk-over-terraform.md) | Why AWS CDK was chosen over Terraform for IaC |
| [Self-Managed K8s vs EKS](adrs/self-managed-k8s-vs-eks.md) | Why self-managed Kubernetes on EC2 over EKS |
| [MCP for Operations](adrs/mcp-for-operations.md) | Using Model Context Protocol for operational tooling |

---

## Kubernetes Operations

### Troubleshooting Guides

| Guide | Scenario |
|:------|:---------|
| [CloudFront Connectivity](kubernetes/cloudfront-connectivity-troubleshooting.md) | 504 errors, origin unreachable, TLS handshake failures |
| [Cross-Node Networking](kubernetes/cross-node-networking-troubleshooting.md) | Pod-to-pod, pod-to-service, Calico BGP mesh diagnostics |
| [Security Groups & NACLs](kubernetes/security-groups-and-nacls.md) | AWS security group + NACL rules for K8s traffic |
| [SG Networking Guide](kubernetes/security-group-networking-troubleshooting-guide.md) | Deep-dive security group debugging with tcpdump/iptables |
| [Prometheus Targets](kubernetes/prometheus-targets-troubleshooting.md) | ServiceMonitor discovery, scrape failures, metric gaps |
| [Monitoring Stack](kubernetes/monitoring-troubleshooting-guide.md) | Grafana/Loki/Prometheus stack health and recovery |
| [Image + CloudFront](kubernetes/image-cloudfront-troubleshooting-guide.md) | Image serving via CloudFront — S3 origin, cache, rewrite |

### Deployment & Verification

| Guide | Purpose |
|:------|:--------|
| [Deployment Pipeline](kubernetes/deployment-pipeline-guide.md) | End-to-end K8s deployment pipeline walkthrough |
| [Post-Deployment Verification](kubernetes/post-deployment-verification-guide.md) | Readiness checks after stack deployment |
| [ArgoCD Readiness](kubernetes/argocd-readiness-verification-guide.md) | ArgoCD health, sync status, app-of-apps verification |
| [Bootstrap vs App Deploy](kubernetes/bootstrap-vs-app-deploy-review.md) | SSM Automation lifecycle: bootstrap vs. app-deploy stages |

---

## Networking & Edge

| Document | Scope |
|:---------|:------|
| [NLB Security Group Configuration](nlb-security-group-configuration.md) | NLB security group rules, health checks, target group binding |
| [Networking Observability](networking-observability.md) | VPC Flow Logs, NLB access logs, CloudWatch metrics |
| [ArgoCD Networking Review](networking-review-argocd.md) | ArgoCD ingress, Redis, and repo-server networking analysis |

---

## AI & Content Pipeline (Bedrock)

| Document | Topic |
|:---------|:------|
| [Article Generation Pipeline](bedrock/bedrock-article-generation-pipeline.md) | AWS Bedrock → MDX article generation workflow |
| [MCP Integration Architecture](bedrock/bedrock-mcp-integration-architecture.md) | MCP server architecture for Bedrock integration |
| [MCP Migration Analysis](bedrock/bedrock_mcp_migration_analysis.md) | Lambda → MCP migration gap analysis |
| [Observability Plan](bedrock/observability-plan.md) | Monitoring and observability for the content pipeline |

---

## Reference

| Document | Purpose |
|:---------|:--------|
| [CDK Monitoring Review Report](cdk_monitoring_review_report.md) | Infrastructure review findings and recommendations |
| [CloudWatch & Steampipe Data Paths](cloudwatch-steampipe-data-paths.md) | CloudWatch metric and Steampipe query reference |
| [Frontend Consumer Guide](frontend-consumer-guide.md) | API contracts and data flow for the Next.js frontend |
| [GitHub Workflow Dispatch](gh-workflow-dispatch.md) | Manual workflow trigger reference |

---

## Diagrams

- [Architecture Overview](architecture.png) — High-level system architecture
