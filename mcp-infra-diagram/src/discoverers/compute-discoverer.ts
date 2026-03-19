/**
 * @fileoverview Compute resource discoverer.
 *
 * Discovers EC2 instances and Auto Scaling Groups from the live
 * AWS account. Resolves instance → SG and ASG → instance relationships.
 *
 * @module discoverers/compute-discoverer
 */

import {
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';

import type { AwsClients } from '../clients/aws-client.js';
import type { ResourceNode, ResourceEdge } from '../graph/types.js';
import { getNameTag, buildLabel, matchesTags } from '../utils/helpers.js';

/** Options for scoping compute discovery. */
export interface ComputeDiscoveryOptions {
  /** Filter by VPC. */
  readonly vpcId?: string;
  /** Tag filter. */
  readonly tags?: Record<string, string>;
}

/** Result of compute discovery. */
export interface ComputeDiscoveryResult {
  readonly nodes: ResourceNode[];
  readonly edges: ResourceEdge[];
}

/**
 * Discovers EC2 instances and Auto Scaling Groups.
 *
 * @param clients - AWS SDK clients.
 * @param options - Optional VPC and tag filters.
 * @returns Nodes for instances/ASGs + SG reference and containment edges.
 */
export async function discoverComputeResources(
  clients: AwsClients,
  options: ComputeDiscoveryOptions = {},
): Promise<ComputeDiscoveryResult> {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  // --- EC2 Instances ---
  const filters = options.vpcId
    ? [{ Name: 'vpc-id' as const, Values: [options.vpcId] }]
    : [];

  const { Reservations = [] } = await clients.ec2.send(
    new DescribeInstancesCommand({ Filters: filters }),
  );

  for (const reservation of Reservations) {
    for (const instance of reservation.Instances ?? []) {
      if (!matchesTags(instance.Tags, options.tags)) continue;

      const instanceId = instance.InstanceId ?? 'unknown';
      const name = getNameTag(instance.Tags);
      const subnetId = instance.SubnetId ?? 'unknown';
      const vpcId = instance.VpcId ?? 'unknown';

      nodes.push({
        id: instanceId,
        type: 'ec2-instance',
        label: buildLabel(instanceId, name),
        metadata: {
          instanceType: instance.InstanceType ?? 'unknown',
          state: instance.State?.Name ?? 'unknown',
          privateIp: instance.PrivateIpAddress ?? '',
          publicIp: instance.PublicIpAddress ?? '',
          subnetId,
          vpcId,
          az: instance.Placement?.AvailabilityZone ?? '',
          iamRole: instance.IamInstanceProfile?.Arn ?? '',
          launchTime: instance.LaunchTime?.toISOString() ?? '',
        },
        region: clients.region,
        parentId: subnetId,
      });

      // Instance → subnet containment
      edges.push({
        source: subnetId,
        target: instanceId,
        label: 'hosts',
        edgeType: 'contains',
      });

      // Instance → security group references
      for (const sg of instance.SecurityGroups ?? []) {
        const sgId = sg.GroupId ?? 'unknown';
        edges.push({
          source: instanceId,
          target: sgId,
          label: 'uses',
          edgeType: 'references',
        });
      }
    }
  }

  // --- Auto Scaling Groups ---
  const { AutoScalingGroups = [] } = await clients.autoScaling.send(
    new DescribeAutoScalingGroupsCommand({}),
  );

  for (const asg of AutoScalingGroups) {
    // Filter by VPC via subnet match
    if (options.vpcId) {
      const asgSubnets = asg.VPCZoneIdentifier ?? '';
      // ASGs have comma-separated subnet IDs; we'd need subnet-to-VPC resolution
      // For now, include all ASGs if VPC filter is set (instances are already filtered)
      if (!asgSubnets) continue;
    }

    const asgName = asg.AutoScalingGroupName ?? 'unknown';
    const asgArn = asg.AutoScalingGroupARN ?? asgName;

    if (options.tags) {
      const asgTags = (asg.Tags ?? []).map((t) => ({
        Key: t.Key,
        Value: t.Value,
      }));
      if (!matchesTags(asgTags, options.tags)) continue;
    }

    nodes.push({
      id: asgArn,
      type: 'auto-scaling-group',
      label: asgName,
      metadata: {
        desiredCapacity: String(asg.DesiredCapacity ?? 0),
        minSize: String(asg.MinSize ?? 0),
        maxSize: String(asg.MaxSize ?? 0),
        healthCheck: asg.HealthCheckType ?? '',
        subnets: asg.VPCZoneIdentifier ?? '',
        launchTemplate: asg.LaunchTemplate?.LaunchTemplateName ?? '',
      },
      region: clients.region,
    });

    // ASG → instance membership edges
    for (const instance of asg.Instances ?? []) {
      const instanceId = instance.InstanceId ?? 'unknown';
      edges.push({
        source: asgArn,
        target: instanceId,
        label: `member (${instance.HealthStatus ?? 'unknown'})`,
        edgeType: 'references',
      });
    }
  }

  return { nodes, edges };
}
