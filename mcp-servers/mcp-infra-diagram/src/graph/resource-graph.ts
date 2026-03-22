/**
 * @fileoverview Infrastructure graph builder.
 *
 * Orchestrates all discoverers and assembles their results into a
 * unified {@link InfraGraph}. Deduplicates nodes and resolves
 * cross-discoverer edge references.
 *
 * @module graph/resource-graph
 */

import type { AwsClients } from '../clients/aws-client.js';
import type { K8sClients } from '../clients/k8s-client.js';
import type { InfraGraph, ResourceNode, ResourceEdge, DiagramScope, ResourceType } from './types.js';
import {
  discoverVpcResources,
  discoverSecurityGroups,
  discoverLoadBalancers,
  discoverComputeResources,
  discoverEdgeResources,
  discoverK8sResources,
} from '../discoverers/index.js';

/** Options for building the infrastructure graph. */
export interface BuildGraphOptions {
  /** AWS region to scan. */
  readonly region: string;
  /** Optional VPC ID to scope AWS discovery. */
  readonly vpcId?: string;
  /** Optional tag filter for AWS resources. */
  readonly tags?: Record<string, string>;
  /** Whether to include Kubernetes cluster resources. */
  readonly includeK8s: boolean;
  /** Diagram scope filter (applied after discovery). */
  readonly scope?: DiagramScope;
}

/** Resource types included in each diagram scope. */
const SCOPE_TYPES: Record<DiagramScope, ReadonlySet<ResourceType>> = {
  full: new Set<ResourceType>([
    'vpc', 'subnet', 'security-group', 'nat-gateway', 'internet-gateway',
    'route-table', 'ec2-instance', 'auto-scaling-group', 'nlb', 'alb',
    'target-group', 'listener', 'cloudfront-distribution', 'waf-web-acl',
    'acm-certificate', 'k8s-pod', 'k8s-service', 'k8s-deployment',
    'k8s-daemonset', 'k8s-ingress', 'k8s-namespace',
  ]),
  networking: new Set<ResourceType>([
    'vpc', 'subnet', 'security-group', 'nat-gateway', 'internet-gateway',
    'route-table', 'nlb', 'alb', 'target-group', 'listener',
  ]),
  compute: new Set<ResourceType>([
    'ec2-instance', 'auto-scaling-group', 'k8s-pod', 'k8s-service',
    'k8s-deployment', 'k8s-daemonset', 'k8s-namespace',
  ]),
  edge: new Set<ResourceType>([
    'cloudfront-distribution', 'waf-web-acl', 'acm-certificate',
  ]),
};

/**
 * Builds a unified infrastructure graph from live AWS and K8s resources.
 *
 * @param awsClients - AWS SDK clients for resource discovery.
 * @param k8sClients - K8s API clients (used only if `includeK8s` is true).
 * @param options - Graph building options.
 * @returns A complete {@link InfraGraph} ready for rendering.
 */
export async function buildInfraGraph(
  awsClients: AwsClients,
  k8sClients: K8sClients | undefined,
  options: BuildGraphOptions,
): Promise<InfraGraph> {
  const allNodes: ResourceNode[] = [];
  const allEdges: ResourceEdge[] = [];

  const discoveryOptions = {
    vpcId: options.vpcId,
    tags: options.tags,
  };

  // Run AWS discoverers in parallel
  const [vpcResult, sgResult, lbResult, computeResult, edgeResult] = await Promise.all([
    discoverVpcResources(awsClients, discoveryOptions),
    discoverSecurityGroups(awsClients, discoveryOptions),
    discoverLoadBalancers(awsClients, discoveryOptions),
    discoverComputeResources(awsClients, discoveryOptions),
    discoverEdgeResources(awsClients, {}),
  ]);

  allNodes.push(...vpcResult.nodes, ...sgResult.nodes, ...lbResult.nodes,
    ...computeResult.nodes, ...edgeResult.nodes);
  allEdges.push(...vpcResult.edges, ...sgResult.edges, ...lbResult.edges,
    ...computeResult.edges, ...edgeResult.edges);

  // K8s discovery (optional)
  if (options.includeK8s && k8sClients) {
    const k8sResult = await discoverK8sResources(k8sClients);
    allNodes.push(...k8sResult.nodes);
    allEdges.push(...k8sResult.edges);
  }

  // Deduplicate nodes by ID
  const nodeMap = new Map<string, ResourceNode>();
  for (const node of allNodes) {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
  }

  // Apply scope filter
  const scope = options.scope ?? 'full';
  const allowedTypes = SCOPE_TYPES[scope];

  const filteredNodes = [...nodeMap.values()].filter((n) =>
    allowedTypes.has(n.type),
  );
  const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));

  // Only keep edges where both source and target are in scope
  const filteredEdges = allEdges.filter(
    (e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target),
  );

  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    discoveredAt: new Date().toISOString(),
    region: options.region,
    includesK8s: options.includeK8s,
  };
}
