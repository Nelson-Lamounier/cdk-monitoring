/**
 * @fileoverview MCP tool handler: get_cluster_info
 * Returns a summary of the current Kubernetes cluster context,
 * server URL, and namespace overview.
 *
 * @module tools/get-cluster-info
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { getCurrentContextName, getClusterServerUrl } from '../../clients/k8s-client.js';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `get_cluster_info` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerGetClusterInfo(server: McpServer, clients: K8sClients): void {
  server.tool(
    'get_cluster_info',
    'Get information about the connected Kubernetes cluster: current context, server URL, and namespace summary.',
    {},
    async () => {
      try {
        const contextName = getCurrentContextName(clients.kubeConfig);
        const serverUrl = getClusterServerUrl(clients.kubeConfig);

        // Fetch namespaces for the summary
        const nsResponse = await clients.coreV1.listNamespace();
        const namespaces = nsResponse.items;

        // Fetch node count
        const nodeResponse = await clients.coreV1.listNode();
        const nodes = nodeResponse.items;

        const nodeDetails = nodes.map((node) => {
          const name = node.metadata?.name ?? 'unknown';
          const ready = node.status?.conditions?.find((c) => c.type === 'Ready');
          const status = ready?.status === 'True' ? 'Ready' : 'NotReady';
          const roles = Object.keys(node.metadata?.labels ?? {})
            .filter((l) => l.startsWith('node-role.kubernetes.io/'))
            .map((l) => l.replace('node-role.kubernetes.io/', ''))
            .join(', ') || 'worker';

          return `  ${name.padEnd(40)} ${status.padEnd(10)} ${roles}`;
        });

        const sections = [
          '=== Cluster Information ===',
          '',
          `Context:    ${contextName}`,
          `Server:     ${serverUrl}`,
          `Nodes:      ${nodes.length}`,
          `Namespaces: ${namespaces.length}`,
          '',
          '=== Nodes ===',
          `  ${'NAME'.padEnd(40)} ${'STATUS'.padEnd(10)} ROLES`,
          `  ${'-'.repeat(65)}`,
          ...nodeDetails,
          '',
          '=== Namespaces ===',
          ...namespaces.map((ns) => `  ${ns.metadata?.name ?? 'unknown'} (${ns.status?.phase ?? 'Unknown'})`),
        ];

        return { content: [{ type: 'text', text: sections.join('\n') }] };
      } catch (error) {
        const k8sError = handleK8sError(error, 'getting cluster info');
        return {
          content: [{ type: 'text', text: formatK8sErrorForMcp(k8sError) }],
          isError: true,
        };
      }
    },
  );
}
