/**
 * @fileoverview MCP tool handler: apply_resource
 * Server-side applies a Kubernetes manifest (YAML or JSON).
 * This is a write operation — the AI tool should confirm with the user before invoking.
 *
 * @module tools/apply-resource
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import type { KubernetesObject } from '@kubernetes/client-node';
import { handleK8sError, formatK8sErrorForMcp, formatResourceAsJson } from '../../utils/index.js';
import * as yaml from 'js-yaml';

const applyResourceInputSchema = {
  manifest: z.string().describe(
    'The Kubernetes resource manifest as YAML or JSON string. Must include apiVersion, kind, and metadata.name.',
  ),
};

/**
 * Registers the `apply_resource` tool with the MCP server.
 * ⚠️ This is a MUTATING operation — it creates or updates resources.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerApplyResource(server: McpServer, clients: K8sClients): void {
  server.tool(
    'apply_resource',
    '⚠️ WRITE OPERATION: Apply (create or update) a Kubernetes resource from a YAML/JSON manifest. This modifies cluster state — confirm with the user before invoking.',
    applyResourceInputSchema,
    async (params) => {
      const { manifest } = params;

      let resource: KubernetesObject;
      try {
        resource = parseManifest(manifest);
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        return {
          content: [{ type: 'text', text: `Failed to parse manifest: ${message}` }],
          isError: true,
        };
      }

      const name = resource.metadata?.name ?? 'unknown';
      const kind = resource.kind ?? 'unknown';
      const namespace = resource.metadata?.namespace;
      const operationDesc = `applying ${kind}/${name}${namespace ? ` in ${namespace}` : ''}`;

      try {
        // Build the spec object with required name field for objectApi.read
        const readSpec = {
          apiVersion: resource.apiVersion ?? '',
          kind: resource.kind ?? '',
          metadata: {
            name,
            ...(namespace ? { namespace } : {}),
          },
        };

        // Attempt to read the existing resource first
        let existing: KubernetesObject | undefined;
        try {
          const readResult = await clients.objectApi.read(readSpec);
          existing = readResult as unknown as KubernetesObject;
        } catch {
          // Resource does not exist — will create
        }

        let result: KubernetesObject;
        let action: string;

        if (existing) {
          // Update (replace) the existing resource
          resource.metadata = {
            ...resource.metadata,
            resourceVersion: (existing.metadata as Record<string, unknown>)?.resourceVersion as string,
          };
          const patchResult = await clients.objectApi.replace(resource);
          result = patchResult as unknown as KubernetesObject;
          action = 'updated';
        } else {
          // Create a new resource
          const createResult = await clients.objectApi.create(resource);
          result = createResult as unknown as KubernetesObject;
          action = 'created';
        }

        const output = [
          `✓ Successfully ${action} ${kind}/${name}${namespace ? ` in namespace ${namespace}` : ''}.`,
          '',
          formatResourceAsJson(result as unknown as Record<string, unknown>),
        ].join('\n');

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

/**
 * Parses a manifest string (YAML or JSON) into a KubernetesObject.
 *
 * @param manifest - Raw manifest string.
 * @returns Parsed KubernetesObject.
 * @throws Error if the manifest is invalid or missing required fields.
 */
function parseManifest(manifest: string): KubernetesObject {
  let parsed: unknown;

  // Try JSON first, then YAML
  try {
    parsed = JSON.parse(manifest);
  } catch {
    parsed = yaml.load(manifest);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Manifest must be a valid YAML or JSON object.');
  }

  const obj = parsed as Record<string, unknown>;

  if (!obj.apiVersion) {
    throw new Error('Manifest is missing required field: apiVersion');
  }
  if (!obj.kind) {
    throw new Error('Manifest is missing required field: kind');
  }
  if (!obj.metadata || typeof obj.metadata !== 'object') {
    throw new Error('Manifest is missing required field: metadata');
  }

  const meta = obj.metadata as Record<string, unknown>;
  if (!meta.name) {
    throw new Error('Manifest metadata is missing required field: name');
  }

  return parsed as KubernetesObject;
}
