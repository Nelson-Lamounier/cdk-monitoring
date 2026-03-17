/**
 * @fileoverview MCP tool: query-dynamo
 *
 * Query or scan a DynamoDB table with optional key conditions and filters.
 * Supports both targeted key-based queries and full table scans.
 *
 * @module tools/query-dynamo
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import type { AwsClients } from '../../clients/aws-client.js';
import { QueryDynamoSchema } from '../../schemas/aws-params.js';
import { formatDynamoItems, formatAwsErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `query-dynamo` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - AWS service clients.
 */
export function registerQueryDynamo(server: McpServer, clients: AwsClients): void {
  server.tool(
    'query-dynamo',
    'Query or scan a DynamoDB table with optional key conditions. Use scanAll=true for a full table scan.',
    QueryDynamoSchema,
    async (params) => {
      try {
        const { tableName, partitionKey, partitionValue, sortKey, sortValue, indexName, limit, scanAll } = params;

        if (scanAll || (!partitionKey && !partitionValue)) {
          // Full table scan
          const result = await clients.docClient.send(
            new ScanCommand({
              TableName: tableName,
              Limit: limit,
              ...(indexName ? { IndexName: indexName } : {}),
            }),
          );

          const items = (result.Items ?? []) as Record<string, unknown>[];
          const summary = `Scan returned ${items.length} items (scanned ${result.ScannedCount ?? 0})`;

          return {
            content: [
              { type: 'text' as const, text: `${summary}\n\n${formatDynamoItems(items, limit)}` },
            ],
          };
        }

        // Key-based query
        if (!partitionKey || !partitionValue) {
          return {
            content: [
              { type: 'text' as const, text: 'Error: partitionKey and partitionValue are required for key-based queries. Use scanAll=true for full scans.' },
            ],
            isError: true,
          };
        }

        const keyCondition = sortKey && sortValue
          ? `#pk = :pk AND #sk = :sk`
          : `#pk = :pk`;

        const expressionNames: Record<string, string> = {
          '#pk': partitionKey,
          ...(sortKey ? { '#sk': sortKey } : {}),
        };

        const expressionValues: Record<string, string> = {
          ':pk': partitionValue,
          ...(sortValue ? { ':sk': sortValue } : {}),
        };

        const result = await clients.docClient.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: keyCondition,
            ExpressionAttributeNames: expressionNames,
            ExpressionAttributeValues: expressionValues,
            Limit: limit,
            ...(indexName ? { IndexName: indexName } : {}),
          }),
        );

        const items = (result.Items ?? []) as Record<string, unknown>[];
        const summary = `Query returned ${items.length} items`;

        return {
          content: [
            { type: 'text' as const, text: `${summary}\n\n${formatDynamoItems(items, limit)}` },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsErrorForMcp(error, 'query-dynamo') },
          ],
          isError: true,
        };
      }
    },
  );
}
