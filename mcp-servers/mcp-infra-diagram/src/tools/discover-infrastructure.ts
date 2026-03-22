/**
 * @fileoverview MCP tool: discover-infrastructure
 *
 * Scans live AWS (and optionally K8s) resources and returns the
 * raw infrastructure graph as JSON. This is the foundation tool
 * that other diagram tools build upon.
 *
 * @module tools/discover-infrastructure
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AwsClients } from '../clients/aws-client.js';
import type { K8sClients } from '../clients/k8s-client.js';
import { DiscoverInfrastructureSchema } from '../schemas/tool-params.js';
import { buildInfraGraph } from '../graph/resource-graph.js';
import { formatAwsError } from '../utils/helpers.js';

/**
 * Registers the `discover-infrastructure` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param awsClients - AWS SDK clients.
 * @param k8sClients - Optional K8s clients (undefined if K8s is unavailable).
 */
export function registerDiscoverInfrastructure(
  server: McpServer,
  awsClients: AwsClients,
  k8sClients: K8sClients | undefined,
): void {
  server.tool(
    'discover-infrastructure',
    'Scan live AWS and Kubernetes resources to build an infrastructure graph. Returns JSON with all discovered nodes (VPCs, subnets, SGs, instances, LBs, pods, services) and their relationships (network rules, containment, forwarding chains).',
    DiscoverInfrastructureSchema.shape,
    async (params) => {
      try {
        const graph = await buildInfraGraph(awsClients, k8sClients, {
          region: params.region,
          vpcId: params.vpcId,
          tags: params.tags,
          includeK8s: params.includeK8s,
        });

        const summary = [
          `Discovered ${graph.nodes.length} resources and ${graph.edges.length} relationships`,
          `Region: ${graph.region}`,
          `K8s included: ${graph.includesK8s}`,
          `Timestamp: ${graph.discoveredAt}`,
        ].join('\n');

        return {
          content: [
            { type: 'text' as const, text: `${summary}\n\n${JSON.stringify(graph, null, 2)}` },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: formatAwsError(error, 'discover-infrastructure') },
          ],
          isError: true,
        };
      }
    },
  );
}
