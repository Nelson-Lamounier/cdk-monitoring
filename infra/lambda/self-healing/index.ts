/**
 * @format
 * Self-Healing Agent — TypeScript Handler
 *
 * Production-grade agentic remediation loop using the Bedrock
 * ConverseCommand API with MCP tool integration.
 *
 * Flow:
 * 1. Receive CloudWatch Alarm / EventBridge event
 * 2. Deduplicate via alarm name + timestamp hash (idempotency)
 * 3. Discover tools dynamically from MCP Gateway (fallback to defaults)
 * 4. Build a natural language prompt from the event
 * 5. Call Bedrock with tool definitions
 * 6. If model requests tool_use → invoke tool → feed result back
 * 7. Repeat until model produces a final text response
 * 8. Return structured remediation report
 *
 * Environment Variables:
 *   GATEWAY_URL      - AgentCore Gateway MCP endpoint URL
 *   FOUNDATION_MODEL - Bedrock model ID
 *   DRY_RUN          - 'true' to propose only, 'false' to execute
 *   SYSTEM_PROMPT    - Agent behaviour instructions
 */

import {
    BedrockRuntimeClient,
    ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
    ContentBlock,
    ConversationRole,
    Message,
    SystemContentBlock,
    Tool,
    ToolConfiguration,
    ToolResultBlock,
    ToolResultContentBlock,
    ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
    CognitoIdentityProviderClient,
    DescribeUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';

// =============================================================================
// Configuration
// =============================================================================

const GATEWAY_URL = process.env.GATEWAY_URL ?? '';
const FOUNDATION_MODEL = process.env.FOUNDATION_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ?? 'You are an infrastructure remediation agent.';

/** Cognito OAuth2 configuration for Gateway M2M auth */
const COGNITO_TOKEN_ENDPOINT = process.env.COGNITO_TOKEN_ENDPOINT ?? '';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const COGNITO_SCOPES = process.env.COGNITO_SCOPES ?? '';

/** Maximum agentic loop iterations to prevent runaway execution */
const MAX_ITERATIONS = 10;

/** Timeout for MCP Gateway HTTP calls (milliseconds) */
const MCP_TIMEOUT_MS = 10_000;

/** Buffer before token expiry to trigger refresh (seconds) */
const TOKEN_REFRESH_BUFFER_S = 60;

const bedrock = new BedrockRuntimeClient({});
const cognito = new CognitoIdentityProviderClient({});

/** Cached OAuth2 access token */
let cachedToken = '';
/** Timestamp (epoch seconds) when the cached token expires */
let tokenExpiresAt = 0;
/** Cached Cognito client secret (resolved once at cold start) */
let clientSecret: string | undefined;

// =============================================================================
// Types
// =============================================================================

/** Incoming event from EventBridge / CloudWatch */
interface AlarmEvent {
    readonly source?: string;
    readonly 'detail-type'?: string;
    readonly detail?: {
        readonly alarmName?: string;
        readonly state?: {
            readonly value?: string;
            readonly reason?: string;
        };
        readonly [key: string]: unknown;
    };
    readonly time?: string;
    readonly [key: string]: unknown;
}

/** Tool definition for Bedrock ConverseCommand */
interface AgentTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
}

/** MCP tools/list response shape */
interface McpToolsListResponse {
    readonly result?: {
        readonly tools?: ReadonlyArray<{
            readonly name: string;
            readonly description?: string;
            readonly inputSchema?: Record<string, unknown>;
        }>;
    };
}

/** Agent execution result */
interface AgentResult {
    readonly statusCode: number;
    readonly body: string;
}

// =============================================================================
// Structured Logger
// =============================================================================

/** Correlation ID for the current invocation */
let correlationId = '';

/**
 * Emit a structured JSON log line.
 *
 * Every log entry includes `correlationId`, `timestamp`, and `level`
 * for CloudWatch Logs Insights filterability.
 *
 * @param level - Log level (INFO, WARN, ERROR)
 * @param message - Human-readable message
 * @param data - Additional structured data
 */
function log(
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, unknown>,
): void {
    const entry = {
        level,
        message,
        correlationId,
        timestamp: new Date().toISOString(),
        ...data,
    };
    if (level === 'ERROR') {
        console.error(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

// =============================================================================
// Idempotency Guard
// =============================================================================

/**
 * In-memory deduplication cache.
 * Survives across warm invocations within the same Lambda container.
 * Key: `alarmName#eventTime`, Value: timestamp when first seen.
 */
const deduplicationCache = new Map<string, number>();

/** Maximum entries in the dedup cache before pruning */
const DEDUP_CACHE_MAX = 100;

/** Dedup window in milliseconds (5 minutes) */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Check if this event has already been processed within the dedup window.
 *
 * @param event - The incoming event
 * @returns true if the event is a duplicate and should be skipped
 */
function isDuplicate(event: AlarmEvent): boolean {
    const alarmName = event.detail?.alarmName ?? '';
    const eventTime = event.time ?? '';
    if (!alarmName) return false;

    const key = `${alarmName}#${eventTime}`;
    const now = Date.now();

    // Prune stale entries
    if (deduplicationCache.size > DEDUP_CACHE_MAX) {
        for (const [k, v] of deduplicationCache) {
            if (now - v > DEDUP_WINDOW_MS) {
                deduplicationCache.delete(k);
            }
        }
    }

    if (deduplicationCache.has(key)) {
        const firstSeen = deduplicationCache.get(key) as number;
        if (now - firstSeen < DEDUP_WINDOW_MS) {
            return true;
        }
    }

    deduplicationCache.set(key, now);
    return false;
}

// =============================================================================
// Prompt Builder
// =============================================================================

/**
 * Build a natural language prompt from the incoming event payload.
 *
 * Extracts key information from CloudWatch Alarm state changes or
 * generic EventBridge events and formats them for the agent.
 *
 * @param event - The incoming EventBridge event
 * @returns A structured natural language prompt
 */
function buildPrompt(event: AlarmEvent): string {
    const source = event.source ?? 'unknown';
    const detailType = event['detail-type'] ?? 'Unknown';
    const detail = event.detail ?? {};

    const dryRunNote = DRY_RUN
        ? 'DRY RUN MODE: Propose remediation steps but do NOT execute them.'
        : 'Execute the appropriate remediation steps.';

    // CloudWatch Alarm state change
    if (source === 'aws.cloudwatch') {
        const alarmName = detail.alarmName ?? 'unknown';
        const newState = detail.state?.value ?? 'unknown';
        const reason = detail.state?.reason ?? 'no reason provided';

        return [
            'A CloudWatch Alarm has fired.',
            `Alarm: ${alarmName}`,
            `New State: ${newState}`,
            `Reason: ${reason}`,
            '',
            dryRunNote,
            '',
            `Full event detail:\n${JSON.stringify(detail, null, 2)}`,
        ].join('\n');
    }

    // Generic EventBridge event
    return [
        'An infrastructure event has occurred.',
        `Source: ${source}`,
        `Type: ${detailType}`,
        '',
        dryRunNote,
        '',
        `Full event:\n${JSON.stringify(event, null, 2)}`,
    ].join('\n');
}

// =============================================================================
// OAuth2 Token Acquisition (Cognito Client Credentials Flow)
// =============================================================================

/**
 * Cognito OAuth2 token response shape.
 */
interface TokenResponse {
    readonly access_token: string;
    readonly expires_in: number;
    readonly token_type: string;
}

/**
 * Resolve the Cognito User Pool Client secret at cold start.
 *
 * Calls `DescribeUserPoolClient` to retrieve the auto-generated secret.
 * The result is cached for the lifetime of the Lambda container.
 *
 * @returns The client secret string
 * @throws Error if the secret cannot be retrieved
 */
async function resolveClientSecret(): Promise<string> {
    if (clientSecret) return clientSecret;

    if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) {
        throw new Error('Missing COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID — cannot resolve client secret');
    }

    const result = await cognito.send(new DescribeUserPoolClientCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
    }));

    const secret = result.UserPoolClient?.ClientSecret;
    if (!secret) {
        throw new Error(`Cognito client ${COGNITO_CLIENT_ID} has no client secret`);
    }

    clientSecret = secret;
    return secret;
}

/**
 * Obtain a valid OAuth2 access token for the MCP Gateway.
 *
 * Uses the Cognito client credentials grant flow. Tokens are cached
 * and refreshed when they are within {@link TOKEN_REFRESH_BUFFER_S}
 * seconds of expiry.
 *
 * @returns Bearer access token string
 */
async function getAccessToken(): Promise<string> {
    // Return cached token if still valid
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && tokenExpiresAt > now + TOKEN_REFRESH_BUFFER_S) {
        return cachedToken;
    }

    if (!COGNITO_TOKEN_ENDPOINT) {
        log('WARN', 'No COGNITO_TOKEN_ENDPOINT configured — Gateway calls will be unauthenticated');
        return '';
    }

    const secret = await resolveClientSecret();
    const credentials = Buffer.from(`${COGNITO_CLIENT_ID}:${secret}`).toString('base64');

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: COGNITO_SCOPES,
    });

    const response = await fetch(COGNITO_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${credentials}`,
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Token request failed (${response.status}): ${errorBody}`);
    }

    const tokenData = await response.json() as TokenResponse;
    cachedToken = tokenData.access_token;
    tokenExpiresAt = now + tokenData.expires_in;

    log('INFO', 'Obtained Cognito access token', {
        expiresIn: tokenData.expires_in,
        tokenType: tokenData.token_type,
    });

    return cachedToken;
}

// =============================================================================
// Dynamic Tool Discovery
// =============================================================================

/**
 * Discover available tools from the MCP Gateway via the tools/list endpoint.
 *
 * Falls back to the default hardcoded tool definitions if the Gateway
 * is unavailable, returns an error, or times out.
 *
 * @returns Array of tool definitions for Bedrock
 */
async function discoverTools(): Promise<AgentTool[]> {
    if (!GATEWAY_URL) {
        log('INFO', 'No GATEWAY_URL configured, using default tools');
        return getDefaultTools();
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

        const accessToken = await getAccessToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await fetch(GATEWAY_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'discover',
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const result = await response.json() as McpToolsListResponse;
        const mcpTools = result.result?.tools ?? [];

        if (mcpTools.length === 0) {
            log('WARN', 'MCP Gateway returned no tools, using defaults');
            return getDefaultTools();
        }

        const tools: AgentTool[] = mcpTools.map(t => ({
            name: t.name,
            description: t.description ?? `Tool: ${t.name}`,
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }));

        log('INFO', 'Discovered tools from MCP Gateway', {
            toolCount: tools.length,
            toolNames: tools.map(t => t.name),
        });

        return tools;
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('WARN', 'MCP tool discovery failed, using defaults', { error });
        return getDefaultTools();
    }
}

// =============================================================================
// Tool Invocation
// =============================================================================

/**
 * Invoke a tool registered with the AgentCore Gateway.
 *
 * Uses an AbortController-based timeout. If the Gateway URL is not set,
 * returns a stub response for development/testing.
 *
 * @param toolName - Name of the MCP tool to invoke
 * @param toolInput - Input parameters for the tool
 * @returns The tool's response as a string
 */
async function invokeTool(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
    if (!GATEWAY_URL) {
        return JSON.stringify({
            status: 'stub',
            message: `Would invoke tool '${toolName}' via MCP Gateway`,
            input: toolInput,
        });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

    try {
        const accessToken = await getAccessToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await fetch(GATEWAY_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: toolInput,
                },
                id: Date.now().toString(),
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const result = await response.json() as Record<string, unknown>;
        return JSON.stringify(result);
    } catch (err) {
        clearTimeout(timeoutId);
        const error = err instanceof Error ? err.message : String(err);
        log('ERROR', `Tool invocation failed: ${toolName}`, { error, toolInput });
        return JSON.stringify({ status: 'error', error });
    }
}

// =============================================================================
// Default Tool Definitions (fallback when MCP Gateway is unavailable)
// =============================================================================

/**
 * Default tool definitions for the self-healing agent.
 *
 * Used when the MCP Gateway is unavailable or returns no tools.
 * In production, tools are dynamically discovered from the Gateway.
 */
function getDefaultTools(): AgentTool[] {
    return [
        {
            name: 'diagnose_alarm',
            description: 'Analyse a CloudWatch Alarm and return diagnostic information about the affected resource',
            inputSchema: {
                type: 'object',
                properties: {
                    alarmName: { type: 'string', description: 'Name of the CloudWatch Alarm' },
                    alarmReason: { type: 'string', description: 'Reason the alarm fired' },
                },
                required: ['alarmName'],
            },
        },
        {
            name: 'ebs_detach',
            description: 'Detach an EBS volume from a terminated or unhealthy instance',
            inputSchema: {
                type: 'object',
                properties: {
                    volumeId: { type: 'string', description: 'The EBS volume ID to detach' },
                },
                required: ['volumeId'],
            },
        },
    ];
}

// =============================================================================
// Bedrock Tool Config Builder
// =============================================================================

/**
 * Convert agent tool definitions to Bedrock ConverseCommand ToolConfiguration.
 */
function buildToolConfig(tools: AgentTool[]): ToolConfiguration {
    const bedrockTools: Tool[] = tools.map(tool => ({
        toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: {
                json: tool.inputSchema as Record<string, unknown>,
            },
        },
    } as Tool));

    return { tools: bedrockTools };
}

// =============================================================================
// Core Agent Loop
// =============================================================================

/**
 * Execute the agentic remediation loop.
 *
 * Calls Bedrock with the prompt and tool definitions. If the model
 * requests a tool_use, invokes the tool and feeds the result back.
 * Repeats until the model produces a final text response or the
 * iteration limit is reached.
 *
 * @param prompt - The natural language prompt built from the event
 * @param tools - Discovered or default tool definitions
 * @returns The agent's final text response
 */
async function runAgentLoop(prompt: string, tools: AgentTool[]): Promise<string> {
    const toolConfig = buildToolConfig(tools);
    const systemPrompt: SystemContentBlock[] = [{ text: SYSTEM_PROMPT }];

    const messages: Message[] = [
        {
            role: 'user' as ConversationRole,
            content: [{ text: prompt }],
        },
    ];

    let totalToolCalls = 0;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const iterationStart = Date.now();

        const response = await bedrock.send(new ConverseCommand({
            modelId: FOUNDATION_MODEL,
            system: systemPrompt,
            messages,
            toolConfig,
        }));

        const iterationMs = Date.now() - iterationStart;
        const assistantContent = response.output?.message?.content ?? [];

        log('INFO', `Iteration ${iteration} completed`, {
            iteration,
            stopReason: response.stopReason,
            durationMs: iterationMs,
            inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
        });

        // Add assistant response to conversation
        messages.push({
            role: 'assistant' as ConversationRole,
            content: assistantContent,
        });

        // Check if model wants to use tools
        if (response.stopReason === 'tool_use') {
            const toolUseBlocks = assistantContent.filter(
                (block): block is ContentBlock.ToolUseMember => 'toolUse' in block,
            );

            const toolResults: ContentBlock[] = [];

            for (const block of toolUseBlocks) {
                const toolUse = block.toolUse as ToolUseBlock;
                const toolName = toolUse.name ?? 'unknown';
                const toolInput = (toolUse.input ?? {}) as Record<string, unknown>;

                totalToolCalls++;
                const toolStart = Date.now();

                log('INFO', `Invoking tool: ${toolName}`, {
                    iteration,
                    toolName,
                    toolInput,
                    totalToolCalls,
                });

                const result = await invokeTool(toolName, toolInput);

                log('INFO', `Tool completed: ${toolName}`, {
                    iteration,
                    toolName,
                    durationMs: Date.now() - toolStart,
                    resultLength: result.length,
                });

                const toolResultContent: ToolResultContentBlock = { text: result };
                const toolResult: ToolResultBlock = {
                    toolUseId: toolUse.toolUseId,
                    content: [toolResultContent],
                };

                toolResults.push({ toolResult } as ContentBlock);
            }

            // Feed tool results back to the model
            messages.push({
                role: 'user' as ConversationRole,
                content: toolResults,
            });

            continue;
        }

        // Model produced a final response — extract text
        const textBlocks = assistantContent.filter(
            (block): block is ContentBlock.TextMember => 'text' in block,
        );

        log('INFO', 'Agent loop completed', {
            totalIterations: iteration + 1,
            totalToolCalls,
        });

        return textBlocks.map(b => b.text).join('\n');
    }

    log('WARN', 'Agent reached maximum iterations', { MAX_ITERATIONS, totalToolCalls });
    return `Agent reached maximum iterations (${MAX_ITERATIONS}) without completing.`;
}

// =============================================================================
// Lambda Handler
// =============================================================================

/**
 * Main Lambda handler — receives failure events and orchestrates
 * remediation through the Bedrock agentic loop.
 *
 * Includes idempotency guard, dynamic tool discovery, structured
 * logging, and graceful error handling.
 *
 * @param event - CloudWatch Alarm / EventBridge event
 * @returns Structured remediation report
 */
export async function handler(event: AlarmEvent): Promise<AgentResult> {
    const handlerStart = Date.now();
    correlationId = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const alarmName = event.detail?.alarmName ?? 'unknown';

    log('INFO', 'Self-healing agent invoked', {
        source: event.source,
        detailType: event['detail-type'],
        alarmName,
        dryRun: DRY_RUN,
        foundationModel: FOUNDATION_MODEL,
    });

    // Idempotency check
    if (isDuplicate(event)) {
        log('INFO', 'Duplicate event detected, skipping', { alarmName });
        return {
            statusCode: 200,
            body: JSON.stringify({
                skipped: true,
                reason: 'Duplicate event within deduplication window',
                alarmName,
            }),
        };
    }

    try {
        // Discover available tools
        const tools = await discoverTools();

        const prompt = buildPrompt(event);
        log('INFO', 'Prompt built', { promptLength: prompt.length });

        const result = await runAgentLoop(prompt, tools);
        const durationMs = Date.now() - handlerStart;

        log('INFO', 'Agent completed successfully', { durationMs, alarmName });

        return {
            statusCode: 200,
            body: JSON.stringify({
                dryRun: DRY_RUN,
                result,
                source: event.source ?? 'unknown',
                alarmName,
                durationMs,
                correlationId,
            }),
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - handlerStart;

        log('ERROR', 'Agent execution failed', { error, durationMs, alarmName });

        return {
            statusCode: 500,
            body: JSON.stringify({
                error,
                dryRun: DRY_RUN,
                alarmName,
                durationMs,
                correlationId,
            }),
        };
    }
}

// =============================================================================
// Exported for testing
// =============================================================================

export { buildPrompt, isDuplicate, getDefaultTools, buildToolConfig };
export type { AlarmEvent, AgentTool, AgentResult };
