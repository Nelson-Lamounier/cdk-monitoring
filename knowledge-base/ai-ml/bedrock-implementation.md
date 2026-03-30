---
title: "Bedrock AI Content Pipeline Implementation"
doc_type: code-analysis
domain: ai-ml
tags:
  - bedrock
  - step-functions
  - lambda
  - pinecone
  - rag
  - converse-api
  - dynamodb
  - content-generation
  - s3-event-notification
  - multi-agent
  - model-registry
related_docs:
  - infrastructure/adrs/step-functions-over-lambda-orchestration.md
  - ai-ml/self-healing-agent.md
  - ai-ml/strategist-pipeline.md
last_updated: "2026-03-30"
author: Nelson Lamounier
status: active
---

# Bedrock AI Content Pipeline Implementation

**Project:** cdk-monitoring
**Last Updated:** 2026-03-30

## Architecture

The Bedrock content pipeline is a multi-agent Step Functions orchestration that transforms draft `.md` articles into polished `.mdx` portfolio content using Claude via the Bedrock Converse API. Three specialised agents (Research, Writer, QA) run as separate Lambda functions, coordinated by an AWS Step Functions state machine.

```
Admin "Paste Mode" (S3 upload)
  └─ drafts/{slug}.md → S3 Event Notification
      └─ Trigger Lambda
          ├─ DynamoDB: status = "processing"
          └─ Step Functions: StartExecution
              ├─ Research Agent → Pinecone KB retrieval + source analysis
              ├─ Writer Agent → Structured MDX generation
              └─ QA Agent → Validation + S3 write (review/) + DynamoDB (status = "review")

Admin Approve/Reject (Lambda.invoke)
  └─ Publish Lambda
      ├─ Approve: S3 copy review/ → published/ + DynamoDB (status = "published") + ISR
      └─ Reject: S3 copy review/ → archived/ + DynamoDB (status = "rejected")
```

### Article Status Lifecycle

| Status | Written by | When |
|--------|-----------|------|
| `processing` | Trigger Lambda | Draft uploaded to S3 |
| `review` | QA Handler | Pipeline completes (all 3 agents finish) |
| `published` | Publish Lambda | Admin approves |
| `rejected` | Publish Lambda | Admin rejects |

### S3 Event Notification Wiring

The pipeline is triggered automatically via S3 `OBJECT_CREATED` event notification on the `drafts/` prefix with `.md` suffix filter. CDK's `LambdaDestination` handles permission grants. No manual Lambda invocation is needed.

## Decision Reasoning

1. **Multi-agent over monolithic Lambda** — The original single-Lambda publisher bundled research, writing, and QA into one 1,000+ line function. The Step Functions approach isolates concerns, enables independent retries, and produces a clear execution audit trail. Each agent stays under 300 lines.

2. **Bedrock over OpenAI API** — Bedrock keeps all data within the AWS account (no external API calls), simplifies IAM-based access control, and avoids API key management. The trade-off is limited model selection compared to OpenAI.

3. **KB-augmented mode** — Short briefs (5-10 lines) query the Pinecone-backed Knowledge Base for relevant factual content, ensuring articles are evidence-based. A minimum context threshold (3,000 chars) rejects briefs with insufficient KB backing rather than generating hallucinated content.

4. **Adaptive Thinking budget** — Complexity analysis (LOW/MID/HIGH) drives how many thinking tokens Claude receives. Dense IaC articles get 10,000 tokens; simple narratives get 2,000. This controls cost while maintaining quality for complex topics.

5. **DynamoDB dual-record pattern** — Each article creates two DynamoDB records: a mutable METADATA record (for frontend queries via GSI) and an immutable CONTENT version record (for audit trail and rollback). The GSI1 key pattern `STATUS#<status>` enables efficient dashboard queries by article state.

6. **Processing status as early signal** — The trigger Lambda writes a `status: "processing"` record immediately, before starting the Step Functions execution. This allows the frontend admin dashboard to distinguish between "not started" and "in progress" states. A `ConditionExpression` guard prevents overwriting published articles on accidental re-upload.

7. **S3 event notification over direct Lambda invocation** — Automatic S3 → Lambda wiring means the frontend only needs S3 PutObject permissions. No Lambda ARN discovery, no SDK invocation. The infra handles routing entirely.

## Key Components

| Component | File | Purpose |
|---|---|---|
| Trigger Lambda | `bedrock-applications/article-pipeline/src/handlers/trigger-handler.ts` | S3 event → DynamoDB "processing" → SFN StartExecution |
| Research Agent | `bedrock-applications/article-pipeline/src/agents/research-agent.ts` | Pinecone KB retrieval + source analysis |
| Writer Agent | `bedrock-applications/article-pipeline/src/agents/writer-agent.ts` | Structured MDX content generation via Converse API |
| QA Agent | `bedrock-applications/article-pipeline/src/agents/qa-agent.ts` | Content validation + S3 write + DynamoDB update |
| Research Handler | `bedrock-applications/article-pipeline/src/handlers/research-handler.ts` | Lambda entry point for Research Agent |
| Writer Handler | `bedrock-applications/article-pipeline/src/handlers/writer-handler.ts` | Lambda entry point for Writer Agent |
| QA Handler | `bedrock-applications/article-pipeline/src/handlers/qa-handler.ts` | Lambda entry point for QA Agent |
| Publish Lambda | `bedrock-applications/article-pipeline/src/handlers/publish-handler.ts` | Admin approve/reject → S3 move + DynamoDB + ISR |
| Shared Types | `bedrock-applications/shared/src/index.ts` | Barrel export: types, metrics, agent-runner utilities |
| Pipeline Stack | `infra/lib/stacks/bedrock/pipeline-stack.ts` | CDK: Step Functions, 5 Lambdas, S3 event, DLQ, SSM |
| Content Config | `infra/lib/config/bedrock/content-configurations.ts` | DynamoDB table config per environment |

### SSM Parameter Exports

| SSM Path | Value |
|----------|-------|
| `/{namePrefix}/pipeline-state-machine-arn` | Step Functions state machine ARN |
| `/{namePrefix}/pipeline-publish-function-arn` | Publish Lambda ARN (for admin dashboard) |
| `/{namePrefix}/pipeline-trigger-function-arn` | Trigger Lambda ARN (for diagnostics) |

### Frontend Integration Contract

The frontend (separate repository) integrates via:

1. **Upload**: `PUT s3://<assets-bucket>/drafts/{slug}.md` — triggers pipeline automatically
2. **Poll**: Query DynamoDB `pk=ARTICLE#{slug}`, `sk=METADATA` — track `status` field
3. **Approve/Reject**: `Lambda.invoke(publishFunctionArn, { slug, action: "approve" | "reject" })`
4. **Environment**: `PUBLISH_LAMBDA_ARN` from SSM `/{namePrefix}/pipeline-publish-function-arn`

## CDK Stack Architecture

The Article pipeline is deployed as `Bedrock-Pipeline-development`, the sixth stack in the Bedrock dependency chain:

```
Data → KB → Agent → Api → Content → Pipeline → StrategistData → StrategistPipeline
```

> **Note:** The Job Strategist pipeline extends this chain with 2 additional stacks. See [Strategist Pipeline](strategist-pipeline.md) for full documentation.

### Infrastructure Highlights

- **Step Functions**: Standard workflow with Lambda task integrations for each agent
- **Dead Letter Queue**: SQS DLQ with 14-day retention for failed executions
- **S3 Event Notification**: `OBJECT_CREATED` on `drafts/*.md` → Trigger Lambda
- **Logging**: Step Functions `ALL` log level; each Lambda has a dedicated CloudWatch log group
- **DynamoDB**: RETAIN removal policy (protects data from stack deletion)
- **Tracing**: X-Ray active tracing on all Lambda functions

## Challenges Encountered

- **JSON extraction from LLM output** — Claude sometimes wraps JSON in markdown code blocks or adds preamble text. Solved by extracting the first `{` to last `}` substring, not expecting clean JSON.
- **Mermaid syntax validation** — LLM-generated Mermaid diagrams frequently had syntax errors (YAML frontmatter leaking, empty chart bodies). Added `validateMermaidSyntax()` post-processing to catch these before publishing.
- **Cost control** — Early prompts generated 3,000+ word articles at $0.15+ per invocation. The word budget table in the system prompt constrains output to 1,200-1,800 words at ~$0.03-$0.05 per article.
- **Import path fragility** — Deep relative imports between `article-pipeline/` and `shared/` broke during esbuild bundling. Solved by creating a barrel export (`shared/src/index.ts`) and standardising all handler imports to a single `../../../shared/src/index.js` path. Files at `src/agents/` depth (3 levels below `bedrock-applications/`) must use `../../../shared/src/` — using `../../` (2 levels) resolves to the non-existent `article-pipeline/shared/src/` instead.
- **Centralised model registry** — All Bedrock model IDs are sourced from `infra/lib/config/shared/model-registry.ts`. When a model is deprecated (e.g. Haiku 3.5 → 4.5), change the constant once and all projects (ChatBot, Article Pipeline, Job Strategist, Self-Healing) pick up the new identifier. Environment variable validation wraps `process.env` reads in typed helper functions (e.g. `requireQaModel()`) to ensure TypeScript narrows the type to `string`.
- **Missing S3 event notification** — The trigger Lambda was built to receive S3 events but no `addEventNotification` was wired in CDK. Uploading a draft to S3 did nothing until the notification was added to `pipeline-stack.ts`.

## Transferable Skills Demonstrated

- **LLM integration engineering** — building production-grade multi-agent LLM pipelines with input validation, output parsing, error handling, and cost controls. Applicable to any team integrating generative AI into product workflows.
- **RAG architecture** — implementing retrieval-augmented generation with Pinecone vector search and minimum context thresholds. The same pattern applies to any knowledge-intensive AI application.
- **Step Functions orchestration** — designing state machines that coordinate multiple Lambda functions with retry policies, error handling, and audit trails. Directly transferable to any AWS workflow automation.
- **Event-driven architecture** — S3 event notifications → Lambda → Step Functions demonstrates the serverless event bus pattern used across AWS production workloads.
- **Prompt engineering** — designing structured system prompts with persona definition, content architecture, output schema, and quality controls. Transferable to any AI-powered content generation system.

## Source Files

- `bedrock-applications/article-pipeline/src/handlers/trigger-handler.ts` — S3 event trigger + DynamoDB processing status
- `bedrock-applications/article-pipeline/src/agents/research-agent.ts` — Research Agent (Pinecone RAG)
- `bedrock-applications/article-pipeline/src/agents/writer-agent.ts` — Writer Agent (MDX generation)
- `bedrock-applications/article-pipeline/src/agents/qa-agent.ts` — QA Agent (validation)
- `bedrock-applications/article-pipeline/src/handlers/publish-handler.ts` — Admin approve/reject
- `bedrock-applications/shared/src/index.ts` — Barrel export for shared types and utilities
- `infra/lib/stacks/bedrock/pipeline-stack.ts` — CDK infrastructure (Step Functions, Lambdas, S3 event, DLQ)
- `infra/lib/config/bedrock/content-configurations.ts` — Environment-specific configuration

## Summary

This document analyses the Bedrock multi-agent content pipeline that transforms draft markdown articles into polished MDX portfolio content using three specialised AI agents (Research, Writer, QA) orchestrated by AWS Step Functions. The pipeline is triggered automatically via S3 event notifications, tracks article status through a `processing → review → published/rejected` lifecycle in DynamoDB, and provides a Publish Lambda for admin approve/reject actions with ISR revalidation.

## Keywords

bedrock, step-functions, lambda, pinecone, rag, converse-api, dynamodb, content-generation, claude, mdx, publishing, s3-trigger, multi-agent, event-driven, pipeline, article-lifecycle
