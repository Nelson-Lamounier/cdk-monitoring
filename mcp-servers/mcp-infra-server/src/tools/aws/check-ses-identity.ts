/**
 * @fileoverview MCP tool: check-ses-identity
 *
 * Checks the verification status of an SES email identity or domain.
 * Useful for diagnosing email delivery issues.
 *
 * @module tools/check-ses-identity
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  GetIdentityVerificationAttributesCommand,
  GetSendQuotaCommand,
} from '@aws-sdk/client-ses';

import type { AwsClients } from '../../clients/aws-client.js';
import { CheckSesIdentitySchema } from '../../schemas/aws-params.js';
import { formatAwsErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `check-ses-identity` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - AWS service clients.
 */
export function registerCheckSesIdentity(server: McpServer, clients: AwsClients): void {
  server.tool(
    'check-ses-identity',
    'Check if an SES email identity or domain is verified and ready to send. Also shows sending quota.',
    CheckSesIdentitySchema,
    async (params) => {
      try {
        const { identity } = params;

        // Check identity verification status
        const verificationResult = await clients.sesClient.send(
          new GetIdentityVerificationAttributesCommand({
            Identities: [identity],
          }),
        );

        const attrs = verificationResult.VerificationAttributes?.[identity];

        // Get sending quota
        const quotaResult = await clients.sesClient.send(
          new GetSendQuotaCommand({}),
        );

        const parts: string[] = [
          `SES Identity: ${identity}`,
          `Region: ${clients.region}`,
          '',
        ];

        if (attrs) {
          const status = attrs.VerificationStatus ?? 'Unknown';
          const isVerified = status === 'Success';
          const icon = isVerified ? '✅' : '❌';

          parts.push(`Verification Status: ${icon} ${status}`);

          if (attrs.VerificationToken) {
            parts.push(`Verification Token: ${attrs.VerificationToken}`);
          }
        } else {
          parts.push('❌ Identity not found in SES.');
          parts.push('');
          parts.push('To verify this identity:');
          parts.push(`  aws ses verify-email-identity --email-address ${identity} --region ${clients.region}`);
        }

        parts.push('');
        parts.push('Sending Quota:');
        parts.push(`  24h Limit: ${quotaResult.Max24HourSend ?? 'N/A'}`);
        parts.push(`  Sent (last 24h): ${quotaResult.SentLast24Hours ?? 'N/A'}`);
        parts.push(`  Max Send Rate: ${quotaResult.MaxSendRate ?? 'N/A'}/sec`);

        const remaining = (quotaResult.Max24HourSend ?? 0) - (quotaResult.SentLast24Hours ?? 0);
        if (remaining <= 10) {
          parts.push('');
          parts.push('⚠️ Warning: SES sending quota nearly exhausted!');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsErrorForMcp(error, 'check-ses-identity') },
          ],
          isError: true,
        };
      }
    },
  );
}
