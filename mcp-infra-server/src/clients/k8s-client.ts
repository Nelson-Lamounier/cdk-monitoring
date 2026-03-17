/**
 * @fileoverview Kubernetes client factory.
 * Initialises `@kubernetes/client-node` with kubeconfig auto-detection
 * and exposes typed API group clients for use across tool handlers.
 *
 * The client respects:
 * - `KUBECONFIG` environment variable
 * - `~/.kube/config` fallback
 * - In-cluster service account token (when running inside a pod)
 *
 * @module k8s-client
 */

import * as k8s from '@kubernetes/client-node';

/**
 * Container for all Kubernetes API clients used by the MCP server.
 * Each client targets a specific API group and is ready to make authenticated requests.
 */
export interface K8sClients {
  /** Core V1 API: Pods, Services, ConfigMaps, Secrets, Namespaces, Events, etc. */
  readonly coreV1: k8s.CoreV1Api;
  /** Apps V1 API: Deployments, StatefulSets, DaemonSets, ReplicaSets */
  readonly appsV1: k8s.AppsV1Api;
  /** Batch V1 API: Jobs, CronJobs */
  readonly batchV1: k8s.BatchV1Api;
  /** Networking V1 API: Ingresses, NetworkPolicies */
  readonly networkingV1: k8s.NetworkingV1Api;
  /** Custom Objects API: CRDs and any non-core resources */
  readonly customObjects: k8s.CustomObjectsApi;
  /** The underlying KubeConfig instance for context information */
  readonly kubeConfig: k8s.KubeConfig;
  /** Kubernetes Object API for generic CRUD operations */
  readonly objectApi: k8s.KubernetesObjectApi;
}

/**
 * Creates a set of Kubernetes API clients configured from the user's kubeconfig.
 *
 * @param kubeconfigPath - Optional explicit path to a kubeconfig file.
 *   If omitted, the client falls back to:
 *   1. `KUBECONFIG` environment variable
 *   2. `~/.kube/config`
 *   3. In-cluster service account configuration
 *
 * @returns A readonly object containing all API clients and the KubeConfig instance.
 *
 * @throws Error if no valid kubeconfig can be loaded.
 *
 * @example
 * ```typescript
 * const clients = createK8sClients();
 * const { body } = await clients.coreV1.listNamespacedPod('default');
 * ```
 */
export function createK8sClients(kubeconfigPath?: string): K8sClients {
  const kc = new k8s.KubeConfig();

  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }

  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
  const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  const batchV1 = kc.makeApiClient(k8s.BatchV1Api);
  const networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api);
  const customObjects = kc.makeApiClient(k8s.CustomObjectsApi);
  const objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);

  return {
    coreV1,
    appsV1,
    batchV1,
    networkingV1,
    customObjects,
    kubeConfig: kc,
    objectApi,
  };
}

/**
 * Retrieves the current Kubernetes context name from a KubeConfig instance.
 *
 * @param kc - The KubeConfig to read the current context from.
 * @returns The name of the current context, or 'unknown' if not set.
 */
export function getCurrentContextName(kc: k8s.KubeConfig): string {
  return kc.getCurrentContext() || 'unknown';
}

/**
 * Retrieves the cluster server URL for the current context.
 *
 * @param kc - The KubeConfig to read from.
 * @returns The cluster server URL, or 'unknown' if the context/cluster cannot be resolved.
 */
export function getClusterServerUrl(kc: k8s.KubeConfig): string {
  const currentContext = kc.getCurrentContext();
  const context = kc.getContexts().find((c) => c.name === currentContext);

  if (!context) {
    return 'unknown';
  }

  const cluster = kc.getClusters().find((c) => c.name === context.cluster);
  return cluster?.server || 'unknown';
}
