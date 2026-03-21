/**
 * @fileoverview MCP tool handler: list_resources
 * Lists Kubernetes resources by apiVersion and kind, with optional
 * namespace and label selector filtering.
 *
 * Uses the v1.4+ object-parameter API pattern for @kubernetes/client-node.
 *
 * @module tools/list-resources
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { K8sClients } from '../../clients/k8s-client.js';
import { z } from 'zod';
import { handleK8sError, formatK8sErrorForMcp } from '../../utils/index.js';

const listResourcesInputSchema = {
  apiVersion: z.string().describe('Kubernetes API version (e.g. "v1", "apps/v1")'),
  kind: z.string().describe('Resource kind (e.g. "Pod", "Deployment", "Service")'),
  namespace: z.string().optional().describe('Namespace to list from. Omit for cluster-wide.'),
  labelSelector: z.string().optional().describe('Label selector (e.g. "app=myapp,env=prod")'),
  fieldSelector: z.string().optional().describe('Field selector (e.g. "status.phase=Running")'),
  limit: z.number().int().min(1).max(500).default(100).optional().describe('Max resources to return (default: 100)'),
};

/**
 * Registers the `list_resources` tool with the MCP server.
 * This is the most generic listing tool — it can list any K8s resource type.
 *
 * @param server - The MCP server instance.
 * @param clients - The Kubernetes API clients.
 */
export function registerListResources(server: McpServer, clients: K8sClients): void {
  server.tool(
    'list_resources',
    'List Kubernetes resources by API version and kind. Supports namespace, label, and field selector filtering.',
    listResourcesInputSchema,
    async (params) => {
      const { apiVersion, kind, namespace, labelSelector, fieldSelector, limit } = params;
      const operationDesc = `listing ${kind} (${apiVersion})${namespace ? ` in namespace ${namespace}` : ''}`;

      try {
        const { group, version } = parseApiVersion(apiVersion);

        // Use the appropriate API based on the resource type
        let items: Array<Record<string, unknown>>;

        if (group === '' && version === 'v1') {
          items = await listCoreResources(clients, kind, namespace, labelSelector, fieldSelector, limit);
        } else if (group === 'apps' && version === 'v1') {
          items = await listAppsResources(clients, kind, namespace, labelSelector, fieldSelector, limit);
        } else {
          // Fallback to custom objects API for CRDs and other groups
          items = await listCustomResources(clients, group, version, kind, namespace, labelSelector, limit);
        }

        if (items.length === 0) {
          return {
            content: [{ type: 'text', text: `No ${kind} resources found${namespace ? ` in namespace ${namespace}` : ''}.` }],
          };
        }

        // Format as a concise summary
        const summaries = items.map((item) => {
          const meta = item.metadata as Record<string, unknown> | undefined;
          const name = (meta?.name as string) ?? 'unknown';
          const ns = (meta?.namespace as string) ?? '-';
          return `  ${ns.padEnd(20)} ${name}`;
        });

        const header = `  ${'NAMESPACE'.padEnd(20)} NAME`;
        const output = [
          `Found ${items.length} ${kind} resource(s):`,
          '',
          header,
          '  ' + '-'.repeat(50),
          ...summaries,
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
 * Parses a Kubernetes API version string into group and version components.
 *
 * @param apiVersion - e.g. "v1", "apps/v1", "networking.k8s.io/v1"
 * @returns Object with group (empty string for core) and version.
 */
function parseApiVersion(apiVersion: string): { group: string; version: string } {
  const parts = apiVersion.split('/');
  if (parts.length === 1) {
    return { group: '', version: parts[0] };
  }
  return { group: parts[0], version: parts[1] };
}

/** Common request parameters for K8s list operations. */
interface ListParams {
  readonly labelSelector?: string;
  readonly fieldSelector?: string;
  readonly limit: number;
}

/**
 * Lists core V1 resources (Pods, Services, ConfigMaps, etc.)
 * using the v1.4+ object-parameter API.
 */
async function listCoreResources(
  clients: K8sClients,
  kind: string,
  namespace?: string,
  labelSelector?: string,
  fieldSelector?: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  const opts: ListParams = {
    labelSelector,
    fieldSelector,
    limit: limit ?? 100,
  };

  const kindLower = kind.toLowerCase();

  // Cluster-scoped resources
  switch (kindLower) {
    case 'namespace':
    case 'namespaces': {
      const result = await clients.coreV1.listNamespace({ labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit });
      return result.items as unknown as Array<Record<string, unknown>>;
    }
    case 'node':
    case 'nodes': {
      const result = await clients.coreV1.listNode({ labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit });
      return result.items as unknown as Array<Record<string, unknown>>;
    }
    case 'persistentvolume':
    case 'persistentvolumes': {
      const result = await clients.coreV1.listPersistentVolume({ labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit });
      return result.items as unknown as Array<Record<string, unknown>>;
    }
  }

  // Namespaced resources — dispatch based on kind
  if (namespace) {
    return listNamespacedCoreResource(clients, kindLower, kind, namespace, opts);
  }

  // All namespaces
  return listAllNamespacesCoreResource(clients, kindLower, kind, opts);
}

/**
 * Lists a namespaced core V1 resource in a specific namespace.
 */
async function listNamespacedCoreResource(
  clients: K8sClients,
  kindLower: string,
  kindOriginal: string,
  namespace: string,
  opts: ListParams,
): Promise<Array<Record<string, unknown>>> {
  const common = { namespace, labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit };

  switch (kindLower) {
    case 'pod':
    case 'pods': {
      const r = await clients.coreV1.listNamespacedPod(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'service':
    case 'services': {
      const r = await clients.coreV1.listNamespacedService(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'configmap':
    case 'configmaps': {
      const r = await clients.coreV1.listNamespacedConfigMap(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'secret':
    case 'secrets': {
      const r = await clients.coreV1.listNamespacedSecret(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'event':
    case 'events': {
      const r = await clients.coreV1.listNamespacedEvent(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'serviceaccount':
    case 'serviceaccounts': {
      const r = await clients.coreV1.listNamespacedServiceAccount(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'persistentvolumeclaim':
    case 'persistentvolumeclaims': {
      const r = await clients.coreV1.listNamespacedPersistentVolumeClaim(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'endpoints': {
      const r = await clients.coreV1.listNamespacedEndpoints(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    default:
      throw new Error(`Unsupported core resource kind: ${kindOriginal}. Supported: Pod, Service, ConfigMap, Secret, Event, Namespace, Node, ServiceAccount, PersistentVolume, PersistentVolumeClaim, Endpoints`);
  }
}

/**
 * Lists a core V1 resource across all namespaces.
 */
async function listAllNamespacesCoreResource(
  clients: K8sClients,
  kindLower: string,
  kindOriginal: string,
  opts: ListParams,
): Promise<Array<Record<string, unknown>>> {
  const common = { labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit };

  switch (kindLower) {
    case 'pod':
    case 'pods': {
      const r = await clients.coreV1.listPodForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'service':
    case 'services': {
      const r = await clients.coreV1.listServiceForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'configmap':
    case 'configmaps': {
      const r = await clients.coreV1.listConfigMapForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'secret':
    case 'secrets': {
      const r = await clients.coreV1.listSecretForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'event':
    case 'events': {
      const r = await clients.coreV1.listEventForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'serviceaccount':
    case 'serviceaccounts': {
      const r = await clients.coreV1.listServiceAccountForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'persistentvolumeclaim':
    case 'persistentvolumeclaims': {
      const r = await clients.coreV1.listPersistentVolumeClaimForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'endpoints': {
      const r = await clients.coreV1.listEndpointsForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    default:
      throw new Error(`Unsupported core resource kind: ${kindOriginal}. Supported: Pod, Service, ConfigMap, Secret, Event, Namespace, Node, ServiceAccount, PersistentVolume, PersistentVolumeClaim, Endpoints`);
  }
}

/**
 * Lists apps/v1 resources (Deployments, StatefulSets, DaemonSets, ReplicaSets)
 * using the v1.4+ object-parameter API.
 */
async function listAppsResources(
  clients: K8sClients,
  kind: string,
  namespace?: string,
  labelSelector?: string,
  fieldSelector?: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  const kindLower = kind.toLowerCase();
  const opts: ListParams = { labelSelector, fieldSelector, limit: limit ?? 100 };

  if (namespace) {
    const common = { namespace, labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit };

    switch (kindLower) {
      case 'deployment':
      case 'deployments': {
        const r = await clients.appsV1.listNamespacedDeployment(common);
        return r.items as unknown as Array<Record<string, unknown>>;
      }
      case 'statefulset':
      case 'statefulsets': {
        const r = await clients.appsV1.listNamespacedStatefulSet(common);
        return r.items as unknown as Array<Record<string, unknown>>;
      }
      case 'daemonset':
      case 'daemonsets': {
        const r = await clients.appsV1.listNamespacedDaemonSet(common);
        return r.items as unknown as Array<Record<string, unknown>>;
      }
      case 'replicaset':
      case 'replicasets': {
        const r = await clients.appsV1.listNamespacedReplicaSet(common);
        return r.items as unknown as Array<Record<string, unknown>>;
      }
      default:
        throw new Error(`Unsupported apps/v1 resource kind: ${kind}. Supported: Deployment, StatefulSet, DaemonSet, ReplicaSet`);
    }
  }

  // All namespaces
  const common = { labelSelector: opts.labelSelector, fieldSelector: opts.fieldSelector, limit: opts.limit };

  switch (kindLower) {
    case 'deployment':
    case 'deployments': {
      const r = await clients.appsV1.listDeploymentForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'statefulset':
    case 'statefulsets': {
      const r = await clients.appsV1.listStatefulSetForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'daemonset':
    case 'daemonsets': {
      const r = await clients.appsV1.listDaemonSetForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    case 'replicaset':
    case 'replicasets': {
      const r = await clients.appsV1.listReplicaSetForAllNamespaces(common);
      return r.items as unknown as Array<Record<string, unknown>>;
    }
    default:
      throw new Error(`Cannot list ${kind} across all namespaces via apps/v1 API.`);
  }
}

/**
 * Lists custom resources via the CustomObjectsApi
 * using the v1.4+ object-parameter API.
 */
async function listCustomResources(
  clients: K8sClients,
  group: string,
  version: string,
  kind: string,
  namespace?: string,
  labelSelector?: string,
  limit?: number,
): Promise<Array<Record<string, unknown>>> {
  const plural = kind.toLowerCase() + 's'; // Best-effort pluralisation

  if (namespace) {
    const result = await clients.customObjects.listNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      labelSelector,
      limit,
    });
    const body = result as { items?: Array<Record<string, unknown>> };
    return body.items ?? [];
  }

  const result = await clients.customObjects.listClusterCustomObject({
    group,
    version,
    plural,
    labelSelector,
    limit,
  });
  const body = result as { items?: Array<Record<string, unknown>> };
  return body.items ?? [];
}
