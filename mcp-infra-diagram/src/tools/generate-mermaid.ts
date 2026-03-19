/**
 * @fileoverview MCP tool: generate-mermaid-diagram
 *
 * Discovers live infrastructure and renders it as a Mermaid diagram
 * string ready for markdown embedding. Supports scope filtering.
 *
 * @module tools/generate-mermaid
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AwsClients } from '../clients/aws-client.js';
import type { K8sClients } from '../clients/k8s-client.js';
import { GenerateMermaidSchema } from '../schemas/tool-params.js';
import { buildInfraGraph } from '../graph/resource-graph.js';
import { renderMermaid } from '../renderers/mermaid-renderer.js';
import { formatAwsError } from '../utils/helpers.js';

/**
 * Registers the `generate-mermaid-diagram` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param awsClients - AWS SDK clients.
 * @param k8sClients - Optional K8s clients.
 */
export function registerGenerateMermaid(
  server: McpServer,
  awsClients: AwsClients,
  k8sClients: K8sClients | undefined,
): void {
  server.tool(
    'generate-mermaid-diagram',
    'Discover live AWS/K8s infrastructure and generate a Mermaid diagram showing real resource IDs, CIDRs, ports, and relationships. Embed the output in markdown code blocks.',
    GenerateMermaidSchema.shape,
    async (params) => {
      try {
        const graph = await buildInfraGraph(awsClients, k8sClients, {
          region: params.region,
          vpcId: params.vpcId,
          tags: params.tags,
          includeK8s: params.includeK8s,
          scope: params.scope,
        });

        const mermaid = renderMermaid(graph);

        const summary = [
          `## Infrastructure Diagram (${params.scope} scope)`,
          `- **Resources:** ${graph.nodes.length}`,
          `- **Relationships:** ${graph.edges.length}`,
          `- **Region:** ${graph.region}`,
          `- **Discovered at:** ${graph.discoveredAt}`,
          '',
          '```mermaid',
          mermaid,
          '```',
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsError(error, 'generate-mermaid-diagram') },
          ],
          isError: true,
        };
      }
    },
  );
}
