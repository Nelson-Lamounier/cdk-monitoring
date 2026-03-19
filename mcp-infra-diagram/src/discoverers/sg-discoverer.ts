/**
 * @fileoverview Security Group discoverer.
 *
 * Discovers security groups and their inbound/outbound rules from the
 * live AWS account. Resolves SG-to-SG references into named edges
 * with protocol and port information.
 *
 * @module discoverers/sg-discoverer
 */

import { DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import type { IpPermission } from '@aws-sdk/client-ec2';

import type { AwsClients } from '../clients/aws-client.js';
import type { ResourceNode, ResourceEdge } from '../graph/types.js';
import { getNameTag, buildLabel, matchesTags } from '../utils/helpers.js';

/** Options for scoping security group discovery. */
export interface SgDiscoveryOptions {
  /** Discover only SGs in this VPC. */
  readonly vpcId?: string;
  /** Tag filter: only include resources with all matching tags. */
  readonly tags?: Record<string, string>;
}

/** Result of security group discovery. */
export interface SgDiscoveryResult {
  readonly nodes: ResourceNode[];
  readonly edges: ResourceEdge[];
}

/**
 * Formats an IP permission rule into a human-readable string.
 *
 * @param rule - An inbound or outbound IP permission.
 * @returns String like 'TCP/443' or 'ALL TRAFFIC'.
 */
function formatPortRule(rule: IpPermission): string {
  const protocol = rule.IpProtocol ?? 'unknown';
  if (protocol === '-1') return 'ALL TRAFFIC';

  const from = rule.FromPort ?? 0;
  const to = rule.ToPort ?? 0;
  const proto = protocol.toUpperCase();

  return from === to ? `${proto}/${from}` : `${proto}/${from}-${to}`;
}

/**
 * Discovers security groups and their rules from the live AWS account.
 *
 * @param clients - AWS SDK clients.
 * @param options - Optional VPC and tag filters.
 * @returns Nodes for security groups + network edges for rules.
 */
export async function discoverSecurityGroups(
  clients: AwsClients,
  options: SgDiscoveryOptions = {},
): Promise<SgDiscoveryResult> {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const filters = options.vpcId
    ? [{ Name: 'vpc-id' as const, Values: [options.vpcId] }]
    : [];

  const { SecurityGroups = [] } = await clients.ec2.send(
    new DescribeSecurityGroupsCommand({ Filters: filters }),
  );

  const filteredSgs = SecurityGroups.filter((sg) => matchesTags(sg.Tags, options.tags));

  for (const sg of filteredSgs) {
    const sgId = sg.GroupId ?? 'unknown';
    const sgName = sg.GroupName ?? getNameTag(sg.Tags) ?? sgId;
    const vpcId = sg.VpcId ?? 'unknown';

    // Collect ingress rules for metadata
    const ingressRules: string[] = [];
    const egressRules: string[] = [];

    for (const rule of sg.IpPermissions ?? []) {
      const portLabel = formatPortRule(rule);

      // CIDR-based rules
      for (const cidr of rule.IpRanges ?? []) {
        ingressRules.push(`${portLabel} from ${cidr.CidrIp ?? 'unknown'}`);
      }
      for (const cidr of rule.Ipv6Ranges ?? []) {
        ingressRules.push(`${portLabel} from ${cidr.CidrIpv6 ?? 'unknown'}`);
      }

      // SG-to-SG references → network edges
      for (const sgRef of rule.UserIdGroupPairs ?? []) {
        const sourceSgId = sgRef.GroupId ?? 'unknown';
        ingressRules.push(`${portLabel} from ${sourceSgId}`);

        edges.push({
          source: sourceSgId,
          target: sgId,
          label: portLabel,
          edgeType: 'network',
        });
      }

      // Prefix list references
      for (const pl of rule.PrefixListIds ?? []) {
        ingressRules.push(`${portLabel} from ${pl.PrefixListId ?? 'unknown'}`);
      }
    }

    for (const rule of sg.IpPermissionsEgress ?? []) {
      const portLabel = formatPortRule(rule);

      for (const cidr of rule.IpRanges ?? []) {
        egressRules.push(`${portLabel} to ${cidr.CidrIp ?? 'unknown'}`);
      }

      for (const sgRef of rule.UserIdGroupPairs ?? []) {
        const targetSgId = sgRef.GroupId ?? 'unknown';
        egressRules.push(`${portLabel} to ${targetSgId}`);

        edges.push({
          source: sgId,
          target: targetSgId,
          label: portLabel,
          edgeType: 'network',
        });
      }
    }

    nodes.push({
      id: sgId,
      type: 'security-group',
      label: buildLabel(sgId, sgName),
      metadata: {
        name: sgName,
        description: sg.Description ?? '',
        vpcId,
        ingressRuleCount: String(ingressRules.length),
        egressRuleCount: String(egressRules.length),
        ingressRules: ingressRules.join(' | '),
        egressRules: egressRules.join(' | '),
      },
      region: clients.region,
      parentId: vpcId,
    });
  }

  return { nodes, edges };
}
