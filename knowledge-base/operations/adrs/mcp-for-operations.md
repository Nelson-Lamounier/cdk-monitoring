---
title: "MCP Servers for Operations & Developer Experience"
doc_type: adr
domain: operations
tags:
  - mcp
  - model-context-protocol
  - ai-operations
  - developer-tooling
  - kubernetes
  - dynamodb
  - ssm
related_docs:
  - ai-ml/self-healing-agent.md
  - ai-ml/bedrock-implementation.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted
---

# ADR: MCP Servers for Operations & Developer Experience

**Date:** 2026-03-23
**Status:** Accepted

## Context

As a solo operator managing ~30 CloudFormation stacks, a Kubernetes cluster, and a Bedrock AI pipeline, repetitive operational tasks (checking pod status, querying DynamoDB, reviewing infrastructure state, generating documentation) consumed significant time. Two approaches were evaluated: ad-hoc CLI scripts or building structured MCP (Model Context Protocol) servers that AI assistants can invoke directly.

## Decision

I built two custom MCP servers for three reasons:

1. **AI-assisted operations** — MCP servers expose typed tools (`list_namespaces`, `query-dynamo`, `get-ssm-parameters`) that AI assistants invoke via stdio. Instead of writing one-off `kubectl` or `aws` CLI commands, I describe the intent ("check pod health in monitoring namespace") and the AI composes the correct tool calls. This reduces context-switching between terminal and documentation.

2. **Structured output, not raw CLI** — CLI tools return unstructured text. MCP tools return typed JSON with Zod-validated schemas. The AI assistant parses structured responses to make decisions (e.g., "pod is CrashLoopBackOff → check events → suggest fix"). Raw `kubectl get pods -o json` requires the AI to parse arbitrary JSON shapes.

3. **Evidence-based documentation** — The `mcp-portfolio-docs` server scans the repository, detects skills via glob+regex patterns, and generates documentation with every claim traceable to actual files. This ensures KB articles and ADRs reference real code, not fabricated examples.

## Evidence

> Files in this repository that demonstrate this decision:

### mcp-infra-server (19 tools)
- `mcp-servers/mcp-infra-server/src/index.ts` — Registers all 19 tools (7 K8s read, 5 K8s write, 7 AWS)
- `mcp-servers/mcp-infra-server/src/tools/k8s/` — Kubernetes tool handlers (list, get, describe, logs, events, apply, delete, exec, scale, helm)
- `mcp-servers/mcp-infra-server/src/tools/aws/` — AWS tool handlers (DynamoDB, SSM, SES, HTTP)
- `mcp-servers/mcp-infra-server/src/schemas/` — Zod input schemas for type-safe validation
- `mcp-servers/mcp-infra-server/src/clients/` — K8s and AWS client factories

### mcp-portfolio-docs (8 tools)
- `mcp-servers/mcp-portfolio-docs/src/index.ts` — Registers scan, analyse, generate tools
- `mcp-servers/mcp-portfolio-docs/README.md` — Full tool reference and architecture
- `mcp-servers/mcp-portfolio-docs/src/scanner/` — File tree scanner with fast-glob
- `mcp-servers/mcp-portfolio-docs/src/skills/` — Skills taxonomy (43 skills, 12 categories)

## Consequences

### Benefits

- **Faster operational diagnostics** — checking cluster health, DynamoDB state, and SSM parameters via natural language intent instead of composing CLI commands
- **Type-safe tool interfaces** — Zod schemas validate all inputs before execution. Invalid requests fail with descriptive errors, not cryptic AWS SDK exceptions
- **Zero credential storage** — K8s auth via kubeconfig, AWS auth via SDK default chain. No credentials in server code
- **Reusable across AI tools** — MCP is protocol-standard. The servers work with any MCP-compatible assistant, not just one vendor

### Trade-offs

- **Development overhead** — building and maintaining two MCP servers (~1,500 LOC each) is more effort than writing shell scripts
- **MCP protocol maturity** — MCP is still evolving. Schema changes or SDK updates may require server refactoring
- **Security surface** — write operations (`apply_resource`, `delete_resource`, `scale_resource`) are exposed to the AI. Mitigated by ⚠️ WRITE OPERATION markers and AI confirmation prompts
- **Debugging complexity** — when an MCP tool fails, the error path crosses AI → stdio → server → K8s/AWS API. Tracing requires checking multiple layers

## Transferable Skills Demonstrated

- **Developer tooling** — building typed, protocol-standard developer tools (MCP servers) that integrate with AI assistants. This is an emerging 2026 skill expected by teams adopting AI-assisted operations.
- **API design** — designing 27 tool interfaces with Zod schemas, structured error handling, and security model (read-only by default, explicit write markers). Applicable to any team building internal APIs or CLIs.
- **TypeScript full-stack** — same language (TypeScript, strict mode) across CDK stacks, Lambda handlers, MCP servers, and tests. Demonstrates single-language stack efficiency.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*
## Summary

This ADR documents the decision to build two custom MCP servers (mcp-infra-server with 19 tools and mcp-portfolio-docs with 8 tools) for AI-assisted infrastructure operations, replacing ad-hoc CLI scripts with structured, typed tool interfaces that AI assistants invoke via stdio.

## Keywords

mcp, model-context-protocol, ai-operations, developer-tooling, kubernetes, dynamodb, ssm, zod, typescript, ai-assistant
