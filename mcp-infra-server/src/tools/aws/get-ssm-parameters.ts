/**
 * @fileoverview MCP tool: get-ssm-parameters
 *
 * Reads SSM parameters by path prefix for cross-stack resource discovery.
 * Enables dynamic lookup of table names, API URLs, bucket names, etc.
 *
 * @module tools/get-ssm-parameters
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';

import type { AwsClients } from '../../clients/aws-client.js';
import { GetSsmParametersSchema } from '../../schemas/aws-params.js';
import { formatSsmParameters, formatAwsErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `get-ssm-parameters` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - AWS service clients.
 */
export function registerGetSsmParameters(server: McpServer, clients: AwsClients): void {
  server.tool(
    'get-ssm-parameters',
    'Read SSM parameters by path prefix. Useful for discovering DynamoDB table names, API URLs, bucket names, and other infrastructure references.',
    GetSsmParametersSchema,
    async (params) => {
      try {
        const { pathPrefix, recursive } = params;

        const allParameters: Array<{ name: string; value: string; type: string }> = [];
        let nextToken: string | undefined;

        // Paginate through all parameters under the prefix
        do {
          const result = await clients.ssmClient.send(
            new GetParametersByPathCommand({
              Path: pathPrefix,
              Recursive: recursive,
              WithDecryption: false, // Don't decrypt SecureString values
              NextToken: nextToken,
            }),
          );

          for (const param of result.Parameters ?? []) {
            allParameters.push({
              name: param.Name ?? '',
              value: param.Value ?? '',
              type: param.Type ?? 'String',
            });
          }

          nextToken = result.NextToken;
        } while (nextToken);

        if (allParameters.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No SSM parameters found under prefix '${pathPrefix}'.\n\nCommon prefixes:\n  /nextjs/development\n  /bedrock/development\n  /k8s/development\n  /shared/vpc/development\n  /shared/ecr/development`,
              },
            ],
          };
        }

        // Sort by name for consistent output
        allParameters.sort((a, b) => a.name.localeCompare(b.name));

        const summary = `Found ${allParameters.length} parameter(s) under '${pathPrefix}'`;

        return {
          content: [
            { type: 'text' as const, text: `${summary}\n\n${formatSsmParameters(allParameters)}` },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsErrorForMcp(error, 'get-ssm-parameters') },
          ],
          isError: true,
        };
      }
    },
  );
}
