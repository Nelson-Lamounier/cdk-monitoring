/**
 * @fileoverview MCP tool handler: get_events
 * Lists Kubernetes events, optionally filtered by namespace or involved object.
 *
 * @module tools/get-events
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

const getEventsInputSchema = {
  namespace: z.string().optional().describe('Namespace to list events from. Omit for all namespaces.'),
  involvedObjectName: z.string().optional().describe('Filter by involved object name (e.g. a pod or deployment name)'),
  involvedObjectKind: z.string().optional().describe('Filter by involved object kind (e.g. "Pod", "Deployment")'),
  limit: z.number().int().min(1).max(200).default(50).optional().describe('Max events to return (default: 50)'),
};

/**
 * Registers the `get_events` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerGetEvents(server: McpServer, clients: K8sClients): void {
  server.tool(
    'get_events',
    'List Kubernetes events (warnings, errors, state changes) for debugging. Optionally filter by namespace or involved object.',
    getEventsInputSchema,
    async (params) => {
      const { namespace, involvedObjectName, involvedObjectKind, limit } = params;
      const operationDesc = `listing events${namespace ? ` in ${namespace}` : ' across all namespaces'}`;

      try {
        // Build field selector for filtering
        const fieldParts: string[] = [];
        if (involvedObjectName) {
          fieldParts.push(`involvedObject.name=${involvedObjectName}`);
        }
        if (involvedObjectKind) {
          fieldParts.push(`involvedObject.kind=${involvedObjectKind}`);
        }
        const fieldSelector = fieldParts.length > 0 ? fieldParts.join(',') : undefined;

        let events: Array<{
          lastTimestamp?: Date;
          type?: string;
          reason?: string;
          message?: string;
          involvedObject?: { kind?: string; name?: string; namespace?: string };
          metadata?: { namespace?: string };
          count?: number;
        }>;

        if (namespace) {
          const response = await clients.coreV1.listNamespacedEvent({
            namespace,
            fieldSelector,
            limit: limit ?? 50,
          });
          events = response.items;
        } else {
          const response = await clients.coreV1.listEventForAllNamespaces({
            fieldSelector,
            limit: limit ?? 50,
          });
          events = response.items;
        }

        if (events.length === 0) {
          return {
            content: [{ type: 'text', text: `No events found${namespace ? ` in namespace ${namespace}` : ''}.` }],
          };
        }

        // Sort by timestamp (most recent first)
        events.sort((a, b) => {
          const aTime = a.lastTimestamp?.getTime() ?? 0;
          const bTime = b.lastTimestamp?.getTime() ?? 0;
          return bTime - aTime;
        });

        const lines = events.map((event) => {
          const time = event.lastTimestamp
            ? formatTimestamp(event.lastTimestamp)
            : 'unknown';
          const eventType = (event.type ?? 'Normal').padEnd(8);
          const ns = (event.metadata?.namespace ?? '-').padEnd(15);
          const objKind = event.involvedObject?.kind ?? '';
          const objName = event.involvedObject?.name ?? '';
          const reason = (event.reason ?? '').padEnd(20);
          const count = event.count ? `(x${event.count})` : '';
          const message = event.message ?? '';

          return `${time}  ${eventType} ${ns} ${objKind}/${objName}  ${reason} ${count} ${message}`;
        });

        const header = `Found ${events.length} event(s)${namespace ? ` in ${namespace}` : ''}:\n`;
        return { content: [{ type: 'text', text: header + lines.join('\n') }] };
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

/**
 * Formats a date into a concise timestamp string.
 *
 * @param date - The timestamp to format.
 * @returns Formatted timestamp (e.g. "Mar 17 15:42").
 */
function formatTimestamp(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
