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

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*