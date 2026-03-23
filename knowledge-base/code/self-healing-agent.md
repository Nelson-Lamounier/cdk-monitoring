# Self-Healing Agent — AI-Driven Infrastructure Remediation

## Overview

The Self-Healing Agent is an AI-driven infrastructure remediation pipeline that automatically diagnoses and resolves CloudWatch alarm events. It uses Bedrock's ConverseCommand API with a native tool-use loop, discovering available remediation tools via the Model Context Protocol (MCP) through a Bedrock AgentCore Gateway.

## Architecture

```
CloudWatch Alarm (ALARM state)
    ↓
EventBridge Rule (scoped, excludes agent's own alarms)
    ↓
Self-Healing Agent Lambda (Bedrock ConverseCommand)
    ↓
AgentCore Gateway (MCP protocol v2025-03-26)
    ├── diagnose-alarm     → CloudWatch API
    ├── ebs-detach         → EC2 + ASG API
    ├── check-node-health  → SSM → kubectl on Control Plane
    └── analyse-cluster-health → SSM → K8sGPT on Control Plane
    ↓
SNS → Email remediation report
S3  → Session memory (conversation history)
```

## CDK Evidence

### Gateway Stack
- **File:** `infra/lib/stacks/self-healing/gateway-stack.ts`
- Creates an AgentCore Gateway using the `@aws-cdk/aws-bedrock-agentcore-alpha` L2 construct.
- Provisions Cognito User Pool + Client automatically for M2M OAuth 2.0 client credentials flow.
- Registers 4 Lambda tool functions with inline MCP ToolSchema definitions (input/output schemas).

### Agent Stack
- **File:** `infra/lib/stacks/self-healing/agent-stack.ts`
- TypeScript Lambda (Node.js 22, esbuild-bundled) using Bedrock ConverseCommand API.
- EventBridge rule triggers on any CloudWatch alarm entering ALARM state, **excluding** the agent's own token budget alarm (prevents feedback loops).
- FinOps guardrails: token budget alarm (100K tokens/hour), reserved concurrency, metric filters for input/output token tracking.
- Session memory persisted to S3 with 30-day lifecycle policy.

### Live Resources (from SSM Discovery)

| Resource | ID / Value | Purpose |
|:---|:---|:---|
| Gateway | `self-healing-dev-gateway-eowcx1b8cf` | MCP tool discovery + invocation |
| Gateway URL | `https://self-healing-dev-gateway-...amazonaws.com/mcp` | MCP endpoint |
| Agent Lambda | `self-healing-dev-agent` | Bedrock ConverseCommand handler |
| Agent DLQ | `self-healing-dev-agent-dlq` | Failed invocation capture |

## MCP Tool Registry

The Gateway exposes 4 tools to the agent via the MCP protocol:

### 1. `diagnose_alarm`
- **Purpose:** Queries CloudWatch for alarm configuration, current state, and recent metric datapoints.
- **Input:** `alarmName` (string)
- **Output:** Alarm state, threshold, recent datapoints, affected resources.
- **Permissions:** `cloudwatch:DescribeAlarms`, `cloudwatch:GetMetricData`

### 2. `ebs_detach`
- **Purpose:** Detaches tagged EBS volumes from terminating instances and completes ASG lifecycle actions.
- **Input:** `EC2InstanceId` (required), `AutoScalingGroupName`, `LifecycleHookName`, `LifecycleActionToken`
- **Permissions:** `ec2:DescribeVolumes`, `ec2:DetachVolume`, `autoscaling:CompleteLifecycleAction`

### 3. `check_node_health`
- **Purpose:** Runs `kubectl get nodes -o json` on the control plane via SSM SendCommand.
- **Input:** `nodeNameFilter` (optional substring)
- **Output:** Total nodes, ready/not-ready counts, per-node health details.
- **Permissions:** `ec2:DescribeInstances`, `ssm:SendCommand`, `ssm:GetCommandInvocation`

### 4. `analyse_cluster_health`
- **Purpose:** Runs K8sGPT on the control plane via SSM to diagnose workload issues. Falls back to `kubectl` if K8sGPT is not installed.
- **Input:** `namespace` (optional), `filters` (optional K8sGPT analyser filters)
- **Output:** Issue count, criticality, analysis method used (k8sgpt/kubectl-fallback).
- **Permissions:** `ec2:DescribeInstances`, `ssm:SendCommand`, `ssm:GetCommandInvocation`

## Agent Behaviour Loop

```
1. EventBridge delivers CloudWatch alarm event to Lambda
2. Agent loads previous session from S3 (if retry scenario)
3. Agent sends alarm details to Bedrock ConverseCommand
4. Model reasons about the failure and selects an MCP tool
5. Agent invokes tool via AgentCore Gateway (Cognito JWT auth)
6. Tool result returned to model for next reasoning step
7. Loop continues until model determines remediation complete
8. Agent publishes remediation report to SNS (email)
9. Session record saved to S3 for future reference
10. Failures → SQS DLQ (2 retry attempts before DLQ)
```

## FinOps Guardrails

| Guardrail | Implementation | Purpose |
|:---|:---|:---|
| Token budget alarm | CloudWatch MathExpression: input + output tokens > 100K/hour | Catch runaway agent loops |
| Reserved concurrency | Lambda `reservedConcurrentExecutions` (configurable) | Prevent parallel cost spikes |
| Metric filters | Extract `$.inputTokens` / `$.outputTokens` from structured logs | FinOps visibility |
| Self-exclusion | EventBridge `anything-but: { prefix: 'self-healing-dev-agent' }` | Prevent feedback loops |
| DLQ | SQS with configurable retention | No silent event loss |
| Dry-run mode | `DRY_RUN=true` environment variable | Propose without executing |

## Security Architecture

- **Cognito M2M auth** — AgentCore Gateway uses OAuth 2.0 client credentials flow. Agent Lambda retrieves client secret at runtime via `cognito-idp:DescribeUserPoolClient`.
- **Scoped IAM** — Each tool Lambda has minimal IAM permissions. Foundation model invocation is scoped to the specific model ARN + cross-region inference profile.
- **CDK-nag compliance** — All Nag suppressions documented with explicit reasoning (e.g., MFA not applicable for M2M flow, wildcard resource required for dynamic instance IDs).
- **Encrypted queues** — DLQ uses SQS-managed encryption. S3 memory bucket uses SSE-S3 with `blockPublicAccess: BLOCK_ALL`.

## Decision Reasoning

- **AgentCore Gateway over custom API** — The L2 construct auto-provisions IAM roles, Cognito auth, and MCP protocol configuration. Building a custom MCP API server would require 500+ lines of boilerplate for auth, routing, and schema validation.
- **ConverseCommand over Bedrock Agent** — ConverseCommand gives full control over the tool-use loop (retry logic, session memory, custom system prompts). Bedrock Agents abstract too much for a self-healing pipeline where you need to inspect every tool call.
- **MCP protocol** — Model Context Protocol (2025-03-26) is an open standard for tool discovery. Using MCP means the same tools are accessible from CLI dev tools, IDE extensions, and the production agent without code changes.
- **EventBridge with self-exclusion** — The `anything-but` filter on alarm names prevents the agent's own token budget alarm from triggering another agent invocation, which would create an infinite feedback loop.
- **Session memory in S3** — Cheaper than DynamoDB for low-frequency writes (alarm events happen rarely). 30-day lifecycle ensures old sessions are cleaned up automatically.

## Challenges Encountered

- **Cognito secret retrieval** — The AgentCore L2 construct creates a Cognito User Pool Client, but the client secret is not available at synth time. The agent Lambda must call `DescribeUserPoolClient` at runtime to obtain it, requiring an additional IAM permission.
- **Cross-region inference profiles** — Using `eu.anthropic.claude-3-5-haiku` requires IAM permissions on both the inference profile ARN (account-scoped, current region) and the foundation model ARN (wildcard region). This is non-obvious and causes `AccessDeniedException` if only one is granted.
- **SSM SendCommand latency** — K8sGPT analysis via SSM takes 30-90 seconds due to SSH-less command execution overhead. The tool Lambda timeout is set to 90 seconds accordingly.
- **CDK-nag for L2 constructs** — The AgentCore L2 auto-generates IAM roles and Cognito resources. CDK-nag flags these as "missing" MFA, advanced security mode, etc. — all inapplicable for M2M auth. Requires explicit suppressions with documented reasoning.

## Transferable Skills Demonstrated

- **AI agent orchestration** — Building a production AI agent with tool-use loops, session memory, and FinOps guardrails. Applicable to any GenAI application architecture.
- **MCP adoption** — Implementing the Model Context Protocol for tool interoperability. MCP is becoming the standard for AI tool integration in 2025-2026.
- **Infrastructure self-healing** — Automated alarm → diagnosis → remediation pipeline. Demonstrates SRE automation thinking and reduces MTTR.
- **FinOps for AI workloads** — Token budget alarms, metric filters, and reserved concurrency. Critical for controlling GenAI costs in production.
- **Event-driven architecture** — EventBridge → Lambda → MCP Gateway → Tool Lambda chain with DLQ safety nets. Applicable to any serverless event processing pipeline.
