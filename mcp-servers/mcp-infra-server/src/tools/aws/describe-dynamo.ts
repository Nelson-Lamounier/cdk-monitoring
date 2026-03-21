/**
 * @fileoverview MCP tool: describe-dynamo
 *
 * Retrieves DynamoDB table schema, GSIs, item count, and billing mode.
 *
 * @module tools/describe-dynamo
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';

import type { AwsClients } from '../../clients/aws-client.js';
import { DescribeDynamoSchema } from '../../schemas/aws-params.js';
import { formatAwsErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `describe-dynamo` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - AWS service clients.
 */
export function registerDescribeDynamo(server: McpServer, clients: AwsClients): void {
  server.tool(
    'describe-dynamo',
    'Get DynamoDB table schema, indexes, item count, billing mode, and encryption details.',
    DescribeDynamoSchema,
    async (params) => {
      try {
        const result = await clients.dynamoClient.send(
          new DescribeTableCommand({ TableName: params.tableName }),
        );

        const table = result.Table;
        if (!table) {
          return {
            content: [{ type: 'text' as const, text: `Table '${params.tableName}' not found.` }],
            isError: true,
          };
        }

        const keySchema = (table.KeySchema ?? []).map(
          (k) => `${k.AttributeName} (${k.KeyType})`,
        );

        const attributes = (table.AttributeDefinitions ?? []).map(
          (a) => `${a.AttributeName}: ${a.AttributeType}`,
        );

        const gsis = (table.GlobalSecondaryIndexes ?? []).map((gsi) => {
          const gsiKeys = (gsi.KeySchema ?? []).map(
            (k) => `${k.AttributeName} (${k.KeyType})`,
          );
          return `  ${gsi.IndexName}: ${gsiKeys.join(', ')} | Status: ${gsi.IndexStatus} | Items: ${gsi.ItemCount ?? 'N/A'}`;
        });

        const parts: string[] = [
          `Table: ${table.TableName}`,
          `Status: ${table.TableStatus}`,
          `Item Count: ${table.ItemCount ?? 'N/A'}`,
          `Size: ${table.TableSizeBytes ? `${(table.TableSizeBytes / 1024).toFixed(1)} KB` : 'N/A'}`,
          `Billing: ${table.BillingModeSummary?.BillingMode ?? 'PROVISIONED'}`,
          `Created: ${table.CreationDateTime?.toISOString() ?? 'N/A'}`,
          '',
          'Key Schema:',
          ...keySchema.map((k) => `  ${k}`),
          '',
          'Attributes:',
          ...attributes.map((a) => `  ${a}`),
        ];

        if (gsis.length > 0) {
          parts.push('', 'Global Secondary Indexes:', ...gsis);
        }

        const encryption = table.SSEDescription;
        if (encryption) {
          parts.push('', `Encryption: ${encryption.SSEType ?? 'DEFAULT'} (Status: ${encryption.Status})`);
          if (encryption.KMSMasterKeyArn) {
            parts.push(`  KMS Key: ${encryption.KMSMasterKeyArn}`);
          }
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: formatAwsErrorForMcp(error, 'describe-dynamo') }],
          isError: true,
        };
      }
    },
  );
}
