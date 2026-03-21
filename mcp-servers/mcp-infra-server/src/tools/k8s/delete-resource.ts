/**
 * @fileoverview MCP tool handler: delete_resource
 * Deletes a Kubernetes resource by name, namespace, apiVersion, and kind.
 * ⚠️ Destructive operation — the AI tool should confirm with the user.
 *
 * @module tools/delete-resource
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

const deleteResourceInputSchema = {
  apiVersion: z.string().describe('Kubernetes API version (e.g. "v1", "apps/v1")'),
  kind: z.string().describe('Resource kind (e.g. "Pod", "Deployment")'),
  name: z.string().describe('Name of the resource to delete'),
  namespace: z.string().optional().describe('Namespace of the resource.'),
  gracePeriodSeconds: z.number().int().min(0).optional().describe(
    'Grace period in seconds before force deletion. 0 means immediate deletion.',
  ),
};

/**
 * Registers the `delete_resource` tool with the MCP server.
 * ⚠️ DESTRUCTIVE operation.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerDeleteResource(server: McpServer, clients: K8sClients): void {
  server.tool(
    'delete_resource',
    '⚠️ DESTRUCTIVE OPERATION: Delete a Kubernetes resource permanently. Confirm with the user before invoking.',
    deleteResourceInputSchema,
    async (params) => {
      const { apiVersion, kind, name, namespace, gracePeriodSeconds } = params;
      const operationDesc = `deleting ${kind}/${name}${namespace ? ` in ${namespace}` : ''}`;

      try {
        const spec = {
          apiVersion,
          kind,
          metadata: {
            name,
            ...(namespace ? { namespace } : {}),
          },
        };

        const deleteOptions = gracePeriodSeconds !== undefined
          ? { gracePeriodSeconds }
          : undefined;

        await clients.objectApi.delete(spec, undefined, undefined, undefined, deleteOptions as unknown as undefined);

        const output = `✓ Successfully deleted ${kind}/${name}${namespace ? ` from namespace ${namespace}` : ''}.`;
        return { content: [{ type: 'text', text: output }] };
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
