/**
 * @fileoverview MCP tool handler: list_namespaces
 * Lists all namespaces in the Kubernetes cluster.
 *
 * @module tools/list-namespaces
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

/**
 * Registers the `list_namespaces` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerListNamespaces(server: McpServer, clients: K8sClients): void {
  server.tool(
    'list_namespaces',
    'List all namespaces in the Kubernetes cluster.',
    {},
    async () => {
      try {
        const response = await clients.coreV1.listNamespace();
        const namespaces = response.items;

        if (namespaces.length === 0) {
          return { content: [{ type: 'text', text: 'No namespaces found.' }] };
        }

        const lines = namespaces.map((ns) => {
          const name = ns.metadata?.name ?? 'unknown';
          const phase = ns.status?.phase ?? 'Unknown';
          const age = ns.metadata?.creationTimestamp
            ? formatAge(ns.metadata.creationTimestamp)
            : 'unknown';
          return `${name.padEnd(30)} ${phase.padEnd(10)} ${age}`;
        });

        const header = `${'NAME'.padEnd(30)} ${'STATUS'.padEnd(10)} AGE`;
        const separator = '-'.repeat(55);
        const output = [header, separator, ...lines].join('\n');

        return {
          content: [
            { type: 'text', text: `Found ${namespaces.length} namespace(s):\n\n${output}` },
          ],
        };
      } catch (error) {
        const k8sError = handleK8sError(error, 'listing namespaces');
        return {
          content: [{ type: 'text', text: formatK8sErrorForMcp(k8sError) }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Formats a Date into a human-readable age string (e.g. "5d", "3h", "10m").
 *
 * @param date - The creation timestamp.
 * @returns Human-readable age string.
 */
function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}
