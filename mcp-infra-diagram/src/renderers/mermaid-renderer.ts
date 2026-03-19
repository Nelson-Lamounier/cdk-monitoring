/**
 * @fileoverview Mermaid diagram renderer.
 *
 * Converts an {@link InfraGraph} into a Mermaid `graph TB` string
 * with subgraphs for VPCs, subnets, and K8s namespaces.
 *
 * @module renderers/mermaid-renderer
 */

import type { InfraGraph, ResourceNode, ResourceType } from '../graph/types.js';
import { shortenId } from '../utils/helpers.js';

/** Mermaid style classes for different resource types. */
const STYLE_MAP: Partial<Record<ResourceType, string>> = {
  'vpc': 'fill:#1a472a,color:#fff,stroke:#2d6a4f',
  'subnet': 'fill:#2d6a4f,color:#fff',
  'security-group': 'fill:#c0392b,color:#fff',
  'nat-gateway': 'fill:#8e44ad,color:#fff',
  'internet-gateway': 'fill:#2980b9,color:#fff',
  'ec2-instance': 'fill:#e67e22,color:#fff',
  'auto-scaling-group': 'fill:#d35400,color:#fff',
  'nlb': 'fill:#3498db,color:#fff',
  'alb': 'fill:#3498db,color:#fff',
  'cloudfront-distribution': 'fill:#9b59b6,color:#fff',
  'waf-web-acl': 'fill:#e74c3c,color:#fff',
  'acm-certificate': 'fill:#27ae60,color:#fff',
  'k8s-namespace': 'fill:#326ce5,color:#fff',
  'k8s-deployment': 'fill:#326ce5,color:#fff',
  'k8s-service': 'fill:#1abc9c,color:#fff',
  'k8s-pod': 'fill:#2ecc71,color:#fff',
  'k8s-ingress': 'fill:#f39c12,color:#fff',
};

/**
 * Sanitises a string for use as a Mermaid node ID.
 * Replaces characters that break Mermaid syntax.
 *
 * @param id - Raw resource ID.
 * @returns Safe Mermaid node ID.
 */
function sanitiseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Escapes a label string for safe use inside Mermaid node labels.
 *
 * @param label - Raw label text.
 * @returns Escaped label.
 */
function escapeLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/[[\](){}]/g, '');
}

/**
 * Renders an infrastructure graph as a Mermaid diagram string.
 *
 * @param graph - The discovered infrastructure graph.
 * @returns A Mermaid `graph TB` string ready for markdown embedding.
 */
export function renderMermaid(graph: InfraGraph): string {
  const lines: string[] = ['graph TB'];

  // Group nodes by parent for subgraph structure
  const rootNodes: ResourceNode[] = [];
  const childrenByParent = new Map<string, ResourceNode[]>();

  for (const node of graph.nodes) {
    if (node.parentId) {
      const siblings = childrenByParent.get(node.parentId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
    } else {
      rootNodes.push(node);
    }
  }

  // Render function for a node
  const renderNode = (node: ResourceNode, indent: string): void => {
    const safeId = sanitiseId(node.id);
    const label = escapeLabel(node.label);
    const metadata = buildMetadataLabel(node);
    const fullLabel = metadata ? `${label}<br/>${metadata}` : label;

    lines.push(`${indent}${safeId}["${fullLabel}"]`);

    // Apply style
    const style = STYLE_MAP[node.type];
    if (style) {
      lines.push(`${indent}style ${safeId} ${style}`);
    }

    // Render children as subgraph
    const children = childrenByParent.get(node.id);
    if (children && children.length > 0) {
      // VPCs and namespaces become subgraphs
      if (node.type === 'vpc' || node.type === 'k8s-namespace') {
        lines.push(`${indent}subgraph ${safeId}_sg["${label}"]`);
        for (const child of children) {
          renderNode(child, `${indent}    `);
        }
        lines.push(`${indent}end`);
      }
    }
  };

  // Render root nodes
  for (const node of rootNodes) {
    renderNode(node, '    ');
  }

  // Render edges
  lines.push('');
  for (const edge of graph.edges) {
    const source = sanitiseId(edge.source);
    const target = sanitiseId(edge.target);
    const label = escapeLabel(edge.label);

    // Skip containment edges (handled by subgraphs)
    if (edge.edgeType === 'contains') continue;

    if (label) {
      lines.push(`    ${source} -->|"${label}"| ${target}`);
    } else {
      lines.push(`    ${source} --> ${target}`);
    }
  }

  return lines.join('\n');
}

/**
 * Builds a compact metadata label for Mermaid node display.
 *
 * @param node - The resource node.
 * @returns Compact metadata string or empty string.
 */
function buildMetadataLabel(node: ResourceNode): string {
  switch (node.type) {
    case 'vpc':
      return node.metadata.cidr ?? '';
    case 'subnet':
      return `${node.metadata.cidr ?? ''} ${node.metadata.az ?? ''}`;
    case 'security-group':
      return `${node.metadata.ingressRuleCount ?? 0} in / ${node.metadata.egressRuleCount ?? 0} out`;
    case 'ec2-instance':
      return `${node.metadata.instanceType ?? ''} ${node.metadata.state ?? ''}`;
    case 'nlb':
    case 'alb':
      return `${node.metadata.scheme ?? ''} ${node.metadata.state ?? ''}`;
    case 'cloudfront-distribution':
      return node.metadata.domainName ?? '';
    case 'auto-scaling-group':
      return `${node.metadata.desiredCapacity ?? 0}/${node.metadata.maxSize ?? 0}`;
    case 'k8s-deployment':
      return `${node.metadata.readyReplicas ?? 0}/${node.metadata.replicas ?? 0} ready`;
    case 'k8s-pod':
      return `${node.metadata.phase ?? ''} ${shortenId(node.metadata.ip ?? '')}`;
    case 'k8s-service':
      return `${node.metadata.type ?? ''} ${node.metadata.ports ?? ''}`;
    default:
      return '';
  }
}
