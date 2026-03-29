---
title: "Live Infrastructure — Security Posture"
doc_type: live-infra
domain: infrastructure
tags:
  - security
  - guardduty
  - inspector
  - security-hub
  - access-analyzer
  - encryption
  - network-security
related_docs:
  - infrastructure/security-implementation.md
  - infrastructure/stack-overview.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
---

# Live Infrastructure — Security Posture

**Region:** eu-west-1 (Ireland)
**Environment:** development
**Assessment Method:** Well-Architected Security MCP + CDK-nag (build-time)

## Security Services Status

| Service | Status | Details |
|:---|:---|:---|
| **GuardDuty** | ✅ Enabled | Publishing findings every 15 minutes |
| **Inspector** | ✅ Enabled | Account-level enabled, but EC2/ECR/Lambda scans individually disabled |
| **IAM Access Analyzer** | ✅ Active | Account-scoped analyser — **9 active findings** |
| **Security Hub** | ✅ Enabled | Hub active, but **0 security standards** enabled |
| **Trusted Advisor** | ❌ Not available | Requires Business/Enterprise Support plan |
| **Macie** | ❌ Not enabled | S3 data classification not configured |

## GuardDuty Feature Coverage

| Feature | Status | Notes |
|:---|:---|:---|
| CloudTrail Events | ✅ Enabled | Management events monitored |
| DNS Logs | ✅ Enabled | DNS query anomaly detection |
| VPC Flow Logs | ✅ Enabled | Network anomaly detection |
| S3 Data Events | ❌ Disabled | Cost saving — low S3 volume |
| EKS Audit Logs | ❌ Disabled | Self-managed K8s, not EKS |
| EBS Malware Protection | ❌ Disabled | Not applicable in dev environment |
| Lambda Network Logs | ❌ Disabled | Low Lambda usage |
| Runtime Monitoring | ❌ Disabled | EC2 agent management off |

### Reasoning for Disabled Features

- **EKS features disabled** — The cluster is self-managed K8s (kubeadm), not EKS. EKS-specific features do not apply.
- **S3 data events disabled** — Only low-volume KB data and static assets. S3 data event monitoring costs ~€0.80/1M events — not justified at this scale.
- **Runtime monitoring disabled** — The EC2 agent approach requires the SSM agent + GuardDuty agent on each instance. A cost-optimised decision for a development environment.

## IAM Access Analyzer

- **Type:** ACCOUNT (analyses this account only)
- **Active Findings:** 9
- **Purpose:** Detects resources shared externally (S3 buckets, IAM roles, KMS keys, Lambda layers, SQS queues) and flags overly permissive policies.

## Security Hub

- **Status:** Enabled but **no standards configured**
- **Recommendation:** Enable AWS Foundational Security Best Practices (FSBP) standard for automated compliance checks against CIS benchmarks and AWS security best practices.

## Encryption Posture

| Resource Type | Encryption | Key Type |
|:---|:---|:---|
| SSM SecureString parameters | ✅ KMS | Dedicated account KMS key |
| K8s secrets, tokens, keys | ✅ KMS | Dedicated K8s encryption key |
| EBS volumes | ✅ KMS | Default EBS encryption key |
| S3 buckets | ✅ SSE-S3 | Server-side encryption via CDK construct defaults |
| DynamoDB tables | ✅ AWS-owned | Default encryption |

## Network Security Architecture

- **SSM-only access** — No SSH keys, no bastion hosts. All instance access via SSM Session Manager.
- **IP allowlisting** — Admin operations restricted to an explicit IPv4/IPv6 allowlist stored in SSM configuration. No hardcoded IPs in security group rules.
- **Private K8s API** — API server accessible only within VPC via private DNS hostname. No public K8s API endpoint.
- **4 dedicated security groups** — Separate SGs for cluster base, control plane, ingress (Traefik), and monitoring node. Data-driven rule definitions in CDK config.
- **Cross-account DNS** — Route 53 validation role in a separate account for cert-manager DNS-01 challenges. Demonstrates multi-account IAM patterns.

## Identified Gaps and Recommendations

| Gap | Risk Level | Recommendation |
|:---|:---|:---|
| Inspector scans disabled | Medium | Enable EC2 scanning for CVE detection on instances |
| Security Hub — 0 standards | Medium | Enable FSBP standard for automated compliance |
| Macie not enabled | Low | Not critical for a portfolio with no PII/PHI data |
| 9 Access Analyzer findings | Medium | Review and remediate external access findings |

## Decision Reasoning

- **GuardDuty as core detection** — Chose GuardDuty's CloudTrail + DNS + Flow Log analysis as the primary threat detection surface. At the free-tier level (first 30 days) and low-volume pricing, this provides the best detection-to-cost ratio for a solo developer.
- **Access Analyzer for IAM hygiene** — Account-level analyser catches accidental public S3 buckets or overly permissive cross-account roles. Zero ongoing cost.
- **Security Hub as central pane** — Aggregates findings from GuardDuty + Access Analyzer. Standards not yet enabled to avoid per-check charges (~€0.0010/check/month) during development.
- **CDK-nag at build time** — Policy-as-code (AwsSolutions pack) catches security misconfigurations before deployment. Complements runtime detection with shift-left compliance.

## Transferable Skills Demonstrated

- **Security service orchestration** — Configuring and reasoning about GuardDuty, Inspector, Access Analyzer, and Security Hub as complementary layers. Applicable to SOC engineering and security architecture roles.
- **Defence-in-depth architecture** — Combining CDK-nag (build-time), NetworkPolicies (runtime), SSM-only access (network), and GuardDuty (detection) into a layered security model.
- **Cost-conscious security** — Making principled decisions about which security features to enable based on risk-vs-cost analysis. Demonstrates FinOps-aware security thinking.

## Summary

This document assesses the live security posture: GuardDuty feature coverage (CloudTrail, DNS, Flow Logs enabled; EKS/S3/Runtime disabled with reasoning), IAM Access Analyzer (9 active findings), Security Hub (enabled, 0 standards), encryption at rest across SSM/EBS/S3/DynamoDB, and network security architecture (SSM-only, IP allowlisting, private K8s API).

## Keywords

security, guardduty, inspector, security-hub, access-analyzer, encryption, network-security, ssm-only, cdk-nag, defence-in-depth
