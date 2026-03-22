/**
 * @format
 * Unit tests for the Bedrock Agent Invoke Lambda handler.
 *
 * Mocks the BedrockAgentRuntimeClient to test request parsing,
 * response assembly, CORS headers, session management, and error handling.
 */

// =============================================================================
// Environment variables — must be set BEFORE handler module loads, because
// the handler reads them at module scope (top-level `const`).
// =============================================================================
process.env.AGENT_ID = 'test-agent-id';
process.env.AGENT_ALIAS_ID = 'test-alias-id';
process.env.ALLOWED_ORIGINS = 'https://example.com,https://dev.example.com';

// =============================================================================
// Mocks — Jest hoists variables prefixed with `mock` above jest.mock()
// =============================================================================
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
    BedrockAgentRuntimeClient: jest.fn(() => ({ send: mockSend })),
    InvokeAgentCommand: jest.fn((input: unknown) => input),
}));

// Import handler AFTER env vars and mocks are set up
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { handler } from './index';


// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Build a minimal API Gateway proxy event for testing.
 *
 * @param body - Request body (will be JSON-stringified)
 * @param headers - Optional headers
 * @returns A partial APIGatewayProxyEvent
 */
function buildEvent(
    body: Record<string, unknown> | null,
    headers: Record<string, string> = {},
): APIGatewayProxyEvent {
    return {
        body: body ? JSON.stringify(body) : null,
        headers,
        httpMethod: 'POST',
        path: '/invoke',
        isBase64Encoded: false,
        pathParameters: null,
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        stageVariables: null,
        requestContext: {} as APIGatewayProxyEvent['requestContext'],
        resource: '/invoke',
        multiValueHeaders: {},
    };
}

/**
 * Create a mock async iterable that yields Bedrock Agent response chunks.
 *
 * @param texts - Array of text chunks to yield
 * @returns An async iterable of ResponseStream events
 */
async function* mockCompletionStream(texts: string[]) {
    for (const text of texts) {
        yield {
            chunk: {
                bytes: new TextEncoder().encode(text),
            },
        };
    }
}

// =============================================================================
// Tests
// =============================================================================

describe('Bedrock invoke-agent handler', () => {
    beforeEach(() => {
        mockSend.mockReset();
    });

    describe('Successful invocations', () => {
        it('should invoke the agent and return assembled response', async () => {
            mockSend.mockResolvedValue({
                completion: mockCompletionStream([
                    'Hello, ',
                    'I am your ',
                    'portfolio assistant.',
                ]),
            });

            const event = buildEvent(
                { prompt: 'Tell me about this project' },
                { origin: 'https://example.com' },
            );

            const result = await handler(event);

            expect(result.statusCode).toBe(200);

            const body = JSON.parse(result.body);
            expect(body.response).toBe('Hello, I am your portfolio assistant.');
            expect(body.sessionId).toBeDefined();
        });

        it('should use the provided sessionId for conversation continuity', async () => {
            mockSend.mockResolvedValue({
                completion: mockCompletionStream(['Response text']),
            });

            const event = buildEvent({
                prompt: 'Follow-up question',
                sessionId: 'existing-session-123',
            });

            const result = await handler(event);
            const body = JSON.parse(result.body);

            expect(result.statusCode).toBe(200);
            expect(body.sessionId).toBe('existing-session-123');
        });

        it('should generate a UUID sessionId when not provided', async () => {
            mockSend.mockResolvedValue({
                completion: mockCompletionStream(['Response']),
            });

            const event = buildEvent({ prompt: 'Hello' });
            const result = await handler(event);
            const body = JSON.parse(result.body);

            expect(body.sessionId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            );
        });
    });

    describe('CORS headers', () => {
        it('should return the matching allowed origin', async () => {
            mockSend.mockResolvedValue({
                completion: mockCompletionStream(['OK']),
            });

            const event = buildEvent(
                { prompt: 'Test' },
                { origin: 'https://dev.example.com' },
            );

            const result = await handler(event);

            expect(result.headers?.['Access-Control-Allow-Origin']).toBe('https://dev.example.com');
        });

        it('should fall back to first allowed origin for unknown origins', async () => {
            mockSend.mockResolvedValue({
                completion: mockCompletionStream(['OK']),
            });

            const event = buildEvent(
                { prompt: 'Test' },
                { origin: 'https://malicious.com' },
            );

            const result = await handler(event);

            expect(result.headers?.['Access-Control-Allow-Origin']).toBe('https://example.com');
        });
    });

    describe('Error handling', () => {
        it('should return 400 when body is missing', async () => {
            const event = buildEvent(null);
            const result = await handler(event);

            expect(result.statusCode).toBe(400);

            const body = JSON.parse(result.body);
            expect(body.error).toBe('BadRequest');
        });

        it('should return 400 when prompt is missing', async () => {
            const event = buildEvent({ sessionId: 'abc' });
            const result = await handler(event);

            expect(result.statusCode).toBe(400);

            const body = JSON.parse(result.body);
            expect(body.error).toBe('BadRequest');
        });

        it('should return 400 for validation errors from Bedrock', async () => {
            const validationError = new Error('Invalid input');
            validationError.name = 'ValidationException';
            mockSend.mockRejectedValue(validationError);

            const event = buildEvent({ prompt: 'Test' });
            const result = await handler(event);

            expect(result.statusCode).toBe(400);

            const body = JSON.parse(result.body);
            expect(body.error).toBe('ValidationException');
        });

        it('should return 500 for unexpected errors', async () => {
            mockSend.mockRejectedValue(new Error('Service unavailable'));

            const event = buildEvent({ prompt: 'Test' });
            const result = await handler(event);

            expect(result.statusCode).toBe(500);

            const body = JSON.parse(result.body);
            expect(body.error).toBe('InternalError');
        });
    });
});
