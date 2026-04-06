---
title: "Step Functions over Lambda Orchestration"
doc_type: adr
domain: infrastructure
tags:
  - step-functions
  - lambda
  - bootstrap
  - ssm-automation
  - event-driven
  - orchestration
related_docs:
  - kubernetes/bootstrap-pipeline.md
  - kubernetes/adrs/self-managed-k8s-vs-eks.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
---

# ADR: Step Functions over Lambda Orchestration

**Date:** 2026-03-22
**Status:** Accepted

## Context

The Kubernetes bootstrap pipeline requires orchestrating multiple steps in sequence: resolve ASG tags → update SSM parameter → run SSM Automation → poll for completion → optionally chain secrets deployment + worker CA re-join. The two options were Step Functions (state machine) or Lambda-to-Lambda orchestration.

## Decision

I chose AWS Step Functions over direct Lambda orchestration for three reasons:

1. **Visual execution history** — Step Functions provides a visual state machine graph showing exactly which step failed, how long each step took, and what the input/output was at every stage. For a solo operator debugging a 1 AM bootstrap failure, this eliminates the need to grep through scattered CloudWatch log groups.

2. **Built-in retry and error handling** — Each state supports configurable retry policies with exponential backoff. The bootstrap orchestrator uses a wait-check-loop pattern: wait 30 seconds → check SSM Automation status → loop until complete or timeout after 15 minutes. This is expressed declaratively in the state machine definition, not in Lambda code.

3. **Cost optimisation** — Step Functions Express Workflows cost $0.000025 per state transition. The bootstrap orchestrator runs ~15 transitions per invocation (once per ASG instance launch). Lambda-to-Lambda orchestration would require idle waiting (polling) which wastes Lambda compute time.

## Evidence

Key implementation files:

- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` — Step Functions state machine definition
  - EventBridge rule triggers on ASG `EC2 Instance Launch Successful`
  - Router Lambda reads `k8s:bootstrap-role` tag from ASG to resolve SSM doc name
  - State machine chains: Resolve → Update SSM → Start Automation → Poll → (optional) Chain secrets + worker CA
  - Non-K8s ASGs silently ignored (no `k8s:bootstrap-role` tag)

- `infra/lib/stacks/kubernetes/ssm-automation-stack.ts` — SSM Automation documents ×6:
  1. Control plane bootstrap (`kubeadm init`)
  2. Application worker join (`kubeadm join`)
  3. Monitoring worker join
  4. ArgoCD worker join
  5. Next.js secrets deployment
  6. Monitoring secrets deployment

- CloudWatch Alarm + SNS: failure notifications for bootstrap timeout or SSM Automation failure

## Consequences

### Benefits

- **Visual debugging** — Step Functions console shows exact failure point in the bootstrap sequence
- **Declarative retry logic** — backoff and timeout policies expressed in state machine, not Lambda code
- **Event-driven** — EventBridge trigger on ASG launch means zero manual intervention for instance replacement
- **Chained orchestration** — control plane bootstrap automatically chains secrets deployment + worker re-join

### Trade-offs

- **State machine complexity** — ASL (Amazon States Language) JSON/CDK is verbose compared to procedural Lambda code
- **Cold start latency** — the Router Lambda adds ~500ms cold start on first invocation (acceptable for bootstrap)
- **Express workflow limits** — 5-minute execution limit for Express; switched to Standard for the 15-minute bootstrap timeout

## Transferable Skills Demonstrated

- **Event-driven orchestration** — designing EventBridge → Step Functions → SSM Automation chains for automated instance bootstrap demonstrates serverless workflow patterns used by platform teams for any multi-step operational process.
- **Self-healing infrastructure** — ASG replacement → automatic bootstrap → drift enforcement creates a self-healing pipeline where instance failures require zero manual intervention. This is the same reliability pattern used by SRE teams aiming for reduced operational toil.
- **Declarative workflow design** — expressing retry logic, backoff policies, and conditional branching in the state machine definition (not Lambda code) separates orchestration concerns from business logic. Applicable to any team building complex operational workflows.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*
## Summary

This ADR documents the decision to use AWS Step Functions over direct Lambda-to-Lambda orchestration for the Kubernetes bootstrap pipeline, citing visual execution history for debugging, built-in retry with exponential backoff, and cost optimisation through declarative state transitions.

## Keywords

step-functions, lambda, bootstrap, ssm-automation, event-driven, orchestration, serverless, self-healing, asg
