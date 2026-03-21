/**
 * @fileoverview MCP tool: list-subscriptions
 *
 * Lists email subscriptions from DynamoDB, filtered by status.
 * Uses the GSI on `gsi1pk = "ENTITY#EMAIL"` to list all subscriptions efficiently.
 *
 * @module tools/list-subscriptions
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import type { AwsClients } from '../../clients/aws-client.js';
import { ListSubscriptionsSchema } from '../../schemas/aws-params.js';
import { formatAwsErrorForMcp } from '../../utils/index.js';

/** GSI partition key for email subscriptions */
const ENTITY_EMAIL_PK = 'ENTITY#EMAIL';

/**
 * Registers the `list-subscriptions` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - AWS service clients.
 */
export function registerListSubscriptions(server: McpServer, clients: AwsClients): void {
  server.tool(
    'list-subscriptions',
    'List email subscriptions from DynamoDB. Filter by status: pending, verified, or all.',
    ListSubscriptionsSchema,
    async (params) => {
      try {
        const { tableName, status, limit } = params;

        let items: Record<string, unknown>[];

        // Try GSI query first (most efficient)
        try {
          const gsiResult = await clients.docClient.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'gsi1',
              KeyConditionExpression: '#pk = :pk',
              ExpressionAttributeNames: { '#pk': 'gsi1pk' },
              ExpressionAttributeValues: { ':pk': ENTITY_EMAIL_PK },
              Limit: limit,
              ScanIndexForward: false, // Newest first
            }),
          );
          items = (gsiResult.Items ?? []) as Record<string, unknown>[];
        } catch {
          // Fallback to scan if GSI doesn't exist
          const scanResult = await clients.docClient.send(
            new ScanCommand({
              TableName: tableName,
              FilterExpression: 'begins_with(#pk, :prefix)',
              ExpressionAttributeNames: { '#pk': 'pk' },
              ExpressionAttributeValues: { ':prefix': 'EMAIL#' },
              Limit: limit,
            }),
          );
          items = (scanResult.Items ?? []) as Record<string, unknown>[];
        }

        // Apply status filter
        if (status !== 'all') {
          items = items.filter((item) => item.status === status);
        }

        if (items.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: `No subscriptions found${status !== 'all' ? ` with status '${status}'` : ''}.` },
            ],
          };
        }

        // Format as readable table
        const header = 'EMAIL                                  STATUS     SUBSCRIBED AT              NAME';
        const separator = '-'.repeat(header.length);
        const rows = items.map((item) => {
          const email = String(item.email ?? '').padEnd(39);
          const itemStatus = String(item.status ?? '').padEnd(10);
          const subscribedAt = String(item.subscribedAt ?? '').padEnd(26);
          const name = String(item.name ?? '');
          return `${email} ${itemStatus} ${subscribedAt} ${name}`;
        });

        const summary = `Found ${items.length} subscription(s)${status !== 'all' ? ` with status '${status}'` : ''}`;

        return {
          content: [
            { type: 'text' as const, text: `${summary}\n\n${header}\n${separator}\n${rows.join('\n')}` },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsErrorForMcp(error, 'list-subscriptions') },
          ],
          isError: true,
        };
      }
    },
  );
}
