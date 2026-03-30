---
title: "Infrastructure Cost Breakdown"
doc_type: cost
domain: finops
tags:
  - cost
  - finops
  - ec2
  - spot
  - s3
  - cloudfront
  - lambda
  - budget
related_docs:
  - infrastructure/stack-overview.md
  - kubernetes/adrs/self-managed-k8s-vs-eks.md
last_updated: "2026-03-29"
author: Nelson Lamounier
status: accepted
---

# Cost Breakdown — Portfolio Infrastructure

**Region:** eu-west-1 (Ireland)  
**Pricing Source:** AWS Price List API (via aws-pricing MCP), retrieved 2026-03-23  
**Currency:** EUR (converted from USD at 1 USD = 0.92 EUR)  
**Pricing Model:** On-Demand  

> All prices are per-unit rates from the AWS Price List API. Monthly estimates assume 730 hours/month and the portfolio's actual usage profile (low-traffic, developer workload).

## Compute — EC2 Instances

| Instance | vCPU | Memory | Unit Price (USD) | Unit Price (EUR) | Monthly (EUR) |
|:---|:---|:---|:---|:---|:---|
| t3.small (control plane) | 2 | 2 GiB | $0.0228/hr | €0.0210/hr | **€15.33** |
| t3.medium (worker) | 2 | 4 GiB | $0.0456/hr | €0.0420/hr | **€30.66** |
| **Subtotal** | | | | | **€45.99** |

**Calculation:** $0.0228 × 730 hrs = $16.64 × 0.92 = €15.33 | $0.0456 × 730 hrs = $33.29 × 0.92 = €30.66

### Decision Reasoning
- **t3.small for control plane** — burstable instance sufficient for K8s API server, etcd, and scheduler in a single-node control plane. Baseline 20% CPU with burst credits covers periodic kubectl/ArgoCD reconciliation spikes.
- **t3.medium for worker** — 4 GiB RAM needed for running the full observability stack (Prometheus, Grafana, Loki, Tempo) plus application workloads. A t3.small worker would OOM under the Prometheus scrape load.

## Networking — NLB + Route 53

| Component | Unit Price (USD) | Unit Price (EUR) | Monthly (EUR) |
|:---|:---|:---|:---|
| NLB hourly | $0.0252/hr | €0.0232/hr | **€16.94** |
| NLB capacity units (NLCU) | $0.006/NLCU-hr | €0.0055/NLCU-hr | ~€0.50 (low traffic) |
| Route 53 hosted zone | $0.50/zone/month | €0.46/zone/month | **€0.46** |
| Route 53 queries | $0.40/1M queries | €0.37/1M queries | ~€0.10 |
| **Subtotal** | | | **~€18.00** |

**Calculation:** NLB = $0.0252 × 730 = $18.40 × 0.92 = €16.94 | NLCU cost is negligible at portfolio traffic levels (<1 NLCU avg).

### Decision Reasoning
- **NLB over ALB** — TCP passthrough avoids double TLS termination. Traefik handles TLS via cert-manager, so there is no need for ALB's HTTP-level routing. NLB is also £5/month cheaper than ALB at low traffic.
- **No CloudFront distribution** — Direct NLB → Traefik path keeps the architecture simple. CloudFront would add ~€1.00/month but is unnecessary for a portfolio site with global users served from a single region.

## Serverless — Lambda

| Dimension | Unit Price (USD) | Unit Price (EUR) | Monthly (EUR) |
|:---|:---|:---|:---|
| Requests | $0.20/1M requests | €0.184/1M requests | ~€0.01 |
| Duration (Tier 1, first 6B GB-s) | $0.0000166667/GB-s | €0.0000153333/GB-s | ~€0.05 |
| **Subtotal** | | | **~€0.06** |

**Assumptions:** ~500 Lambda invocations/month (Bedrock publisher Step Function, email subscription handler). Average 512 MB memory, 3-second duration per invocation.

**Calculation:** 500 requests × $0.0000002 = $0.0001 | 500 × 3s × 0.5GB = 750 GB-s × $0.0000166667 = $0.0125 | Total ≈ $0.013 × 0.92 = €0.01

### Free Tier Note
Lambda free tier includes 1M requests and 400,000 GB-s per month — this workload falls entirely within free tier for the first 12 months.

## Storage — S3

| Tier | Unit Price (USD) | Unit Price (EUR) | Monthly (EUR) |
|:---|:---|:---|:---|
| Standard (first 50 TB) | $0.023/GB-Mo | €0.0212/GB-Mo | **~€0.25** |
| PUT/POST requests | $0.005/1K requests | €0.0046/1K requests | ~€0.01 |
| GET requests | $0.0004/1K requests | €0.00037/1K requests | ~€0.01 |
| **Subtotal** | | | **~€0.27** |

**Assumptions:** ~10 GB stored across KB docs bucket, NLB access logs bucket, frontend static assets, and Bedrock article artefacts. ~200 PUT + 2,000 GET requests/month.

## Database — DynamoDB (On-Demand)

| Dimension | Unit Price (USD) | Unit Price (EUR) | Monthly (EUR) |
|:---|:---|:---|:---|
| Read request units | $0.1415/1M RRU | €0.1302/1M RRU | ~€0.01 |
| Write request units | $0.705/1M WRU | €0.6486/1M WRU | ~€0.01 |
| Storage | $0.283/GB-Mo | €0.260/GB-Mo | ~€0.03 |
| **Subtotal** | | | **~€0.05** |

**Assumptions:** 2 tables (articles, email subscriptions). ~5,000 reads + 500 writes/month (article page views + occasional Bedrock publishes). <1 GB storage.

### Decision Reasoning
- **On-Demand over Provisioned** — Traffic is too low and unpredictable to justify provisioned capacity. On-Demand pricing at this scale costs less than the minimum provisioned throughput.

## AI — Bedrock Foundation Models

| Model | Input Tokens (USD/1M) | Output Tokens (USD/1M) | Monthly (EUR) |
|:---|:---|:---|:---|
| Claude 3 Haiku | $0.25/1M | $1.25/1M | ~€0.15 |
| Claude Haiku 4.5 | $0.80/1M | $4.00/1M | ~€0.50 |
| **Subtotal** | | | **~€0.15–€0.50** |

**Assumptions:** ~2 article generations/month. Each generation: ~8,000 input tokens (KB context + system prompt) + ~4,000 output tokens (generated article). Model used depends on configured pipeline.

**Calculation (Claude 3 Haiku):** 2 × (8K/1M × $0.25 + 4K/1M × $1.25) = 2 × ($0.002 + $0.005) = $0.014 × 0.92 = €0.013

### Decision Reasoning
- **Claude 3 Haiku as default** — Fastest and cheapest model for article generation. Quality is sufficient for the portfolio use case. Claude 3 Sonnet ($3/$15 per 1M tokens) is 12× more expensive and only marginally better for structured markdown output.

## Security & Monitoring

| Service | Unit Price (USD) | Monthly (EUR) |
|:---|:---|:---|
| GuardDuty (CloudTrail analysis) | $4.00/1M events (first 500M) | ~€0.10 |
| GuardDuty (VPC Flow Logs) | $1.00/GB (first 500 GB) | ~€0.05 |
| CloudWatch Logs (ingestion) | $0.57/GB | ~€0.30 |
| CloudWatch Metrics (custom) | $0.30/metric/month | ~€1.50 |
| CloudWatch Dashboards | $3.00/dashboard/month | ~€2.76/dashboard |
| **Subtotal** | | **~€5.00** |

**Assumptions:** 1 dashboard, ~5 custom metrics, ~500 MB log ingestion, minimal GuardDuty event volume.

---

## Monthly Cost Summary

| Category | Monthly (EUR) | % of Total |
|:---|:---|:---|
| EC2 Compute | €45.99 | 65% |
| NLB + Route 53 | €18.00 | 25% |
| Security & Monitoring | €5.00 | 7% |
| Bedrock AI | €0.15–€0.50 | <1% |
| S3 Storage | €0.27 | <1% |
| Lambda | €0.06 | <1% |
| DynamoDB | €0.05 | <1% |
| **Total** | **~€69.52** | 100% |

> **Budget Context:** Monthly budget is £50 (~€58). Compute and NLB account for 90% of the spend. The infrastructure exceeds the budget by ~€11/month, which could be reclaimed by using Reserved Instances (1-year, no upfront → ~40% savings on EC2) or Spot Instances for the worker node.

## Cost Optimisation Opportunities

| Opportunity | Potential Savings | Implementation Effort |
|:---|:---|:---|
| EC2 Reserved Instances (1yr, no upfront) | ~€18/month (40% on EC2) | Low — purchase via console |
| Spot Instance for worker node | ~€20/month (60% on EC2) | Medium — requires termination handler |
| Downscale to single t3.small (combined) | ~€15/month | High — tight on RAM for observability |
| NLB idle hours (stop overnight) | ~€6/month | Medium — Lambda scheduler + startup latency |

## Trade-Off Analysis

| Decision | Cost Impact | Operational Impact |
|:---|:---|:---|
| Self-managed K8s over EKS | Saves ~€67/month (EKS control plane fee) | Higher operational overhead, but builds transferable skills |
| Traefik DaemonSet over ALB | Saves ~€5/month | More complex ingress config, but gains native observability |
| On-Demand DynamoDB over Provisioned | Optimal at this scale | Would need reassessment above 1M requests/month |
| In-cluster observability over managed | Saves ~€50/month vs CloudWatch Container Insights | Requires Helm chart maintenance and PV storage |

## FinOps Maturity Indicators

| Indicator | Status | Evidence |
|:---|:---|:---|
| OpenCost | ✅ Deployed | `kubernetes-app/platform/argocd-apps/opencost.yaml` — **K8s cost attribution only** (on-demand pricing via AWS Price List API). Does not cover Lambda, Bedrock, DynamoDB, Reserved Instances, or Savings Plans. RI-aware pricing requires CUR → Athena integration (not configured). |
| Bedrock EMF Cost Tracking | ✅ Implemented | `EstimatedCostUSD` metric in `BedrockPublisher` namespace — per-invocation token cost estimates via EMF logs |
| AWS Budget Alerts | ✅ Implemented | `infra/lib/stacks/shared/finops-stack.ts`, `infra/lib/constructs/finops/budget-construct.ts` |
| Cost tagging | ✅ Implemented | CDK `Tags.of()` applied globally in `app.ts` |
| Right-sizing analysis | ✅ Documented | This breakdown + CloudWatch CPU/memory metrics |
| Reserved Instance planning | ❌ Not yet | Recommended next step for EC2 |

## Transferable Skills Demonstrated

- **FinOps practices** — Budget alerts, cost tagging, right-sizing analysis, and OpenCost for Kubernetes cost attribution. Demonstrates the ability to manage cloud spend at scale.
- **Data-driven pricing analysis** — Using the AWS Price List API programmatically to build cost models. Applicable to FinOps engineering roles, cloud economics, and procurement.
- **Trade-off articulation** — Quantifying the cost implications of architectural decisions (self-managed K8s, Traefik over ALB). Demonstrates the ability to communicate cost vs. operational complexity to stakeholders.

---

*Pricing data retrieved from AWS Price List API via aws-pricing MCP server, 2026-03-23. Converted at 1 USD = 0.92 EUR.*
## Summary

This document provides a detailed cost analysis of the entire cdk-monitoring infrastructure, breaking down monthly spend across EC2 instances (Spot vs On-Demand), S3 storage, CloudFront distribution, Lambda functions, and supporting AWS services. It demonstrates FinOps thinking by comparing the self-managed Kubernetes cost against equivalent managed service pricing. OpenCost provides K8s-only cost attribution (on-demand rates); managed service costs (Lambda, Bedrock, DynamoDB) are tracked separately via AWS Cost Explorer and EMF custom metrics.

## Keywords

cost, finops, ec2, spot, s3, cloudfront, lambda, budget, pricing, cost-optimisation, self-managed, eks-comparison, opencost, reserved-instances, emf
