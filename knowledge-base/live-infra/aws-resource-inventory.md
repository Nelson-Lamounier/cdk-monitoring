# Live Infrastructure — AWS Resource Inventory

**Region:** eu-west-1 (Ireland)
**Environment:** development
**Discovery Method:** AWS Resource Explorer + SSM Parameter Store

## Resource Counts by Service

| Service | Count | Category |
|:---|:---|:---|
| SSM Parameters | 141 | Configuration |
| CloudWatch Logs | 269 | Observability |
| EC2 (instances, SGs, EIPs, volumes) | 172 | Compute / Networking |
| KMS Keys | 38 | Security |
| CloudFormation Stacks | 23 | IaC |
| API Gateway | 21 | Serverless |
| Lambda Functions | 19 | Serverless |
| Image Builder | 15 | CI/CD |
| S3 Buckets | 10 | Storage |
| MemoryDB | 8 | Cache |
| SNS Topics | 8 | Messaging |
| CloudWatch (dashboards, alarms) | 6 | Observability |
| ELB (NLB, target groups) | 5 | Networking |
| Secrets Manager | 5 | Security |
| Bedrock (agents, KBs) | 5 | AI |
| ACM Certificates | 4 | Security |
| Auto Scaling | 4 | Compute |
| ECR Repositories | 4 | Containers |
| SQS Queues | 4 | Messaging |
| Events Rules | 4 | Orchestration |
| Athena | 2 | Analytics |
| Backup | 2 | DR |
| SES | 2 | Email |
| Resource Explorer | 2 | Discovery |
| GuardDuty | 1 | Security |
| DynamoDB | 1 | Database |
| ECS | 1 | Containers (legacy) |
| Access Analyzer | 1 | Security |
| App Runner | 1 | Containers (legacy) |
| Cognito | 1 | Identity |
| Step Functions | 1 | Orchestration |
| ElastiCache | 1 | Cache |

**Total:** ~780 resources across 32 services

## Key Resource Patterns

### Networking

- **VPC:** Single VPC with `/16` CIDR — 2 public subnets across 2 AZs
- **Elastic IP:** 1 EIP attached to NLB for static DNS A records
- **NLB Target Groups:** HTTP + HTTPS target groups for Traefik ingress
- **Security Groups:** 4 dedicated groups — cluster base, control plane, ingress (Traefik), monitoring node
- **Domain:** Custom domain with public + private hosted zones

### Compute

- **4 EC2 instances:** Control plane, app worker, ArgoCD worker, monitoring worker
- **Golden AMI:** Custom AMI built via EC2 Image Builder pipeline with K8s prerequisites
- **EBS:** GP3 volumes with KMS encryption
- **KMS:** Dedicated key for K8s secrets encryption (etcd encryption at rest)

### Kubernetes

- **API Endpoint:** Private DNS hostname on port 6443 (not publicly accessible)
- **Bootstrap:** Step Functions-orchestrated SSM Automation documents
- **Network Policy:** 4 security groups with role-based access rules

### Storage

- **S3 Buckets:** KB source data, bootstrap scripts, frontend static assets (10 total)
- **EFS:** Shared filesystem for monitoring data (Prometheus, Grafana) — survives instance termination
- **DynamoDB:** Single table for published article metadata (single-table design)

### AI / Bedrock

- **Bedrock Agent:** 1 agent with 1 alias for chatbot interactions
- **Knowledge Base:** 1 KB backed by S3 source documents
- **Publisher Lambda:** Article generation with DLQ for failure handling
- **API Gateway:** REST API with stage-level throttling

### Self-Healing Agent

- **AgentCore Gateway:** MCP-protocol gateway with registered tools
- **Agent Lambda:** Event-driven with EventBridge trigger from CloudWatch Alarms
- **DLQ:** Separate dead-letter queue for agent failures

### Frontend

- **ECR:** 1 repository for Next.js container images (SHA-tagged)
- **API Gateway:** Separate REST API for subscription and article data endpoints

### Observability

- **Loki:** Log aggregation endpoint on monitoring node (NodePort)
- **Tempo:** Distributed tracing endpoint on monitoring node (NodePort)
- **SNS:** Monitoring alerts topic for Alertmanager notifications
- **Secrets:** Prometheus metrics token and Grafana admin password in SSM SecureString

## SSM Parameter Architecture

All infrastructure outputs are stored in SSM Parameter Store (141 parameters) using a hierarchical path structure:

```
/{project}/{environment}/
    ├── networking/       — VPC ID, subnet IDs, EIP, SG IDs
    ├── compute/          — Instance IDs, AMI ID, key pair
    ├── kubernetes/       — API endpoint, join token, certs
    ├── monitoring/       — Loki/Tempo endpoints, Grafana creds
    ├── bedrock/          — Agent IDs, KB ID, API URLs
    ├── self-healing/     — Gateway URL, agent ARN
    └── frontend/         — ECR URI, API Gateway URL
```

- **SecureString** for: join tokens, deploy keys, admin passwords, TLS certificates
- **String** for: resource IDs, endpoint URLs, configuration values
- **KMS encryption** on all SecureString parameters

## Decision Reasoning

- **SSM as parameter store** — All infrastructure outputs stored in SSM rather than CloudFormation exports or Terraform outputs. This enables cross-stack lookups, programmatic discovery by CI/CD pipelines, and MCP tool access.
- **SecureString for secrets** — K8s join tokens, deploy keys, admin passwords, and TLS certificates stored as KMS-encrypted SecureString parameters. No secrets in Git or environment variables.
- **4 EC2 instances** — Separated control plane from worker nodes by role (app, ArgoCD, monitoring). Each node has a dedicated SSM automation execution ID for traceable bootstrap provenance.
- **EFS for monitoring data** — Prometheus and Grafana data persisted to EFS rather than local EBS. Survives instance termination and supports the self-healing architecture.

## Transferable Skills Demonstrated

- **Infrastructure cataloguing** — Programmatic resource discovery across 32 services using Resource Explorer and SSM. Applicable to CMDB population, cost attribution, and compliance auditing.
- **Secrets management architecture** — Structured SSM parameter hierarchy with KMS encryption. Demonstrates understanding of secret rotation, least-privilege access, and audit trails.
- **Immutable infrastructure evidence** — Golden AMI builds, SSM bootstrap execution IDs, and image SHA tags prove every component is traceable and reproducible.
