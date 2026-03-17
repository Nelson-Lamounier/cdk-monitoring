# Bedrock Article Generation Pipeline

> Agentic content supply chain: drop a `.md` into S3, receive a polished `.mdx` blog post with AI-enhanced metadata, versioned content, and a Director's Shot List — all fully automated.

---

## Architecture

```
S3 (drafts/*.md)
  │
  ├─ Event Notification ─► Lambda (ai-publisher)
  │                           │
  │                           ├─ 1. Read draft
  │                           ├─ 2. Analyse complexity (LOW/MID/HIGH)
  │                           ├─ 3. Call Bedrock Converse API (Claude 4.6 Sonnet)
  │                           │     ├── Prompt Caching (cachePoint)
  │                           │     └── Adaptive Thinking (budget_tokens)
  │                           ├─ 4. Parse JSON → MDX + metadata + shotList
  │                           ├─ 5. Write to S3 (published/ + content/v_<ISO>/)
  │                           ├─ 6. Write to DynamoDB (METADATA + CONTENT#v_<ISO>)
  │                           └─ 7. Trigger ISR revalidation (optional)
  │
  ├─ published/{slug}.mdx    ← latest version (consumer reads this)
  └─ content/v_{ISO}/{slug}.mdx  ← immutable version snapshot
```

---

## Stack Topology

| Stack | Responsibility | Key Resources |
|---|---|---|
| `BedrockDataStack` | Stateful data layer | S3 bucket, access logs bucket, optional KMS key |
| `BedrockAgentStack` | AI agent core | Bedrock Agent, Guardrail, Action Group Lambda, Agent Alias |
| `BedrockApiStack` | HTTP frontend | API Gateway, invoke Lambda, API key + usage plan |
| `AiContentStack` | Content pipeline | Publisher Lambda, DynamoDB (Global Table V2), SQS DLQ |

All stacks are orchestrated by `BedrockProjectFactory` which resolves per-environment allocations and configurations.

---

## Module Documentation (AG-DOC-01)

---

### BedrockDataStack
* **Objective:** Stateful S3 bucket and access logs for the Bedrock Knowledge Base data source.

* **Interface:**

| Input Prop | Type | Description |
|---|---|---|
| `namePrefix` | `string` | Resource naming prefix (e.g. `bedrock-development`) |
| `createEncryptionKey` | `boolean` | Whether to create a customer-managed KMS key |
| `removalPolicy` | `RemovalPolicy` | Bucket retention behaviour on stack deletion |

| Output | Type | SSM Path |
|---|---|---|
| `dataBucket` | `s3.Bucket` | — |
| `bucketName` | `string` | `/{namePrefix}/kb-bucket-name` |
| `bucketArn` | `string` | `/{namePrefix}/kb-bucket-arn` |

* **Flight Path:**
```typescript
const data = new BedrockDataStack(app, 'Data', {
    namePrefix: 'bedrock-development',
    createEncryptionKey: false,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
});
// Downstream: data.bucketName → AiContentStack
```

---

### BedrockAgentStack
* **Objective:** Creates the Bedrock Agent with Guardrail, Action Group Lambda, and a stable Agent Alias for invocations.

* **Interface:**

| Input Prop | Type | Description |
|---|---|---|
| `namePrefix` | `string` | Resource naming prefix |
| `foundationModel` | `string` | Model ID (e.g. `anthropic.claude-sonnet-4-6-20260310-v1:0`) |
| `agentInstruction` | `string` | System prompt for the agent |
| `enableContentFilters` | `boolean` | Whether guardrail content filters are active |
| `actionGroupLambdaMemoryMb` | `number` | Action Group handler memory (MB) |
| `actionGroupLambdaTimeoutSeconds` | `number` | Action Group handler timeout (s) |

| Output | Type | SSM Path |
|---|---|---|
| `agentId` | `string` | `/{namePrefix}/agent-id` |
| `agentAliasId` | `string` | `/{namePrefix}/agent-alias-id` |
| `agentArn` | `string` | `/{namePrefix}/agent-arn` |

* **Flight Path:**
```typescript
const agent = new BedrockAgentStack(app, 'Agent', {
    namePrefix: 'bedrock-development',
    foundationModel: 'anthropic.claude-sonnet-4-6-20260310-v1:0',
    agentInstruction: 'You are an infrastructure assistant...',
    enableContentFilters: true,
    // ...other props from allocations + configurations
});
```

---

### AiContentStack
* **Objective:** Event-driven MD-to-Blog pipeline that transforms raw markdown drafts into polished MDX posts using Claude 4.6 Sonnet via the Bedrock Converse API.

* **Interface:**

| Input Prop | Type | Description |
|---|---|---|
| `namePrefix` | `string` | Resource naming prefix |
| `assetsBucketName` | `string` | S3 bucket name from DataStack |
| `draftPrefix` | `string` | S3 key prefix for draft files (e.g. `drafts/`) |
| `publishedPrefix` | `string` | S3 key prefix for published MDX (e.g. `published/`) |
| `contentPrefix` | `string` | S3 key prefix for versioned blobs (e.g. `content/`) |
| `foundationModel` | `string` | Bedrock model ID |
| `maxTokens` | `number` | Response token ceiling |
| `thinkingBudgetTokens` | `number` | Adaptive Thinking token budget |
| `lambdaMemoryMb` | `number` | Publisher Lambda memory (MB) |
| `lambdaTimeoutSeconds` | `number` | Publisher Lambda timeout (s) |

| Output | Type | SSM Path |
|---|---|---|
| `contentTable` | `dynamodb.TableV2` | `/{namePrefix}/content-table-name` |
| `publisherFunction` | `NodejsFunction` | `/{namePrefix}/publisher-function-name` |

* **Flight Path:**
```typescript
const content = new AiContentStack(app, 'Content', {
    namePrefix: 'bedrock-development',
    assetsBucketName: data.bucketName, // from DataStack
    draftPrefix: 'drafts/',
    foundationModel: 'anthropic.claude-sonnet-4-6-20260310-v1:0',
    maxTokens: 16_000,
    thinkingBudgetTokens: 16_000,
    // ...other props
});
```

---

### BedrockProjectFactory
* **Objective:** Orchestrates all four stacks with per-environment allocations and configurations, ensuring correct dependency ordering.

* **Interface:**

| Input | Type | Description |
|---|---|---|
| `environment` | `Environment` | Target environment (`development`, `staging`, `production`) |
| `context` | `BedrockFactoryContext` | Optional overrides for model/instruction |

| Output | Type | Description |
|---|---|---|
| `ProjectStackFamily` | `object` | All instantiated stacks with inter-stack wirings |

* **Flight Path:**
```typescript
const factory = new BedrockProjectFactory('development');
factory.createAllStacks(app, { environment: 'development' });
```

---

### bedrock-publisher Lambda
* **Objective:** Lambda handler that reads S3 draft events, transforms markdown via Bedrock Converse API with Adaptive Thinking, and writes MDX + metadata to S3 and DynamoDB.

* **Interface:**

| Input | Source | Description |
|---|---|---|
| S3 Event | S3 `ObjectCreated` notification | Draft `.md` file uploaded to `drafts/` |
| `ASSETS_BUCKET` | Environment variable | Target S3 bucket name |
| `TABLE_NAME` | Environment variable | DynamoDB table for metadata |
| `FOUNDATION_MODEL` | Environment variable | Bedrock model ID |
| `MAX_TOKENS` | Environment variable | Response ceiling |
| `THINKING_BUDGET_TOKENS` | Environment variable | Adaptive Thinking token budget |
| `REVALIDATION_URL` | Environment variable (optional) | ISR revalidation endpoint |
| `REVALIDATION_SECRET` | Environment variable (optional) | ISR secret (sent via `x-revalidation-secret` header) |

| Output | Destination | Description |
|---|---|---|
| `published/{slug}.mdx` | S3 | Latest published MDX |
| `content/v_{ISO}/{slug}.mdx` | S3 | Immutable versioned snapshot |
| `ARTICLE#{slug} / METADATA` | DynamoDB | Consumer-facing metadata |
| `ARTICLE#{slug} / CONTENT#v_{ISO}` | DynamoDB | Pipeline audit trail |

* **Flight Path:**
```bash
# Upload a draft to trigger the pipeline
aws s3 cp my-article.md s3://bedrock-development-kb-data/drafts/my-article.md
# Lambda auto-triggers → published MDX + metadata appear in ~60s
```

---

### analyseComplexity
* **Objective:** Classifies raw markdown into LOW/MID/HIGH complexity tiers to dynamically scale the Adaptive Thinking budget.

* **Interface:**

| Input | Type | Description |
|---|---|---|
| `markdown` | `string` | Raw markdown content |

| Output Field | Type | Description |
|---|---|---|
| `tier` | `'LOW' \| 'MID' \| 'HIGH'` | Complexity classification |
| `budgetTokens` | `number` | Thinking budget (2048 / 8192 / ceiling) |
| `reason` | `string` | Human-readable classification reasoning |
| `signals` | `object` | Raw metrics: `charCount`, `codeBlockCount`, `codeRatio`, `yamlFrontmatterBlocks`, `uniqueHeadingCount` |

* **Flight Path:**
```typescript
import { analyseComplexity } from './index';
const result = analyseComplexity(markdownContent);
// result.tier === 'HIGH', result.budgetTokens === 16000
```

---

### parseTransformResult
* **Objective:** Extracts and validates structured JSON from Claude's Converse API response, handling control characters embedded in MDX content strings.

* **Interface:**

| Input | Type | Description |
|---|---|---|
| `responseText` | `string` | Raw text from Bedrock (may contain surrounding text) |

| Output Field | Type | Description |
|---|---|---|
| `content` | `string` | Full MDX body with frontmatter |
| `metadata` | `object` | Title, tags, slug, readingTime, aiSummary, technicalConfidence |
| `shotList` | `ShotListItem[]` | Director's Shot List with visual asset instructions |

* **Flight Path:**
```typescript
import { parseTransformResult } from './index';
const result = parseTransformResult(bedrockResponseText);
// result.metadata.slug === 'my-article'
// result.shotList.length === 3
```

---

### validateMermaidSyntax
* **Objective:** Pre-flight validation of `<MermaidChart>` components in MDX to catch empty charts and leaked YAML frontmatter before S3 write.

* **Interface:**

| Input | Type | Description |
|---|---|---|
| `mdxContent` | `string` | MDX content string to validate |

| Output | Type | Description |
|---|---|---|
| `warnings` | `string[]` | Array of warning messages (empty = all valid) |

* **Flight Path:**
```typescript
import { validateMermaidSyntax } from './index';
const warnings = validateMermaidSyntax(mdxContent);
if (warnings.length > 0) console.warn('Mermaid issues:', warnings);
```

---

## DynamoDB Schema

```
Table: bedrock-{env}-ai-content
  pk: ARTICLE#{slug}
  sk: METADATA              ← consumer-facing entity
  sk: CONTENT#v_{ISO}       ← immutable version audit trail

GSI: gsi1-status-date
  gsi1pk: STATUS#published
  gsi1sk: {YYYY-MM-DD}#{slug}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ASSETS_BUCKET` | ✅ | — | S3 bucket for drafts and published content |
| `TABLE_NAME` | ✅ | — | DynamoDB table name |
| `FOUNDATION_MODEL` | ❌ | `anthropic.claude-sonnet-4-6-20260310-v1:0` | Bedrock model |
| `MAX_TOKENS` | ❌ | `16000` | Output token ceiling |
| `THINKING_BUDGET_TOKENS` | ❌ | `16000` | Adaptive Thinking budget |
| `DRAFT_PREFIX` | ❌ | `drafts/` | S3 key prefix for incoming drafts |
| `PUBLISHED_PREFIX` | ❌ | `published/` | S3 key prefix for published MDX |
| `CONTENT_PREFIX` | ❌ | `content/` | S3 key prefix for versioned blobs |
| `REVALIDATION_URL` | ❌ | — | Next.js ISR revalidation endpoint |
| `REVALIDATION_SECRET` | ❌ | — | Secret sent via `x-revalidation-secret` header |

---

## Design Decisions

| Decision | Rationale |
|---|---|
| **4-stack separation** | Data persists across agent redeployments; agent/API can be torn down independently |
| **Metadata Brain model** | DynamoDB stores metadata + S3 pointers, bypassing the 400KB item limit for content |
| **Prompt Caching** | `cachePoint` blocks reduce Bedrock cost by ~90% on repeated system prompt tokens |
| **Adaptive Thinking** | Complexity-driven budget prevents overspending on simple articles |
| **Shared ISO timestamp** | S3 `content/v_{ISO}/` key and DynamoDB `CONTENT#v_{ISO}` SK use the same timestamp for trivial cross-referencing |
| **ISR header secret** | Secret sent via `x-revalidation-secret` header, not query param, to avoid URL log exposure |
| **requireEnv helper** | Fails fast at Lambda cold start with descriptive errors instead of silent `undefined` propagation |

---

## Test Coverage

| Suite | Count | What is tested |
|---|---|---|
| `bedrock-publisher` | 30 | `analyseComplexity`, `deriveSlug`, `derivePublishedKey`, `deriveContentKey`, `parseTransformResult`, `validateMermaidSyntax` |
| `data-stack.test.ts` | 14 | S3 bucket config, encryption, access logs, SSM parameters |
| `agent-stack.test.ts` | 14 | Lambda functions, SSM parameters, stack outputs |
| `api-stack.test.ts` | 14 | API Gateway, usage plans, Lambda invoke function |
| `ai-content-stack.test.ts` | 18 | DynamoDB schema, GSI, S3 notifications, IAM policies, DLQ encryption |

---

## Related Documentation

| Document | Purpose |
|---|---|
| [observability-plan.md](./observability-plan.md) | Grafana dashboards, EMF metrics, X-Ray tracing, and alerts |
| [frontend-consumer-guide.md](../frontend-consumer-guide.md) | Next.js integration: data fetching, MDX rendering, ISR setup |
