---
title: "Knowledge Base Index"
doc_type: index
domain: all
tags:
  - index
  - navigation
  - document-graph
  - table-of-contents
last_updated: "2026-03-29"
author: Nelson Lamounier
status: accepted
---

# Knowledge Base — Document Index

This index provides a navigable map of all documents in the cdk-monitoring knowledge base, organised by domain.

## Infrastructure (8 documents)

Core AWS infrastructure: CDK stacks, VPC networking, security, and live resource inventory.

| Document | Type | Description |
|:---|:---|:---|
| [Stack Overview](infrastructure/stack-overview.md) | Architecture | 12-stack CDK architecture across K8s, compute, AI/ML, and edge |
| [Networking Implementation](infrastructure/networking-implementation.md) | Code Analysis | VPC, security groups, NLB, Route 53, and traffic flow |
| [Security Implementation](infrastructure/security-implementation.md) | Code Analysis | IAM, GuardDuty, KMS, IMDSv2, CDK-nag compliance |
| [Infrastructure Topology](infrastructure/infrastructure-topology.md) | Live Infra | Network flow map, VPC layout, 4-node cluster topology |
| [AWS Resource Inventory](infrastructure/aws-resource-inventory.md) | Live Infra | Snapshot inventory of all deployed AWS resources |
| [Security Posture](infrastructure/security-posture.md) | Live Infra | GuardDuty, Security Hub, IAM Access Analyzer status |
| [CDK over Terraform](infrastructure/adrs/cdk-over-terraform.md) | ADR | Why AWS CDK (TypeScript) was chosen over Terraform |
| [Step Functions over Lambda](infrastructure/adrs/step-functions-over-lambda-orchestration.md) | ADR | Why Step Functions over Lambda-to-Lambda orchestration |

## Kubernetes (11 documents)

Self-managed Kubernetes cluster: bootstrap, GitOps, Crossplane, and operational runbooks.

| Document | Type | Description |
|:---|:---|:---|
| [Bootstrap Pipeline](kubernetes/bootstrap-pipeline.md) | Implementation | Golden AMI → User Data → SSM Automation → Step Functions |
| [Bootstrap System Scripts](kubernetes/bootstrap-system-scripts.md) | Implementation | ArgoCD bootstrap, TLS persistence, etcd DR, deploy helpers |
| [Crossplane Implementation](kubernetes/crossplane-implementation.md) | Code Analysis | XRD platform engineering for S3/SQS golden-path provisioning |
| [Self-Managed K8s vs EKS](kubernetes/adrs/self-managed-k8s-vs-eks.md) | ADR | Why kubeadm on EC2 over Amazon EKS |
| [ArgoCD over Flux](kubernetes/adrs/argocd-over-flux.md) | ADR | GitOps controller selection with sync-waves and Image Updater |
| [Argo Rollouts](kubernetes/adrs/argo-rollouts-zero-downtime.md) | ADR | BlueGreen deployments with S3 static asset retention |
| [Crossplane for App IaC](kubernetes/adrs/crossplane-for-app-level-iac.md) | ADR | Two-layer IaC: CDK foundation + Crossplane app resources |
| [Traefik over NGINX/ALB](kubernetes/adrs/traefik-over-nginx-alb.md) | ADR | Ingress controller choice with DaemonSet hostNetwork |
| [Pod CrashLoop Runbook](kubernetes/runbooks/pod-crashloop.md) | Runbook | Diagnosing CrashLoopBackOff: OOM, image pull, probes |
| [BlueGreen Rollout Stuck](kubernetes/runbooks/bluegreen-rollout-stuck.md) | Runbook | Fixing stuck Argo Rollouts promotions |
| [Instance Terminated](kubernetes/runbooks/instance-terminated.md) | Runbook | Auto-healing response when EC2 node is terminated |

## Observability (4 documents)

Monitoring, logging, tracing, and real-user monitoring dashboards.

| Document | Type | Description |
|:---|:---|:---|
| [Observability Implementation](observability/observability-implementation.md) | Code Analysis | Prometheus, Grafana, Loki, Tempo, Alloy, Promtail stack |
| [Frontend Performance](observability/frontend-performance.md) | Implementation | Traefik-based golden signals and SLI dashboard |
| [RUM Dashboard Review](observability/rum-dashboard-review.md) | Implementation | Faro Web SDK: Core Web Vitals, error tracking, sessions |
| [Faro RUM No Data](observability/runbooks/faro-rum-no-data.md) | Runbook | Fixing missing RUM data in Grafana dashboards |

## AI/ML (2 documents)

Bedrock AI content pipeline and self-healing infrastructure agent.

| Document | Type | Description |
|:---|:---|:---|
| [Bedrock Implementation](ai-ml/bedrock-implementation.md) | Code Analysis | Publisher Lambda, Claude Converse API, Pinecone RAG |
| [Self-Healing Agent](ai-ml/self-healing-agent.md) | Code Analysis | CloudWatch → EventBridge → Bedrock tool-use remediation |

## Frontend (1 document)

Next.js application infrastructure and deployment.

| Document | Type | Description |
|:---|:---|:---|
| [Frontend Integration](frontend/frontend-integration.md) | Code Analysis | CloudFront edge, WAF, Argo Rollouts, API Gateway |

## Operations (2 documents)

CI/CD pipelines and AI-assisted operations tooling.

| Document | Type | Description |
|:---|:---|:---|
| [CI/CD Implementation](operations/ci-cd-implementation.md) | Code Analysis | GitHub Actions, ArgoCD ApplicationSet, Image Updater |
| [MCP for Operations](operations/adrs/mcp-for-operations.md) | ADR | Custom MCP servers for AI-assisted infrastructure ops |

## FinOps (1 document)

Cost analysis and optimisation.

| Document | Type | Description |
|:---|:---|:---|
| [Cost Breakdown](finops/cost-breakdown.md) | Cost | Monthly spend analysis: EC2, S3, CloudFront, Lambda |

## Career (3 documents)

Professional development, certifications, and learning methodology.

| Document | Type | Description |
|:---|:---|:---|
| [Career Transition](career/career-transition.md) | Self-Reflection | From Customer Service to Cloud Engineering |
| [Certification Journey](career/certification-journey.md) | Self-Reflection | AWS DevOps Professional exam: failure analysis and SPIDER method |
| [Learning Methodology](career/learning-methodology.md) | Self-Reflection | Build, Break, Document learning framework |

## Summary

This knowledge base contains 32 documents across 8 domains, covering the full cdk-monitoring portfolio infrastructure from AWS CDK stacks through self-managed Kubernetes to AI-powered content generation and self-healing agents.

## Keywords

knowledge-base, index, navigation, document-graph, table-of-contents, cdk-monitoring, portfolio, infrastructure, kubernetes, observability, ai-ml, frontend, operations, finops, career
