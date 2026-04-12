---
title: "Kubernetes Bootstrap Pipeline"
doc_type: implementation
domain: kubernetes
tags:
  - bootstrap
  - ssm-automation
  - step-functions
  - golden-ami
  - kubeadm
  - user-data
  - ec2
related_docs:
  - infrastructure/adrs/step-functions-over-lambda-orchestration.md
  - kubernetes/adrs/self-managed-k8s-vs-eks.md
  - kubernetes/bootstrap-system-scripts.md
last_updated: "2026-03-30"
author: Nelson Lamounier
status: accepted
---

# Kubernetes Bootstrap Pipeline

**Date:** 2026-03-25
**Audience:** Developer
**Style:** Architecture Overview

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [API Reference](#api-reference)
4. [Type Definitions](#type-definitions)
5. [Usage Examples](#usage-examples)
6. [Error Handling](#error-handling)
7. [Configuration](#configuration)
8. [Source Files](#source-files)

## Overview

This document covers the EventBridge → Step Functions → SSM Automation → RunCommand bootstrap pipeline for Kubernetes EC2 instances, including Golden AMI baking, control plane bootstrap, worker node join process, and node drift enforcement.


## API Reference

### From `infra/lib/stacks/kubernetes/ssm-automation-stack.ts`

```typescript
export interface K8sSsmAutomationStackProps extends cdk.StackProps

export class K8sSsmAutomationStack extends cdk.Stack
```

### From `infra/lib/stacks/kubernetes/golden-ami-stack.ts`

```typescript
export interface GoldenAmiStackProps extends cdk.StackProps

export class GoldenAmiStack extends cdk.Stack
```

### From `infra/lib/stacks/kubernetes/control-plane-stack.ts`

```typescript
export interface KubernetesControlPlaneStackProps extends cdk.StackProps

export class KubernetesControlPlaneStack extends cdk.Stack
```

### From `infra/lib/constructs/ssm/bootstrap-orchestrator.ts`

```typescript
export interface BootstrapOrchestratorProps

export class BootstrapOrchestratorConstruct extends Construct
```

### From `infra/lib/constructs/ssm/node-drift-enforcement.ts`

```typescript
export interface NodeDriftEnforcementProps

export class NodeDriftEnforcementConstruct extends Construct
```


## Type Definitions

### From `infra/lib/stacks/kubernetes/ssm-automation-stack.ts`

```typescript
export interface K8sSsmAutomationStackProps extends cdk.StackProps

export class K8sSsmAutomationStack extends cdk.Stack
```

### From `infra/lib/stacks/kubernetes/golden-ami-stack.ts`

```typescript
export interface GoldenAmiStackProps extends cdk.StackProps

export class GoldenAmiStack extends cdk.Stack
```

### From `infra/lib/stacks/kubernetes/control-plane-stack.ts`

```typescript
export interface KubernetesControlPlaneStackProps extends cdk.StackProps

export class KubernetesControlPlaneStack extends cdk.Stack
```

### From `infra/lib/constructs/ssm/bootstrap-orchestrator.ts`

```typescript
export interface BootstrapOrchestratorProps

export class BootstrapOrchestratorConstruct extends Construct
```

### From `infra/lib/constructs/ssm/node-drift-enforcement.ts`

```typescript
export interface NodeDriftEnforcementProps

export class NodeDriftEnforcementConstruct extends Construct
```


## Usage Examples

### Example 1

@format
SSM Automation Stack — K8s Bootstrap Orchestration
Standalone CDK stack containing SSM Automation documents that orchestrate
the Kubernetes bootstrap process. Deployed independently from the Compute
stack so that bootstrap scripts can be updated without re-deploying EC2.
Resources Created:
  - SSM Automation Documents (5): CP, app-worker, mon-worker, argocd-worker,
    k8s-deploy-secrets (consolidated — 2-step sequence for Next.js + monitoring)
  - SSM Parameters: Document name discovery for EC2 user data
    - Bootstrap: `/k8s/<env>/bootstrap/<role>-doc-name`
    - Deploy: `/k8s/<env>/deploy/secrets-doc-name` (single consolidated path)
  - IAM Role: Automation execution role with RunCommand permissions
  - Step Functions: Bootstrap orchestrator state machine (2-state: 1 lookup + 1 chain)
  - Lambda: Thin router for ASG tag resolution
  - EventBridge: Auto-trigger on ASG instance launch
  - CloudWatch Alarm + SNS: Failure notifications
Lifecycle:
  - Day-1: Deployed by K8s pipeline before Compute stack
  - Day-2+: Updated independently via dedicated SSM Automation pipeline
@example
```typescript
const ssmAutomationStack = new K8sSsmAutomationStack(app, 'K8s-SsmAutomation-dev', {
    env: cdkEnvironment(Environment.DEVELOPMENT),
    targetEnvironment: Environment.DEVELOPMENT,
    configs: getK8sConfigs(Environment.DEVELOPMENT),
    ssmPrefix: '/k8s/development',
    scriptsBucketName: 'my-scripts-bucket',
});
```

### Example 2

@format
Kubernetes Control Plane Stack — Runtime Layer
Runtime compute resources for the kubeadm Kubernetes cluster.
Consumes long-lived base infrastructure from KubernetesBaseStack
via SSM parameter lookups (no cross-stack CloudFormation exports).
Resources Created:
  - Launch Template (Amazon Linux 2023, IMDSv2, Golden AMI from SSM)
  - ASG (min=1, max=1, single-node cluster with self-healing)
  - IAM Role (SSM, EBS, S3, Route53, KMS, CloudWatch grants)
  - EIP Failover Lambda (EventBridge → auto-associate on instance replace)
  - CloudWatch Log Group (KMS-encrypted)
  - SSM State Manager (optional post-boot configuration)
Resources from KubernetesBaseStack (resolved via SSM):
  - VPC, Security Groups ×3 (cluster, control-plane, ingress)
  - KMS Key, EBS Volume, Elastic IP
  - S3 Bucket (scripts & manifests), Route 53 Hosted Zone
@example
```typescript
const computeStack = new KubernetesControlPlaneStack(app, 'K8s-Compute-dev', {
    env: cdkEnvironment(Environment.DEVELOPMENT),
    targetEnvironment: Environment.DEVELOPMENT,
    vpcId: 'vpc-xxxx',
    configs: getK8sConfigs(Environment.DEVELOPMENT),
    namePrefix: 'k8s-development',
    ssmPrefix: '/k8s/development',
});
```

### Example 3

@format
Bootstrap Orchestrator Construct
Step Functions state machine that orchestrates K8s instance bootstrap:
  1. Router Lambda reads ASG tags and resolves SSM doc names
  2. Updates instance-id SSM parameter
  3. Starts SSM Automation document
  4. Polls for completion (wait → check → loop)
  5. For control-plane: triggers Config Orchestrator (SM-B) via EventBridge + worker CA re-join
Non-K8s ASGs are silently ignored (no `k8s:bootstrap-role` tag).

Architected as part of a two-tier model (Bootstrap Orchestrator + Config Orchestrator) to decouple OS-level node bootstrapping from application-level Day-2 configurations.
## EventBridge Integration
Triggers automatically on any ASG `EC2 Instance Launch Successful` event.
@example
```typescript
const orchestrator = new BootstrapOrchestratorConstruct(this, 'Orchestrator', {
    prefix: 'k8s',
    ssmPrefix: '/k8s/development',
    automationRoleArn: role.roleArn,
    scriptsBucketName: 'my-scripts-bucket',
});
```

### Example 4

@format
Node Drift Enforcement — SSM State Manager Association
Continuously enforces critical OS-level Kubernetes prerequisites
across all K8s compute nodes. Runs every 30 minutes via State Manager,
providing automatic drift remediation for settings that the Golden AMI
bakes in but that can be lost after kernel upgrades, reboots, or
accidental configuration changes.
Enforced settings:
  - Kernel modules: overlay, br_netfilter
  - Sysctl: net.bridge.bridge-nf-call-iptables, ip6tables, ip_forward
  - Services: containerd, kubelet
Architecture (Layer 3b of hybrid bootstrap):
  - Layer 1: Golden AMI (pre-baked software)
  - Layer 2: User Data (EBS attach, cfn-signal — slim trigger)
  - Layer 3: SSM Automation (kubeadm bootstrap — one-shot)
  - Layer 3b: SSM Association (THIS) — continuous drift enforcement
  - Layer 4: Self-Healing Agent (application-level remediation)
Design Decision: Targets all K8s nodes by the `project` tag applied
by the TaggingAspect (value: 'k8s-platform'). This captures control
plane + all worker roles without maintaining a per-stack tag list.
Cost: SSM State Manager Associations and Run Command are free-tier.
The only indirect cost is CloudWatch Logs ingestion (~KB per execution).
@example
```typescript
new NodeDriftEnforcementConstruct(this, 'DriftEnforcement', {
    prefix: 'k8s',
    targetEnvironment: Environment.DEVELOPMENT,
});
```








## Deployment Pipeline — 6-Phase Workflow

The `_deploy-ssm-automation.yml` workflow implements a phased deployment:

| Phase | Job | Description |
|-------|-----|-------------|
| 1 | `sync-and-verify` | Write Admin IPs to SSM (Traefik allowlists) |
| 2 | `sync-and-verify` | Sync Scripts to S3 (3 targets) |
| 3 | `sync-and-verify` | Verify S3 artefacts via integration test |
| 4 | `trigger-bootstrap` | Trigger SM-A Bootstrap Orchestrator |
| 5 | `verify-ssm-automation` | Instance targeting + health integration tests |
| 6 | `post-bootstrap-config` | Trigger SM-B Config Injection + test verify |

### S3 Sync Targets

| Source | S3 Prefix | Purpose |
|--------|-----------|----------|
| `kubernetes-app/k8s-bootstrap/` | `k8s-bootstrap/` | Core bootstrap scripts |
| `kubernetes-app/workloads/charts/nextjs/` | `app-deploy/nextjs/` | Next.js deploy scripts |
| `kubernetes-app/platform/charts/monitoring/` | `app-deploy/monitoring/` | Monitoring deploy scripts |

### Integration Tests in Pipeline

| Test | Phase | Validates |
|------|-------|-----------|
| `s3-bootstrap-artefacts.integration.test.ts` | 3 | S3 bucket exists, file counts per prefix |
| `ssm-automation-runtime.integration.test.ts` | 5 | Instance targeting, EC2 health, SSM Agent |

### Two-Tier Configuration Delivery

`_post-bootstrap-config.yml` triggers the Config Orchestrator (SM-B) which sequentially deploys all application secrets and ConfigMaps without blocking node bootstrap:
- **Phase 6:** Triggers SM-B via `trigger-config.ts` replacing direct SSM calls
- SM-B runs 5 deploy scripts: Next.js, Monitoring, Start Admin, Admin API, and Public API scripts over SSM.

Both SM-A and SM-B execution artifacts leverage consistent EventBridge + Step Function state machines for self-healing across nodes.

## Source Files

> This document was generated from the following source files:

- `infra/lib/stacks/kubernetes/ssm-automation-stack.ts` *(code)*
- `infra/lib/stacks/kubernetes/golden-ami-stack.ts` *(code)*
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` *(code)*
- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` *(code)*
- `infra/lib/constructs/ssm/config-orchestrator.ts` *(code)*
- `infra/scripts/cd/trigger-config.ts` *(code)*
- `infra/lib/constructs/ssm/node-drift-enforcement.ts` *(code)*
- `infra/lib/constructs/ssm/automation-document.ts` *(code)*
- `infra/tests/integration/kubernetes/s3-bootstrap-artefacts.integration.test.ts` *(integration test)*
- `infra/tests/integration/kubernetes/ssm-automation-runtime.integration.test.ts` *(integration test)*
- `.github/workflows/_deploy-ssm-automation.yml` *(workflow)*
- `.github/workflows/_post-bootstrap-config.yml` *(workflow)*

---

*Updated 2026-03-30 — Fixed States.MathAdd CDK synthesis bug in poll counter.*

## Troubleshooting

### States.MathAdd Crash on Second Poll Iteration

**What happened:** The bootstrap orchestrator Step Function crashed at `WorkerBootstrapIncrCount` with `Invalid arguments in States.MathAdd` every time an SSM Automation took longer than one 30-second poll cycle. New worker nodes failed to complete bootstrap.

**Why:** Two interacting CDK synthesis bugs in `sfn.Pass` with `parameters` and `sfn.JsonPath.mathAdd()` — (1) the `'count.$'` key was emitted as a literal string rather than a JSONPath assignment, and (2) `sfn.JsonPath.numberAt()` inside `sfn.JsonPath.mathAdd()` dropped the path suffix (`.count`). The first poll worked incidentally (counter was `0`, a plain number) but produced `{"count.$": 1}` (an object), causing the second poll to crash.

**Fix:** Replaced `sfn.Pass` with `sfn.CustomState` for both `InitCount` and `IncrCount` states, emitting raw ASL JSON to bypass the CDK token resolution bug. Changed counter structure from `{ count: N }` to `{ value: N }`. See CDK issue [#23387](https://github.com/aws/aws-cdk/issues/23387).

## Transferable Skills Demonstrated

- **Immutable infrastructure** — golden AMI build pipeline with Packer and User Data
- **AWS orchestration** — SSM Automation documents and Step Functions for multi-stage bootstrap
- **Kubernetes cluster lifecycle** — kubeadm init/join with HA control plane configuration
- **Infrastructure testing** — integration tests validating bootstrap stages end-to-end

## Summary

This document provides an implementation walkthrough of the 4-layer Kubernetes bootstrap pipeline: Golden AMI (EC2 Image Builder) → User Data (LaunchTemplate) → SSM Automation (6 documents) → Step Functions orchestration (EventBridge-triggered). It covers the full lifecycle from bare EC2 instance to operational Kubernetes node, including the `sfn.CustomState` workaround for CDK's `States.MathAdd` token resolution bug in the polling loop.

## Keywords

bootstrap, ssm-automation, step-functions, golden-ami, kubeadm, user-data, ec2, image-builder, asg, calico, containerd
