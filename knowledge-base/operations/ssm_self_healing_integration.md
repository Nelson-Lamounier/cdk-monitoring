---
title: "SSM Bootstrap & Self-Healing Integration"
description: "Documents the integration between SSM Bootstrap Automation and the Self-Healing Bedrock Pipeline for Kubernetes node lifecycle management."
tags: ["ssm", "kubernetes", "self-healing", "bedrock", "automation"]
last_updated: "2026-04-01"
---

# SSM Bootstrap & Self-Healing Integration

This article documents the integration between the **SSM Bootstrap Automation** system (which handles Day-1 Kubernetes node lifecycle) and the **Self-Healing Bedrock Pipeline** (which handles autonomous "Day-2" incident response). 

The goal of this integration is to allow the Self-Healing Agent to automatically diagnose and recover failed Kubernetes node bootstrap sequences without operator intervention.

## 1. Architectural Flow

The self-healing workflow for bootstrap failures relies exclusively on AWS-native services, specifically the SSM control plane.

1. **Detection**: The Step Function orchestrating the node bootstrap detects a failure and triggers the `bootstrap-orchestrator` CloudWatch Alarm.
2. **Alerting**: EventBridge routes the alarm state change to the Self-Healing Lambda.
3. **Execution**: The Self-Healing Lambda passes the alarm payload to the AI Agent (Claude on Bedrock).
4. **Diagnosis**: The Agent uses the `get_node_diagnostic_json` MCP tool to pull the `run_summary.json` directly from the offending node via an SSM `SendCommand`. 
5. **Remediation**: If the failure is classified as **Transient** (e.g., `CALICO_TIMEOUT`, `ARGOCD_SYNC_FAIL`), the Agent automatically triggers the `remediate_node_bootstrap` MCP tool, initiating the SSM Automation step for remediation.
6. **Verification**: The Agent calls the `check_node_health` MCP tool to ensure the Kubernetes cluster recognizes the recovered node in a `Ready` state.

## 2. Machine-Readable Diagnostics (`run_summary.json`)

To prevent the Agent from hallucinating or struggling to parse massive unstructured CloudWatch logs, the Python `StepRunner` writes a strict validation log at `/opt/k8s-bootstrap/run_summary.json`. 

This JSON file contains:
- `overall_status`: Final status (`success` or `failed`).
- `failure_code`: A deterministic classification of the failure (e.g., `S3_FORBIDDEN`, `KUBEADM_FAIL`, `CALICO_TIMEOUT`).
- `steps`: Timing and error details for every executed step.

## 3. The New MCP Tools

Two specialized MCP tools were added to the Agent's TypeScript registry and registered with the API Gateway:

- **`get_node_diagnostic_json`**
  - Uses `ssm:SendCommand` to execute `cat /opt/k8s-bootstrap/run_summary.json` on the target EC2 instance.
- **`remediate_node_bootstrap`**
  - Resolves the correct SSM Document name and Automation Role ARN via Parameter Store queries (e.g., `/k8s/development/ssm-automation/worker-document-name`).
  - Calls `ssm:StartAutomationExecution` with the failed instance ID, triggering a Day-2 recovery path.

## 4. Troubleshooting and Edge Cases

If the Agent fails to remediate the node, check the following:
1. **SSM Parameter Store**: Ensure the parameters `/k8s/{env}/ssm-automation/{worker|cp}-document-name` exist and point to valid Documents.
2. **Permanent Failures**: The Agent is explicitly instructed **not** to automatically remediate `PERMANENT` errors like `AMI_MISMATCH` or `S3_FORBIDDEN`. These require human intervention.
3. **Outside-In API Checks**: The verify scripts now perform outside-in curl validation to the NLB `/healthz` endpoint to combat hidden proxy or AWS Load Balancer propagation delays.

## Summary

This article outlines how the Bedrock Self-Healing Agent interacts with the SSM Bootstrap Automation to autonomously recover failed Kubernetes worker nodes. Through specialized MCP tools (`get_node_diagnostic_json` and `remediate_node_bootstrap`), the agent reads the structured failure logs of the node, determines if the error is transient, and triggers the SSM pipeline to remediate without operator intervention.

## Keywords

ssm, self-healing, kubernetes, bootstrap, bedrock, agent, mcp, automation, run_summary, troubleshooting
