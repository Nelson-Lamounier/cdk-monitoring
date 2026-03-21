/**
 * @fileoverview AWS client factory for the infrastructure diagram MCP server.
 *
 * Creates typed AWS SDK v3 clients for resource discovery:
 * EC2 (VPCs, SGs, instances), ELBv2 (load balancers), CloudFront,
 * WAFv2, ACM, and Auto Scaling.
 *
 * @module clients/aws-client
 */

import { ACMClient } from '@aws-sdk/client-acm';
import { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { WAFV2Client } from '@aws-sdk/client-wafv2';

/** Container for all AWS service clients used by discoverers. */
export interface AwsClients {
  /** EC2 client — VPCs, subnets, security groups, instances, route tables. */
  readonly ec2: EC2Client;
  /** ELBv2 client — NLBs, ALBs, target groups, listeners. */
  readonly elbv2: ElasticLoadBalancingV2Client;
  /** CloudFront client — distributions, origins. */
  readonly cloudfront: CloudFrontClient;
  /** WAFv2 client — WebACLs, IP sets, rules (us-east-1 for CloudFront). */
  readonly wafv2: WAFV2Client;
  /** WAFv2 client scoped to us-east-1 for CloudFront-associated WebACLs. */
  readonly wafv2Global: WAFV2Client;
  /** ACM client — certificates. */
  readonly acm: ACMClient;
  /** Auto Scaling client — ASGs, launch templates. */
  readonly autoScaling: AutoScalingClient;
  /** The resolved AWS region for regional resources. */
  readonly region: string;
}

/**
 * Creates typed AWS SDK v3 clients for infrastructure discovery.
 *
 * All clients share the same region for regional resources. A separate
 * WAFv2 client is created for `us-east-1` (required for CloudFront WebACLs).
 *
 * @param region - AWS region. Defaults to `AWS_REGION` env var, then `eu-west-1`.
 * @returns Readonly client container.
 */
export function createAwsClients(region?: string): AwsClients {
  const resolvedRegion = region ?? process.env.AWS_REGION ?? 'eu-west-1';

  return {
    ec2: new EC2Client({ region: resolvedRegion }),
    elbv2: new ElasticLoadBalancingV2Client({ region: resolvedRegion }),
    cloudfront: new CloudFrontClient({ region: resolvedRegion }),
    wafv2: new WAFV2Client({ region: resolvedRegion }),
    wafv2Global: new WAFV2Client({ region: 'us-east-1' }),
    acm: new ACMClient({ region: resolvedRegion }),
    autoScaling: new AutoScalingClient({ region: resolvedRegion }),
    region: resolvedRegion,
  };
}
