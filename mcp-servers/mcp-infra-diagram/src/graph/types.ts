/**
 * @fileoverview Infrastructure graph type definitions.
 *
 * Defines the core data structures for representing discovered AWS and
 * Kubernetes resources as a directed graph. Nodes represent resources;
 * edges represent network, containment, or reference relationships.
 *
 * @module graph/types
 */

/** Supported AWS and Kubernetes resource types. */
export type ResourceType =
  | 'vpc'
  | 'subnet'
  | 'security-group'
  | 'nat-gateway'
  | 'internet-gateway'
  | 'route-table'
  | 'ec2-instance'
  | 'auto-scaling-group'
  | 'nlb'
  | 'alb'
  | 'target-group'
  | 'listener'
  | 'cloudfront-distribution'
  | 'waf-web-acl'
  | 'acm-certificate'
  | 'k8s-pod'
  | 'k8s-service'
  | 'k8s-deployment'
  | 'k8s-daemonset'
  | 'k8s-ingress'
  | 'k8s-namespace';

/** Classification of how two resources relate to each other. */
export type EdgeType =
  | 'network'       // SG rule, port-based connection
  | 'contains'      // VPC contains subnet, namespace contains pod
  | 'references'    // Service selector → pod, ASG → launch template
  | 'routes'        // Route table → NAT/IGW, CloudFront → origin
  | 'forwards-to';  // LB listener → target group → instance

/** A single infrastructure resource discovered from AWS or Kubernetes. */
export interface ResourceNode {
  /** Unique resource identifier (e.g. 'vpc-0abc123', 'pod/my-app-xyz'). */
  readonly id: string;
  /** Resource type classification. */
  readonly type: ResourceType;
  /** Human-readable label for diagram display. */
  readonly label: string;
  /** Arbitrary metadata: CIDRs, ports, rules, tags, status. */
  readonly metadata: Record<string, string>;
  /** AWS region (omitted for K8s resources). */
  readonly region?: string;
  /** Kubernetes namespace (omitted for AWS resources). */
  readonly namespace?: string;
  /** Parent node ID for containment hierarchy (e.g. subnet's VPC ID). */
  readonly parentId?: string;
}

/** A directed relationship between two resource nodes. */
export interface ResourceEdge {
  /** Source resource node ID. */
  readonly source: string;
  /** Target resource node ID. */
  readonly target: string;
  /** Human-readable edge label (e.g. 'TCP/443', 'forwards-to'). */
  readonly label: string;
  /** Relationship classification. */
  readonly edgeType: EdgeType;
}

/**
 * Complete infrastructure graph built from discovered resources.
 *
 * Consumed by renderers to produce Mermaid diagrams or Python scripts.
 */
export interface InfraGraph {
  /** All discovered resource nodes. */
  readonly nodes: readonly ResourceNode[];
  /** All resolved relationships between nodes. */
  readonly edges: readonly ResourceEdge[];
  /** ISO timestamp of when discovery was performed. */
  readonly discoveredAt: string;
  /** AWS region that was scanned. */
  readonly region: string;
  /** Whether Kubernetes resources were included. */
  readonly includesK8s: boolean;
}

/** Scope filter for controlling diagram focus. */
export type DiagramScope = 'full' | 'networking' | 'compute' | 'edge';
