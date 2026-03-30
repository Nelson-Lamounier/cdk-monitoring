---
title: "Job Strategist Multi-Agent Pipeline"
doc_type: code-analysis
domain: ai-ml
tags:
  - bedrock
  - step-functions
  - lambda
  - dynamodb
  - multi-agent
  - job-application
  - interview-coaching
  - converse-api
  - knowledge-base
  - career-strategy
related_docs:
  - ai-ml/bedrock-implementation.md
  - infrastructure/adrs/step-functions-over-lambda-orchestration.md
  - infrastructure/stack-overview.md
last_updated: "2026-03-30"
author: Nelson Lamounier
status: active
---

# Job Strategist Multi-Agent Pipeline

**Project:** cdk-monitoring
**Last Updated:** 2026-03-30

## Architecture

The Job Strategist is a 3-agent Step Functions pipeline that analyses job descriptions against the candidate's verified experience (from Bedrock Knowledge Base) and produces a comprehensive application strategy, tailored documents, and stage-specific interview preparation.

```
Admin Dashboard (Submit JD)
  └─ POST /api/strategist/trigger → Invoke Lambda (SDK)
      └─ Trigger Lambda
          ├─ DynamoDB: status = "analysing" (METADATA record)
          └─ Step Functions: StartExecution
              ├─ Research Agent → KB retrieval, resume parsing, gap analysis
              ├─ Strategist Agent → 5-phase analysis, cover letter, resume tailoring
              └─ Coach Agent → Interview prep, DynamoDB writes (METADATA + ANALYSIS + INTERVIEW)

Pipeline completion:
  └─ Coach Handler writes 3 DynamoDB records:
      ├─ METADATA update: status = "analysis-ready", fitRating, recommendation
      ├─ ANALYSIS#{pipelineId}: Full XML analysis + cover letter
      └─ INTERVIEW#{stage}: Stage-specific interview preparation JSON
```

### Application Status Lifecycle

| Status | Written by | When |
|--------|-----------|------|
| `analysing` | Trigger Lambda | User submits job description |
| `analysis-ready` | Coach Handler | Pipeline completes (all 3 agents finish) |
| `interview-prep` | Admin action | User begins interview preparation |
| `applied` | Admin action | Application submitted |
| `interviewing` | Admin action | Active interview process |
| `offer-received` | Admin action | Offer extended |
| `accepted` | Admin action | Offer accepted |
| `rejected` | Admin action | Application rejected |
| `withdrawn` | Admin action | Application withdrawn |

### Comparison with Article Pipeline

| Aspect | Article Pipeline | Job Strategist |
|--------|-----------------|---------------|
| Trigger | S3 event notification (`drafts/*.md`) | Direct Lambda invoke (admin POST) |
| Agents | Research → Writer → QA (3) | Research → Strategist → Coach (3) |
| Output | MDX article + S3 artefacts | XML analysis + cover letter + interview prep |
| DynamoDB | 2 records (METADATA + CONTENT) | 3 records (METADATA + ANALYSIS + INTERVIEW) |
| Frontend action | Approve/Reject | Status lifecycle progression |
| API Gateway | Not used (S3 event) | Not used (Lambda SDK invoke) |

## Decision Reasoning

1. **3-agent separation** — Each agent has a distinct concern: research (KB + resume data gathering), strategy (5-phase analysis + document generation), and coaching (interview preparation). Separating them enables independent retries and clear audit trails per agent.

2. **XML output for analysis** — The Strategist Agent produces a comprehensive XML document with structured sections (JD deconstruction, gap analysis, positioning strategy, cover letter, resume modifications). XML preserves section hierarchy better than JSON for long-form content whilst remaining machine-parseable.

3. **DynamoDB single-table design** — All application data uses `APPLICATION#<slug>` as the partition key with multiple sort keys (METADATA, ANALYSIS#id, INTERVIEW#stage). This enables efficient `Query` operations for full application retrieval.

4. **GSI1 for admin listing** — `APP_STATUS#<status>` as GSI1 partition key enables efficient queries like "show all analysis-ready applications, newest first" without scanning the entire table.

5. **No API Gateway** — Following the Article Pipeline pattern, the Trigger Lambda is invoked directly via the AWS SDK from a Next.js API route. The Lambda ARN is exported via SSM and injected as a K8s secret.

6. **Truthfulness mandate** — The system prompts enforce strict guardrails: never fabricate skills, always cite sources, flag gaps honestly. This is a core design constraint, not an afterthought.

## Key Components

| Component | File | Purpose |
|---|---|---|
| Trigger Handler | `bedrock-applications/job-strategist/src/handlers/trigger-handler.ts` | API → DynamoDB "analysing" → SFN StartExecution |
| Research Handler | `bedrock-applications/job-strategist/src/handlers/research-handler.ts` | KB retrieval + resume parsing + gap analysis |
| Strategist Handler | `bedrock-applications/job-strategist/src/handlers/strategist-handler.ts` | 5-phase analysis + cover letter + resume tailoring |
| Coach Handler | `bedrock-applications/job-strategist/src/handlers/coach-handler.ts` | Interview prep + DynamoDB final writes |
| Research Agent | `bedrock-applications/job-strategist/src/agents/research-agent.ts` | Bedrock Converse API + KB Retrieve |
| Strategist Agent | `bedrock-applications/job-strategist/src/agents/strategist-agent.ts` | Extended thinking + XML output generation |
| Coach Agent | `bedrock-applications/job-strategist/src/agents/coach-agent.ts` | Stage-specific interview preparation |
| Shared Types | `bedrock-applications/shared/src/strategist-types.ts` | Pipeline context, agent result shapes, DynamoDB entity |
| Strategist Persona | `infra/lib/config/bedrock/strategist-persona.ts` | System prompts for all 3 agents |
| Data Stack | `infra/lib/stacks/bedrock/strategist-data-stack.ts` | DynamoDB table + GSI + SSM exports |
| Pipeline Stack | `infra/lib/stacks/bedrock/strategist-pipeline-stack.ts` | Step Functions + 4 Lambdas + SQS DLQ |
| Allocations | `infra/lib/config/bedrock/strategist-allocations.ts` | Model IDs + memory/timeout per environment |
| Configurations | `infra/lib/config/bedrock/strategist-configurations.ts` | Stack configuration per environment |

### Agent Model Allocations (Development)

| Agent | Model | Max Tokens | Thinking Budget | Memory |
|-------|-------|-----------|----------------|--------|
| Research | Claude Haiku 3.5 | — | — | 512 MB |
| Strategist | Claude Sonnet 4.6 | 16,384 | 8,192 | 512 MB |
| Coach | Claude Haiku 4.5 | 8,192 | 4,096 | 512 MB |
| Trigger | — | — | — | 256 MB |

### SSM Parameter Exports

| SSM Path | Value |
|----------|-------|
| `/{namePrefix}/strategist-table-name` | DynamoDB table name |
| `/{namePrefix}/strategist-table-arn` | DynamoDB table ARN |
| `/{namePrefix}/strategist-state-machine-arn` | Step Functions state machine ARN |
| `/{namePrefix}/strategist-trigger-function-arn` | Trigger Lambda ARN |

### DynamoDB Schema

**Table:** `${namePrefix}-job-strategist`

| Entity | `pk` | `sk` | Key Fields |
|--------|------|------|-----------|
| Metadata | `APPLICATION#<slug>` | `METADATA` | status, fitRating, recommendation, interviewStage |
| Analysis | `APPLICATION#<slug>` | `ANALYSIS#<pipelineId>` | analysisXml, coverLetter, metadata, resumeAdditions |
| Interview | `APPLICATION#<slug>` | `INTERVIEW#<stage>` | interviewPrep (JSON), technicalQuestionCount |

**GSI1 (gsi1-status-date):**
- `gsi1pk`: `APP_STATUS#<status>` — admin listing by status
- `gsi1sk`: `<YYYY-MM-DD>#<slug>` — chronological ordering

## CDK Stack Architecture

The Strategist adds 2 stacks to the Bedrock dependency chain, extending it from 6 to 8:

```
Data → KB → Agent → Api → Content → Pipeline → StrategistData → StrategistPipeline
```

### Infrastructure Highlights

- **Step Functions**: Standard workflow with 3 Lambda task states (ResearchTask, StrategistTask, CoachTask) + PipelineFailed error handler
- **Dead Letter Queue**: SQS DLQ with 14-day retention and SQS-managed SSE encryption
- **Logging**: Step Functions `ALL` log level; 5 CloudWatch log groups (4 Lambdas + 1 state machine)
- **DynamoDB**: PAY_PER_REQUEST billing, point-in-time recovery enabled
- **Tracing**: X-Ray active tracing on all 4 Lambda functions and the state machine
- **Runtime**: Node.js 22.x for all Lambda functions

### Unit Test Coverage

| Test Suite | Tests | Coverage |
|-----------|-------|---------|
| `strategist-data-stack.test.ts` | 23 | DynamoDB schema, GSI, SSM, grants, removal policy |
| `strategist-pipeline-stack.test.ts` | 37 | Lambda config, env vars, SFN, SQS, IAM, SSM |

## Frontend Integration Design

The frontend integration contract is documented in detail at `docs/bedrock/strategist-frontend-design.md`. Key points:

1. **Trigger**: Next.js API route → Lambda SDK invoke (via `STRATEGIST_TRIGGER_ARN` K8s secret)
2. **Read**: DynamoDB Query on `APPLICATION#<slug>` for full detail, GSI1 for listing by status
3. **Status update**: DynamoDB UpdateCommand on METADATA record
4. **K8s wiring**: SSM parameters resolved by `deploy.py` → K8s secrets → Next.js env vars

### Required K8s Secrets (via deploy.py)

| SSM Path | Env Var | Purpose |
|----------|---------|---------|
| `/{namePrefix}/strategist-table-name` | `STRATEGIST_TABLE_NAME` | DynamoDB reads |
| `/{namePrefix}/strategist-trigger-function-arn` | `STRATEGIST_TRIGGER_ARN` | Lambda invoke |

## Transferable Skills Demonstrated

- **Multi-agent AI orchestration** — Designing and implementing a 3-agent pipeline with distinct responsibilities, coordinated by Step Functions with error handling and cost tracking.
- **Career-domain AI application** — Applying LLM capabilities to a real-world career strategy use case: job description analysis, gap identification, and interview preparation.
- **Single-table DynamoDB design** — Implementing a multi-entity schema with composite keys and GSIs for efficient admin listing queries.
- **Truthfulness-first prompt engineering** — Designing system prompts with strict guardrails against fabrication, source citation requirements, and honest gap assessment.
- **Infrastructure testing** — 60 unit tests covering DynamoDB schema, Lambda configuration, Step Functions orchestration, and IAM permissions.

## Summary

This document analyses the Job Strategist multi-agent pipeline — a 3-agent Bedrock application that analyses job descriptions against the candidate's verified experience and produces comprehensive application strategies, tailored cover letters, and stage-specific interview preparation. The pipeline is orchestrated by Step Functions, stores results in DynamoDB with a single-table design, and is deployed as 2 CDK stacks (StrategistData + StrategistPipeline) with 60 unit tests.

## Keywords

bedrock, step-functions, lambda, dynamodb, multi-agent, job-application, interview-coaching, converse-api, knowledge-base, career-strategy, gap-analysis, cover-letter, resume-tailoring, claude, strategist
