/**
 * @fileoverview MCP tool: generate-infra-doc
 *
 * Discovers live infrastructure and generates structured markdown
 * documentation about resource relationships. Supports two modes:
 * - **inventory** — factual tables and lists
 * - **narrative** — explains WHY each relationship exists
 *
 * @module tools/generate-infra-doc
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AwsClients } from '../clients/aws-client.js';
import type { K8sClients } from '../clients/k8s-client.js';
import { GenerateInfraDocSchema } from '../schemas/tool-params.js';
import { buildInfraGraph } from '../graph/resource-graph.js';
import { renderInfraDoc } from '../renderers/doc-renderer.js';
import type { DocMode } from '../renderers/doc-renderer.js';
import { formatAwsError } from '../utils/helpers.js';

/**
 * Registers the `generate-infra-doc` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param awsClients - AWS SDK clients.
 * @param k8sClients - Optional K8s clients.
 */
export function registerGenerateInfraDoc(
  server: McpServer,
  awsClients: AwsClients,
  k8sClients: K8sClients | undefined,
): void {
  server.tool(
    'generate-infra-doc',
    'Discover live AWS/K8s infrastructure and generate structured documentation explaining resource relationships. Use "narrative" mode to explain WHY each port is open, WHY each SG rule exists, and trace the full request path from CloudFront through WAF, NLB, target groups, to pods.',
    GenerateInfraDocSchema.shape,
    async (params) => {
      try {
        const graph = await buildInfraGraph(awsClients, k8sClients, {
          region: params.region,
          vpcId: params.vpcId,
          tags: params.tags,
          includeK8s: params.includeK8s,
          scope: params.scope,
        });

        const doc = renderInfraDoc(graph, params.mode as DocMode);

        return {
          content: [{ type: 'text' as const, text: doc }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsError(error, 'generate-infra-doc') },
          ],
          isError: true,
        };
      }
    },
  );
}
