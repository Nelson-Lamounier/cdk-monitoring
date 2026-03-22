/**
 * @format
 * Bedrock Agent Invoke Handler
 *
 * API Gateway Lambda proxy integration that invokes a Bedrock Agent
 * using the AWS SDK v3 BedrockAgentRuntime client.
 *
 * Flow:
 * 1. Parse API Gateway proxy event → extract `prompt` and optional `sessionId`
 * 2. Generate a UUID session ID if none provided (conversation continuity)
 * 3. Call `InvokeAgent` with streaming response
 * 4. Collect completion chunks and assemble final text
 * 5. Return JSON response with CORS headers
 *
 * Environment Variables:
 *   AGENT_ID        — Bedrock Agent ID (from SSM)
 *   AGENT_ALIAS_ID  — Bedrock Agent Alias ID (from SSM)
 *   ALLOWED_ORIGINS — Comma-separated CORS origins (default: '*')
 */

import { randomUUID } from 'crypto';

import {
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type {
    ResponseStream,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// =============================================================================
// Configuration
// =============================================================================

const AGENT_ID = process.env.AGENT_ID ?? '';
const AGENT_ALIAS_ID = process.env.AGENT_ALIAS_ID ?? '';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? '*';

/** Maximum prompt length (validated by API Gateway, belt-and-braces check) */
const MAX_PROMPT_LENGTH = 10_000;

const client = new BedrockAgentRuntimeClient({});

// =============================================================================
// Types
// =============================================================================

/** Parsed request body from API Gateway */
interface InvokeRequestBody {
    readonly prompt: string;
    readonly sessionId?: string;
}

/** Successful response payload */
interface InvokeResponseBody {
    readonly response: string;
    readonly sessionId: string;
}

/** Error response payload */
interface ErrorResponseBody {
    readonly error: string;
    readonly message: string;
}

// =============================================================================
// Structured Logger
// =============================================================================

/**
 * Emit a structured JSON log line for CloudWatch Logs Insights.
 *
 * @param level - Log level
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
// Response Helpers
// =============================================================================

/**
 * Resolve the CORS origin header based on the request origin.
 *
 * @param requestOrigin - The Origin header from the incoming request
 * @returns The origin to set in Access-Control-Allow-Origin
 */
function resolveOrigin(requestOrigin?: string): string {
    if (ALLOWED_ORIGINS === '*') return '*';

    const allowed = ALLOWED_ORIGINS.split(',').map(o => o.trim());
    if (requestOrigin && allowed.includes(requestOrigin)) {
        return requestOrigin;
    }

    return allowed[0] ?? '*';
}

/**
 * Build a standardised API Gateway proxy response.
 *
 * @param statusCode - HTTP status code
 * @param body - Response body object
 * @param origin - CORS origin header value
 * @returns API Gateway proxy result
 */
function buildResponse(
    statusCode: number,
    body: InvokeResponseBody | ErrorResponseBody,
    origin: string,
): APIGatewayProxyResult {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
        },
        body: JSON.stringify(body),
    };
}

// =============================================================================
// Agent Invocation
// =============================================================================

/**
 * Invoke the Bedrock Agent and collect the streaming response.
 *
 * The InvokeAgent API returns an event stream. Each `chunk` event
 * contains a `bytes` field with a UTF-8 encoded fragment of the
 * agent's response text. We concatenate all chunks to build the
 * complete response.
 *
 * @param prompt - The user's input text
 * @param sessionId - Session ID for conversation continuity
 * @returns The agent's complete text response
 */
async function invokeAgent(prompt: string, sessionId: string): Promise<string> {
    const command = new InvokeAgentCommand({
        agentId: AGENT_ID,
        agentAliasId: AGENT_ALIAS_ID,
        sessionId,
        inputText: prompt,
    });

    const response = await client.send(command);

    if (!response.completion) {
        throw new Error('No completion stream returned from Bedrock Agent');
    }

    const chunks: string[] = [];

    for await (const event of response.completion as AsyncIterable<ResponseStream>) {
        if ('chunk' in event && event.chunk?.bytes) {
            const text = new TextDecoder('utf-8').decode(event.chunk.bytes);
            chunks.push(text);
        }
    }

    return chunks.join('');
}

// =============================================================================
// Lambda Handler
// =============================================================================

/**
 * API Gateway Lambda proxy handler for Bedrock Agent invocation.
 *
 * Expects a JSON body with:
 * - `prompt` (string, required) — the user's question
 * - `sessionId` (string, optional) — for conversation continuity
 *
 * Returns:
 * - `response` (string) — the agent's text reply
 * - `sessionId` (string) — the session ID (generated if not provided)
 *
 * @param event - API Gateway proxy event
 * @returns API Gateway proxy result
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const origin = resolveOrigin(event.headers?.origin ?? event.headers?.Origin);
    const startTime = Date.now();

    try {
        // Validate environment
        if (!AGENT_ID || !AGENT_ALIAS_ID) {
            log('ERROR', 'Missing AGENT_ID or AGENT_ALIAS_ID environment variables');
            return buildResponse(500, {
                error: 'ConfigurationError',
                message: 'Agent not configured',
            }, origin);
        }

        // Parse request body
        if (!event.body) {
            return buildResponse(400, {
                error: 'BadRequest',
                message: 'Request body is required',
            }, origin);
        }

        const body: InvokeRequestBody = JSON.parse(event.body);

        if (!body.prompt || typeof body.prompt !== 'string') {
            return buildResponse(400, {
                error: 'BadRequest',
                message: 'prompt is required and must be a string',
            }, origin);
        }

        if (body.prompt.length > MAX_PROMPT_LENGTH) {
            return buildResponse(400, {
                error: 'BadRequest',
                message: `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`,
            }, origin);
        }

        const sessionId = body.sessionId ?? randomUUID();

        log('INFO', 'Invoking Bedrock Agent', {
            agentId: AGENT_ID,
            sessionId,
            promptLength: body.prompt.length,
        });

        // Invoke the agent
        const agentResponse = await invokeAgent(body.prompt, sessionId);

        const durationMs = Date.now() - startTime;

        log('INFO', 'Agent invocation completed', {
            sessionId,
            responseLength: agentResponse.length,
            durationMs,
        });

        return buildResponse(200, {
            response: agentResponse,
            sessionId,
        }, origin);

    } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorName = err instanceof Error ? err.name : 'UnknownError';

        log('ERROR', 'Agent invocation failed', {
            error: errorMessage,
            errorName,
            durationMs,
        });

        // Client errors (validation, throttling)
        if (errorName === 'ValidationException' || errorName === 'ThrottlingException') {
            return buildResponse(400, {
                error: errorName,
                message: errorMessage,
            }, origin);
        }

        return buildResponse(500, {
            error: 'InternalError',
            message: 'Failed to invoke agent',
        }, origin);
    }
}
