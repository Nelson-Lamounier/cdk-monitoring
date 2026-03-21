/**
 * @fileoverview MCP tool: test-api-endpoint
 *
 * Makes an HTTP request to any URL and returns status, headers, and body.
 * Useful for testing API Gateway endpoints, health checks, and external APIs.
 *
 * @module tools/test-api-endpoint
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AwsClients } from '../../clients/aws-client.js';
import { TestApiEndpointSchema } from '../../schemas/aws-params.js';
import { formatHttpResponse, formatAwsErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `test-api-endpoint` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param _clients - AWS service clients (unused, but kept for interface consistency).
 */
export function registerTestApiEndpoint(server: McpServer, _clients: AwsClients): void {
  server.tool(
    'test-api-endpoint',
    'Make an HTTP request to any URL and return the status code, headers, and response body. Supports GET, POST, PUT, DELETE, and PATCH.',
    TestApiEndpointSchema,
    async (params) => {
      try {
        const { url, method, body, headers, timeoutMs } = params;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const fetchHeaders: Record<string, string> = {
          'Accept': 'application/json',
          ...headers,
        };

        if (body && !fetchHeaders['Content-Type']) {
          fetchHeaders['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: body ?? undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const responseBody = await response.text();

        return {
          content: [
            {
              type: 'text' as const,
              text: formatHttpResponse(response.status, responseHeaders, responseBody),
            },
          ],
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return {
            content: [
              { type: 'text' as const, text: `[test-api-endpoint] Request timed out after ${params.timeoutMs}ms` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: 'text' as const, text: formatAwsErrorForMcp(error, 'test-api-endpoint') },
          ],
          isError: true,
        };
      }
    },
  );
}
