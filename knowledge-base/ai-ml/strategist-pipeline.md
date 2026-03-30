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
  - iterative-pipeline
  - prompt-engineering
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

The Job Strategist is an **iterative, stage-driven AI pipeline** built on AWS Bedrock and Step Functions. Unlike the monolithic Article Pipeline (which runs all agents in one pass), the Strategist decomposes the career strategy workflow into **two independent state machines** that the user triggers at different points in the application lifecycle.

### Two-Pipeline Design

```
┌─────────────────────────── ANALYSIS PIPELINE ───────────────────────────┐
│  Trigger Lambda (operation='analyse')                                   │
│    └─ Step Functions: Analysis State Machine                            │
│        ├─ Research Agent   → KB retrieval, resume parsing, gap analysis │
│        ├─ Strategist Agent → 5-phase analysis, cover letter, resume     │
│        └─ Analysis Persist → METADATA + ANALYSIS#{pipelineId} → DDB    │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────── COACHING PIPELINE ───────────────────────────┐
│  Trigger Lambda (operation='coach')                                     │
│    └─ Step Functions: Coaching State Machine                            │
│        ├─ Coach Loader    → Load latest ANALYSIS# from DDB             │
│        └─ Coach Agent     → Stage-specific interview prep → DDB        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Two Pipelines, Not One

The monolithic approach (`Research → Strategist → Coach` in a single execution) forced the user to run all three agents every time, regardless of which stage they were at. In reality:

1. **Application stage**: You only need resume analysis and tailoring — no interview prep yet.
2. **Interview stage**: You need coaching based on the *existing* analysis — no need to re-run research.
3. **Re-analysis**: You may refine the resume multiple times before ever getting an interview.

Separating into two state machines enables **independent iterations**: run analysis N times, then coaching M times per interview stage, without coupling the two concerns.

### Iterative Stage Progression

```
User submits JD + Resume
  └─ operation='analyse' → Analysis SM → METADATA(status='analysing')
      └─ Pipeline completes → METADATA(status='analysis-ready')
          ├─ Review results, iterate (re-run 'analyse' if needed)
          └─ Get interview invitation
              └─ operation='coach', interviewStage='phone' → Coaching SM
                  └─ METADATA(status='interviewing') + INTERVIEW#phone
                      └─ Advance stage
                          └─ operation='coach', interviewStage='onsite' → Coaching SM
                              └─ INTERVIEW#onsite record appended
```

Each coaching iteration builds on the previous analysis — the Coach Loader fetches the latest `ANALYSIS#` record from DynamoDB, so the coaching agent always has full context without re-running research.

## AI Implementation Design

### Agent Separation Strategy

Each agent has a distinct reasoning requirement that maps to a specific Claude model:

| Agent | Model | Reasoning Profile | Token Budget | Why This Model |
|-------|-------|--------------------|-------------|----------------|
| Research | Haiku 3.5 | Extraction & classification | 8,192 / 4,096 thinking | Cost-efficient for structured data retrieval — no creative reasoning needed |
| Strategist | Sonnet 4.6 | Complex analysis & writing | 16,384 / 8,192 thinking | Deep reasoning for 5-phase analysis, cover letter crafting, and resume tailoring |
| Coach | Haiku 4.5 | Conversational preparation | 8,192 / 4,096 thinking | Fast, structured output for interview Q&A and coaching scenarios |

The model selection is intentional: expensive models (Sonnet) are reserved for the phase requiring the deepest reasoning, whilst cheaper models (Haiku) handle extraction and conversational output. This reduces per-pipeline cost by ~60% compared to using Sonnet for all three agents.

### Research Agent — KB Retrieval & Gap Analysis

**Purpose:** Gather ground truth about the candidate before any strategic reasoning.

```
Input:  Job Description + Resume JSON + Pipeline Context
Output: StructuredResumeData + Gap Analysis + KB Portfolio Evidence
```

**Implementation details:**

1. **Pinecone KB retrieval** — Queries the Bedrock Knowledge Base (Pinecone-backed) with up to 15 passages relevant to the role. This provides verified portfolio and project evidence for the Strategist to reference.
2. **Resume formatting** — Converts the structured `ResumeData` JSON into a prompt-friendly format via `formatResumeForPrompt()`, preserving section hierarchy.
3. **Input sanitisation** — All user-provided text (JD, resume fields) is passed through `sanitiseInput()` to strip prompt injection attempts before reaching the model.
4. **Skill classification** — The Research persona classifies each JD requirement as `verified` (backed by KB evidence), `partial` (some evidence), or `gap` (no evidence). This tripartite classification drives the Strategist's honest assessment.

### Strategist Agent — 5-Phase Analysis & Document Generation

**Purpose:** The core reasoning engine. Produces the comprehensive application strategy.

```
Input:  Research Brief + Full Resume + Pipeline Context
Output: XML Analysis + Cover Letter + Resume Suggestions
```

**5-Phase analysis framework:**

| Phase | Name | Output |
|-------|------|--------|
| 1 | JD Deconstruction | Structured breakdown of all role requirements |
| 2 | Gap Analysis | Honest mapping: verified skills, partial matches, genuine gaps |
| 3 | Positioning Strategy | How to frame each skill/gap for maximum impact |
| 4 | Cover Letter | Tailored letter with evidence-backed claims |
| 5 | Resume Tailoring | Per-bullet suggestions: additions, reframes, ESL corrections |

**Key design decisions:**

- **XML output** — The Strategist produces a comprehensive XML document rather than JSON. XML preserves section hierarchy better for long-form content whilst remaining machine-parseable. The `sanitiseOutput()` step validates well-formedness.
- **Extended thinking** — Sonnet 4.6 is configured with an 8,192-token thinking budget. The model uses this internal scratchpad to reason about gap analysis and positioning before producing output. This is critical for the nuanced "truthful but positive" framing requirement.
- **Resume suggestions schema** — Output includes typed arrays: `ResumeAdditionSuggestion[]` (new bullets to add), `ResumeReframeSuggestion[]` (existing bullets to rephrase), and `ResumeEslCorrection[]` (grammar/style fixes). Each includes `section`, `index`, and specific before/after text.

### Coach Agent — Stage-Specific Interview Preparation

**Purpose:** Generate interview coaching tailored to the specific stage (phone, onsite, panel, etc.).

```
Input:  Latest Analysis Record + Pipeline Context (with interviewStage)
Output: Structured Interview Prep JSON (questions, scenarios, talking points)
```

**Implementation details:**

- **Context reuse** — Does *not* re-run research. The Coach Loader fetches the latest `ANALYSIS#` record from DynamoDB, providing full JD, gap analysis, and positioning strategy as context.
- **Stage awareness** — The `interviewStage` parameter (`phone | technical | onsite | panel | final`) drives different coaching prompts: phone screens focus on elevator pitches and salary expectations; onsite sessions focus on system design and behavioural STAR responses.
- **Coaching-only persistence** — The Coach Handler writes only `INTERVIEW#<stage>` records and updates METADATA status to `interviewing`. It does *not* modify the `ANALYSIS#` record.

### Prompt Engineering Principles

All three agents enforce strict guardrails:

1. **Truthfulness mandate** — Never fabricate skills or experience. If a gap exists, it must be honestly acknowledged with a mitigation strategy, not hidden.
2. **Source citation** — Every claim about the candidate's experience must trace back to a Research Agent finding or resume entry. No hallucinated credentials.
3. **Override-if-true framing** — When the AI identifies a skill gap, the prompt instructs it to frame this as "KB evidence suggests this is a gap — override if you have this skill and have implemented it". This respects the user's authority over their own career data.
4. **Cost-bounded output** — Each agent has explicit max token limits to prevent runaway costs. The Research Agent is capped at 8K tokens; the Strategist at 16K.

## Handler Decomposition

### Trigger Handler — Dual-Operation Routing

The single entry point receives requests from the Next.js admin dashboard and routes to the appropriate state machine:

| Operation | State Machine | Required Fields |
|-----------|--------------|-----------------|
| `analyse` | Analysis SM | `jobDescription`, `targetCompany`, `targetRole`, `resumeId` |
| `coach` | Coaching SM | `applicationSlug`, `interviewStage` |

For `analyse`, the trigger handler resolves `resumeId` to full `ResumeData` JSON, creates the initial METADATA record in DynamoDB (status: `analysing`), generates a URL-safe `applicationSlug`, and starts the Analysis State Machine.

For `coach`, it starts the Coaching State Machine directly — the Coach Loader will fetch the analysis from DynamoDB.

### Analysis Persist Handler — Pipeline Terminal Stage

Final Lambda in the Analysis Pipeline. Writes two DynamoDB records:

1. **METADATA update** — Sets `status = 'analysis-ready'`, stores `fitRating`, `recommendation`, cumulative cost/tokens.
2. **ANALYSIS#\<pipelineId\>** — Full versioned record: XML analysis, cover letter, resume suggestions, timestamps.

The pipelineId-based versioning enables comparison across re-analysis iterations — the user can view how their resume strategy improved across runs.

### Coach Loader Handler — DynamoDB Context Fetch

First Lambda in the Coaching Pipeline. Issues a DynamoDB `Query` with `begins_with(sk, 'ANALYSIS#')` and `ScanIndexForward: false` to retrieve the newest analysis record. This ensures coaching always uses the latest resume strategy.

Throws a descriptive error if no analysis exists, directing the user to run the `analyse` operation first.

## Application Status Lifecycle

| Status | Written by | Trigger |
|--------|-----------|---------|
| `analysing` | Trigger Lambda | User submits JD (operation='analyse') |
| `analysis-ready` | Analysis Persist Handler | Analysis Pipeline completes |
| `interviewing` | Coach Handler | User requests coaching (operation='coach') |
| `applied` | Admin action | Application submitted |
| `offer-received` | Admin action | Offer extended |
| `accepted` | Admin action | Offer accepted |
| `rejected` | Admin action | Application rejected |
| `withdrawn` | Admin action | Application withdrawn |

## Key Components

| Component | File | Purpose |
|---|---|---|
| Trigger Handler | `bedrock-applications/job-strategist/src/handlers/trigger-handler.ts` | Dual-operation routing → Analysis SM or Coaching SM |
| Research Handler | `bedrock-applications/job-strategist/src/handlers/research-handler.ts` | KB retrieval + resume parsing + gap analysis |
| Strategist Handler | `bedrock-applications/job-strategist/src/handlers/strategist-handler.ts` | 5-phase analysis + cover letter + resume tailoring |
| Analysis Persist | `bedrock-applications/job-strategist/src/handlers/analysis-persist-handler.ts` | DynamoDB writes: METADATA + ANALYSIS# records |
| Coach Loader | `bedrock-applications/job-strategist/src/handlers/coach-loader-handler.ts` | Load latest ANALYSIS# from DDB for coaching context |
| Coach Handler | `bedrock-applications/job-strategist/src/handlers/coach-handler.ts` | Stage-specific coaching + INTERVIEW# DDB writes |
| Research Agent | `bedrock-applications/job-strategist/src/agents/research-agent.ts` | Bedrock Converse API + KB Retrieve |
| Strategist Agent | `bedrock-applications/job-strategist/src/agents/strategist-agent.ts` | Extended thinking + XML output generation |
| Coach Agent | `bedrock-applications/job-strategist/src/agents/coach-agent.ts` | Stage-specific interview preparation |
| Shared Types | `bedrock-applications/shared/src/strategist-types.ts` | Pipeline context, agent results, DDB entity shapes |
| Strategist Persona | `infra/lib/config/bedrock/strategist-persona.ts` | System prompts for all 3 agents |
| Data Stack | `infra/lib/stacks/bedrock/strategist-data-stack.ts` | DynamoDB table + GSI + SSM exports |
| Pipeline Stack | `infra/lib/stacks/bedrock/strategist-pipeline-stack.ts` | 2 Step Functions + 6 Lambdas + SQS DLQ |
| Allocations | `infra/lib/config/bedrock/strategist-allocations.ts` | Model IDs + memory/timeout per environment |
| Configurations | `infra/lib/config/bedrock/strategist-configurations.ts` | Stack configuration per environment |

### SSM Parameter Exports

| SSM Path | Value | Consumed by |
|----------|-------|-------------|
| `/{namePrefix}/strategist-table-name` | DynamoDB table name | Frontend (K8s secret) |
| `/{namePrefix}/strategist-table-arn` | DynamoDB table ARN | CDK grants only |
| `/{namePrefix}/strategist-analysis-state-machine-arn` | Analysis Pipeline SM ARN | Trigger Lambda env var only |
| `/{namePrefix}/strategist-coaching-state-machine-arn` | Coaching Pipeline SM ARN | Trigger Lambda env var only |
| `/{namePrefix}/strategist-trigger-function-arn` | Trigger Lambda ARN | Frontend (K8s secret) |

### DynamoDB Schema

**Table:** `${namePrefix}-job-strategist`

| Entity | `pk` | `sk` | Key Fields |
|--------|------|------|-----------|
| Metadata | `APPLICATION#<slug>` | `METADATA` | status, fitRating, recommendation, interviewStage |
| Analysis | `APPLICATION#<slug>` | `ANALYSIS#<pipelineId>` | analysisXml, coverLetter, metadata, resumeSuggestions |
| Interview | `APPLICATION#<slug>` | `INTERVIEW#<stage>` | interviewPrep (JSON), technicalQuestionCount |

**GSI1 (gsi1-status-date):**
- `gsi1pk`: `APP_STATUS#<status>` — admin listing by status
- `gsi1sk`: `<YYYY-MM-DD>#<slug>` — chronological ordering

### DynamoDB Record Lifecycle

```
APPLICATION#acme-sre → METADATA        (analysing → analysis-ready → interviewing)
                     → ANALYSIS#<id1>   (versioned — first analysis run)
                     → ANALYSIS#<id2>   (versioned — re-analysis after resume update)
                     → INTERVIEW#phone  (coaching for phone screen stage)
                     → INTERVIEW#onsite (coaching for onsite interview stage)
```

## CDK Stack Architecture

The Strategist adds 2 stacks to the Bedrock dependency chain, extending it from 6 to 8:

```
Data → KB → Agent → Api → Content → Pipeline → StrategistData → StrategistPipeline
```

### Infrastructure Highlights

- **Step Functions**: 2 Standard workflows — Analysis SM (3 Lambda tasks: Research, Strategist, AnalysisPersist) and Coaching SM (2 Lambda tasks: CoachLoader, Coach)
- **Lambda count**: 6 functions (trigger, research, strategist, analysis-persist, coach-loader, coach)
- **Dead Letter Queue**: SQS DLQ with 14-day retention and SQS-managed SSE encryption
- **Logging**: Step Functions `ALL` log level; 7 CloudWatch log groups (6 Lambdas + 1 shared SM log group)
- **DynamoDB**: PAY_PER_REQUEST billing, point-in-time recovery enabled
- **Tracing**: X-Ray active tracing on all 6 Lambda functions and both state machines
- **Runtime**: Node.js 22.x for all Lambda functions

### Unit Test Coverage

| Test Suite | Tests | Coverage |
|-----------|-------|---------|
| `strategist-data-stack.test.ts` | 23 | DynamoDB schema, GSI, SSM, grants, removal policy |
| `strategist-pipeline-stack.test.ts` | 45 | 6 Lambdas, 2 SMs, env vars, SQS, IAM, 3 SSM params |

## Frontend Integration Design

The frontend integration contract is documented in detail at `docs/bedrock/strategist-frontend-design.md`. Key points:

1. **Trigger**: Next.js API route → Lambda SDK invoke (via `STRATEGIST_TRIGGER_ARN` K8s secret) with `operation` field
2. **Read**: DynamoDB Query on `APPLICATION#<slug>` for full detail, GSI1 for listing by status
3. **Status update**: DynamoDB UpdateCommand on METADATA record
4. **K8s wiring**: SSM parameters resolved by `deploy.py` → K8s secrets → Next.js env vars

### Required K8s Secrets (via deploy.py)

| SSM Path | Env Var | Purpose |
|----------|---------|----------|
| `/{namePrefix}/strategist-table-name` | `STRATEGIST_TABLE_NAME` | DynamoDB reads + status polling |
| `/{namePrefix}/strategist-trigger-function-arn` | `STRATEGIST_TRIGGER_ARN` | Lambda invoke (start pipelines) |

> **Note:** The SM ARN SSM parameters (`strategist-analysis-state-machine-arn`, `strategist-coaching-state-machine-arn`) are **not** wired to the frontend. They are consumed only by the trigger Lambda's environment variables. The frontend polls pipeline status via **DynamoDB `METADATA.status`** rather than `SFN DescribeExecution`, keeping the frontend's IAM surface minimal (DynamoDB + Lambda invoke only).

### API Contract

**Analyse Operation:**
```json
POST /api/admin/strategist
{
  "operation": "analyse",
  "jobDescription": "...",
  "targetCompany": "Acme Corp",
  "targetRole": "Senior SRE",
  "resumeId": "resume-v2"
}
```

**Coach Operation:**
```json
POST /api/admin/strategist
{
  "operation": "coach",
  "applicationSlug": "acme-corp-senior-sre",
  "interviewStage": "phone"
}
```

## Comparison with Article Pipeline

| Aspect | Article Pipeline | Job Strategist |
|--------|-----------------|---------------|
| Trigger | S3 event notification (`drafts/*.md`) | Direct Lambda invoke (admin POST) |
| State Machines | 1 (linear) | 2 (Analysis + Coaching) |
| Agents | Research → Writer → QA (3) | Research → Strategist + AnalysisPersist / CoachLoader → Coach |
| Iteration model | One-shot per article | Iterative — analyse N times, coach M times |
| Output | MDX article + S3 artefacts | XML analysis + cover letter + interview prep |
| DynamoDB | 2 records (METADATA + CONTENT) | 3+ records (METADATA + ANALYSIS# + INTERVIEW#) |
| Frontend action | Approve/Reject | Operation selection (analyse/coach) + status lifecycle |
| API Gateway | Not used (S3 event) | Not used (Lambda SDK invoke) |

## Transferable Skills Demonstrated

- **Iterative multi-agent AI orchestration** — Designing a two-pipeline architecture where analysis and coaching execute independently, enabling iterative refinement at each application lifecycle stage.
- **Career-domain AI application** — Applying LLM capabilities to a real-world career strategy use case: job description analysis, gap identification, resume tailoring, and stage-specific interview preparation.
- **Model selection optimisation** — Strategic assignment of Claude variants (Haiku 3.5 for extraction, Sonnet 4.6 for reasoning, Haiku 4.5 for coaching) to balance cost and quality across agents.
- **Truthfulness-first prompt engineering** — Designing system prompts with strict guardrails against fabrication, source citation requirements, honest gap assessment, and override-if-true framing.
- **Single-table DynamoDB design** — Implementing a multi-entity schema with composite keys and GSIs for efficient admin listing, with versioned analysis records for iteration comparison.
- **Infrastructure testing** — 68 unit tests covering DynamoDB schema, Lambda configuration, Step Functions orchestration, and IAM permissions across both stacks.

## Summary

This document analyses the Job Strategist multi-agent pipeline — an iterative, stage-driven AI application that uses two independent Step Functions state machines to separate resume analysis from interview coaching. The Analysis Pipeline (Research → Strategist → AnalysisPersist) produces comprehensive application strategies using a 5-phase framework. The Coaching Pipeline (CoachLoader → Coach) generates stage-specific interview preparation by loading existing analysis from DynamoDB. Three Claude models (Haiku 3.5, Sonnet 4.6, Haiku 4.5) are strategically assigned based on reasoning requirements. The pipeline is deployed as 2 CDK stacks (StrategistData + StrategistPipeline) with 6 Lambda functions, 68 unit tests, and 5 SSM parameter exports wired to the Next.js frontend via K8s secrets.

## Keywords

bedrock, step-functions, lambda, dynamodb, multi-agent, job-application, interview-coaching, converse-api, knowledge-base, career-strategy, gap-analysis, cover-letter, resume-tailoring, claude, strategist, iterative-pipeline, two-pipeline, analysis-persist, coach-loader, prompt-engineering, extended-thinking, haiku, sonnet
