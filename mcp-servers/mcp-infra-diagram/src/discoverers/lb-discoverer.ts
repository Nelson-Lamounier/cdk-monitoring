/**
 * @fileoverview Load Balancer discoverer.
 *
 * Discovers NLBs, ALBs, their listeners, target groups, and target
 * health from the live AWS account. Produces forwarding edges
 * showing the full request path: listener → target group → instance.
 *
 * @module discoverers/lb-discoverer
 */

import {
  DescribeLoadBalancersCommand,
  DescribeListenersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

import type { AwsClients } from '../clients/aws-client.js';
import type { ResourceNode, ResourceEdge } from '../graph/types.js';
import { getNameTag, buildLabel, matchesTags } from '../utils/helpers.js';

/** Options for scoping load balancer discovery. */
export interface LbDiscoveryOptions {
  /** Discover only LBs in this VPC. */
  readonly vpcId?: string;
  /** Tag filter. */
  readonly tags?: Record<string, string>;
}

/** Result of load balancer discovery. */
export interface LbDiscoveryResult {
  readonly nodes: ResourceNode[];
  readonly edges: ResourceEdge[];
}

/**
 * Discovers load balancers, listeners, target groups, and target health.
 *
 * @param clients - AWS SDK clients.
 * @param options - Optional VPC and tag filters.
 * @returns Nodes for LBs, listeners, TGs + forwarding edges.
 */
export async function discoverLoadBalancers(
  clients: AwsClients,
  options: LbDiscoveryOptions = {},
): Promise<LbDiscoveryResult> {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const { LoadBalancers = [] } = await clients.elbv2.send(
    new DescribeLoadBalancersCommand({}),
  );

  // Filter by VPC and tags
  const filteredLbs = LoadBalancers.filter((lb) => {
    if (options.vpcId && lb.VpcId !== options.vpcId) return false;
    return true;
  });

  for (const lb of filteredLbs) {
    const lbArn = lb.LoadBalancerArn ?? 'unknown';
    const lbName = lb.LoadBalancerName ?? 'unknown';
    const lbType = lb.Type === 'network' ? 'nlb' : 'alb';
    const vpcId = lb.VpcId ?? 'unknown';

    nodes.push({
      id: lbArn,
      type: lbType,
      label: buildLabel(lbName, lbType.toUpperCase()),
      metadata: {
        scheme: lb.Scheme ?? 'unknown',
        state: lb.State?.Code ?? 'unknown',
        dnsName: lb.DNSName ?? '',
        vpcId,
        securityGroups: (lb.SecurityGroups ?? []).join(', '),
        availabilityZones: (lb.AvailabilityZones ?? [])
          .map((az) => `${az.ZoneName}/${az.SubnetId}`)
          .join(', '),
      },
      region: clients.region,
      parentId: vpcId,
    });

    // SG associations
    for (const sgId of lb.SecurityGroups ?? []) {
      edges.push({
        source: lbArn,
        target: sgId,
        label: 'uses',
        edgeType: 'references',
      });
    }

    // --- Listeners ---
    const { Listeners = [] } = await clients.elbv2.send(
      new DescribeListenersCommand({ LoadBalancerArn: lbArn }),
    );

    for (const listener of Listeners) {
      const listenerArn = listener.ListenerArn ?? 'unknown';
      const protocol = listener.Protocol ?? 'unknown';
      const port = listener.Port ?? 0;

      nodes.push({
        id: listenerArn,
        type: 'listener',
        label: `${protocol}/${port}`,
        metadata: {
          protocol,
          port: String(port),
        },
        region: clients.region,
        parentId: lbArn,
      });

      edges.push({
        source: lbArn,
        target: listenerArn,
        label: `${protocol}/${port}`,
        edgeType: 'contains',
      });

      // Listener → Target Group forwarding
      for (const action of listener.DefaultActions ?? []) {
        if (action.TargetGroupArn) {
          edges.push({
            source: listenerArn,
            target: action.TargetGroupArn,
            label: 'forwards-to',
            edgeType: 'forwards-to',
          });
        }
      }
    }
  }

  // --- Target Groups ---
  const { TargetGroups = [] } = await clients.elbv2.send(
    new DescribeTargetGroupsCommand({}),
  );

  for (const tg of TargetGroups) {
    const tgArn = tg.TargetGroupArn ?? 'unknown';
    const tgName = tg.TargetGroupName ?? 'unknown';
    const vpcId = tg.VpcId ?? 'unknown';

    // Only include TGs in filtered VPCs
    if (options.vpcId && vpcId !== options.vpcId) continue;

    nodes.push({
      id: tgArn,
      type: 'target-group',
      label: tgName,
      metadata: {
        protocol: tg.Protocol ?? '',
        port: String(tg.Port ?? 0),
        targetType: tg.TargetType ?? '',
        healthCheckPath: tg.HealthCheckPath ?? '',
        healthCheckPort: tg.HealthCheckPort ?? '',
        vpcId,
      },
      region: clients.region,
      parentId: vpcId,
    });

    // --- Target Health (instances) ---
    try {
      const { TargetHealthDescriptions = [] } = await clients.elbv2.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: tgArn }),
      );

      for (const target of TargetHealthDescriptions) {
        const targetId = target.Target?.Id ?? 'unknown';
        const targetPort = target.Target?.Port ?? 0;
        const health = target.TargetHealth?.State ?? 'unknown';

        edges.push({
          source: tgArn,
          target: targetId,
          label: `port ${targetPort} (${health})`,
          edgeType: 'forwards-to',
        });
      }
    } catch {
      // Target health may not be available for all TG types
    }
  }

  return { nodes, edges };
}
