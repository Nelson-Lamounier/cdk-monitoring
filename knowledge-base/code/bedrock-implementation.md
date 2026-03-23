# Bedrock AI Content Pipeline Implementation

**Project:** cdk-monitoring
**Last Updated:** 2026-03-23

## Architecture

The Bedrock publisher is an S3-triggered Lambda that transforms draft `.md` articles into polished `.mdx` portfolio content using Claude via the Bedrock Converse API. It supports two modes: KB-augmented (brief → Pinecone retrieval → article) and legacy (full draft → enhancement).

```
Draft .md → S3 (drafts/) → Lambda trigger → Complexity Analysis
  → KB mode: Pinecone retrieval → Converse API + System Prompt → .mdx
  → Legacy: Direct content → Converse API + System Prompt → .mdx
  → Save to S3 (published/) + DynamoDB (metadata + content version)
```

## Decision Reasoning

1. **Bedrock over OpenAI API** — Bedrock keeps all data within the AWS account (no external API calls), simplifies IAM-based access control, and avoids API key management. The trade-off is limited model selection compared to OpenAI.

2. **KB-augmented mode** — Short briefs (5-10 lines) query the Pinecone-backed Knowledge Base for relevant factual content, ensuring articles are evidence-based. A minimum context threshold (3,000 chars) rejects briefs with insufficient KB backing rather than generating hallucinated content.

3. **Adaptive Thinking budget** — Complexity analysis (LOW/MID/HIGH) drives how many thinking tokens Claude receives. Dense IaC articles get 10,000 tokens; simple narratives get 2,000. This controls cost while maintaining quality for complex topics.

4. **DynamoDB dual-record pattern** — Each article creates two DynamoDB records: a mutable METADATA record (for frontend queries via GSI) and an immutable CONTENT version record (for audit trail and rollback).

## Key Components

| Component | File | Purpose |
|---|---|---|
| Publisher Lambda | `bedrock-publisher/src/index.ts` | S3 trigger, Converse API, DynamoDB writes |
| System Prompt | `bedrock-publisher/src/prompts/blog-persona.ts` | Persona, voice, content architecture, output schema |
| Complexity Analyser | `bedrock-publisher/src/index.ts` (analyseComplexity) | Signal-based tier classification (code blocks, IaC patterns, word count) |
| CDK Stack | `infra/lib/stacks/bedrock/publisher-stack.ts` | Lambda, S3 trigger, IAM roles |
| Observability | `infra/lib/constructs/observability/bedrock-observability.ts` | CloudWatch dashboard, CloudTrail data events |
| KB Integration | `bedrock-publisher/src/index.ts` (retrieveKnowledgeBaseContext) | Pinecone vector search for RAG |

## Challenges Encountered

- **JSON extraction from LLM output** — Claude sometimes wraps JSON in markdown code blocks or adds preamble text. Solved by extracting the first `{` to last `}` substring, not expecting clean JSON.
- **Mermaid syntax validation** — LLM-generated Mermaid diagrams frequently had syntax errors (YAML frontmatter leaking, empty chart bodies). Added `validateMermaidSyntax()` post-processing to catch these before publishing.
- **Cost control** — Early prompts generated 3,000+ word articles at $0.15+ per invocation. The word budget table in the system prompt constrains output to 1,200-1,800 words at ~$0.03-$0.05 per article.

## Transferable Skills Demonstrated

- **LLM integration engineering** — building production-grade LLM pipelines with input validation, output parsing, error handling, and cost controls. Applicable to any team integrating generative AI into product workflows.
- **RAG architecture** — implementing retrieval-augmented generation with Pinecone vector search and minimum context thresholds. The same pattern applies to any knowledge-intensive AI application.
- **Prompt engineering** — designing structured system prompts with persona definition, content architecture, output schema, and quality controls. Transferable to any AI-powered content generation system.

## Source Files

- `bedrock-publisher/src/index.ts` — Publisher Lambda (1,018 lines)
- `bedrock-publisher/src/prompts/blog-persona.ts` — System prompt (605 lines)
- `bedrock-publisher/src/__tests__/index.test.ts` — Unit tests (30 tests)
- `infra/lib/stacks/bedrock/publisher-stack.ts` — CDK stack
- `infra/lib/constructs/observability/bedrock-observability.ts` — CloudWatch + CloudTrail