/**
 * @fileoverview MCP tool handler: get_pod_logs
 * Retrieves logs from a specific pod container.
 *
 * @module tools/get-pod-logs
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

const getPodLogsInputSchema = {
  name: z.string().describe('Name of the pod'),
  namespace: z.string().describe('Namespace of the pod'),
  container: z.string().optional().describe('Container name (required if pod has multiple containers)'),
  tailLines: z.number().int().min(1).max(10000).default(100).optional().describe(
    'Number of lines from the end of the logs (default: 100)',
  ),
  previous: z.boolean().default(false).optional().describe(
    'Return logs from a previously terminated container (default: false)',
  ),
  sinceSeconds: z.number().int().min(1).optional().describe(
    'Return logs newer than this many seconds',
  ),
};

/**
 * Registers the `get_pod_logs` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerGetPodLogs(server: McpServer, clients: K8sClients): void {
  server.tool(
    'get_pod_logs',
    'Get logs from a Kubernetes pod. Supports tail lines, previous container logs, and time-based filtering.',
    getPodLogsInputSchema,
    async (params) => {
      const { name, namespace, container, tailLines, previous, sinceSeconds } = params;
      const operationDesc = `getting logs for pod ${name} in ${namespace}${container ? ` (container: ${container})` : ''}`;

      try {
        const response = await clients.coreV1.readNamespacedPodLog({
          name,
          namespace,
          container,
          previous: previous ?? false,
          sinceSeconds,
          tailLines: tailLines ?? 100,
        });

        const logs = typeof response === 'string' ? response : String(response);

        if (!logs || logs.trim().length === 0) {
          return {
            content: [{ type: 'text', text: `No logs found for pod ${name}${container ? ` (container: ${container})` : ''} in ${namespace}.` }],
          };
        }

        const header = `=== Logs: ${name}${container ? `/${container}` : ''} (${namespace}) ===`;
        return { content: [{ type: 'text', text: `${header}\n\n${logs}` }] };
      } catch (error) {
        const k8sError = handleK8sError(error, operationDesc);
        return {
          content: [{ type: 'text', text: formatK8sErrorForMcp(k8sError) }],
          isError: true,
        };
      }
    },
  );
}
