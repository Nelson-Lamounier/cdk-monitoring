/**
 * @format
 * AI Publisher — Lambda Handler
 *
 * Implements two content generation modes:
 *
 * 1. **KB-Augmented Mode** (new): Short brief (< 500 chars) uploaded to
 *    drafts/*.md → Lambda queries Bedrock Knowledge Base (Pinecone) → retrieves
 *    context → Sonnet writes a fresh MDX article from knowledge.
 *
 * 2. **Legacy Transform Mode**: Full .md article uploaded → Sonnet transforms
 *    it into polished .mdx (backward compatible, no KB query).
 *
 * Both modes write output using the Metadata Brain model:
 *   → S3 (published/ + content/v{n}/)
 *   → DynamoDB (ARTICLE#slug / METADATA + CONTENT#v{ts})
 *
 * DynamoDB Entity Schema (Metadata Brain):
 *   pk: ARTICLE#<slug>
 *   sk: METADATA        — latest AI-enhanced metadata + s3Key pointer
 *   sk: CONTENT#v<ts>   — versioned S3 content pointer
 *
 * Content blobs live in S3 at content/v{n}/<slug>.mdx, bypassing
 * the 400KB DynamoDB item limit.
 *
 * Features:
 * - Bedrock Converse API with Prompt Caching
 * - KB-Augmented generation via Bedrock Retrieve API (Pinecone)
 * - Adaptive Thinking with dynamic budget based on content complexity
 * - AI-enhanced metadata (aiSummary, readingTime, technicalConfidence)
 * - Content versioning in S3
 */

import type { S3Event, S3Handler } from 'aws-lambda';

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
    BedrockRuntimeClient,
    ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { BLOG_PERSONA_SYSTEM_PROMPT } from './prompts/blog-persona.js';

// =============================================================================
// ENVIRONMENT & CLIENTS
// =============================================================================

/**
 * Validate and retrieve a required environment variable.
 *
 * @param name - The environment variable name
 * @returns The environment variable value
 * @throws Error with a descriptive message if the variable is missing
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const ASSETS_BUCKET = requireEnv('ASSETS_BUCKET');
const DRAFT_PREFIX = process.env.DRAFT_PREFIX ?? 'drafts/';
const PUBLISHED_PREFIX = process.env.PUBLISHED_PREFIX ?? 'published/';
const CONTENT_PREFIX = process.env.CONTENT_PREFIX ?? 'content/';
const TABLE_NAME = requireEnv('TABLE_NAME');
const FOUNDATION_MODEL = process.env.FOUNDATION_MODEL ?? 'anthropic.claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS ?? '8192', 10);
const THINKING_BUDGET_TOKENS = parseInt(process.env.THINKING_BUDGET_TOKENS ?? '16000', 10);

/** Knowledge Base ID for KB-augmented mode (empty = disabled). */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/** Number of KB passages to retrieve per article brief. */
const KB_RETRIEVE_COUNT = parseInt(process.env.KB_RETRIEVE_COUNT ?? '15', 10);

/**
 * Minimum KB context length required for KB-augmented generation.
 * If the retrieved context is below this threshold, the publisher rejects
 * generation rather than proceeding with thin context that leads to hallucination.
 * 2000 chars ≈ 2–3 substantive KB passages with real code/config detail.
 */
const KB_MIN_CONTEXT_CHARS = parseInt(process.env.KB_MIN_CONTEXT_CHARS ?? '2000', 10);

/**
 * Character threshold for brief detection.
 * Files shorter than this are treated as topic briefs (KB-augmented mode).
 * Files at or above this length use the legacy full-transform path.
 */
const BRIEF_THRESHOLD = 500;

const bedrockClient = new BedrockRuntimeClient({});
const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const s3Client = new S3Client({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// TYPES
// =============================================================================

/**
 * A single entry in the Director's Shot List.
 *
 * Each visual asset requested by the AI Director has a matching
 * inline <ImageRequest /> tag in the content AND an entry here.
 */
interface ShotListItem {
    /** Kebab-case identifier matching the inline <ImageRequest id="..." /> */
    id: string;
    /** The type of visual asset */
    type: 'screenshot' | 'diagram' | 'hero';
    /** Clear, actionable description of what the visual should show */
    instruction: string;
    /** Why this visual matters — used for SEO alt-text and developer placeholder hint */
    context?: string;
}

/**
 * Structured output from Claude's content transformation.
 *
 * Uses the Principal Editor schema with Director's Shot List.
 */
interface TransformResult {
    /** Full MDX article body with frontmatter, MermaidChart, and ImageRequest components */
    content: string;
    metadata: {
        title: string;
        description: string;
        tags: string[];
        slug: string;
        publishDate: string;
        /** Numeric reading time in minutes (e.g. 8) */
        readingTime: number;
        category: string;
        /** 2–3 sentence SEO teaser generated by Bedrock */
        aiSummary: string;
        /** AI-scored technical accuracy rating (0–100) */
        technicalConfidence: number;
        /** Brief note about what made this draft interesting/challenging */
        processingNote?: string;
        /** Hero image URL for article cards and social sharing */
        heroImageUrl?: string;
    };
    /** Director's Shot List — manifest of all visual assets requested */
    shotList: ShotListItem[];
}

/**
 * Complexity tier classification for Adaptive Thinking budget.
 *
 * The tier drives how much "thinking time" Claude gets:
 * - LOW:  Short, narrative-heavy posts — minimal reasoning needed
 * - MID:  Standard DevOps articles with some code — moderate reasoning
 * - HIGH: Dense IaC, multi-service architectures — maximum reasoning
 */
type ComplexityTier = 'LOW' | 'MID' | 'HIGH';

/**
 * Result of the static complexity analysis performed on the raw markdown.
 */
interface ComplexityAnalysis {
    /** Classified complexity tier */
    tier: ComplexityTier;
    /** Adaptive Thinking budget tokens for this tier */
    budgetTokens: number;
    /** Human-readable reasoning for the classification */
    reason: string;
    /** Raw signal values used to determine the tier */
    signals: {
        charCount: number;
        codeBlockCount: number;
        codeRatio: number;
        yamlFrontmatterBlocks: number;
        uniqueHeadingCount: number;
    };
}

// =============================================================================
// COMPLEXITY ANALYSIS — drives Adaptive Thinking budget
// =============================================================================

/**
 * Budget tokens per complexity tier.
 * These are clamped to the env var ceiling (THINKING_BUDGET_TOKENS).
 *
 * LOW  — 2 048 tokens:  enough for simple reformatting
 * MID  — 8 192 tokens:  standard DevOps articles
 * HIGH — budget ceiling: deep reasoning for dense IaC/multi-service posts
 */
const TIER_BUDGETS: Record<ComplexityTier, number> = {
    LOW: 2_048,
    MID: 8_192,
    HIGH: THINKING_BUDGET_TOKENS, // env var ceiling
};

/**
 * Analyse the raw markdown to classify its technical complexity.
 *
 * Signals inspected:
 * 1. **Length** — character count correlates with breadth of content
 * 2. **Code density** — ratio of fenced-code-block chars to total chars
 * 3. **Code block count** — number of distinct ``` fenced blocks
 * 4. **YAML/config blocks** — yaml/yml/toml/hcl code fences (IaC indicator)
 * 5. **Heading depth** — number of unique headings (structural complexity)
 */
export function analyseComplexity(markdown: string): ComplexityAnalysis {
    const charCount = markdown.length;

    // Count fenced code blocks and their total character length
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = markdown.match(codeBlockRegex) ?? [];
    const codeBlockCount = codeBlocks.length;
    const codeChars = codeBlocks.reduce((sum, block) => sum + block.length, 0);
    const codeRatio = charCount > 0 ? codeChars / charCount : 0;

    // Count IaC-specific code fences (yaml, hcl, toml, terraform, dockerfile)
    const iacFenceRegex = /```(?:ya?ml|hcl|terraform|toml|dockerfile|Dockerfile)/gi;
    const yamlFrontmatterBlocks = (markdown.match(iacFenceRegex) ?? []).length;

    // Count unique headings (## or ###)
    const headingRegex = /^#{1,4}\s+.+$/gm;
    const uniqueHeadingCount = (markdown.match(headingRegex) ?? []).length;

    // ---- Classification logic ----
    let tier: ComplexityTier;
    let reason: string;

    const isLong = charCount > 8_000;
    const isCodeHeavy = codeRatio > 0.30;
    const hasManyCodeBlocks = codeBlockCount >= 6;
    const hasIacBlocks = yamlFrontmatterBlocks >= 2;
    const isStructurallyComplex = uniqueHeadingCount >= 8;

    // HIGH: meets ≥ 2 of the "heavy" signals
    const heavySignals = [isLong && isCodeHeavy, hasManyCodeBlocks, hasIacBlocks, isStructurallyComplex];
    const heavyCount = heavySignals.filter(Boolean).length;

    if (heavyCount >= 2) {
        tier = 'HIGH';
        reason = `Dense technical content (${codeBlockCount} code blocks, ${(codeRatio * 100).toFixed(0)}% code, ${yamlFrontmatterBlocks} IaC fences, ${uniqueHeadingCount} headings)`;
    } else if (isLong || hasManyCodeBlocks || isCodeHeavy) {
        tier = 'MID';
        reason = `Moderate complexity (${codeBlockCount} code blocks, ${(codeRatio * 100).toFixed(0)}% code, ${charCount.toLocaleString()} chars)`;
    } else {
        tier = 'LOW';
        reason = `Light content (${codeBlockCount} code blocks, ${charCount.toLocaleString()} chars)`;
    }

    return {
        tier,
        budgetTokens: Math.min(TIER_BUDGETS[tier], THINKING_BUDGET_TOKENS),
        reason,
        signals: {
            charCount,
            codeBlockCount,
            codeRatio: Math.round(codeRatio * 100) / 100,
            yamlFrontmatterBlocks,
            uniqueHeadingCount,
        },
    };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Read the raw markdown file from S3
 *
 * @param bucket - The S3 bucket name
 * @param key - The S3 object key
 * @returns The file contents as a UTF-8 string
 * @throws Error if the S3 object body is empty or missing
 */
async function readDraftFromS3(bucket: string, key: string): Promise<string> {
    const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));

    if (!response.Body) {
        throw new Error(`S3 GetObject returned empty body for s3://${bucket}/${key}`);
    }

    return await response.Body.transformToString('utf-8');
}

/**
 * Write the transformed MDX file to S3.
 *
 * Writes to TWO locations:
 * 1. published/<slug>.mdx   — backward-compatible flat output
 * 2. content/v<n>/<slug>.mdx — versioned content blob (Metadata Brain)
 */
async function writeContentToS3(
    bucket: string,
    publishedKey: string,
    contentKey: string,
    content: string,
): Promise<void> {
    // Write both locations in parallel
    await Promise.all([
        s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: publishedKey,
            Body: content,
            ContentType: 'text/mdx',
        })),
        s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: contentKey,
            Body: content,
            ContentType: 'text/mdx',
        })),
    ]);
}

/**
 * Write AI-enhanced metadata to DynamoDB using the Metadata Brain entity model.
 *
 * Two records per article:
 *
 * 1. METADATA (sk: "METADATA") — the clean, consumer-facing record.
 *    This is what the Next.js app on K8s queries to render article cards.
 *    Includes a shotListCount for the consumer to know how many visuals
 *    are pending or available.
 *    ```json
 *    {
 *      "pk": "ARTICLE#devsecops-pipeline",
 *      "sk": "METADATA",
 *      "title": "DevSecOps Pipeline: 30 Custom Checkov Rules",
 *      "tags": ["Security", "CDK"],
 *      "heroImageUrl": "https://cdn.example.com/assets/hero.png",
 *      "contentRef": "s3://my-bucket/published/devsecops-pipeline.mdx",
 *      "aiSummary": "A deep dive into 30 custom rules...",
 *      "readingTime": 8
 *    }
 *    ```
 *
 * 2. CONTENT version (sk: "CONTENT#v_{ts}") — immutable audit record.
 *    Stores all enrichment fields (description, category, complexity, etc.)
 *    for pipeline diagnostics and version history.
 */
async function writeMetadataToDynamoDB(
    slug: string,
    metadata: TransformResult['metadata'],
    shotList: ShotListItem[],
    sourceKey: string,
    publishedKey: string,
    complexity: ComplexityAnalysis,
    versionTimestamp: string,
): Promise<void> {
    const now = versionTimestamp;
    const pk = `ARTICLE#${slug}`;
    const contentRef = `s3://${ASSETS_BUCKET}/${publishedKey}`;

    // 1. METADATA record — clean, consumer-facing entity
    //    All fields the Next.js app needs to render article cards
    //    and the /articles listing page.  gsi1pk/gsi1sk populate the
    //    gsi1-status-date GSI for "all published, newest first".
    const datePrefix = metadata.publishDate
        ? metadata.publishDate.substring(0, 10)
        : now.substring(0, 10); // YYYY-MM-DD

    const metadataItem: Record<string, unknown> = {
        pk,
        sk: 'METADATA',
        entityType: 'ARTICLE_METADATA',

        // Core fields
        slug,
        title: metadata.title,
        description: metadata.description,
        author: 'Nelson Lamounier',
        date: datePrefix,
        status: 'draft',
        category: metadata.category,
        tags: metadata.tags,
        readingTimeMinutes: metadata.readingTime,

        // S3 pointer
        contentRef,
        contentType: 'mdx',

        // AI fields
        aiSummary: metadata.aiSummary,
        processingNote: metadata.processingNote || '',
        shotListCount: shotList.length,

        // Timestamps
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
        version: 1,

        // GSI keys (frontend listing query)
        gsi1pk: 'STATUS#draft',
        gsi1sk: `${datePrefix}#${slug}`,
    };

    // Only include heroImageUrl if non-empty
    if (metadata.heroImageUrl) {
        metadataItem.heroImageUrl = metadata.heroImageUrl;
    }

    await dynamoClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: metadataItem,
    }));

    // 2. CONTENT version record — immutable audit trail
    //    Full enrichment for pipeline diagnostics and version history.
    //    Includes the full shotList for visual asset tracking.
    await dynamoClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
            pk,
            sk: `CONTENT#v_${now}`,
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            slug: metadata.slug,
            publishDate: metadata.publishDate,
            readingTime: metadata.readingTime,
            category: metadata.category,
            aiSummary: metadata.aiSummary,
            technicalConfidence: metadata.technicalConfidence,
            heroImageUrl: metadata.heroImageUrl ?? '',
            contentRef,
            sourceKey,
            transformedAt: now,
            model: FOUNDATION_MODEL,
            complexityTier: complexity.tier,
            complexityReason: complexity.reason,
            thinkingBudgetUsed: complexity.budgetTokens,
            shotList,
        },
    }));
}

/**
 * Derive the published S3 key (backward-compatible flat output).
 * Input:  drafts/my-article.md
 * Output: published/my-article.mdx
 */
export function derivePublishedKey(draftKey: string): string {
    const filename = draftKey
        .replace(DRAFT_PREFIX, '')
        .replace(/\.md$/, '.mdx');
    return `${PUBLISHED_PREFIX}${filename}`;
}

/**
 * Derive the versioned content blob S3 key (Metadata Brain).
 *
 * Uses ISO timestamp to align with DynamoDB sort key format
 * (`CONTENT#v_2026-03-17T08:30:00.000Z`) for easier debugging
 * and cross-reference between S3 and DynamoDB.
 *
 * @param draftKey - The source draft S3 key (e.g. `drafts/my-article.md`)
 * @param isoTimestamp - ISO 8601 timestamp for versioning
 * @returns The versioned content S3 key (e.g. `content/v_2026-03-17T.../my-article.mdx`)
 */
export function deriveContentKey(draftKey: string, isoTimestamp: string): string {
    const filename = draftKey
        .replace(DRAFT_PREFIX, '')
        .replace(/\.md$/, '.mdx');
    return `${CONTENT_PREFIX}v_${isoTimestamp}/${filename}`;
}

/**
 * Derive a slug from the draft filename.
 * Input:  drafts/deploying-k8s-on-aws.md
 * Output: deploying-k8s-on-aws
 */
export function deriveSlug(draftKey: string): string {
    return draftKey
        .replace(DRAFT_PREFIX, '')
        .replace(/\.md$/, '');
}

/**
 * Parse Claude's response into structured TransformResult.
 *
 * Claude's MDX content contains literal newlines, tabs, and backtick
 * code fences.  A naïve regex-based extraction or blanket control-char
 * replacement breaks either the extraction (nested ```) or the JSON
 * structure (structural newlines converted to \\n).
 *
 * Strategy:
 *   1. Locate the outermost { … } in the response text.
 *   2. Walk through the JSON char-by-char, tracking whether we are
 *      inside a JSON string value (between unescaped quotes).
 *   3. Only escape control characters (U+0000-U+001F) when inside a
 *      string value; structural whitespace is left alone.
 */
export function parseTransformResult(responseText: string): TransformResult {
    // ── Step 1: find the outermost JSON object ──
    const firstBrace = responseText.indexOf('{');
    const lastBrace  = responseText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        console.error(`No JSON object found in response (length=${responseText.length}). First 500 chars:\n${responseText.substring(0, 500)}`);
        throw new Error('No JSON object found in Bedrock response');
    }
    const rawJson = responseText.substring(firstBrace, lastBrace + 1);

    // ── Step 2: sanitise control chars inside string values only ──
    const out: string[] = [];
    let inString = false;
    let escaped  = false;

    for (let i = 0; i < rawJson.length; i++) {
        const ch = rawJson[i];

        if (escaped) {
            out.push(ch);
            escaped = false;
            continue;
        }

        if (ch === '\\' && inString) {
            out.push(ch);
            escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            out.push(ch);
            continue;
        }

        // Only escape control chars when inside a JSON string
        if (inString && ch.charCodeAt(0) < 0x20) {
            switch (ch) {
                case '\n': out.push('\\n'); break;
                case '\r': out.push('\\r'); break;
                case '\t': out.push('\\t'); break;
                default:   out.push('\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
            }
            continue;
        }

        out.push(ch);
    }

    const jsonStr = out.join('');

    let parsed: TransformResult;
    try {
        parsed = JSON.parse(jsonStr) as TransformResult;
    } catch (err) {
        // Log context around the failure position for debugging
        const posMatch = String(err).match(/position (\d+)/);
        const pos = posMatch ? parseInt(posMatch[1], 10) : -1;
        const snippet = pos >= 0
            ? jsonStr.substring(Math.max(0, pos - 200), pos + 200)
            : jsonStr.substring(0, 500);
        console.error(`JSON parse failed at position ${pos}. Snippet around failure:\n${snippet}`);
        console.error(`Raw response: ${responseText.length} chars, extracted JSON: ${rawJson.length} chars, sanitised: ${jsonStr.length} chars`);
        throw err;
    }

    // Validate required fields (new schema uses 'content' not 'mdxContent')
    if (!parsed.content || !parsed.metadata?.slug) {
        throw new Error('Invalid transform result: missing content or metadata.slug');
    }

    // Ensure shotList is an array (default to empty if missing)
    if (!Array.isArray(parsed.shotList)) {
        parsed.shotList = [];
    }

    // Coerce readingTime to number if Claude returns a string
    if (typeof parsed.metadata.readingTime === 'string') {
        parsed.metadata.readingTime = parseInt(parsed.metadata.readingTime, 10) || 5;
    }

    // Clamp technicalConfidence to 0-100
    if (typeof parsed.metadata.technicalConfidence === 'number') {
        parsed.metadata.technicalConfidence = Math.max(0, Math.min(100, parsed.metadata.technicalConfidence));
    } else {
        parsed.metadata.technicalConfidence = 0;
    }

    // Cross-validate: count inline ImageRequest tags vs shotList
    const inlineImageRequests = parsed.content.match(/<ImageRequest\s/g) ?? [];
    if (inlineImageRequests.length !== parsed.shotList.length) {
        console.warn(
            `shotList mismatch: ${inlineImageRequests.length} inline <ImageRequest> tags vs ${parsed.shotList.length} shotList entries`,
        );
    }

    return parsed;
}

// =============================================================================
// KB-AUGMENTED RETRIEVAL
// =============================================================================

/**
 * Retrieve relevant context from the Bedrock Knowledge Base (Pinecone).
 *
 * Queries the KB with the article topic/brief and returns concatenated
 * passages for injection into the Converse API prompt.
 *
 * @param topic - The article topic or brief text to search for
 * @returns Concatenated KB passages formatted for prompt injection
 */
async function retrieveKnowledgeBaseContext(topic: string): Promise<string> {
    const response = await bedrockAgentClient.send(new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: topic },
        retrievalConfiguration: {
            vectorSearchConfiguration: {
                numberOfResults: KB_RETRIEVE_COUNT,
            },
        },
    }));

    const results = response.retrievalResults ?? [];
    console.log(`KB retrieval returned ${results.length} passages for topic: "${topic.substring(0, 100)}..."`);

    return results
        .map((r: { content?: { text?: string } }, i: number) => `[Source ${i + 1}]\n${r.content?.text ?? ''}`)
        .join('\n\n');
}

/**
 * Build the user message for KB-augmented mode.
 *
 * Injects retrieved KB context before the article brief, giving Sonnet
 * the factual evidence it needs to write a complete article from scratch.
 *
 * @param brief - The short article brief from the uploaded .md file
 * @param kbContext - Retrieved passages from the Knowledge Base
 * @param slug - The article slug derived from the filename
 * @param complexity - Complexity analysis result
 * @returns Formatted user message for the Converse API
 */
function buildKbAugmentedMessage(
    brief: string,
    kbContext: string,
    slug: string,
    complexity: ComplexityAnalysis,
): string {
    return [
        `Write a COMPLETE blog article from scratch using the Knowledge Base context below as your primary source material.`,
        `The article slug is: "${slug}"`,
        `Today's date is: ${new Date().toISOString().split('T')[0]}`,
        ``,
        `## Complexity Assessment`,
        `This article has been classified as **${complexity.tier}** complexity.`,
        `Reason: ${complexity.reason}`,
        ``,
        `--- BEGIN KNOWLEDGE BASE CONTEXT ---`,
        kbContext,
        `--- END KNOWLEDGE BASE CONTEXT ---`,
        ``,
        `--- BEGIN ARTICLE BRIEF ---`,
        brief,
        `--- END ARTICLE BRIEF ---`,
        ``,
        `Use the Knowledge Base context as your factual source. Write a complete, polished MDX blog post following all rules in the system prompt.`,
        `If the brief mentions specific focus areas, prioritise those KB passages.`,
        `Do NOT hallucinate details not present in the KB context — note missing information in processingNote.`,
        ``,
        `Return ONLY the JSON object as specified in the system prompt. No additional text.`,
    ].join('\n');
}

/**
 * Build the user message for legacy full-transform mode.
 *
 * @param markdownContent - The full markdown article to transform
 * @param slug - The article slug derived from the filename
 * @param complexity - Complexity analysis result
 * @returns Formatted user message for the Converse API
 */
function buildLegacyTransformMessage(
    markdownContent: string,
    slug: string,
    complexity: ComplexityAnalysis,
): string {
    return [
        `Transform the following raw markdown draft into a polished MDX blog post.`,
        `The article slug is: "${slug}"`,
        `Today's date is: ${new Date().toISOString().split('T')[0]}`,
        ``,
        `## Complexity Assessment`,
        `This draft has been classified as **${complexity.tier}** complexity.`,
        `Reason: ${complexity.reason}`,
        ``,
        `### Adaptive Detail Preservation Rules`,
        complexity.tier === 'HIGH'
            ? [
                `- This is a HIGHLY technical article. Preserve ALL code blocks, configs, and CLI commands verbatim.`,
                `- Maintain every architectural detail, flag, and parameter from the original.`,
                `- Add explanatory comments to code blocks where the author hasn't provided them.`,
                `- Expand abbreviated explanations into full technical reasoning.`,
                `- Include a detailed Prerequisites section.`,
            ].join('\n')
            : complexity.tier === 'MID'
                ? [
                    `- Preserve all code blocks and commands exactly as written.`,
                    `- Add brief context around code examples where helpful.`,
                    `- Balance narrative flow with technical precision.`,
                ].join('\n')
                : [
                    `- Focus on readability and narrative flow.`,
                    `- Keep code examples but prioritise the storytelling.`,
                    `- Light-touch editing — polish rather than restructure.`,
                ].join('\n'),
        ``,
        `--- BEGIN DRAFT ---`,
        markdownContent,
        `--- END DRAFT ---`,
        ``,
        `Return ONLY the JSON object as specified in the system prompt. No additional text.`,
    ].join('\n');
}

// =============================================================================
// BEDROCK CONVERSE API CALL
// =============================================================================

/**
 * Call Claude 4.6 Sonnet via the Bedrock Converse API with
 * Prompt Caching and Adaptive Thinking.
 *
 * Accepts a pre-built user message (from either KB-augmented or legacy mode).
 * The thinking budget is dynamically scaled based on the complexity analysis.
 *
 * @param userMessage - The formatted user message (KB-augmented or legacy)
 * @param complexity - Complexity analysis driving the thinking budget
 * @returns Parsed transform result with MDX content, metadata, and shot list
 */
async function transformWithBedrock(
    userMessage: string,
    complexity: ComplexityAnalysis,
): Promise<TransformResult> {
    const command = new ConverseCommand({
        modelId: FOUNDATION_MODEL,
        system: BLOG_PERSONA_SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        text: userMessage,
                    },
                ],
            },
        ],
        inferenceConfig: {
            maxTokens: MAX_TOKENS,
            // temperature must be 1 (or omitted) when thinking is enabled
        },
        additionalModelRequestFields: {
            thinking: {
                type: 'enabled',
                budget_tokens: complexity.budgetTokens,
            },
        },
    });

    const response = await bedrockClient.send(command);

    // Log usage and stop reason for debugging
    const stopReason = response.stopReason ?? 'unknown';
    const usage = response.usage;
    console.log(`Bedrock response: stopReason=${stopReason}, inputTokens=${usage?.inputTokens}, outputTokens=${usage?.outputTokens}`);

    // Check for truncated response
    if (stopReason === 'max_tokens') {
        throw new Error(
            `Response truncated — output hit maxTokens limit (${usage?.outputTokens} tokens used). ` +
            `Increase MAX_TOKENS env var or reduce article complexity.`
        );
    }

    // Extract text from output content blocks (skip thinking blocks)
    const outputBlocks = response.output?.message?.content ?? [];
    const textContent = outputBlocks
        .filter((block): block is { text: string } =>
            typeof block === 'object' && block !== null && 'text' in block && typeof (block as { text?: unknown }).text === 'string')
        .map((block) => block.text)
        .join('');

    if (!textContent) {
        throw new Error('No text content in Bedrock Converse response');
    }

    return parseTransformResult(textContent);
}

// =============================================================================
// LAMBDA HANDLER
// =============================================================================

/**
 * Validate MermaidChart components in MDX content.
 *
 * Basic pre-checks before writing to S3:
 * - No empty chart props
 * - No YAML frontmatter leaked into chart props
 * Returns an array of warning strings (empty = all good).
 */
export function validateMermaidSyntax(mdxContent: string): string[] {
    // Match <MermaidChart chart={`...`} /> components
    const mermaidComponentRegex = /<MermaidChart\s+chart=\{`([\s\S]*?)`\}\s*\/>/g;
    const errors: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = mermaidComponentRegex.exec(mdxContent)) !== null) {
        const code = match[1].trim();
        if (!code) {
            errors.push('Empty MermaidChart component found');
        }
        if (code.startsWith('---')) {
            errors.push('YAML frontmatter detected inside MermaidChart component');
        }
    }
    return errors;
}

/**
 * S3 event handler for the MD-to-Blog pipeline.
 *
 * Triggered by s3:ObjectCreated on drafts/*.md.
 *
 * Supports two modes:
 * - **KB-Augmented**: Short briefs (< 500 chars) + KNOWLEDGE_BASE_ID set →
 *   retrieves context from Pinecone, Sonnet writes from knowledge.
 * - **Legacy Transform**: Full articles → Sonnet transforms into MDX.
 *
 * Both modes analyse complexity, scale Adaptive Thinking budget,
 * and write results using the Metadata Brain model.
 */
export const handler: S3Handler = async (event: S3Event): Promise<void> => {
    console.log(`Processing ${event.Records.length} S3 event(s)`);

    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

        console.log(`Processing draft: s3://${bucket}/${key}`);

        try {
            // 1. Read the raw markdown from S3
            const markdownContent = await readDraftFromS3(bucket, key);
            console.log(`Read ${markdownContent.length} chars from draft`);

            // 2. Detect mode: KB-augmented brief vs legacy full transform
            const isKbBrief = markdownContent.length < BRIEF_THRESHOLD && KNOWLEDGE_BASE_ID.length > 0;
            console.log(`Mode: ${isKbBrief ? 'KB-AUGMENTED' : 'LEGACY-TRANSFORM'} (${markdownContent.length} chars, KB=${KNOWLEDGE_BASE_ID ? 'configured' : 'disabled'})`);

            // 3. For KB mode, retrieve context; for legacy, use the content directly
            let contentForComplexity: string;
            let userMessage: string;

            // 4. Derive output paths (ISO timestamp shared between S3 key and DynamoDB sort key)
            const slug = deriveSlug(key);
            const publishedKey = derivePublishedKey(key);
            const versionTimestamp = new Date().toISOString();
            const contentKey = deriveContentKey(key, versionTimestamp);

            if (isKbBrief) {
                // KB-Augmented: retrieve context from Pinecone-backed KB
                console.log(`Retrieving KB context for brief: "${markdownContent.substring(0, 100)}..."`);
                const kbContext = await retrieveKnowledgeBaseContext(markdownContent);
                console.log(`KB context retrieved: ${kbContext.length} chars`);

                // Guard: reject if KB context is too thin to write a factual article
                if (kbContext.length < KB_MIN_CONTEXT_CHARS) {
                    const msg = `KB context too thin (${kbContext.length} chars < ${KB_MIN_CONTEXT_CHARS} min). ` +
                        `Enrich knowledge-base/ documents before generating articles from briefs. ` +
                        `Draft: ${key}`;
                    console.error(msg);
                    throw new Error(msg);
                }

                // Use KB context for complexity analysis (the brief alone is too short)
                contentForComplexity = kbContext;

                const complexity = analyseComplexity(contentForComplexity);
                console.log(
                    `Complexity: ${complexity.tier} → ${complexity.budgetTokens} thinking tokens | ${complexity.reason}`,
                );

                userMessage = buildKbAugmentedMessage(markdownContent, kbContext, slug, complexity);

                // 5. Transform via Bedrock Converse API
                console.log(`Invoking ${FOUNDATION_MODEL} in KB-Augmented mode (budget: ${complexity.budgetTokens} tokens)`);
                const result = await transformWithBedrock(userMessage, complexity);
                console.log(`Transform complete: "${result.metadata.title}" (${result.metadata.readingTime} min, confidence: ${result.metadata.technicalConfidence}%, shotList: ${result.shotList.length} items)`);


                // Post-processing (shared between both modes)
                await writePostProcessing(result, slug, key, publishedKey, contentKey, complexity, versionTimestamp);
            } else {
                // Legacy Transform: full article → polished MDX
                const complexity = analyseComplexity(markdownContent);
                console.log(
                    `Complexity: ${complexity.tier} → ${complexity.budgetTokens} thinking tokens | ${complexity.reason}`,
                );

                userMessage = buildLegacyTransformMessage(markdownContent, slug, complexity);

                // 5. Transform via Bedrock Converse API
                console.log(`Invoking ${FOUNDATION_MODEL} in Legacy-Transform mode (budget: ${complexity.budgetTokens} tokens)`);
                const result = await transformWithBedrock(userMessage, complexity);
                console.log(`Transform complete: "${result.metadata.title}" (${result.metadata.readingTime} min, confidence: ${result.metadata.technicalConfidence}%, shotList: ${result.shotList.length} items)`);

                // Post-processing (shared between both modes)
                await writePostProcessing(result, slug, key, publishedKey, contentKey, complexity, versionTimestamp);
            }

        } catch (error) {
            console.error(`Failed to process ${key}:`, error);
            throw error; // Let Lambda retry / send to DLQ
        }
    }

    console.log('All records processed successfully');
};

/**
 * Shared post-processing: validate, write to S3, write metadata, trigger ISR.
 *
 * Extracted to avoid code duplication between KB-augmented and legacy modes.
 *
 * @param result - The parsed transform result from Bedrock
 * @param slug - Article slug
 * @param sourceKey - Original S3 key of the draft
 * @param publishedKey - S3 key for the published MDX
 * @param contentKey - S3 key for the versioned content blob
 * @param complexity - Complexity analysis result
 * @param versionTimestamp - ISO timestamp for versioning
 */
async function writePostProcessing(
    result: TransformResult,
    slug: string,
    sourceKey: string,
    publishedKey: string,
    contentKey: string,
    complexity: ComplexityAnalysis,
    versionTimestamp: string,
): Promise<void> {
    // MermaidChart syntax pre-check (warn but don't block)
    const mermaidWarnings = validateMermaidSyntax(result.content);
    if (mermaidWarnings.length > 0) {
        console.warn(`MermaidChart syntax warnings for ${slug}:`, mermaidWarnings);
    }

    // Log Director's Shot List
    if (result.shotList.length > 0) {
        console.log(`Director's Shot List for ${slug}:`, JSON.stringify(result.shotList, null, 2));
    }

    // Write MDX content to S3 (published/ + content/v{n}/)
    await writeContentToS3(ASSETS_BUCKET, publishedKey, contentKey, result.content);
    console.log(`Content written to s3://${ASSETS_BUCKET}/${publishedKey} + ${contentKey}`);

    // Write AI-enhanced metadata + shotList to DynamoDB (Metadata Brain)
    await writeMetadataToDynamoDB(
        result.metadata.slug || slug,
        result.metadata,
        result.shotList,
        sourceKey,
        publishedKey,
        complexity,
        versionTimestamp,
    );
    console.log(`Metadata written to ${TABLE_NAME} (pk=ARTICLE#${result.metadata.slug || slug})`);

    // On-demand ISR revalidation (opt-in via REVALIDATION_URL env var)
    const revalidationUrl = process.env.REVALIDATION_URL;
    const revalidationSecret = process.env.REVALIDATION_SECRET;
    if (revalidationUrl) {
        try {
            const articleSlug = result.metadata.slug || slug;
            const url = new URL(revalidationUrl);
            url.searchParams.set('slug', articleSlug);
            const headers: Record<string, string> = {};
            if (revalidationSecret) {
                headers['x-revalidation-secret'] = revalidationSecret;
            }
            const response = await fetch(url.toString(), { method: 'GET', headers });
            if (response.ok) {
                console.log(`ISR revalidation triggered for /blog/${articleSlug}`);
            } else {
                console.warn(`ISR revalidation returned ${response.status}: ${await response.text()}`);
            }
        } catch (revalError) {
            console.warn('ISR revalidation failed (non-blocking):', revalError);
        }
    }
}
