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
  - null-safety
  - defensive-parsing
  - cachePoint
  - zod-validation
  - runtime-type-safety
  - error-handling
  - dynamodb-update-item
  - resume-builder
  - s3-offloading
related_docs:
  - ai-ml/bedrock-implementation.md
  - infrastructure/adrs/step-functions-over-lambda-orchestration.md
  - infrastructure/stack-overview.md
last_updated: "2026-04-02"
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
│        ├─ Resume Builder   → Tailored resume JSON generation            │
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
| Research | Haiku 4.5 | Extraction & classification | 8,192 / 4,096 thinking | Cost-efficient for structured data retrieval with Adaptive Thinking support |
| Strategist | Sonnet 4.6 | Complex analysis & writing | 16,384 / 8,192 thinking | Deep reasoning for 5-phase analysis, cover letter crafting, and resume tailoring |
| Resume Builder | Haiku 4.5 | Precision JSON generation | 8,192 / 4,096 thinking | Fast and cost-effective application of Strategist's targeted diffs into the JSON schema |
| Coach | Haiku 4.5 | Conversational preparation | 8,192 / 4,096 thinking | Fast, structured output for interview Q&A and coaching scenarios |

All model IDs are sourced from the centralised `infra/lib/config/shared/model-registry.ts` — when upgrading models, change the constant there and all projects pick up the new identifier. The model selection is intentional: expensive models (Sonnet) are reserved for the phase requiring the deepest reasoning, whilst cheaper models (Haiku) handle extraction and conversational output. This reduces per-pipeline cost by ~60% compared to using Sonnet for all three agents.

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

### Resume Builder Agent — Precision JSON Generation

**Purpose:** Programmatically applies the Strategist's suggested additions and reframes into a strict JSON payload that matches the frontend's expected Resume structure.

```
Input:  Strategist's 5-phase analysis XML + ResumeData + Pipeline Context
Output: Tailored Resume JSON
```

**Implementation details:**

- **Decoupled execution** — Placed in a separate execution step rather than requesting JSON directly from the Strategist, ensuring the Strategist focuses its 16K token budget on reasoning while a cheaper Haiku model formats the JSON.
- **Strict adherence** — Guided by a system persona that aggressively rejects hallucinated JSON fields, strictly mapping to `ResumeAdditionSuggestion[]` and `ResumeReframeSuggestion[]`.

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

### Zod Schema Security Architecture

All handler external boundaries are protected by Zod runtime validation. This eliminates unsafe `as` type assertions on user-supplied data and DynamoDB records:

| Schema | File | Validates |
|--------|------|-----------|
| `TriggerRequestSchema` | `schemas/trigger.schema.ts` | API Gateway request body (discriminated union on `operation`) |
| `StructuredResumeDataSchema` | `schemas/resume-data.schema.ts` | Resume JSON structure from DynamoDB |
| `AnalysisRecordSchema` | `schemas/dynamo-record.schema.ts` | DynamoDB ANALYSIS# record fields |
| `ApplicationMetadataRecordSchema` | `schemas/dynamo-record.schema.ts` | DynamoDB METADATA record structure |
| `FitRatingSchema` | `schemas/dynamo-record.schema.ts` | Enum validation for overallFitRating |
| `ApplicationRecommendationSchema` | `schemas/dynamo-record.schema.ts` | Enum validation for recommendation |
| `TriggerEnvSchema` | `schemas/environment.schema.ts` | Trigger Lambda environment variables |
| `DdbHandlerEnvSchema` | `schemas/environment.schema.ts` | DDB handler environment variables |

**Design principle:** Validate at the boundary, trust internally. All `process.env` reads and DynamoDB record accesses go through Zod schemas that fail fast with descriptive errors on cold start or first access.

### Trigger Handler — Dual-Operation Routing

The single entry point receives requests from the Next.js admin dashboard and routes to the appropriate state machine. Request bodies are validated via `TriggerRequestSchema` — a Zod discriminated union on the `operation` field:

| Operation | State Machine | Required Fields |
|-----------|--------------|-----------------|
| `analyse` | Analysis SM | `jobDescription`, `targetCompany`, `targetRole`, `resumeId` |
| `coach` | Coaching SM | `applicationSlug`, `interviewStage` |

For `analyse`, the trigger handler resolves `resumeId` to full `ResumeData` JSON (Zod-validated via `StructuredResumeDataSchema`), creates the initial METADATA record in DynamoDB (status: `analysing`), generates a URL-safe `applicationSlug`, and starts the Analysis State Machine.

For `coach`, it starts the Coaching State Machine directly — the Coach Loader will fetch the analysis from DynamoDB.

`ZodError` exceptions are caught at the handler level and returned as `400 Bad Request` with structured validation error messages.

### Analysis Persist Handler — Pipeline Terminal Stage

Final Lambda in the Analysis Pipeline. Writes two DynamoDB records:

1. **METADATA update** — Sets `status = 'analysis-ready'`, stores `fitRating`, `recommendation`, cumulative cost/tokens.
2. **ANALYSIS#\<pipelineId\>** — Full versioned record: XML analysis, cover letter, resume suggestions, timestamps.

The pipelineId-based versioning enables comparison across re-analysis iterations — the user can view how their resume strategy improved across runs.

### Coach Loader Handler — DynamoDB Context Fetch

First Lambda in the Coaching Pipeline. Issues a DynamoDB `Query` with `begins_with(sk, 'ANALYSIS#')` and `ScanIndexForward: false` to retrieve the newest analysis record. This ensures coaching always uses the latest resume strategy.

The DynamoDB record is validated via `AnalysisRecordSchema` (Zod) — replacing 8 unsafe `record['field'] as Type` casts with structured validation. Environment variables are validated via `DdbHandlerEnvSchema` on cold start.

Throws a descriptive error if no analysis exists, directing the user to run the `analyse` operation first.

## Application Status Lifecycle

| Status | Written by | Trigger |
|--------|-----------|---------|
| `analysing` | Trigger Lambda | User submits JD (operation='analyse') |
| `failed` | SM DynamoUpdateItem Catch | Any Lambda task error in Analysis or Coaching SM |
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
| Resume Builder Handler | `bedrock-applications/job-strategist/src/handlers/resume-builder-handler.ts` | Resume JSON generation applying suggestions |
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
                                        (→ failed, on any SM task error)
                     → ANALYSIS#<id1>   (versioned — first analysis run)
                     → ANALYSIS#<id2>   (versioned — re-analysis after resume update)
                     → INTERVIEW#phone  (coaching for phone screen stage)
                     → INTERVIEW#onsite (coaching for onsite interview stage)
```

When a Step Functions task fails, the SM Catch block writes `status='failed'` and
`errorMessage` to the METADATA record via a native `DynamoUpdateItem` task before
transitioning to a `Fail` state. The `gsi1pk` is updated to `APP_STATUS#failed`,
enabling GSI queries for all failed applications.

## CDK Stack Architecture

The Strategist adds 2 stacks to the Bedrock dependency chain, extending it from 6 to 8:

```
Data → KB → Agent → Api → Content → Pipeline → StrategistData → StrategistPipeline
```

### Infrastructure Highlights

- **Step Functions**: 2 Standard workflows — Analysis SM (4 Lambda tasks: Research, Strategist, ResumeBuilder, AnalysisPersist) and Coaching SM (2 Lambda tasks: CoachLoader, Coach)
- **Lambda count**: 7 functions (trigger, research, strategist, resume-builder, analysis-persist, coach-loader, coach)
- **Dead Letter Queue**: SQS DLQ with 14-day retention and SQS-managed SSE encryption
- **Logging**: Step Functions `ALL` log level; 8 CloudWatch log groups (7 Lambdas + 1 shared SM log group)
- **DynamoDB**: PAY_PER_REQUEST billing, point-in-time recovery enabled
- **Tracing**: X-Ray active tracing on all 7 Lambda functions and both state machines
- **Runtime**: Node.js 22.x for all Lambda functions

### Unit Test Coverage

| Test Suite | Tests | Coverage |
|-----------|-------|---------|
| `strategist-data-stack.test.ts` | 23 | DynamoDB schema, GSI, SSM, grants, removal policy |
| `strategist-pipeline-stack.test.ts` | 48 | 7 Lambdas, 2 SMs, env vars, SQS, IAM, 3 SSM params, DDB error handlers |

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
| Agents | Research → Writer → QA (3) | Research → Strategist → ResumeBuilder + AnalysisPersist / CoachLoader → Coach |
| Iteration model | One-shot per article | Iterative — analyse N times, coach M times |
| Output | MDX article + S3 artefacts | XML analysis + cover letter + interview prep |
| DynamoDB | 2 records (METADATA + CONTENT) | 3+ records (METADATA + ANALYSIS# + INTERVIEW#) |
| Frontend action | Approve/Reject | Operation selection (analyse/coach) + status lifecycle |
| API Gateway | Not used (S3 event) | Not used (Lambda SDK invoke) |

## Troubleshooting

### Step Functions payload limit exceeded (256 KB)

**What happened:** The Step Functions pipeline failed between states (e.g., between Strategist and Resume Builder, or Persist) with a StateMachine execution error regarding payload size limits.

**Why:** AWS Step Functions has a hard 256 KB limit for payload state passed between tasks. Large textual inputs like `jobDescription`, `resumeData`, and the full generated text of previous agents (like the AI-generated `tailoredResume` JSON) were inflating the JSON payload pushed between handlers as they progressed down the chain.

**Fix:** Implemented a two-pronged approach for payload management:
1. **Payload Trimming:** Large string buffers that are no longer needed by downstream stages are replaced with short sentinel values (e.g., `'[trimmed — persisted in METADATA]'`) or stripped entirely by returning `null` or a trimmed context object in Lambda handlers (`strategist-handler.ts`, `resume-builder-handler.ts`).
2. **S3 Offloading for Large Results:** The Strategist agent outputs a very large XML blob (`analysisXml`) which often exceeds 200KB alone. This blob is now offloaded directly to an S3 `assetsBucket` by the `strategist-handler.ts`, replacing the payload string with the S3 URI (`s3://<bucket>/<key>`). Downstream handlers like `analysis-persist-handler.ts` pull directly from S3 when writing the final DynamoDB record instead of receiving it through the Step Functions payload.

### Invalid `SystemContentBlock` cachePoint format crashes Bedrock SDK

**What happened:** The Analysis Pipeline Step Function failed at `ResearchTask` with `AgentExecutionError: Cannot read properties of undefined (reading '0')`. The DynamoDB METADATA record was permanently stuck at `"analysing"` because the pipeline never reached the Analysis Persist step.

**Why:** All persona files (except `blog-persona.ts`) constructed the Bedrock prompt caching block incorrectly. They used the `guardContent` union member (intended for guardrails) paired with `as unknown as SystemContentBlock` double-casts to construct cachePoint directives:

```typescript
// ❌ WRONG — guardContent is for guardrails, not caching
{ guardContent: { type: 'cachePoint' } } as unknown as SystemContentBlock
```

The `as unknown as` cast masked the TypeScript error, allowing the invalid payload to compile. When the Bedrock SDK serialised this malformed block, it crashed internally during request construction — the `[0]` in the error referred to the SDK's internal array access on the corrupted content blocks.

**Fix:** Replace all occurrences with the correct `cachePoint` union member:

```typescript
// ✅ CORRECT — cachePoint is its own union member
{ cachePoint: { type: 'default' } } as SystemContentBlock
```

Affected files: `research-persona.ts`, `strategist-persona.ts`, `coach-persona.ts` (job-strategist), `research-persona.ts`, `qa-persona.ts` (article-pipeline).

**Anti-pattern lesson:** Never use `as unknown as SdkType` to construct AWS SDK request objects. This suppresses both the TypeScript compiler and the SDK's discriminated union validation.

---

### Incomplete LLM response crashes downstream agent with `undefined` property access

**What happened:** When the Bedrock Knowledge Base returned empty results for a job description query, the LLM generated incomplete JSON (missing `technologyInventory` and other nested objects). The `strategist-agent.ts` then crashed accessing `research.technologyInventory.languages.join(', ')` on the undefined object.

**Why:** The `parseJsonResponse<T>()` function in `shared/src/agent-runner.ts` uses an unsafe `as T` cast. It does not validate that the parsed JSON actually matches the expected type shape. When the LLM omits nested objects, the cast succeeds but downstream property access fails at runtime.

**Fix:** Two layers of defence were applied:

1. **Parsing boundary** (`research-agent.ts` `parseResponse` callback): Added defensive defaults for all nested objects and scalar fields, ensuring the agent always returns a structurally valid `StrategistResearchResult`.

2. **Downstream consumer** (`strategist-agent.ts`): Added optional chaining and null-coalescing when accessing `technologyInventory` properties:

```typescript
// Safe access pattern
const techInv = research.technologyInventory;
`Languages: ${(techInv?.languages ?? []).join(', ') || 'None specified'}`;
```

**Design principle:** Always provide defaults at the `parseResponse` boundary for any LLM-generated JSON, and add secondary safety guards in downstream consumers.

---

### Wrong relative import depth breaks cross-package type resolution

**What happened:** TypeScript compilation of `qa-legacy-bridge.ts` failed with `Cannot find module '../../shared/src/types.js'`. The error affected all four `../../shared/src/` imports in the file.

**Why:** The file is at `article-pipeline/src/agents/` — 3 directories below `bedrock-applications/`. The imports used `../../` (2 levels up, resolving to `article-pipeline/shared/src/`) instead of `../../../` (3 levels up, resolving to the correct `bedrock-applications/shared/src/`). Every other file in `src/agents/` and `src/handlers/` correctly used `../../../`.

**Fix:** Updated all four import paths from `../../shared/src/` to `../../../shared/src/`. Also wrapped the `QA_MODEL` environment variable access in a `requireQaModel()` validation function to ensure TypeScript narrows the type to `string` (not `string | undefined`).

---

### Deprecated Haiku 3.5 model identifier causes Bedrock AgentExecutionError

**What happened:** Bedrock `AgentExecutionError` failures on Article Pipeline Research and Job Strategist Research agents after EU cross-region inference profile validation was tightened.

**Why:** The model registry contained `CLAUDE_HAIKU_3_5 = 'eu.anthropic.claude-haiku-3-5-20241022-v1:0'` which is not a valid EU cross-region inference profile. The identifier was used by `ARTICLE_RESEARCH` and `JOB_STRATEGIST_RESEARCH` role assignments.

**Fix:** Removed `CLAUDE_HAIKU_3_5` entirely from `model-registry.ts`. Migrated both Research agent role assignments to `CLAUDE_HAIKU_4_5` (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`), which has a verified EU cross-region inference profile. Removed the stale Haiku 3.5 pricing entry from `shared/src/metrics.ts`.

---

### Pipeline failures leave DDB METADATA stuck at processing/analysing

**What happened:** When any Lambda task (Research, Strategist, Coach, etc.) threw an error during Step Functions execution, the SM caught the error and transitioned to a `Fail` state, but the DynamoDB METADATA record was never updated. The record remained permanently stuck at its last status (`processing`, `analysing`, `coaching`), causing the frontend polling to time out.

**Why:** The original SM definition had Catch blocks that routed directly to `Fail` states without writing error status to DynamoDB first. The frontend relied on DDB polling for status updates, so a SM-level failure was invisible to the user.

**Fix:** Implemented SF-native `Catch → DynamoUpdateItem → Fail` chains on all three state machines (Article Pipeline, Analysis SM, Coaching SM). Each `DynamoUpdateItem` task writes `status='failed'`, `errorMessage` (from `$.error.Cause`), and specifically both GSI keys (`gsi1pk = APP_STATUS#failed`, `gsi1sk = <YYYY-MM-DD>#<slug>`) to the METADATA record before the SM enters the `Fail` state. DynamoDB GSIs require both the partition key and sort key to project an item into the index, so writing just `gsi1pk` leaves the failed record invisible to the frontend. Uses `resultPath: '$.error'` to preserve original pipeline context for dynamic DDB key resolution. Zero additional Lambdas — fully infrastructure-level error handling.

Affected files: `pipeline-stack.ts`, `strategist-pipeline-stack.ts`, `strategist-pipeline-stack.test.ts` (3 new test assertions).

## Transferable Skills Demonstrated

- **Iterative multi-agent AI orchestration** — Designing a two-pipeline architecture where analysis and coaching execute independently, enabling iterative refinement at each application lifecycle stage.
- **Career-domain AI application** — Applying LLM capabilities to a real-world career strategy use case: job description analysis, gap identification, resume tailoring, and stage-specific interview preparation.
- **Model selection optimisation** — Strategic assignment of Claude variants (Haiku 4.5 for extraction, Sonnet 4.6 for reasoning, Haiku 4.5 for coaching) to balance cost and quality across agents, sourced from a centralised model registry.
- **Truthfulness-first prompt engineering** — Designing system prompts with strict guardrails against fabrication, source citation requirements, honest gap assessment, and override-if-true framing.
- **Single-table DynamoDB design** — Implementing a multi-entity schema with composite keys and GSIs for efficient admin listing, with versioned analysis records for iteration comparison.
- **Infrastructure testing** — 68 unit tests covering DynamoDB schema, Lambda configuration, Step Functions orchestration, and IAM permissions across both stacks.
- **Defensive LLM response parsing** — Implementing belt-and-braces null-safety at both the parsing boundary and downstream consumers to handle incomplete or malformed AI-generated JSON.
- **Zod boundary validation** — Eliminating unsafe `as` casts on all external data boundaries (API Gateway, DynamoDB, environment variables) with fail-fast Zod schemas that produce descriptive error messages.

## Summary

This document analyses the Job Strategist multi-agent pipeline — an iterative, stage-driven AI application that uses two independent Step Functions state machines to separate resume analysis from interview coaching. The Analysis Pipeline (Research → Strategist → AnalysisPersist) produces comprehensive application strategies using a 5-phase framework. The Coaching Pipeline (CoachLoader → Coach) generates stage-specific interview preparation by loading existing analysis from DynamoDB. Two Claude models (Haiku 4.5 for research/coaching, Sonnet 4.6 for strategy) are strategically assigned from a centralised model registry based on reasoning requirements. All handler external boundaries are Zod-validated — no unsafe `as` casts on user input, DynamoDB records, or environment variables. Both SMs use SF-native DynamoUpdateItem error handlers that write `status='failed'` to DDB on any task failure, ensuring the frontend immediately reflects pipeline errors. The pipeline is deployed as 2 CDK stacks (StrategistData + StrategistPipeline) with 6 Lambda functions, 71 unit tests, and 5 SSM parameter exports wired to the Next.js frontend via K8s secrets.

## Keywords

bedrock, step-functions, lambda, dynamodb, multi-agent, job-application, interview-coaching, converse-api, knowledge-base, career-strategy, gap-analysis, cover-letter, resume-tailoring, claude, strategist, iterative-pipeline, two-pipeline, analysis-persist, coach-loader, prompt-engineering, extended-thinking, haiku, sonnet, null-safety, defensive-parsing, cachePoint, system-content-block, zod, runtime-validation, model-registry, import-path-resolution, error-handling, dynamodb-update-item, catch-handler, fail-fast
