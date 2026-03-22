# Kubernetes Bootstrap Pipeline

**Date:** 2026-03-22
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

> This document describes the system architecture, derived from the code structure and engineering specifications below.

> **Writer Context:** Focus on the EventBridge → Step Functions → SSM Automation → RunCommand bootstrap pipeline for Kubernetes EC2 instances. Cover the Golden AMI baking, control plane bootstrap, worker node join process, and node drift enforcement.

## Overview

This documentation covers **5** source file(s) and **0** documentation file(s).

Focus on the EventBridge → Step Functions → SSM Automation → RunCommand bootstrap pipeline for Kubernetes EC2 instances. Cover the Golden AMI baking, control plane bootstrap, worker node join process, and node drift enforcement.


## Prerequisites

*No prerequisites detected. Add a "Prerequisites" section to your source markdown files.*

<!-- FORMATTING GUIDANCE:
  - Use fenced code blocks with language tags for all code
  - Show function signatures with full type annotations
  - Include inline code for variable names, types, and file paths
  - Use tables for parameter/option listings
  - Add JSDoc-style comments in code examples
-->


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
  - SSM Automation Documents (6): CP, app-worker, mon-worker, argocd-worker,
    nextjs-secrets, monitoring-secrets
  - SSM Parameters: Document name discovery for EC2 user data
  - IAM Role: Automation execution role with RunCommand permissions
  - Step Functions: Bootstrap orchestrator state machine
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
  5. For control-plane: chains secrets deployment + worker CA re-join
Non-K8s ASGs are silently ignored (no `k8s:bootstrap-role` tag).
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


## Error Handling

*No error handling documentation found. Consider adding `@throws` tags to your code.*

<!-- FORMATTING GUIDANCE:
  - Use fenced code blocks with language tags for all code
  - Show function signatures with full type annotations
  - Include inline code for variable names, types, and file paths
  - Use tables for parameter/option listings
  - Add JSDoc-style comments in code examples
-->


## Configuration

*No configuration files were provided.*

<!-- FORMATTING GUIDANCE:
  - Use fenced code blocks with language tags for all code
  - Show function signatures with full type annotations
  - Include inline code for variable names, types, and file paths
  - Use tables for parameter/option listings
  - Add JSDoc-style comments in code examples
-->


## Source Files

*Content for "Source Files" will be populated from your source files. Ensure relevant headings exist in your source markdown.*

<!-- FORMATTING GUIDANCE:
  - Use fenced code blocks with language tags for all code
  - Show function signatures with full type annotations
  - Include inline code for variable names, types, and file paths
  - Use tables for parameter/option listings
  - Add JSDoc-style comments in code examples
-->


## Source Files

> This document was generated from the following source files:

- `infra/lib/stacks/kubernetes/ssm-automation-stack.ts` *(code)*
- `infra/lib/stacks/kubernetes/golden-ami-stack.ts` *(code)*
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` *(code)*
- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` *(code)*
- `infra/lib/constructs/ssm/node-drift-enforcement.ts` *(code)*

---

*Generated by mcp-portfolio-docs — Technical Writer (Developer profile).*