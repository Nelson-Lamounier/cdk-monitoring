/**
 * @fileoverview Kubernetes resource discoverer.
 *
 * Discovers pods, services, deployments, daemonsets, and ingresses
 * from the connected K8s cluster. Resolves Service selectors to pod
 * labels and Deployment ownership chains.
 *
 * @module discoverers/k8s-discoverer
 */

import type { K8sClients } from '../clients/k8s-client.js';
import type { ResourceNode, ResourceEdge } from '../graph/types.js';

/** Options for scoping K8s discovery. */
export interface K8sDiscoveryOptions {
  /** Discover only resources in this namespace. Omit for all namespaces. */
  readonly namespace?: string;
  /** Label selector (e.g. 'app=my-app'). */
  readonly labelSelector?: string;
}

/** Result of K8s discovery. */
export interface K8sDiscoveryResult {
  readonly nodes: ResourceNode[];
  readonly edges: ResourceEdge[];
}

/**
 * Discovers Kubernetes resources from the connected cluster.
 *
 * @param clients - K8s API clients.
 * @param options - Optional namespace and label selector filters.
 * @returns Nodes for namespaces, pods, services, deployments, daemonsets,
 *   ingresses + ownership and selector-based edges.
 */
export async function discoverK8sResources(
  clients: K8sClients,
  options: K8sDiscoveryOptions = {},
): Promise<K8sDiscoveryResult> {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];
  const { namespace, labelSelector } = options;

  // --- Namespaces ---
  const { items: namespaces } = await clients.coreV1.listNamespace();
  const nsNames = namespace
    ? [namespace]
    : namespaces
        .map((ns) => ns.metadata?.name)
        .filter((n): n is string => n !== undefined && n !== 'kube-system' && n !== 'kube-public' && n !== 'kube-node-lease');

  for (const ns of nsNames) {
    nodes.push({
      id: `ns/${ns}`,
      type: 'k8s-namespace',
      label: ns,
      metadata: {},
      namespace: ns,
    });
  }

  for (const ns of nsNames) {
    // --- Deployments ---
    const { items: deployments } = await clients.appsV1.listNamespacedDeployment(
      { namespace: ns, labelSelector },
    );

    for (const dep of deployments) {
      const depName = dep.metadata?.name ?? 'unknown';
      const depId = `deploy/${ns}/${depName}`;

      nodes.push({
        id: depId,
        type: 'k8s-deployment',
        label: depName,
        metadata: {
          replicas: String(dep.spec?.replicas ?? 0),
          readyReplicas: String(dep.status?.readyReplicas ?? 0),
          availableReplicas: String(dep.status?.availableReplicas ?? 0),
          strategy: dep.spec?.strategy?.type ?? 'unknown',
          containers: (dep.spec?.template?.spec?.containers ?? [])
            .map((c) => `${c.name}:${c.image ?? 'unknown'}`)
            .join(', '),
        },
        namespace: ns,
        parentId: `ns/${ns}`,
      });

      edges.push({
        source: `ns/${ns}`,
        target: depId,
        label: 'contains',
        edgeType: 'contains',
      });
    }

    // --- DaemonSets ---
    const { items: daemonSets } = await clients.appsV1.listNamespacedDaemonSet(
      { namespace: ns, labelSelector },
    );

    for (const ds of daemonSets) {
      const dsName = ds.metadata?.name ?? 'unknown';
      const dsId = `ds/${ns}/${dsName}`;

      nodes.push({
        id: dsId,
        type: 'k8s-daemonset',
        label: dsName,
        metadata: {
          desiredScheduled: String(ds.status?.desiredNumberScheduled ?? 0),
          currentScheduled: String(ds.status?.currentNumberScheduled ?? 0),
          ready: String(ds.status?.numberReady ?? 0),
          containers: (ds.spec?.template?.spec?.containers ?? [])
            .map((c) => `${c.name}:${c.image ?? 'unknown'}`)
            .join(', '),
        },
        namespace: ns,
        parentId: `ns/${ns}`,
      });

      edges.push({
        source: `ns/${ns}`,
        target: dsId,
        label: 'contains',
        edgeType: 'contains',
      });
    }

    // --- Pods ---
    const { items: pods } = await clients.coreV1.listNamespacedPod(
      { namespace: ns, labelSelector },
    );

    for (const pod of pods) {
      const podName = pod.metadata?.name ?? 'unknown';
      const podId = `pod/${ns}/${podName}`;
      const labels = pod.metadata?.labels ?? {};
      const ownerRefs = pod.metadata?.ownerReferences ?? [];

      nodes.push({
        id: podId,
        type: 'k8s-pod',
        label: podName,
        metadata: {
          phase: pod.status?.phase ?? 'unknown',
          nodeName: pod.spec?.nodeName ?? '',
          ip: pod.status?.podIP ?? '',
          containers: (pod.spec?.containers ?? [])
            .map((c) => c.name)
            .join(', '),
          restarts: String(
            (pod.status?.containerStatuses ?? [])
              .reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0),
          ),
          labels: Object.entries(labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
        },
        namespace: ns,
        parentId: `ns/${ns}`,
      });

      // Pod → owning Deployment/DaemonSet
      for (const owner of ownerRefs) {
        if (owner.kind === 'ReplicaSet') {
          // ReplicaSet name typically = deployment-name-hash
          const depName = owner.name?.replace(/-[a-f0-9]+$/, '') ?? owner.name;
          const depId = `deploy/${ns}/${depName}`;
          edges.push({
            source: depId,
            target: podId,
            label: 'manages',
            edgeType: 'references',
          });
        } else if (owner.kind === 'DaemonSet') {
          const dsId = `ds/${ns}/${owner.name}`;
          edges.push({
            source: dsId,
            target: podId,
            label: 'manages',
            edgeType: 'references',
          });
        }
      }
    }

    // --- Services ---
    const { items: services } = await clients.coreV1.listNamespacedService(
      { namespace: ns, labelSelector },
    );

    for (const svc of services) {
      const svcName = svc.metadata?.name ?? 'unknown';
      const svcId = `svc/${ns}/${svcName}`;
      const selector = svc.spec?.selector ?? {};
      const ports = svc.spec?.ports ?? [];

      nodes.push({
        id: svcId,
        type: 'k8s-service',
        label: svcName,
        metadata: {
          type: svc.spec?.type ?? 'ClusterIP',
          clusterIP: svc.spec?.clusterIP ?? '',
          ports: ports
            .map((p) => `${p.port}/${p.protocol ?? 'TCP'}→${p.targetPort ?? p.port}`)
            .join(', '),
          selector: Object.entries(selector)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
          externalIPs: (svc.spec?.externalIPs ?? []).join(', '),
          loadBalancerIP: svc.status?.loadBalancer?.ingress?.[0]?.hostname ?? '',
        },
        namespace: ns,
        parentId: `ns/${ns}`,
      });

      edges.push({
        source: `ns/${ns}`,
        target: svcId,
        label: 'contains',
        edgeType: 'contains',
      });

      // Service selector → matching pods
      if (Object.keys(selector).length > 0) {
        const matchingPods = pods.filter((pod) => {
          const podLabels = pod.metadata?.labels ?? {};
          return Object.entries(selector).every(
            ([k, v]) => podLabels[k] === v,
          );
        });

        for (const pod of matchingPods) {
          const podId = `pod/${ns}/${pod.metadata?.name ?? 'unknown'}`;
          const portLabel = ports.map((p) => `${p.port}`).join(',');
          edges.push({
            source: svcId,
            target: podId,
            label: portLabel ? `port ${portLabel}` : 'selects',
            edgeType: 'references',
          });
        }
      }
    }

    // --- Ingresses ---
    const { items: ingresses } = await clients.networkingV1.listNamespacedIngress(
      { namespace: ns, labelSelector },
    );

    for (const ing of ingresses) {
      const ingName = ing.metadata?.name ?? 'unknown';
      const ingId = `ing/${ns}/${ingName}`;
      const rules = ing.spec?.rules ?? [];

      const hostPaths: string[] = [];
      for (const rule of rules) {
        const host = rule.host ?? '*';
        for (const path of rule.http?.paths ?? []) {
          hostPaths.push(`${host}${path.path ?? '/'}`);

          // Ingress → backend service
          const backendSvc = path.backend?.service?.name;
          if (backendSvc) {
            const svcId = `svc/${ns}/${backendSvc}`;
            const port = path.backend?.service?.port?.number ?? path.backend?.service?.port?.name ?? '';
            edges.push({
              source: ingId,
              target: svcId,
              label: `${host}${path.path ?? '/'} → port ${port}`,
              edgeType: 'routes',
            });
          }
        }
      }

      nodes.push({
        id: ingId,
        type: 'k8s-ingress',
        label: ingName,
        metadata: {
          hosts: hostPaths.join(' | '),
          ingressClass: ing.spec?.ingressClassName ?? '',
          tls: (ing.spec?.tls ?? [])
            .map((t) => t.hosts?.join(', ') ?? '')
            .join(' | '),
        },
        namespace: ns,
        parentId: `ns/${ns}`,
      });

      edges.push({
        source: `ns/${ns}`,
        target: ingId,
        label: 'contains',
        edgeType: 'contains',
      });
    }
  }

  return { nodes, edges };
}
