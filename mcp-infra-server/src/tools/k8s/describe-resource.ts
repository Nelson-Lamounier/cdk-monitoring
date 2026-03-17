/**
 * @fileoverview MCP tool handler: describe_resource
 * Provides a human-readable description of a Kubernetes resource,
 * similar to `kubectl describe`. Includes status, conditions, events,
 * and key specification details.
 *
 * @module tools/describe-resource
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import {
  handleK8sError,
  formatK8sErrorForMcp,
  formatMetadata,
  formatPodConditions,
  formatContainerStatuses,
} from '../../utils/index.js';
import type { V1Pod, V1PodCondition, CoreV1Event } from '@kubernetes/client-node';

const describeResourceInputSchema = {
  apiVersion: z.string().describe('Kubernetes API version (e.g. "v1", "apps/v1")'),
  kind: z.string().describe('Resource kind (e.g. "Pod", "Deployment")'),
  name: z.string().describe('Name of the resource'),
  namespace: z.string().optional().describe('Namespace of the resource.'),
};

/**
 * Registers the `describe_resource` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerDescribeResource(server: McpServer, clients: K8sClients): void {
  server.tool(
    'describe_resource',
    'Describe a Kubernetes resource in human-readable format (similar to kubectl describe). Shows metadata, status, conditions, and recent events.',
    describeResourceInputSchema,
    async (params) => {
      const { apiVersion, kind, name, namespace } = params;
      const operationDesc = `describing ${kind}/${name}${namespace ? ` in ${namespace}` : ''}`;

      try {
        // Fetch the resource
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

        // Build a describe-like output
        const sections: string[] = [];

        // Metadata section
        const meta = resource.metadata as Record<string, unknown> | undefined;
        sections.push('=== Metadata ===');
        sections.push(formatMetadata(meta as V1Pod['metadata']));

        // Annotations
        if (meta?.annotations && typeof meta.annotations === 'object') {
          const annots = meta.annotations as Record<string, string>;
          const annotKeys = Object.keys(annots);
          if (annotKeys.length > 0) {
            sections.push('');
            sections.push('=== Annotations ===');
            annotKeys.forEach((k) => sections.push(`  ${k}: ${annots[k]}`));
          }
        }

        // Status section
        const status = resource.status as Record<string, unknown> | undefined;
        if (status) {
          sections.push('');
          sections.push('=== Status ===');

          if (status.phase) {
            sections.push(`Phase: ${status.phase}`);
          }

          // Pod-specific: conditions
          if (kind.toLowerCase() === 'pod' && status.conditions) {
            sections.push('');
            sections.push('Conditions:');
            sections.push(
              formatPodConditions(status.conditions as V1PodCondition[] | undefined),
            );

            // Container statuses
            sections.push('');
            sections.push('Containers:');
            sections.push(formatContainerStatuses(resource as unknown as V1Pod));
          }

          // Deployment-specific: replicas
          if (status.replicas !== undefined) {
            sections.push(`Replicas: ${status.readyReplicas ?? 0}/${status.replicas} ready`);
            if (status.updatedReplicas !== undefined) {
              sections.push(`Updated: ${status.updatedReplicas}`);
            }
            if (status.availableReplicas !== undefined) {
              sections.push(`Available: ${status.availableReplicas}`);
            }
          }
        }

        // Spec highlights
        const spec_ = resource.spec as Record<string, unknown> | undefined;
        if (spec_) {
          sections.push('');
          sections.push('=== Spec Highlights ===');

          if (spec_.replicas !== undefined) {
            sections.push(`Desired Replicas: ${spec_.replicas}`);
          }
          if (spec_.type) {
            sections.push(`Type: ${spec_.type}`);
          }
          if (spec_.clusterIP) {
            sections.push(`ClusterIP: ${spec_.clusterIP}`);
          }
          if (spec_.nodeName) {
            sections.push(`Node: ${spec_.nodeName}`);
          }
        }

        // Fetch related events
        if (namespace) {
          try {
            const eventsResponse = await clients.coreV1.listNamespacedEvent({
              namespace,
              fieldSelector: `involvedObject.name=${name},involvedObject.kind=${kind}`,
            });

            const events: CoreV1Event[] = eventsResponse.items;
            if (events.length > 0) {
              sections.push('');
              sections.push('=== Recent Events ===');

              const recentEvents = events
                .sort((a: CoreV1Event, b: CoreV1Event) => {
                  const aTime = a.lastTimestamp?.getTime() ?? 0;
                  const bTime = b.lastTimestamp?.getTime() ?? 0;
                  return bTime - aTime;
                })
                .slice(0, 10);

              recentEvents.forEach((event: CoreV1Event) => {
                const time = event.lastTimestamp?.toISOString() ?? 'unknown';
                const eventType = event.type ?? 'Normal';
                const reason = event.reason ?? 'unknown';
                const message = event.message ?? '';
                sections.push(`  ${time} [${eventType}] ${reason}: ${message}`);
              });
            }
          } catch {
            // Events are non-critical; continue without them
            sections.push('');
            sections.push('=== Events ===');
            sections.push('  Unable to fetch events.');
          }
        }

        const output = sections.join('\n');
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
