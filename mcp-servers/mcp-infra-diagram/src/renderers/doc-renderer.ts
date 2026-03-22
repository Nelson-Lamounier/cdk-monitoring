/**
 * @fileoverview Infrastructure documentation renderer with narrative mode.
 *
 * Converts an {@link InfraGraph} into a structured markdown document
 * that explains real resource relationships — CIDRs, ports, rules,
 * forwarding chains — from live AWS and Kubernetes state.
 *
 * Two modes:
 * - **inventory** — factual tables and lists of every resource and edge
 * - **narrative** — explains *why* each relationship exists, connecting
 *   SG rules to load balancers, selectors to pods, etc.
 *
 * @module renderers/doc-renderer
 */

import type {
  InfraGraph,
  ResourceNode,
  ResourceEdge,
  ResourceType,
} from '../graph/types.js';

/** Documentation mode controls the output style. */
export type DocMode = 'inventory' | 'narrative';

/** Human-readable category labels for resource types. */
const CATEGORY_LABELS: Record<string, string> = {
  networking: '🔗 Network Topology',
  security: '🛡️ Security Posture',
  compute: '💻 Compute Inventory',
  edge: '🌐 Edge & CDN',
  kubernetes: '☸️ Kubernetes Workloads',
  routing: '🔀 Request Path & Routing',
};

/** Groups resource types into documentation categories. */
const TYPE_CATEGORIES: Record<ResourceType, string> = {
  'vpc': 'networking',
  'subnet': 'networking',
  'nat-gateway': 'networking',
  'internet-gateway': 'networking',
  'route-table': 'networking',
  'security-group': 'security',
  'ec2-instance': 'compute',
  'auto-scaling-group': 'compute',
  'nlb': 'routing',
  'alb': 'routing',
  'target-group': 'routing',
  'listener': 'routing',
  'cloudfront-distribution': 'edge',
  'waf-web-acl': 'edge',
  'acm-certificate': 'edge',
  'k8s-pod': 'kubernetes',
  'k8s-service': 'kubernetes',
  'k8s-deployment': 'kubernetes',
  'k8s-daemonset': 'kubernetes',
  'k8s-ingress': 'kubernetes',
  'k8s-namespace': 'kubernetes',
};

// ─── Main Renderer ──────────────────────────────────────────────

/**
 * Renders an infrastructure graph as a structured markdown document.
 *
 * @param graph - The discovered infrastructure graph.
 * @param mode - 'inventory' for factual data, 'narrative' for explanations.
 * @returns A complete markdown document string.
 */
export function renderInfraDoc(graph: InfraGraph, mode: DocMode): string {
  const sections: string[] = [];

  sections.push(renderHeader(graph));

  // Group nodes by category
  const grouped = groupByCategory(graph.nodes);

  // Render each category
  if (grouped.networking.length > 0) {
    sections.push(
      mode === 'narrative'
        ? renderNetworkNarrative(grouped.networking, graph)
        : renderNetworkInventory(grouped.networking, graph),
    );
  }

  if (grouped.security.length > 0) {
    sections.push(
      mode === 'narrative'
        ? renderSecurityNarrative(grouped.security, graph)
        : renderSecurityInventory(grouped.security),
    );
  }

  if (grouped.routing.length > 0) {
    sections.push(
      mode === 'narrative'
        ? renderRoutingNarrative(grouped.routing, graph)
        : renderRoutingInventory(grouped.routing, graph),
    );
  }

  if (grouped.edge.length > 0) {
    sections.push(
      mode === 'narrative'
        ? renderEdgeNarrative(grouped.edge, graph)
        : renderEdgeInventory(grouped.edge),
    );
  }

  if (grouped.compute.length > 0) {
    sections.push(
      mode === 'narrative'
        ? renderComputeNarrative(grouped.compute, graph)
        : renderComputeInventory(grouped.compute),
    );
  }

  if (grouped.kubernetes.length > 0) {
    sections.push(
      mode === 'narrative'
        ? renderK8sNarrative(grouped.kubernetes, graph)
        : renderK8sInventory(grouped.kubernetes, graph),
    );
  }

  return sections.join('\n\n---\n\n');
}

// ─── Header ─────────────────────────────────────────────────────

/**
 * Renders the document header with discovery metadata.
 *
 * @param graph - The infrastructure graph.
 * @returns Markdown header string.
 */
function renderHeader(graph: InfraGraph): string {
  const nodesByType = new Map<string, number>();
  for (const node of graph.nodes) {
    nodesByType.set(node.type, (nodesByType.get(node.type) ?? 0) + 1);
  }

  const typeSummary = [...nodesByType.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');

  return [
    '# Infrastructure Documentation',
    '',
    `> Discovered from live AWS resources on **${graph.discoveredAt}**`,
    `> Region: **${graph.region}** | Kubernetes: **${graph.includesK8s ? 'included' : 'excluded'}**`,
    '',
    `**${graph.nodes.length} resources** (${typeSummary}) with **${graph.edges.length} relationships** discovered.`,
  ].join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────

/** Groups nodes into documentation categories. */
function groupByCategory(
  nodes: readonly ResourceNode[],
): Record<string, ResourceNode[]> {
  const groups: Record<string, ResourceNode[]> = {
    networking: [],
    security: [],
    routing: [],
    edge: [],
    compute: [],
    kubernetes: [],
  };

  for (const node of nodes) {
    const category = TYPE_CATEGORIES[node.type] ?? 'compute';
    groups[category].push(node);
  }

  return groups;
}

/** Finds all edges where a given node is the source or target. */
function findEdges(
  graph: InfraGraph,
  nodeId: string,
  direction: 'outgoing' | 'incoming' | 'both' = 'both',
): ResourceEdge[] {
  return graph.edges.filter((e) => {
    if (direction === 'outgoing') return e.source === nodeId;
    if (direction === 'incoming') return e.target === nodeId;
    return e.source === nodeId || e.target === nodeId;
  });
}

/** Resolves a node by ID from the graph. */
function resolveNode(
  graph: InfraGraph,
  nodeId: string,
): ResourceNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}

/** Formats a node reference as a readable label. */
function nodeRef(node: ResourceNode | undefined): string {
  if (!node) return '_unknown resource_';
  return `\`${node.label}\` (${node.type})`;
}

// ─── Network Topology ───────────────────────────────────────────

/** Inventory mode: factual VPC/subnet/routing table. */
function renderNetworkInventory(
  nodes: ResourceNode[],
  _graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.networking}`, ''];

  const vpcs = nodes.filter((n) => n.type === 'vpc');
  const subnets = nodes.filter((n) => n.type === 'subnet');
  const natGws = nodes.filter((n) => n.type === 'nat-gateway');
  const igws = nodes.filter((n) => n.type === 'internet-gateway');

  for (const vpc of vpcs) {
    lines.push(`### VPC: ${vpc.label}`);
    lines.push(`- **CIDR:** ${vpc.metadata.cidr}`);
    lines.push(`- **State:** ${vpc.metadata.state}`);
    lines.push(`- **Default:** ${vpc.metadata.isDefault}`);
    lines.push('');

    const vpcSubnets = subnets.filter((s) => s.parentId === vpc.id);
    if (vpcSubnets.length > 0) {
      lines.push('| Subnet | CIDR | AZ | Public IP | Available IPs |');
      lines.push('|---|---|---|---|---|');
      for (const s of vpcSubnets) {
        lines.push(
          `| ${s.label} | ${s.metadata.cidr} | ${s.metadata.az} | ${s.metadata.mapPublicIp} | ${s.metadata.availableIps} |`,
        );
      }
      lines.push('');
    }
  }

  if (natGws.length > 0) {
    lines.push('### NAT Gateways');
    for (const nat of natGws) {
      lines.push(`- **${nat.label}** — Public IP: ${nat.metadata.publicIp}, State: ${nat.metadata.state}`);
    }
    lines.push('');
  }

  if (igws.length > 0) {
    lines.push('### Internet Gateways');
    for (const igw of igws) {
      lines.push(`- **${igw.label}** — State: ${igw.metadata.state}`);
    }
  }

  return lines.join('\n');
}

/** Narrative mode: explains the network topology and why it's structured this way. */
function renderNetworkNarrative(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.networking}`, ''];

  const vpcs = nodes.filter((n) => n.type === 'vpc');
  const subnets = nodes.filter((n) => n.type === 'subnet');
  const natGws = nodes.filter((n) => n.type === 'nat-gateway');
  const igws = nodes.filter((n) => n.type === 'internet-gateway');

  for (const vpc of vpcs) {
    lines.push(`### VPC: ${vpc.label}`);
    lines.push('');

    const vpcSubnets = subnets.filter((s) => s.parentId === vpc.id);
    const publicSubnets = vpcSubnets.filter((s) => s.metadata.mapPublicIp === 'true');
    const privateSubnets = vpcSubnets.filter((s) => s.metadata.mapPublicIp !== 'true');
    const azs = [...new Set(vpcSubnets.map((s) => s.metadata.az))];
    const vpcNats = natGws.filter((n) => n.parentId === vpc.id);
    const vpcIgws = igws.filter((n) => n.parentId === vpc.id);

    lines.push(
      `This VPC uses CIDR block \`${vpc.metadata.cidr}\` and spans **${azs.length} availability zone${azs.length > 1 ? 's' : ''}** ` +
      `(${azs.join(', ')}). It contains **${vpcSubnets.length} subnets** — ` +
      `${publicSubnets.length} public and ${privateSubnets.length} private.`,
    );
    lines.push('');

    if (publicSubnets.length > 0 && vpcIgws.length > 0) {
      lines.push(
        `**Public subnets** (${publicSubnets.map((s) => `\`${s.label}\``).join(', ')}) ` +
        `have \`MapPublicIpOnLaunch\` enabled, allowing direct internet access via the ` +
        `Internet Gateway \`${vpcIgws[0].label}\`. These typically host load balancers and bastion instances.`,
      );
      lines.push('');
    }

    if (privateSubnets.length > 0 && vpcNats.length > 0) {
      lines.push(
        `**Private subnets** (${privateSubnets.map((s) => `\`${s.label}\``).join(', ')}) ` +
        `route outbound internet traffic through ${vpcNats.length > 1 ? 'NAT Gateways' : 'a NAT Gateway'} ` +
        `(${vpcNats.map((n) => `\`${n.label}\` at ${n.metadata.publicIp}`).join(', ')}). ` +
        `This provides outbound connectivity for package updates and API calls ` +
        `whilst keeping workloads unreachable from the public internet.`,
      );
      lines.push('');
    }

    // Route table narrative
    const routeTables = nodes.filter((n) => n.type === 'route-table' && n.parentId === vpc.id);
    if (routeTables.length > 0) {
      const routeEdges = routeTables.flatMap((rt) => findEdges(graph, rt.id, 'outgoing'));
      const natRoutes = routeEdges.filter((e) => {
        const target = resolveNode(graph, e.target);
        return target?.type === 'nat-gateway';
      });
      const igwRoutes = routeEdges.filter((e) => {
        const target = resolveNode(graph, e.target);
        return target?.type === 'internet-gateway';
      });

      if (natRoutes.length > 0 || igwRoutes.length > 0) {
        lines.push(
          `**${routeTables.length} route tables** control traffic flow: ` +
          `${igwRoutes.length} route${igwRoutes.length !== 1 ? 's' : ''} direct \`0.0.0.0/0\` traffic to the IGW (public subnets), ` +
          `${natRoutes.length} route${natRoutes.length !== 1 ? 's' : ''} direct it to a NAT Gateway (private subnets).`,
        );
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Security Posture ───────────────────────────────────────────

/** Inventory mode: factual SG rules table. */
function renderSecurityInventory(nodes: ResourceNode[]): string {
  const lines = [`## ${CATEGORY_LABELS.security}`, ''];

  const sgs = nodes.filter((n) => n.type === 'security-group');

  lines.push(`**${sgs.length} security groups** discovered.`);
  lines.push('');

  for (const sg of sgs) {
    lines.push(`### ${sg.label}`);
    lines.push(`- **Description:** ${sg.metadata.description || '_none_'}`);
    lines.push(`- **VPC:** ${sg.metadata.vpcId}`);
    lines.push(`- **Ingress rules:** ${sg.metadata.ingressRuleCount}`);
    lines.push(`- **Egress rules:** ${sg.metadata.egressRuleCount}`);

    if (sg.metadata.ingressRules) {
      lines.push('');
      lines.push('**Inbound Rules:**');
      for (const rule of sg.metadata.ingressRules.split(' | ')) {
        lines.push(`- ${rule}`);
      }
    }

    if (sg.metadata.egressRules) {
      lines.push('');
      lines.push('**Outbound Rules:**');
      for (const rule of sg.metadata.egressRules.split(' | ')) {
        lines.push(`- ${rule}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Narrative mode: explains why each port is open and what uses it. */
function renderSecurityNarrative(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.security}`, ''];

  const sgs = nodes.filter((n) => n.type === 'security-group');

  lines.push(
    `**${sgs.length} security groups** govern network access across the infrastructure. ` +
    `Each rule below is explained in context — what service uses it and why.`,
  );
  lines.push('');

  for (const sg of sgs) {
    lines.push(`### ${sg.label}`);
    lines.push('');

    // Find what uses this SG
    const usedByEdges = findEdges(graph, sg.id, 'incoming')
      .filter((e) => e.edgeType === 'references');
    const usedByNodes = usedByEdges
      .map((e) => resolveNode(graph, e.source))
      .filter((n): n is ResourceNode => n !== undefined);

    if (usedByNodes.length > 0) {
      lines.push(
        `This security group is attached to: ${usedByNodes.map((n) => nodeRef(n)).join(', ')}.`,
      );
      lines.push('');
    }

    // Explain ingress rules with context
    const ingressEdges = findEdges(graph, sg.id, 'incoming')
      .filter((e) => e.edgeType === 'network');

    if (ingressEdges.length > 0) {
      lines.push('**Why these ports are open (inbound):**');
      lines.push('');

      for (const edge of ingressEdges) {
        const sourceNode = resolveNode(graph, edge.source);
        const narrative = buildSgRuleNarrative(
          edge, sourceNode, sg, usedByNodes, graph,
        );
        lines.push(`- ${narrative}`);
      }
      lines.push('');
    }

    // Explain ingress rules from CIDRs (not captured as edges, but in metadata)
    if (sg.metadata.ingressRules) {
      const cidrRules = sg.metadata.ingressRules
        .split(' | ')
        .filter((r) => r.includes('from 10.') || r.includes('from 192.168.') || r.includes('from 0.0.0.0'));

      if (cidrRules.length > 0 && ingressEdges.length === 0) {
        lines.push('**Inbound CIDR rules:**');
        lines.push('');
        for (const rule of cidrRules) {
          const narrative = buildCidrRuleNarrative(rule, sg, usedByNodes);
          lines.push(`- ${narrative}`);
        }
        lines.push('');
      }
    }

    // Egress summary
    if (sg.metadata.egressRules) {
      const egressRules = sg.metadata.egressRules.split(' | ');
      const hasAllTraffic = egressRules.some((r) => r.includes('ALL TRAFFIC'));

      if (hasAllTraffic) {
        lines.push(
          '**Outbound:** All traffic is allowed (default egress rule). ' +
          'This permits the resource to reach any external service, AWS API endpoint, or internet destination.',
        );
      } else {
        lines.push(`**Outbound:** ${egressRules.length} specific rule${egressRules.length !== 1 ? 's' : ''} restrict egress.`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Builds a narrative explanation for an SG-to-SG rule.
 *
 * @param edge - The network edge representing the rule.
 * @param sourceNode - The source security group node.
 * @param targetSg - The target security group.
 * @param usedByNodes - Resources that use the target SG.
 * @param graph - The full infra graph for context resolution.
 * @returns A human-readable explanation of why this rule exists.
 */
function buildSgRuleNarrative(
  edge: ResourceEdge,
  sourceNode: ResourceNode | undefined,
  targetSg: ResourceNode,
  usedByNodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const port = edge.label;

  // Identify what the source SG is attached to
  const sourceUsedBy = sourceNode
    ? findEdges(graph, sourceNode.id, 'incoming')
      .filter((e) => e.edgeType === 'references')
      .map((e) => resolveNode(graph, e.source))
      .filter((n): n is ResourceNode => n !== undefined)
    : [];

  const sourceName = sourceNode ? `\`${sourceNode.label}\`` : '_unknown source_';
  const sourceService = sourceUsedBy.length > 0
    ? sourceUsedBy.map((n) => nodeRef(n)).join(', ')
    : sourceName;

  const targetService = usedByNodes.length > 0
    ? usedByNodes.map((n) => nodeRef(n)).join(', ')
    : `resources using \`${targetSg.label}\``;

  // Build contextual narrative based on port
  if (port.includes('443')) {
    return `**${port}** from ${sourceService} — allows HTTPS traffic, typically from a load balancer forwarding encrypted requests to ${targetService}.`;
  }
  if (port.includes('80')) {
    return `**${port}** from ${sourceService} — allows HTTP traffic from ${sourceService} to ${targetService}. This may be used for health checks or unencrypted internal communication.`;
  }
  if (port.includes('6443')) {
    return `**${port}** from ${sourceService} — allows Kubernetes API server access. This is required for \`kubectl\` commands and cluster management.`;
  }
  if (port.includes('10250')) {
    return `**${port}** from ${sourceService} — allows kubelet API access. The control plane uses this to execute commands in pods and retrieve logs.`;
  }
  if (port.includes('30000') || port.includes('32767')) {
    return `**${port}** from ${sourceService} — allows NodePort range traffic. This enables external access to Kubernetes services through the NLB.`;
  }
  if (port === 'ALL TRAFFIC') {
    return `**All traffic** from ${sourceService} — full network access between ${sourceService} and ${targetService}. This is typically a self-referencing rule for pod-to-pod or node-to-node communication within the same security group.`;
  }

  return `**${port}** from ${sourceService} — allows this traffic to reach ${targetService}.`;
}

/**
 * Builds a narrative explanation for a CIDR-based rule.
 *
 * @param rule - The rule string from metadata.
 * @param sg - The security group node.
 * @param usedByNodes - Resources using this SG.
 * @returns A human-readable explanation.
 */
function buildCidrRuleNarrative(
  rule: string,
  _sg: ResourceNode,
  usedByNodes: ResourceNode[],
): string {
  const target = usedByNodes.length > 0
    ? usedByNodes.map((n) => nodeRef(n)).join(', ')
    : 'attached resources';

  if (rule.includes('from 10.') || rule.includes('from 172.16') || rule.includes('from 192.168.')) {
    return `${rule} — allows traffic from the **VPC private CIDR range**. This enables internal communication between ${target} and other resources within the VPC.`;
  }
  if (rule.includes('from 0.0.0.0/0')) {
    return `${rule} — allows traffic from **any IPv4 address** (public internet). This is typically required for internet-facing load balancers or bastion hosts serving ${target}.`;
  }

  return `${rule} — allows this traffic to reach ${target}.`;
}

// ─── Routing (Load Balancers) ───────────────────────────────────

/** Inventory mode: LB → listener → target group → target chain. */
function renderRoutingInventory(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.routing}`, ''];

  const lbs = nodes.filter((n) => n.type === 'nlb' || n.type === 'alb');
  const tgs = nodes.filter((n) => n.type === 'target-group');

  for (const lb of lbs) {
    lines.push(`### ${lb.label}`);
    lines.push(`- **Type:** ${lb.type.toUpperCase()}`);
    lines.push(`- **Scheme:** ${lb.metadata.scheme}`);
    lines.push(`- **DNS:** ${lb.metadata.dnsName}`);
    lines.push(`- **State:** ${lb.metadata.state}`);
    lines.push(`- **AZs:** ${lb.metadata.availabilityZones}`);

    // Find listeners
    const listenerEdges = findEdges(graph, lb.id, 'outgoing')
      .filter((e) => e.edgeType === 'contains');
    const listeners = listenerEdges
      .map((e) => resolveNode(graph, e.target))
      .filter((n): n is ResourceNode => n !== undefined && n.type === 'listener');

    if (listeners.length > 0) {
      lines.push('');
      lines.push('**Listeners:**');
      for (const l of listeners) {
        lines.push(`- ${l.metadata.protocol}/${l.metadata.port}`);

        const fwdEdges = findEdges(graph, l.id, 'outgoing')
          .filter((e) => e.edgeType === 'forwards-to');
        for (const fwd of fwdEdges) {
          const tg = resolveNode(graph, fwd.target);
          if (tg) {
            lines.push(`  → Target Group: ${tg.label} (${tg.metadata.protocol}/${tg.metadata.port})`);
          }
        }
      }
    }
    lines.push('');
  }

  if (tgs.length > 0) {
    lines.push('### Target Groups');
    lines.push('');
    lines.push('| Name | Protocol | Port | Target Type | Health Check |');
    lines.push('|---|---|---|---|---|');
    for (const tg of tgs) {
      lines.push(
        `| ${tg.label} | ${tg.metadata.protocol} | ${tg.metadata.port} | ${tg.metadata.targetType} | ${tg.metadata.healthCheckPath || tg.metadata.healthCheckPort} |`,
      );
    }
  }

  return lines.join('\n');
}

/** Narrative mode: explains the full request path from LB to targets. */
function renderRoutingNarrative(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.routing}`, ''];

  const lbs = nodes.filter((n) => n.type === 'nlb' || n.type === 'alb');

  for (const lb of lbs) {
    lines.push(`### ${lb.label}`);
    lines.push('');

    const scheme = lb.metadata.scheme === 'internet-facing' ? 'internet-facing' : 'internal';
    const azList = lb.metadata.availabilityZones || 'multiple AZs';

    lines.push(
      `This **${lb.type.toUpperCase()}** is ${scheme === 'internet-facing' ? 'publicly accessible' : 'internal-only'} ` +
      `at \`${lb.metadata.dnsName}\`, deployed across ${azList}.`,
    );
    lines.push('');

    // Trace the full forwarding chain
    const listenerEdges = findEdges(graph, lb.id, 'outgoing')
      .filter((e) => e.edgeType === 'contains');
    const listeners = listenerEdges
      .map((e) => resolveNode(graph, e.target))
      .filter((n): n is ResourceNode => n !== undefined && n.type === 'listener');

    if (listeners.length > 0) {
      lines.push('**Request flow:**');
      lines.push('');

      for (const listener of listeners) {
        const proto = listener.metadata.protocol;
        const port = listener.metadata.port;

        lines.push(`1. Client connects on **${proto}/${port}**`);

        const fwdEdges = findEdges(graph, listener.id, 'outgoing')
          .filter((e) => e.edgeType === 'forwards-to');

        for (const fwd of fwdEdges) {
          const tg = resolveNode(graph, fwd.target);
          if (!tg) continue;

          lines.push(
            `2. Listener forwards to target group **\`${tg.label}\`** ` +
            `(${tg.metadata.targetType} targets on port ${tg.metadata.port})`,
          );

          if (tg.metadata.healthCheckPath) {
            lines.push(
              `3. Health checks: \`${tg.metadata.healthCheckPath}\` on port ${tg.metadata.healthCheckPort}`,
            );
          }

          // Find actual targets
          const targetEdges = findEdges(graph, tg.id, 'outgoing')
            .filter((e) => e.edgeType === 'forwards-to');
          const targets = targetEdges
            .map((e) => resolveNode(graph, e.target))
            .filter((n): n is ResourceNode => n !== undefined);

          if (targets.length > 0) {
            const healthyCount = targetEdges.filter((e) =>
              e.label.includes('healthy'),
            ).length;

            lines.push(
              `4. Traffic reaches **${targets.length} target${targets.length !== 1 ? 's' : ''}** ` +
              `(${healthyCount} healthy): ` +
              targets.map((t) => `\`${t.label}\``).join(', '),
            );
          }
        }
        lines.push('');
      }
    }

    // SG associations
    const sgEdges = findEdges(graph, lb.id, 'outgoing')
      .filter((e) => e.edgeType === 'references');
    if (sgEdges.length > 0) {
      const sgNodes = sgEdges
        .map((e) => resolveNode(graph, e.target))
        .filter((n): n is ResourceNode => n !== undefined);

      lines.push(
        `**Network access** is controlled by security group${sgNodes.length !== 1 ? 's' : ''}: ` +
        sgNodes.map((n) => `\`${n.label}\``).join(', ') + '.',
      );
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Edge & CDN ─────────────────────────────────────────────────

/** Inventory mode: CloudFront/WAF/ACM tables. */
function renderEdgeInventory(nodes: ResourceNode[]): string {
  const lines = [`## ${CATEGORY_LABELS.edge}`, ''];

  const dists = nodes.filter((n) => n.type === 'cloudfront-distribution');
  const wafs = nodes.filter((n) => n.type === 'waf-web-acl');
  const certs = nodes.filter((n) => n.type === 'acm-certificate');

  for (const dist of dists) {
    lines.push(`### CloudFront: ${dist.label}`);
    lines.push(`- **Domain:** ${dist.metadata.domainName}`);
    lines.push(`- **Aliases:** ${dist.metadata.aliases || '_none_'}`);
    lines.push(`- **Status:** ${dist.metadata.status}`);
    lines.push(`- **Origins:** ${dist.metadata.origins}`);
    lines.push(`- **WAF:** ${dist.metadata.webAclId}`);
    lines.push(`- **Certificate:** ${dist.metadata.viewerCert}`);
    lines.push('');
  }

  if (wafs.length > 0) {
    lines.push('### WAF WebACLs');
    for (const waf of wafs) {
      lines.push(`- **${waf.label}** — ${waf.metadata.ruleCount ?? '?'} rules, default: ${waf.metadata.defaultAction ?? 'unknown'}`);
      if (waf.metadata.rules) {
        lines.push(`  Rules: ${waf.metadata.rules}`);
      }
    }
    lines.push('');
  }

  if (certs.length > 0) {
    lines.push('### ACM Certificates');
    lines.push('| Domain | Status | Type | In Use |');
    lines.push('|---|---|---|---|');
    for (const cert of certs) {
      lines.push(`| ${cert.metadata.domain} | ${cert.metadata.status} | ${cert.metadata.type} | ${cert.metadata.inUse} |`);
    }
  }

  return lines.join('\n');
}

/** Narrative mode: explains the edge layer and CDN configuration. */
function renderEdgeNarrative(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.edge}`, ''];

  const dists = nodes.filter((n) => n.type === 'cloudfront-distribution');
  const wafs = nodes.filter((n) => n.type === 'waf-web-acl');

  for (const dist of dists) {
    lines.push(`### CloudFront: ${dist.label}`);
    lines.push('');

    const aliases = dist.metadata.aliases || dist.metadata.domainName;
    lines.push(
      `This CloudFront distribution serves traffic for **${aliases}** ` +
      `(CloudFront domain: \`${dist.metadata.domainName}\`).`,
    );
    lines.push('');

    // Origins narrative
    const originEdges = findEdges(graph, dist.id, 'outgoing')
      .filter((e) => e.edgeType === 'routes');

    if (originEdges.length > 0) {
      lines.push('**Origin routing:**');
      lines.push('');
      for (const oe of originEdges) {
        const originNode = resolveNode(graph, oe.target);
        const originDomain = originNode?.metadata.originDomain ?? oe.target;
        lines.push(
          `- ${oe.label}: Routes requests to \`${originDomain}\`. ` +
          'CloudFront caches responses at edge locations and forwards cache misses to this origin.',
        );
      }
      lines.push('');
    }

    // WAF narrative
    const wafEdge = findEdges(graph, dist.id, 'outgoing')
      .find((e) => e.label === 'protected-by');

    if (wafEdge) {
      const wafNode = resolveNode(graph, wafEdge.target);
      if (wafNode) {
        const ruleCount = wafNode.metadata.ruleCount ?? '?';
        const rules = wafNode.metadata.rules ?? '';
        lines.push(
          `**WAF protection:** WebACL \`${wafNode.label}\` inspects every request before it reaches the origin. ` +
          `It enforces **${ruleCount} rules** (${rules || 'details unavailable'}). ` +
          `Default action: **${wafNode.metadata.defaultAction ?? 'unknown'}**.`,
        );
        lines.push('');
      }
    }

    // Certificate narrative
    const certEdge = findEdges(graph, dist.id, 'outgoing')
      .find((e) => e.label === 'uses-cert');
    if (certEdge) {
      const certNode = resolveNode(graph, certEdge.target);
      if (certNode) {
        lines.push(
          `**TLS certificate:** ACM certificate for \`${certNode.metadata.domain}\` ` +
          `(status: ${certNode.metadata.status}) provides HTTPS encryption. ` +
          `This certificate must be in \`us-east-1\` for CloudFront compatibility.`,
        );
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Compute Inventory ──────────────────────────────────────────

/** Inventory mode: EC2 instances and ASGs. */
function renderComputeInventory(nodes: ResourceNode[]): string {
  const lines = [`## ${CATEGORY_LABELS.compute}`, ''];

  const instances = nodes.filter((n) => n.type === 'ec2-instance');
  const asgs = nodes.filter((n) => n.type === 'auto-scaling-group');

  if (instances.length > 0) {
    lines.push('### EC2 Instances');
    lines.push('| Name | Type | State | Private IP | AZ | Subnet |');
    lines.push('|---|---|---|---|---|---|');
    for (const i of instances) {
      lines.push(
        `| ${i.label} | ${i.metadata.instanceType} | ${i.metadata.state} | ${i.metadata.privateIp} | ${i.metadata.az} | ${i.metadata.subnetId} |`,
      );
    }
    lines.push('');
  }

  if (asgs.length > 0) {
    lines.push('### Auto Scaling Groups');
    for (const asg of asgs) {
      lines.push(`- **${asg.label}** — ${asg.metadata.desiredCapacity}/${asg.metadata.maxSize} capacity, template: ${asg.metadata.launchTemplate || '_inline_'}`);
    }
  }

  return lines.join('\n');
}

/** Narrative mode: explains compute resources and their roles. */
function renderComputeNarrative(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.compute}`, ''];

  const instances = nodes.filter((n) => n.type === 'ec2-instance');
  const asgs = nodes.filter((n) => n.type === 'auto-scaling-group');

  if (asgs.length > 0) {
    for (const asg of asgs) {
      lines.push(`### Auto Scaling Group: ${asg.label}`);
      lines.push('');

      const memberEdges = findEdges(graph, asg.id, 'outgoing')
        .filter((e) => e.edgeType === 'references');
      const members = memberEdges
        .map((e) => resolveNode(graph, e.target))
        .filter((n): n is ResourceNode => n !== undefined);

      lines.push(
        `This ASG maintains **${asg.metadata.desiredCapacity}** instances ` +
        `(min: ${asg.metadata.minSize}, max: ${asg.metadata.maxSize}) ` +
        `using launch template \`${asg.metadata.launchTemplate || 'inline config'}\`. ` +
        `Health checks use the **${asg.metadata.healthCheck}** method.`,
      );
      lines.push('');

      if (members.length > 0) {
        const healthy = memberEdges.filter((e) => e.label.includes('Healthy')).length;
        lines.push(
          `Currently **${members.length} instances** are registered ` +
          `(${healthy} healthy): ` +
          members.map((m) => `\`${m.label}\` (${m.metadata.instanceType})`).join(', ') + '.',
        );
        lines.push('');
      }
    }
  }

  // Standalone instances (not in an ASG)
  const asgMemberIds = new Set(
    asgs.flatMap((asg) =>
      findEdges(graph, asg.id, 'outgoing')
        .filter((e) => e.edgeType === 'references')
        .map((e) => e.target),
    ),
  );

  const standalone = instances.filter((i) => !asgMemberIds.has(i.id));
  if (standalone.length > 0) {
    lines.push('### Standalone Instances');
    lines.push('');
    for (const inst of standalone) {
      lines.push(
        `- **${inst.label}** — ${inst.metadata.instanceType} in ${inst.metadata.az}, ` +
        `state: ${inst.metadata.state}, private IP: \`${inst.metadata.privateIp}\``,
      );
    }
  }

  return lines.join('\n');
}

// ─── Kubernetes ─────────────────────────────────────────────────

/** Inventory mode: K8s resources by namespace. */
function renderK8sInventory(
  nodes: ResourceNode[],
  _graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.kubernetes}`, ''];

  const namespaces = nodes.filter((n) => n.type === 'k8s-namespace');
  const deployments = nodes.filter((n) => n.type === 'k8s-deployment');
  const daemonsets = nodes.filter((n) => n.type === 'k8s-daemonset');
  const services = nodes.filter((n) => n.type === 'k8s-service');
  const pods = nodes.filter((n) => n.type === 'k8s-pod');
  const ingresses = nodes.filter((n) => n.type === 'k8s-ingress');

  lines.push(
    `**${namespaces.length} namespaces**, ` +
    `${deployments.length} deployments, ` +
    `${daemonsets.length} daemonsets, ` +
    `${services.length} services, ` +
    `${pods.length} pods, ` +
    `${ingresses.length} ingresses.`,
  );
  lines.push('');

  for (const ns of namespaces) {
    lines.push(`### Namespace: ${ns.label}`);
    lines.push('');

    const nsDeps = deployments.filter((d) => d.namespace === ns.label);
    const nsDs = daemonsets.filter((d) => d.namespace === ns.label);
    const nsSvcs = services.filter((s) => s.namespace === ns.label);

    if (nsDeps.length > 0) {
      lines.push('| Deployment | Replicas | Ready | Strategy | Containers |');
      lines.push('|---|---|---|---|---|');
      for (const dep of nsDeps) {
        lines.push(
          `| ${dep.label} | ${dep.metadata.replicas} | ${dep.metadata.readyReplicas} | ${dep.metadata.strategy} | ${dep.metadata.containers} |`,
        );
      }
      lines.push('');
    }

    if (nsDs.length > 0) {
      lines.push('**DaemonSets:**');
      for (const ds of nsDs) {
        lines.push(`- ${ds.label} — ${ds.metadata.ready}/${ds.metadata.desiredScheduled} ready`);
      }
      lines.push('');
    }

    if (nsSvcs.length > 0) {
      lines.push('| Service | Type | Ports | Selector |');
      lines.push('|---|---|---|---|');
      for (const svc of nsSvcs) {
        lines.push(`| ${svc.label} | ${svc.metadata.type} | ${svc.metadata.ports} | ${svc.metadata.selector} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Narrative mode: explains K8s workloads and service routing. */
function renderK8sNarrative(
  nodes: ResourceNode[],
  graph: InfraGraph,
): string {
  const lines = [`## ${CATEGORY_LABELS.kubernetes}`, ''];

  const namespaces = nodes.filter((n) => n.type === 'k8s-namespace');

  for (const ns of namespaces) {
    lines.push(`### Namespace: ${ns.label}`);
    lines.push('');

    const deployments = nodes.filter((n) => n.type === 'k8s-deployment' && n.namespace === ns.label);
    const services = nodes.filter((n) => n.type === 'k8s-service' && n.namespace === ns.label);
    const ingresses = nodes.filter((n) => n.type === 'k8s-ingress' && n.namespace === ns.label);
    const daemonsets = nodes.filter((n) => n.type === 'k8s-daemonset' && n.namespace === ns.label);

    // Deployments narrative
    for (const dep of deployments) {
      lines.push(`#### Deployment: ${dep.label}`);
      lines.push('');

      const ready = dep.metadata.readyReplicas ?? '0';
      const total = dep.metadata.replicas ?? '0';

      lines.push(
        `This deployment runs **${ready}/${total} replicas** using a **${dep.metadata.strategy}** strategy. ` +
        `Containers: ${dep.metadata.containers || '_none_'}.`,
      );

      // Find the service that selects this deployment's pods
      const managedPodEdges = findEdges(graph, dep.id, 'outgoing')
        .filter((e) => e.label === 'manages');
      const managedPodIds = new Set(managedPodEdges.map((e) => e.target));

      const matchingServices = services.filter((svc) => {
        const svcEdges = findEdges(graph, svc.id, 'outgoing')
          .filter((e) => e.edgeType === 'references');
        return svcEdges.some((e) => managedPodIds.has(e.target));
      });

      if (matchingServices.length > 0) {
        lines.push(
          `Traffic is routed to these pods through service${matchingServices.length > 1 ? 's' : ''}: ` +
          matchingServices.map((s) => `\`${s.label}\` (${s.metadata.type}, ports: ${s.metadata.ports})`).join(', ') + '.',
        );
      }
      lines.push('');
    }

    // DaemonSets
    for (const ds of daemonsets) {
      lines.push(`#### DaemonSet: ${ds.label}`);
      lines.push('');
      lines.push(
        `This daemonset runs on **${ds.metadata.ready}/${ds.metadata.desiredScheduled} nodes**. ` +
        `Containers: ${ds.metadata.containers || '_none_'}. ` +
        'DaemonSets ensure one pod runs per node, typically used for logging agents, monitoring, or network plugins.',
      );
      lines.push('');
    }

    // Ingresses
    for (const ing of ingresses) {
      lines.push(`#### Ingress: ${ing.label}`);
      lines.push('');

      const routeEdges = findEdges(graph, ing.id, 'outgoing')
        .filter((e) => e.edgeType === 'routes');

      lines.push(
        `This ingress (class: \`${ing.metadata.ingressClass || 'default'}\`) ` +
        `routes external HTTP traffic to backend services:`,
      );
      lines.push('');

      for (const re of routeEdges) {
        const svcNode = resolveNode(graph, re.target);
        lines.push(`- **${re.label}** → ${svcNode ? `\`${svcNode.label}\`` : re.target}`);
      }

      if (ing.metadata.tls) {
        lines.push('');
        lines.push(`TLS is enabled for: ${ing.metadata.tls}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
