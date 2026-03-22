/**
 * @fileoverview MCP tool: test-subscription
 *
 * Executes the full email subscription workflow:
 * 1. POST to the subscription API endpoint
 * 2. Verify the DynamoDB record was created
 * 3. Report the full result (API response + DynamoDB state)
 *
 * This tool creates a real subscription record tagged with `source: mcp-test`
 * for easy identification and cleanup.
 *
 * @module tools/test-subscription
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { GetCommand } from '@aws-sdk/lib-dynamodb';

import type { AwsClients } from '../../clients/aws-client.js';
import { TestSubscriptionSchema } from '../../schemas/aws-params.js';
import { formatDynamoItem, formatAwsErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `test-subscription` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - AWS service clients.
 */
export function registerTestSubscription(server: McpServer, clients: AwsClients): void {
  server.tool(
    'test-subscription',
    'Test the full email subscription workflow: POST to the API, then verify the DynamoDB record was created. Creates a real subscription with source "mcp-test".',
    TestSubscriptionSchema,
    async (params) => {
      try {
        const { apiUrl, email, tableName, name } = params;

        const parts: string[] = [];

        // Step 1: POST to subscription endpoint
        parts.push('=== Step 1: POST /subscriptions ===');

        const subscriptionUrl = apiUrl.endsWith('/')
          ? `${apiUrl}subscriptions`
          : `${apiUrl}/subscriptions`;

        const requestBody = JSON.stringify({
          email,
          name: name ?? 'MCP Test User',
          source: 'mcp-test',
        });

        parts.push(`URL: ${subscriptionUrl}`);
        parts.push(`Body: ${requestBody}`);
        parts.push('');

        let apiStatus: number;
        let apiBody: string;

        try {
          const response = await fetch(subscriptionUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: requestBody,
          });

          apiStatus = response.status;
          apiBody = await response.text();

          parts.push(`Response Status: ${apiStatus}`);
          parts.push(`Response Body: ${apiBody}`);
        } catch (fetchError) {
          parts.push(`API Error: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
          parts.push('');
          parts.push('⚠️ Could not reach the API endpoint. Check:');
          parts.push('  1. Is the API Gateway deployed?');
          parts.push('  2. Is the URL correct?');
          parts.push('  3. Is there a WAF blocking the request?');

          return {
            content: [{ type: 'text' as const, text: parts.join('\n') }],
            isError: true,
          };
        }

        // Step 2: Verify DynamoDB record
        parts.push('');
        parts.push('=== Step 2: Verify DynamoDB Record ===');

        // Wait a moment for Lambda to write to DynamoDB
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const dynamoResult = await clients.docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: `EMAIL#${email.toLowerCase()}`,
              sk: 'SUBSCRIPTION',
            },
          }),
        );

        if (dynamoResult.Item) {
          parts.push('✅ DynamoDB record found:');
          parts.push(formatDynamoItem(dynamoResult.Item as Record<string, unknown>));
        } else {
          parts.push('❌ No DynamoDB record found.');
          parts.push('');
          parts.push('Possible causes:');
          parts.push('  1. Lambda failed to write (check CloudWatch Logs)');
          parts.push('  2. Wrong table name');
          parts.push(`  3. Expected key: pk=EMAIL#${email.toLowerCase()}, sk=SUBSCRIPTION`);
        }

        // Step 3: Summary
        parts.push('');
        parts.push('=== Workflow Summary ===');

        const apiSuccess = apiStatus >= 200 && apiStatus < 300;
        const dynamoSuccess = !!dynamoResult.Item;

        if (apiSuccess && dynamoSuccess) {
          parts.push('✅ Full workflow successful: API accepted → DynamoDB record created');
        } else if (apiSuccess && !dynamoSuccess) {
          parts.push('⚠️ Partial success: API accepted but DynamoDB record not found');
        } else if (apiStatus === 409) {
          parts.push('ℹ️ Email already subscribed (HTTP 409). Check DynamoDB record status.');
        } else {
          parts.push(`❌ API returned ${apiStatus}. DynamoDB record ${dynamoSuccess ? 'exists' : 'missing'}.`);
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsErrorForMcp(error, 'test-subscription') },
          ],
          isError: true,
        };
      }
    },
  );
}
