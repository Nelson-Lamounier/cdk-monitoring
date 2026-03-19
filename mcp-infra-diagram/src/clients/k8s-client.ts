/**
 * @fileoverview Kubernetes client factory for infrastructure diagram discovery.
 *
 * Creates typed K8s API clients for discovering pods, services,
 * deployments, daemonsets, and ingresses from the cluster.
 *
 * @module clients/k8s-client
 */

import * as k8s from '@kubernetes/client-node';

/** Container for Kubernetes API clients. */
export interface K8sClients {
  /** Core V1 — pods, services, namespaces, nodes. */
  readonly coreV1: k8s.CoreV1Api;
  /** Apps V1 — deployments, daemonsets, statefulsets. */
  readonly appsV1: k8s.AppsV1Api;
  /** Networking V1 — ingresses. */
  readonly networkingV1: k8s.NetworkingV1Api;
  /** The kubeconfig used for connection. */
  readonly kc: k8s.KubeConfig;
}

/**
 * Creates Kubernetes API clients from the system kubeconfig.
 *
 * @param kubeconfigPath - Optional explicit kubeconfig path.
 *   Falls back to `KUBECONFIG` env var, then default `~/.kube/config`.
 * @returns Typed K8s client container.
 * @throws Error if kubeconfig cannot be loaded.
 */
export function createK8sClients(kubeconfigPath?: string): K8sClients {
  const kc = new k8s.KubeConfig();

  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }

  return {
    coreV1: kc.makeApiClient(k8s.CoreV1Api),
    appsV1: kc.makeApiClient(k8s.AppsV1Api),
    networkingV1: kc.makeApiClient(k8s.NetworkingV1Api),
    kc,
  };
}
