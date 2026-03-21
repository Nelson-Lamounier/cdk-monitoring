/**
 * @fileoverview MCP tool handler: get_resource
 * Retrieves a single Kubernetes resource by name, namespace, apiVersion, and kind.
 *
 * @module tools/get-resource
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { handleK8sError, formatK8sErrorForMcp, formatResourceAsJson } from '../../utils/index.js';

const getResourceInputSchema = {
  apiVersion: z.string().describe('Kubernetes API version (e.g. "v1", "apps/v1")'),
  kind: z.string().describe('Resource kind (e.g. "Pod", "Deployment", "Service")'),
  name: z.string().describe('Name of the resource'),
  namespace: z.string().optional().describe('Namespace of the resource. Required for namespaced resources.'),
};

/**
 * Registers the `get_resource` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerGetResource(server: McpServer, clients: K8sClients): void {
  server.tool(
    'get_resource',
    'Get a single Kubernetes resource by name. Returns the full resource specification as JSON.',
    getResourceInputSchema,
    async (params) => {
      const { apiVersion, kind, name, namespace } = params;
      const operationDesc = `getting ${kind}/${name}${namespace ? ` in ${namespace}` : ''}`;

      try {
        const spec = {
          apiVersion,
          kind,
          metadata: {
            name,
            ...(namespace ? { namespace } : {}),
          },
        };

        const response = await clients.objectApi.read(spec);
        const resource = response as unknown as Record<string, unknown>;
        const output = formatResourceAsJson(resource);

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
