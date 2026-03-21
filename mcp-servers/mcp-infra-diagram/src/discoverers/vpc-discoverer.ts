/**
 * @fileoverview VPC resource discoverer.
 *
 * Discovers VPCs, subnets, route tables, NAT gateways, and internet
 * gateways from the live AWS account. Produces {@link ResourceNode}
 * and {@link ResourceEdge} entries with real CIDRs and AZ data.
 *
 * @module discoverers/vpc-discoverer
 */

import {
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeRouteTablesCommand,
  DescribeNatGatewaysCommand,
  DescribeInternetGatewaysCommand,
} from '@aws-sdk/client-ec2';

import type { AwsClients } from '../clients/aws-client.js';
import type { ResourceNode, ResourceEdge } from '../graph/types.js';
import { getNameTag, buildLabel, matchesTags } from '../utils/helpers.js';

/** Options for scoping VPC discovery. */
export interface VpcDiscoveryOptions {
  /** Discover only this VPC. Omit for all VPCs. */
  readonly vpcId?: string;
  /** Tag filter: only include resources with all matching tags. */
  readonly tags?: Record<string, string>;
}

/** Result of VPC discovery containing nodes and containment edges. */
export interface VpcDiscoveryResult {
  readonly nodes: ResourceNode[];
  readonly edges: ResourceEdge[];
}

/**
 * Discovers VPC networking resources from the live AWS account.
 *
 * @param clients - AWS SDK clients.
 * @param options - Optional VPC ID and tag filters.
 * @returns Nodes for VPCs, subnets, NATs, IGWs + containment/route edges.
 */
export async function discoverVpcResources(
  clients: AwsClients,
  options: VpcDiscoveryOptions = {},
): Promise<VpcDiscoveryResult> {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  // --- VPCs ---
  const vpcParams = options.vpcId ? { VpcIds: [options.vpcId] } : {};
  const { Vpcs = [] } = await clients.ec2.send(new DescribeVpcsCommand(vpcParams));

  const filteredVpcs = Vpcs.filter((v) => matchesTags(v.Tags, options.tags));

  for (const vpc of filteredVpcs) {
    const vpcId = vpc.VpcId ?? 'unknown';
    const cidr = vpc.CidrBlock ?? 'unknown';
    const name = getNameTag(vpc.Tags);

    nodes.push({
      id: vpcId,
      type: 'vpc',
      label: buildLabel(vpcId, name),
      metadata: {
        cidr,
        state: vpc.State ?? 'unknown',
        isDefault: String(vpc.IsDefault ?? false),
      },
      region: clients.region,
    });
  }

  const vpcIds = filteredVpcs.map((v) => v.VpcId).filter(Boolean) as string[];
  if (vpcIds.length === 0) return { nodes, edges };

  // --- Subnets ---
  const { Subnets = [] } = await clients.ec2.send(
    new DescribeSubnetsCommand({
      Filters: [{ Name: 'vpc-id', Values: vpcIds }],
    }),
  );

  for (const subnet of Subnets) {
    const subnetId = subnet.SubnetId ?? 'unknown';
    const name = getNameTag(subnet.Tags);
    const vpcId = subnet.VpcId ?? 'unknown';

    nodes.push({
      id: subnetId,
      type: 'subnet',
      label: buildLabel(subnetId, name),
      metadata: {
        cidr: subnet.CidrBlock ?? 'unknown',
        az: subnet.AvailabilityZone ?? 'unknown',
        availableIps: String(subnet.AvailableIpAddressCount ?? 0),
        mapPublicIp: String(subnet.MapPublicIpOnLaunch ?? false),
      },
      region: clients.region,
      parentId: vpcId,
    });

    edges.push({
      source: vpcId,
      target: subnetId,
      label: 'contains',
      edgeType: 'contains',
    });
  }

  // --- Route Tables ---
  const { RouteTables = [] } = await clients.ec2.send(
    new DescribeRouteTablesCommand({
      Filters: [{ Name: 'vpc-id', Values: vpcIds }],
    }),
  );

  for (const rt of RouteTables) {
    const rtId = rt.RouteTableId ?? 'unknown';
    const name = getNameTag(rt.Tags);
    const vpcId = rt.VpcId ?? 'unknown';

    nodes.push({
      id: rtId,
      type: 'route-table',
      label: buildLabel(rtId, name),
      metadata: {
        routeCount: String(rt.Routes?.length ?? 0),
      },
      region: clients.region,
      parentId: vpcId,
    });

    // Route table → NAT/IGW edges
    for (const route of rt.Routes ?? []) {
      if (route.NatGatewayId) {
        edges.push({
          source: rtId,
          target: route.NatGatewayId,
          label: `routes ${route.DestinationCidrBlock ?? '0.0.0.0/0'}`,
          edgeType: 'routes',
        });
      }
      if (route.GatewayId?.startsWith('igw-')) {
        edges.push({
          source: rtId,
          target: route.GatewayId,
          label: `routes ${route.DestinationCidrBlock ?? '0.0.0.0/0'}`,
          edgeType: 'routes',
        });
      }
    }
  }

  // --- NAT Gateways ---
  const { NatGateways = [] } = await clients.ec2.send(
    new DescribeNatGatewaysCommand({
      Filter: [{ Name: 'vpc-id', Values: vpcIds }],
    }),
  );

  for (const nat of NatGateways) {
    const natId = nat.NatGatewayId ?? 'unknown';
    const name = getNameTag(nat.Tags);
    const subnetId = nat.SubnetId ?? 'unknown';

    nodes.push({
      id: natId,
      type: 'nat-gateway',
      label: buildLabel(natId, name),
      metadata: {
        state: nat.State ?? 'unknown',
        subnetId,
        publicIp: nat.NatGatewayAddresses?.[0]?.PublicIp ?? 'none',
      },
      region: clients.region,
      parentId: nat.VpcId,
    });

    edges.push({
      source: subnetId,
      target: natId,
      label: 'hosts',
      edgeType: 'contains',
    });
  }

  // --- Internet Gateways ---
  const { InternetGateways = [] } = await clients.ec2.send(
    new DescribeInternetGatewaysCommand({
      Filters: [{ Name: 'attachment.vpc-id', Values: vpcIds }],
    }),
  );

  for (const igw of InternetGateways) {
    const igwId = igw.InternetGatewayId ?? 'unknown';
    const name = getNameTag(igw.Tags);
    const attachedVpc = igw.Attachments?.[0]?.VpcId ?? 'unknown';

    nodes.push({
      id: igwId,
      type: 'internet-gateway',
      label: buildLabel(igwId, name),
      metadata: {
        state: igw.Attachments?.[0]?.State ?? 'unknown',
      },
      region: clients.region,
      parentId: attachedVpc,
    });

    edges.push({
      source: attachedVpc,
      target: igwId,
      label: 'attached',
      edgeType: 'contains',
    });
  }

  return { nodes, edges };
}
