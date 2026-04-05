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
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

// =============================================================================
// Configuration
// =============================================================================

const GATEWAY_URL = process.env.GATEWAY_URL ?? '';
const FOUNDATION_MODEL = process.env.FOUNDATION_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? FOUNDATION_MODEL;
const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ?? 'You are an infrastructure remediation agent.';

/** Cognito OAuth2 configuration for Gateway M2M auth */
const COGNITO_TOKEN_ENDPOINT = process.env.COGNITO_TOKEN_ENDPOINT ?? '';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const COGNITO_SCOPES = process.env.COGNITO_SCOPES ?? '';

/** SNS topic ARN for remediation report notifications */
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN ?? '';

/** S3 bucket for conversation session memory */
const MEMORY_BUCKET = process.env.MEMORY_BUCKET ?? '';

/** Maximum agentic loop iterations to prevent runaway execution */
const MAX_ITERATIONS = 10;

/** Timeout for MCP Gateway HTTP calls (milliseconds) */
const MCP_TIMEOUT_MS = 10_000;

/** Buffer before token expiry to trigger refresh (seconds) */
const TOKEN_REFRESH_BUFFER_S = 60;

const bedrock = new BedrockRuntimeClient({});
const cognito = new CognitoIdentityProviderClient({});
const snsClient = new SNSClient({});
const s3Client = new S3Client({});

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

/**
 * Session record stored in S3 for conversation memory.
 *
 * Captures a compact summary of each agent invocation so that
 * subsequent retries can reference what was previously attempted.
 */
interface SessionRecord {
    readonly alarmName: string;
    readonly timestamp: string;
    readonly correlationId: string;
    readonly prompt: string;
    readonly toolsCalled: string[];
    readonly result: string;
    readonly dryRun: boolean;
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

        // SSM Bootstrap failure — inject diagnostic workflow guidance
        const bootstrapGuidance = isBootstrapAlarm(alarmName)
            ? buildBootstrapDiagnosticGuidance()
            : '';

        return [
            'A CloudWatch Alarm has fired.',
            `Alarm: ${alarmName}`,
            `New State: ${newState}`,
            `Reason: ${reason}`,
            '',
            dryRunNote,
            bootstrapGuidance,
            `Full event detail:\n${JSON.stringify(detail, null, 2)}`,
        ].filter(Boolean).join('\n');
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
        {
            name: 'check_node_health',
            description: 'Check whether Kubernetes worker nodes have joined the cluster and are in Ready state via SSM on the control plane',
            inputSchema: {
                type: 'object',
                properties: {
                    nodeNameFilter: { type: 'string', description: 'Optional substring filter for node names' },
                },
            },
        },
        {
            name: 'analyse_cluster_health',
            description: 'Analyse Kubernetes cluster health using K8sGPT. Diagnoses workload issues such as failing pods, misconfigured services, and unhealthy deployments. Falls back to kubectl if K8sGPT is not installed.',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Optional namespace to analyse (e.g. "argocd", "cert-manager")' },
                    filters: {
                        type: 'array',
                        description: 'Optional K8sGPT analyser filters (e.g. ["Pod", "Service"])',
                        items: { type: 'string' },
                    },
                },
            },
        },
        {
            name: 'get_node_diagnostic_json',
            description: 'Fetch the machine-readable run_summary.json from a Kubernetes node via SSM. Returns the bootstrap step status, failure classification code (AMI_MISMATCH, S3_FORBIDDEN, KUBEADM_FAIL, CALICO_TIMEOUT, ARGOCD_SYNC_FAIL, CW_AGENT_FAIL), and per-step timing. Use this FIRST when diagnosing bootstrap failures.',
            inputSchema: {
                type: 'object',
                properties: {
                    instanceId: { type: 'string', description: 'EC2 instance ID to diagnose' },
                },
                required: ['instanceId'],
            },
        },
        {
            name: 'remediate_node_bootstrap',
            description: 'Trigger the SSM Automation Document to re-run the bootstrap sequence on a failed Kubernetes node. Resolves the correct Document name and IAM role from SSM Parameter Store. Use this AFTER diagnosing the failure with get_node_diagnostic_json and confirming the failure is transient.',
            inputSchema: {
                type: 'object',
                properties: {
                    instanceId: { type: 'string', description: 'EC2 instance ID to remediate' },
                    role: {
                        type: 'string',
                        description: 'Node role: "control-plane" or "worker"',
                        enum: ['control-plane', 'worker'],
                    },
                },
                required: ['instanceId', 'role'],
            },
        },
    ];
}

// =============================================================================
// Bootstrap Alarm Detection & Diagnostic Guidance
// =============================================================================

/** Known bootstrap-related alarm name patterns */
const BOOTSTRAP_ALARM_PATTERNS = [
    'bootstrap-orchestrator',
    'ssm-automation',
    'step-function',
    'k8s-bootstrap',
];

/**
 * Determine whether an alarm name relates to the SSM bootstrap pipeline.
 *
 * @param alarmName - CloudWatch alarm name
 * @returns true if the alarm is bootstrap-related
 */
function isBootstrapAlarm(alarmName: string): boolean {
    const lower = alarmName.toLowerCase();
    return BOOTSTRAP_ALARM_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Build structured diagnostic guidance for bootstrap failures.
 *
 * Injected into the agent prompt when a bootstrap-related alarm fires.
 * Guides the agent through a deterministic diagnostic → remediation flow.
 *
 * @returns Formatted guidance block
 */
function buildBootstrapDiagnosticGuidance(): string {
    return [
        '',
        '─── SSM BOOTSTRAP FAILURE DETECTED ───',
        'This alarm relates to the Kubernetes node bootstrap pipeline.',
        'Follow this diagnostic workflow:',
        '',
        '1. DIAGNOSE: Use `get_node_diagnostic_json` to fetch the run_summary.json',
        '   from the affected instance. This reveals the exact failed step and',
        '   failure code (e.g., AMI_MISMATCH, S3_FORBIDDEN, KUBEADM_FAIL).',
        '',
        '2. CLASSIFY: Determine if the failure is:',
        '   - TRANSIENT: Network timeouts, S3 eventual consistency, NLB propagation',
        '     → Safe to retry by triggering `remediate_node_bootstrap`.',
        '   - PERMANENT: AMI mismatch, IAM permission denied, corrupted certificates',
        '     → Report to operator; do NOT retry automatically.',
        '',
        '3. REMEDIATE (transient only): Use `remediate_node_bootstrap` with the',
        '   correct role (control-plane or worker) to re-trigger the SSM Document.',
        '',
        '4. VERIFY: After remediation, use `check_node_health` to confirm the node',
        '   joined the cluster, then `analyse_cluster_health` for workload health.',
        '───────────────────────────────────────',
        '',
    ].join('\n');
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
 * @returns Object with the agent's final text response and tools called
 */
async function runAgentLoop(prompt: string, tools: AgentTool[]): Promise<{ text: string; toolsCalled: string[] }> {
    const toolConfig = buildToolConfig(tools);
    const systemPrompt: SystemContentBlock[] = [{ text: SYSTEM_PROMPT }];

    const messages: Message[] = [
        {
            role: 'user' as ConversationRole,
            content: [{ text: prompt }],
        },
    ];

    let totalToolCalls = 0;
    const toolNamesCalled: string[] = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const iterationStart = Date.now();

        const response = await bedrock.send(new ConverseCommand({
            modelId: EFFECTIVE_MODEL_ID,
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
                toolNamesCalled.push(toolName);
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

        return { text: textBlocks.map(b => b.text).join('\n'), toolsCalled: [...new Set(toolNamesCalled)] };
    }

    log('WARN', 'Agent reached maximum iterations', { MAX_ITERATIONS, totalToolCalls });
    return {
        text: `Agent reached maximum iterations (${MAX_ITERATIONS}) without completing.`,
        toolsCalled: [...new Set(toolNamesCalled)],
    };
}

// =============================================================================
// SNS — Remediation Report Publishing
// =============================================================================

/**
 * Report payload published to the SNS topic after each agent invocation.
 */
interface ReportPayload {
    readonly status: 'SUCCESS' | 'ERROR';
    readonly alarmName: string;
    readonly dryRun: boolean;
    readonly durationMs: number;
    readonly correlationId: string;
    readonly report: string;
}

/**
 * Publish a remediation report to the SNS topic.
 *
 * Sends a human-readable email via SNS so operators receive immediate
 * visibility into every agent invocation. Silently skips if the topic
 * ARN is not configured.
 *
 * @param payload - Structured report data
 */
async function publishReport(payload: ReportPayload): Promise<void> {
    if (!SNS_TOPIC_ARN) {
        log('WARN', 'No SNS_TOPIC_ARN configured — skipping report notification');
        return;
    }

    const mode = payload.dryRun ? '🔍 DRY RUN' : '⚡ LIVE';
    const icon = payload.status === 'SUCCESS' ? '✅' : '❌';

    const subject = `${icon} Self-Healing ${payload.status}: ${payload.alarmName} [${mode}]`;

    const message = [
        `${icon} Self-Healing Agent Report`,
        `${'═'.repeat(50)}`,
        '',
        `Alarm:          ${payload.alarmName}`,
        `Status:         ${payload.status}`,
        `Mode:           ${mode}`,
        `Duration:       ${(payload.durationMs / 1000).toFixed(1)}s`,
        `Correlation ID: ${payload.correlationId}`,
        '',
        `${'─'.repeat(50)}`,
        'REMEDIATION REPORT',
        `${'─'.repeat(50)}`,
        '',
        payload.report,
        '',
        `${'─'.repeat(50)}`,
        `Timestamp: ${new Date().toISOString()}`,
    ].join('\n');

    try {
        await snsClient.send(new PublishCommand({
            TopicArn: SNS_TOPIC_ARN,
            Subject: subject.slice(0, 100), // SNS subject max 100 chars
            Message: message,
        }));

        log('INFO', 'Remediation report published to SNS', {
            topicArn: SNS_TOPIC_ARN,
            status: payload.status,
        });
    } catch (err) {
        // Non-fatal — log but don't fail the handler
        const error = err instanceof Error ? err.message : String(err);
        log('WARN', 'Failed to publish SNS report', { error });
    }
}

// =============================================================================
// S3 — Conversation Session Memory
// =============================================================================

/**
 * Sanitise an alarm name for use as an S3 key prefix.
 *
 * Replaces characters that are awkward in S3 keys (spaces, slashes,
 * colons) with hyphens and lowercases the result.
 *
 * @param alarmName - Raw CloudWatch alarm name
 * @returns Sanitised string safe for S3 key use
 */
function sanitiseAlarmKey(alarmName: string): string {
    return alarmName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Load the most recent session record for a given alarm.
 *
 * Lists objects under `sessions/{sanitisedAlarmName}/` and retrieves
 * the lexicographically last key (ISO timestamps sort naturally).
 *
 * @param alarmName - The CloudWatch alarm name
 * @returns The most recent session record, or undefined if none exists
 */
async function loadPreviousSession(alarmName: string): Promise<SessionRecord | undefined> {
    if (!MEMORY_BUCKET) return undefined;

    const prefix = `sessions/${sanitiseAlarmKey(alarmName)}/`;

    try {
        const listResult = await s3Client.send(new ListObjectsV2Command({
            Bucket: MEMORY_BUCKET,
            Prefix: prefix,
            MaxKeys: 10,
        }));

        const contents = listResult.Contents ?? [];
        if (contents.length === 0) {
            log('INFO', 'No previous sessions found', { alarmName, prefix });
            return undefined;
        }

        // Sort descending by key (ISO timestamps sort lexicographically)
        contents.sort((a, b) => (b.Key ?? '').localeCompare(a.Key ?? ''));
        const latestKey = contents[0].Key;
        if (!latestKey) return undefined;

        const getResult = await s3Client.send(new GetObjectCommand({
            Bucket: MEMORY_BUCKET,
            Key: latestKey,
        }));

        const body = await getResult.Body?.transformToString();
        if (!body) return undefined;

        const record = JSON.parse(body) as SessionRecord;
        log('INFO', 'Loaded previous session', {
            alarmName,
            previousTimestamp: record.timestamp,
            previousCorrelationId: record.correlationId,
            toolsUsed: record.toolsCalled,
        });

        return record;
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('WARN', 'Failed to load previous session', { alarmName, error });
        return undefined;
    }
}

/**
 * Save a session record to S3 after agent completion.
 *
 * Key format: `sessions/{sanitisedAlarmName}/{ISO-timestamp}.json`
 *
 * @param record - Session data to persist
 */
async function saveSession(record: SessionRecord): Promise<void> {
    if (!MEMORY_BUCKET) return;

    const key = `sessions/${sanitiseAlarmKey(record.alarmName)}/${record.timestamp}.json`;

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: MEMORY_BUCKET,
            Key: key,
            ContentType: 'application/json',
            Body: JSON.stringify(record, null, 2),
        }));

        log('INFO', 'Session saved to S3', { key, alarmName: record.alarmName });
    } catch (err) {
        // Non-fatal — log but don't fail the handler
        const error = err instanceof Error ? err.message : String(err);
        log('WARN', 'Failed to save session to S3', { key, error });
    }
}

/**
 * Build a prompt supplement from a previous session record.
 *
 * Inserted into the agent prompt so the model is aware of prior
 * remediation attempts and can avoid repeating the same actions.
 *
 * @param session - The previous session record
 * @returns A formatted string block for prompt injection
 */
function buildPreviousSessionContext(session: SessionRecord): string {
    const toolsList = session.toolsCalled.length > 0
        ? session.toolsCalled.join(', ')
        : 'none';

    return [
        '',
        '─── PREVIOUS REMEDIATION ATTEMPT (do NOT repeat the same actions) ───',
        `Time: ${session.timestamp}`,
        `Correlation ID: ${session.correlationId}`,
        `Mode: ${session.dryRun ? 'DRY RUN' : 'LIVE'}`,
        `Tools called: ${toolsList}`,
        `Outcome:`,
        session.result.slice(0, 2000),
        '───────────────────────────────────────────────────────────────────────',
        '',
    ].join('\n');
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

        // Load previous session for this alarm (if any)
        const previousSession = await loadPreviousSession(alarmName);

        let prompt = buildPrompt(event);
        if (previousSession) {
            prompt += buildPreviousSessionContext(previousSession);
            log('INFO', 'Prompt enriched with previous session context', {
                previousTimestamp: previousSession.timestamp,
            });
        }
        log('INFO', 'Prompt built', { promptLength: prompt.length, hasPreviousSession: !!previousSession });

        const loopResult = await runAgentLoop(prompt, tools);
        const durationMs = Date.now() - handlerStart;

        log('INFO', 'Agent completed successfully', { durationMs, alarmName, toolsCalled: loopResult.toolsCalled });

        // Save session record to S3 for future retries
        await saveSession({
            alarmName,
            timestamp: new Date().toISOString(),
            correlationId,
            prompt,
            toolsCalled: loopResult.toolsCalled,
            result: loopResult.text,
            dryRun: DRY_RUN,
        });

        // Publish remediation report to SNS for operator visibility
        await publishReport({
            status: 'SUCCESS',
            alarmName,
            dryRun: DRY_RUN,
            durationMs,
            correlationId,
            report: loopResult.text,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                dryRun: DRY_RUN,
                result: loopResult.text,
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

        // Publish error notification to SNS
        await publishReport({
            status: 'ERROR',
            alarmName,
            dryRun: DRY_RUN,
            durationMs,
            correlationId,
            report: `Agent execution failed: ${error}`,
        });

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

export { buildPrompt, isDuplicate, getDefaultTools, buildToolConfig, sanitiseAlarmKey, buildPreviousSessionContext };
export type { AlarmEvent, AgentTool, AgentResult, SessionRecord };
