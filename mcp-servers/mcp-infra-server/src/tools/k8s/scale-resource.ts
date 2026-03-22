/**
 * @fileoverview MCP tool handler: scale_resource
 * Scales Deployments, StatefulSets, and ReplicaSets.
 *
 * @module tools/scale-resource
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

const scaleResourceInputSchema = {
  kind: z.enum(['Deployment', 'StatefulSet', 'ReplicaSet']).describe(
    'Kind of resource to scale.',
  ),
  name: z.string().describe('Name of the resource'),
  namespace: z.string().describe('Namespace of the resource'),
  replicas: z.number().int().min(0).max(1000).describe('Desired number of replicas'),
};

/**
 * Registers the `scale_resource` tool with the MCP server.
 * ⚠️ Modifies workload replica count.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerScaleResource(server: McpServer, clients: K8sClients): void {
  server.tool(
    'scale_resource',
    '⚠️ WRITE OPERATION: Scale a Deployment, StatefulSet, or ReplicaSet to the specified replica count.',
    scaleResourceInputSchema,
    async (params) => {
      const { kind, name, namespace, replicas } = params;
      const operationDesc = `scaling ${kind}/${name} in ${namespace} to ${replicas} replicas`;

      try {
        const patchBody = { spec: { replicas } };

        switch (kind) {
          case 'Deployment':
            await clients.appsV1.patchNamespacedDeploymentScale({
              name,
              namespace,
              body: patchBody,
            });
            break;

          case 'StatefulSet':
            await clients.appsV1.patchNamespacedStatefulSetScale({
              name,
              namespace,
              body: patchBody,
            });
            break;

          case 'ReplicaSet':
            await clients.appsV1.patchNamespacedReplicaSetScale({
              name,
              namespace,
              body: patchBody,
            });
            break;
        }

        return {
          content: [{
            type: 'text',
            text: `✓ Successfully scaled ${kind}/${name} in ${namespace} to ${replicas} replica(s).`,
          }],
        };
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
