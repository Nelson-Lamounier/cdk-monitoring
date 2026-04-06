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
  - error-handling
  - dynamodb-update-item
  - article-versioning
  - immutable-records
related_docs:
  - infrastructure/adrs/step-functions-over-lambda-orchestration.md
  - ai-ml/self-healing-agent.md
  - ai-ml/strategist-pipeline.md
last_updated: "2026-04-02"
author: Nelson Lamounier
status: active
---

# Bedrock AI Content Pipeline Implementation

**Project:** cdk-monitoring
**Last Updated:** 2026-03-31

## Architecture

The Bedrock content pipeline is a multi-agent Step Functions orchestration that transforms draft `.md` articles into polished `.mdx` portfolio content using Claude via the Bedrock Converse API. Three specialised agents (Research, Writer, QA) run as separate Lambda functions, coordinated by an AWS Step Functions state machine. An immutable versioning system ensures published articles remain stable during new draft processing.

```
Admin "Paste Mode" (S3 upload)
  └─ drafts/{slug}.md → S3 Event Notification
      └─ Trigger Lambda
          ├─ DynamoDB: Query VERSION# → resolve next v<n>
          ├─ DynamoDB: Write VERSION#v<n> (status = "processing")
          └─ Step Functions: StartExecution (context.version = n)
              ├─ Research Agent → Pinecone KB retrieval + author direction parsing + previous version fetch
              ├─ Writer Agent → Structured MDX generation (applies targeted diffs via author direction)
              └─ QA Agent → Validation + S3 (review/v<n>/) + DDB (VERSION#v<n> = "review" & METADATA index update)

Admin Approve/Reject (Lambda.invoke)
  └─ Publish Lambda
      ├─ Approve: S3 copy review/v<n>/ → published/ + content/v<n>/
      │           DDB VERSION#v<n> = "published" + METADATA.publishedVersion = n
      │           Old published VERSION → "superseded" + ISR revalidation
      └─ Reject:  S3 copy review/v<n>/ → archived/v<n>/
                  DDB VERSION#v<n> = "rejected" (METADATA untouched)

Admin Version History (Lambda.invoke)
  └─ Version History Lambda
      └─ Query pk=ARTICLE#{slug}, sk begins_with VERSION# → all versions
```

### DynamoDB Schema — Item Collection Pattern

Each article uses a single partition key (`ARTICLE#<slug>`) with multiple sort keys:

| pk | sk | Purpose |
|---|---|---|
| `ARTICLE#<slug>` | `METADATA` | Published state pointer — updated only on admin approval |
| `ARTICLE#<slug>` | `VERSION#v1` | Immutable record for pipeline run 1 |
| `ARTICLE#<slug>` | `VERSION#v<n>` | Immutable record for pipeline run n |

The `METADATA` record acts as the "live pointer" and is never modified during pipeline execution. The `VERSION#v<n>` records are append-only — each pipeline run creates a new version record.

### S3 Path Structure (Version-Scoped)

| Path | Purpose |
|---|---|
| `drafts/<slug>.md` | Uploaded draft (triggers pipeline) |
| `review/v<n>/<slug>.mdx` | Pending QA review (version-scoped) |
| `published/<slug>.mdx` | Live published article (overwritten on each approval) |
| `content/v<n>/<slug>.mdx` | Immutable published snapshot |
| `archived/v<n>/<slug>.mdx` | Rejected versions |

### Article Status Lifecycle

| Status | Written by | When |
|--------|-----------|------|
| `processing` | Trigger Lambda → VERSION#v<n> | Draft uploaded to S3 |
| `failed` | SM DynamoUpdateItem Catch → VERSION#v<n> | Any Lambda task error during pipeline execution |
| `review` | QA Handler → VERSION#v<n> | Pipeline completes (all 3 agents finish) |
| `published` | Publish Lambda → VERSION#v<n> + METADATA | Admin approves |
| `rejected` | Publish Lambda → VERSION#v<n> | Admin rejects |
| `superseded` | Publish Lambda → old VERSION#v<m> | New version published, replacing old |

### S3 Event Notification Wiring

The pipeline is triggered automatically via S3 `OBJECT_CREATED` event notification on the `drafts/` prefix with `.md` suffix filter. CDK's `LambdaDestination` handles permission grants. No manual Lambda invocation is needed.

## Decision Reasoning

1. **Multi-agent over monolithic Lambda** — The original single-Lambda publisher bundled research, writing, and QA into one 1,000+ line function. The Step Functions approach isolates concerns, enables independent retries, and produces a clear execution audit trail. Each agent stays under 300 lines.

2. **Bedrock over OpenAI API** — Bedrock keeps all data within the AWS account (no external API calls), simplifies IAM-based access control, and avoids API key management. The trade-off is limited model selection compared to OpenAI.

3. **KB-augmented mode** — Short briefs (5-10 lines) query the Pinecone-backed Knowledge Base for relevant factual content, ensuring articles are evidence-based. A minimum context threshold (3,000 chars) rejects briefs with insufficient KB backing rather than generating hallucinated content.

4. **Adaptive Thinking budget** — Complexity analysis (LOW/MID/HIGH) drives how many thinking tokens Claude receives. Dense IaC articles get 10,000 tokens; simple narratives get 2,000. This controls cost while maintaining quality for complex topics.

5. **Immutable version records** — Each pipeline run creates a new `VERSION#v<n>` DynamoDB record. The METADATA record is a stable "live pointer" updated only on admin approval. This ensures published articles are never overwritten during new draft processing, and provides a complete audit trail of all pipeline executions.

6. **Version-scoped S3 paths** — Review, content snapshot, and archived paths include the version number (`review/v1/`, `content/v1/`). This prevents race conditions when multiple pipeline runs execute for the same slug, and enables rollback to any previous version.

7. **Supersede logic** — When a new version is published, the publish handler queries for any existing `VERSION#` records with `status='published'` and marks them as `superseded`. This ensures exactly one version is published at any time.

8. **Processing status as early signal** — The trigger Lambda writes a `status: "processing"` VERSION record immediately, before starting the Step Functions execution. This allows the frontend admin dashboard to distinguish between "not started" and "in progress" states.

9. **Targeted Updates via Diffing** — Instead of rewriting the entire article on every iteration, authors can insert `[[AUTHOR_DIRECTION]]` blocks into the draft. The Research Agent fetches the previous published version's content from S3, extracts the directions, and the Writer Agent uses both to apply targeted diffs. This preserves specific phrasing across runs.

10. **S3 event notification over direct Lambda invocation** — Automatic S3 → Lambda wiring means the frontend only needs S3 PutObject permissions. No Lambda ARN discovery, no SDK invocation. The infra handles routing entirely.

## Key Components

| Component | File | Purpose |
|---|---|---|
| Trigger Lambda | `article-pipeline/src/handlers/trigger-handler.ts` | S3 event → version resolution → DDB VERSION#v<n> → SFN StartExecution |
| Research Agent | `article-pipeline/src/agents/research-agent.ts` | Pinecone KB retrieval + source analysis |
| Writer Agent | `article-pipeline/src/agents/writer-agent.ts` | Structured MDX content generation via Converse API |
| QA Agent | `article-pipeline/src/agents/qa-agent.ts` | Content validation + version-scoped S3 write + DDB VERSION update |
| Research Handler | `article-pipeline/src/handlers/research-handler.ts` | Lambda entry point for Research Agent |
| Writer Handler | `article-pipeline/src/handlers/writer-handler.ts` | Lambda entry point for Writer Agent |
| QA Handler | `article-pipeline/src/handlers/qa-handler.ts` | Lambda entry point for QA Agent |
| Publish Lambda | `article-pipeline/src/handlers/publish-handler.ts` | Admin approve/reject → version-scoped S3 move + DDB VERSION/METADATA + ISR |
| Version History | `article-pipeline/src/handlers/version-history-handler.ts` | Query all VERSION# records for a slug (admin dashboard) |
| Shared Types | `shared/src/types.ts` | PipelineContext (with version), ArticleVersionRecord, ArticleStatus |
| Pipeline Stack | `infra/lib/stacks/bedrock/pipeline-stack.ts` | CDK: Step Functions, 6 Lambdas, S3 event, DLQ, SSM |
| Content Config | `infra/lib/config/bedrock/content-configurations.ts` | DynamoDB table config per environment |

### SSM Parameter Exports

| SSM Path | Value |
|----------|-------|
| `/{namePrefix}/pipeline-state-machine-arn` | Step Functions state machine ARN |
| `/{namePrefix}/pipeline-publish-function-arn` | Publish Lambda ARN (for admin dashboard) |
| `/{namePrefix}/pipeline-trigger-function-arn` | Trigger Lambda ARN (for diagnostics) |
| `/{namePrefix}/pipeline-version-history-function-arn` | Version History Lambda ARN (for admin dashboard) |

### Frontend Integration Contract

The frontend (separate repository) integrates via:

1. **Upload**: `PUT s3://<assets-bucket>/drafts/{slug}.md` — triggers pipeline automatically
2. **Poll**: Query DynamoDB `pk=ARTICLE#{slug}`, `sk=METADATA` — track `status` and `publishedVersion` fields
3. **Approve/Reject**: `Lambda.invoke(publishFunctionArn, { slug, version, action: "approve" | "reject" })`
4. **Version History**: `Lambda.invoke(versionHistoryFunctionArn, { slug })` — returns all VERSION# records
5. **Environment**: `PUBLISH_LAMBDA_ARN` from SSM `/{namePrefix}/pipeline-publish-function-arn`

## CDK Stack Architecture

The Article pipeline is deployed as `Bedrock-Pipeline-development`, the sixth stack in the Bedrock dependency chain:

```
Data → KB → Agent → Api → Content → Pipeline → StrategistData → StrategistPipeline
```

> **Note:** The Job Strategist pipeline extends this chain with 2 additional stacks. See [Strategist Pipeline](strategist-pipeline.md) for full documentation.

### Infrastructure Highlights

- **Step Functions**: Standard workflow with Lambda task integrations for each agent
- **Error handling**: SF-native `Catch → DynamoUpdateItem → Fail` chain writes `status='failed'` and `errorMessage` to the `VERSION#v<n>` record (not METADATA) on task failure, using `$.context.version` from the pipeline state
- **Immutable versioning**: Trigger Lambda queries existing VERSION# sort keys to resolve the next version number before starting the pipeline
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
- **Slug mismatch between S3 and DynamoDB** — The persist agent was generating a new slug from the article title instead of using the pipeline's original slug. This caused `DDB pk: ARTICLE#aws-certification-journey` vs `S3 key: review/certification-journey-aws-devops-professional.mdx`. Fixed by enforcing `context.slug` (derived from the S3 filename) across all handlers, overriding any AI-generated metadata slugs.
- **In-place article mutation** — Articles for the same topic were being changed and updated in place, destroying previous versions. Solved by implementing the immutable `VERSION#v<n>` DynamoDB record pattern and version-scoped S3 paths.
- **Missing dashboard projections** — Pipeline tasks (like QA Handler or Step Functions failure catchers) were updating the `status` and `gsi1pk` on the METADATA record but failing to write `gsi1sk` `<YYYY-MM-DD>#<slug>`. Since DynamoDB GSIs require both Keys to project an item, intermediate states frequently vanished from the admin dashboard list. Fixed by ensuring all mutation tasks explicitly write both `gsi1pk` and `gsi1sk`.

## Transferable Skills Demonstrated

- **LLM integration engineering** — building production-grade multi-agent LLM pipelines with input validation, output parsing, error handling, and cost controls. Applicable to any team integrating generative AI into product workflows.
- **RAG architecture** — implementing retrieval-augmented generation with Pinecone vector search and minimum context thresholds. The same pattern applies to any knowledge-intensive AI application.
- **Step Functions orchestration** — designing state machines that coordinate multiple Lambda functions with retry policies, error handling, and audit trails. Directly transferable to any AWS workflow automation.
- **Event-driven architecture** — S3 event notifications → Lambda → Step Functions demonstrates the serverless event bus pattern used across AWS production workloads.
- **Prompt engineering** — designing structured system prompts with persona definition, content architecture, output schema, and quality controls. Transferable to any AI-powered content generation system.

## Source Files

- `bedrock-applications/article-pipeline/src/handlers/trigger-handler.ts` — S3 event trigger + version resolution + DynamoDB VERSION record
- `bedrock-applications/article-pipeline/src/agents/research-agent.ts` — Research Agent (Pinecone RAG)
- `bedrock-applications/article-pipeline/src/agents/writer-agent.ts` — Writer Agent (MDX generation)
- `bedrock-applications/article-pipeline/src/agents/qa-agent.ts` — QA Agent (validation)
- `bedrock-applications/article-pipeline/src/handlers/publish-handler.ts` — Admin approve/reject with version-scoped paths + supersede logic
- `bedrock-applications/article-pipeline/src/handlers/version-history-handler.ts` — Version history query for admin dashboard
- `bedrock-applications/shared/src/types.ts` — PipelineContext (with version), ArticleVersionRecord, ArticleStatus
- `bedrock-applications/shared/src/index.ts` — Barrel export for shared types and utilities
- `infra/lib/stacks/bedrock/pipeline-stack.ts` — CDK infrastructure (Step Functions, 6 Lambdas, S3 event, DLQ, SSM)
- `infra/lib/config/bedrock/content-configurations.ts` — Environment-specific configuration

## Summary

This document analyses the Bedrock multi-agent content pipeline that transforms draft markdown articles into polished MDX portfolio content using three specialised AI agents (Research, Writer, QA) orchestrated by AWS Step Functions. The pipeline uses an immutable versioning system where each pipeline run creates a `VERSION#v<n>` DynamoDB record and writes to version-scoped S3 paths (`review/v<n>/`, `content/v<n>/`), ensuring published articles remain stable during new draft processing. Article status progresses through `processing → failed → review → published/rejected/superseded` lifecycle stages. The Publish Lambda handles admin approve/reject actions with automatic supersede logic for replacing published versions, and a dedicated Version History Lambda enables the admin dashboard to query all versions for a given article.

## Keywords

bedrock, step-functions, lambda, pinecone, rag, converse-api, dynamodb, content-generation, claude, mdx, publishing, s3-trigger, multi-agent, event-driven, pipeline, article-lifecycle, error-handling, dynamodb-update-item, catch-handler, model-registry, article-versioning, immutable-records, version-history, supersede-logic, targeted-diffing, author-direction, gsi-projection
