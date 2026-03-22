/**
 * @fileoverview Python `diagrams` library script renderer.
 *
 * Converts an {@link InfraGraph} into a Python script that uses the
 * `diagrams` library to generate PNG architecture diagrams with
 * AWS and Kubernetes provider icons.
 *
 * @module renderers/python-renderer
 */

import type { InfraGraph, ResourceNode, ResourceType } from '../graph/types.js';

/**
 * Maps resource types to Python `diagrams` library import paths.
 *
 * The format is `[module, class]` for generating import statements.
 */
const DIAGRAM_ICONS: Partial<Record<ResourceType, [string, string]>> = {
  'vpc': ['diagrams.aws.network', 'VPC'],
  'subnet': ['diagrams.aws.network', 'PublicSubnet'],
  'security-group': ['diagrams.aws.security', 'WAF'],
  'nat-gateway': ['diagrams.aws.network', 'NATGateway'],
  'internet-gateway': ['diagrams.aws.network', 'InternetGateway'],
  'ec2-instance': ['diagrams.aws.compute', 'EC2'],
  'auto-scaling-group': ['diagrams.aws.compute', 'AutoScaling'],
  'nlb': ['diagrams.aws.network', 'ElbNetworkLoadBalancer'],
  'alb': ['diagrams.aws.network', 'ElbApplicationLoadBalancer'],
  'cloudfront-distribution': ['diagrams.aws.network', 'CloudFront'],
  'waf-web-acl': ['diagrams.aws.security', 'WAF'],
  'acm-certificate': ['diagrams.aws.security', 'CertificateManager'],
  'k8s-pod': ['diagrams.k8s.compute', 'Pod'],
  'k8s-service': ['diagrams.k8s.network', 'Service'],
  'k8s-deployment': ['diagrams.k8s.compute', 'Deployment'],
  'k8s-daemonset': ['diagrams.k8s.compute', 'DaemonSet'],
  'k8s-ingress': ['diagrams.k8s.network', 'Ingress'],
  'k8s-namespace': ['diagrams.k8s.group', 'Namespace'],
};

/**
 * Sanitises a string for use as a Python variable name.
 *
 * @param id - Raw resource ID.
 * @returns Valid Python identifier.
 */
function pythonVar(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

/**
 * Renders an infrastructure graph as a Python `diagrams` library script.
 *
 * @param graph - The discovered infrastructure graph.
 * @param outputPath - The output file path for the generated PNG
 *   (without extension; `diagrams` adds `.png` automatically).
 * @returns A complete Python script string.
 */
export function renderPythonDiagram(graph: InfraGraph, outputPath: string): string {
  const lines: string[] = [];

  // Collect required imports
  const imports = new Map<string, Set<string>>();
  imports.set('diagrams', new Set(['Diagram', 'Cluster', 'Edge']));

  for (const node of graph.nodes) {
    const iconDef = DIAGRAM_ICONS[node.type];
    if (iconDef) {
      const [module, cls] = iconDef;
      const existing = imports.get(module) ?? new Set();
      existing.add(cls);
      imports.set(module, existing);
    }
  }

  // Generate import statements
  lines.push('#!/usr/bin/env python3');
  lines.push('"""');
  lines.push(`Auto-generated infrastructure diagram — ${graph.discoveredAt}`);
  lines.push(`Region: ${graph.region} | K8s included: ${graph.includesK8s}`);
  lines.push('"""');
  lines.push('');

  for (const [module, classes] of imports) {
    const sortedClasses = [...classes].sort().join(', ');
    lines.push(`from ${module} import ${sortedClasses}`);
  }

  lines.push('');

  // Strip .png extension if provided (diagrams adds it)
  const cleanPath = outputPath.replace(/\.png$/, '').replace(/\.py$/, '');
  const diagramName = cleanPath.split('/').pop() ?? 'infrastructure';

  lines.push(`with Diagram("${graph.region} Infrastructure", filename="${cleanPath}", show=False, direction="TB"):`);

  // Group nodes by parent for clusters
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

  // Render nodes
  const renderNode = (node: ResourceNode, indent: string): void => {
    const varName = pythonVar(node.id);
    const iconDef = DIAGRAM_ICONS[node.type];
    const children = childrenByParent.get(node.id);

    if (children && children.length > 0 &&
        (node.type === 'vpc' || node.type === 'k8s-namespace')) {
      lines.push(`${indent}with Cluster("${node.label}"):`);
      // Render the parent node inside the cluster
      if (iconDef) {
        lines.push(`${indent}    ${varName} = ${iconDef[1]}("${node.label}")`);
      }
      for (const child of children) {
        renderNode(child, `${indent}    `);
      }
    } else if (iconDef) {
      lines.push(`${indent}${varName} = ${iconDef[1]}("${node.label}")`);
    } else {
      lines.push(`${indent}# ${node.type}: ${node.label} (no icon mapping)`);
    }
  };

  for (const node of rootNodes) {
    renderNode(node, '    ');
  }

  // Render edges
  lines.push('');
  lines.push('    # Relationships');
  for (const edge of graph.edges) {
    if (edge.edgeType === 'contains') continue;

    const srcVar = pythonVar(edge.source);
    const tgtVar = pythonVar(edge.target);

    // Only emit edges for nodes that have icon definitions
    const srcNode = graph.nodes.find((n) => n.id === edge.source);
    const tgtNode = graph.nodes.find((n) => n.id === edge.target);
    if (!srcNode || !tgtNode) continue;
    if (!DIAGRAM_ICONS[srcNode.type] || !DIAGRAM_ICONS[tgtNode.type]) continue;

    lines.push(`    ${srcVar} >> Edge(label="${edge.label}") >> ${tgtVar}`);
  }

  lines.push('');

  return lines.join('\n');
}
