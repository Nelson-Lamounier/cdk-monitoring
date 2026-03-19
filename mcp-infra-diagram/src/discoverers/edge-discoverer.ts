/**
 * @fileoverview Edge (CDN) resource discoverer.
 *
 * Discovers CloudFront distributions, WAF WebACLs, and ACM certificates
 * from the live AWS account. CloudFront and its WAF are always in
 * us-east-1; regional resources use the configured region.
 *
 * @module discoverers/edge-discoverer
 */

import {
  ListDistributionsCommand,
} from '@aws-sdk/client-cloudfront';
import {
  GetWebACLCommand,
} from '@aws-sdk/client-wafv2';
import {
  ListCertificatesCommand,
} from '@aws-sdk/client-acm';

import type { AwsClients } from '../clients/aws-client.js';
import type { ResourceNode, ResourceEdge } from '../graph/types.js';

/** Options for scoping edge resource discovery. */
export interface EdgeDiscoveryOptions {
  /** Tag filter (applied to CloudFront tags if available). */
  readonly tags?: Record<string, string>;
}

/** Result of edge discovery. */
export interface EdgeDiscoveryResult {
  readonly nodes: ResourceNode[];
  readonly edges: ResourceEdge[];
}

/**
 * Discovers CloudFront distributions, WAF WebACLs, and ACM certificates.
 *
 * @param clients - AWS SDK clients.
 * @param _options - Optional tag filters.
 * @returns Nodes for distributions, WAFs, certs + routing/reference edges.
 */
export async function discoverEdgeResources(
  clients: AwsClients,
  _options: EdgeDiscoveryOptions = {},
): Promise<EdgeDiscoveryResult> {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  // --- CloudFront Distributions ---
  const { DistributionList } = await clients.cloudfront.send(
    new ListDistributionsCommand({}),
  );

  for (const dist of DistributionList?.Items ?? []) {
    const distId = dist.Id ?? 'unknown';
    const domainName = dist.DomainName ?? '';
    const aliases = dist.Aliases?.Items ?? [];
    const webAclId = dist.WebACLId ?? '';

    // Collect origins
    const originSummaries: string[] = [];
    for (const origin of dist.Origins?.Items ?? []) {
      originSummaries.push(
        `${origin.Id ?? 'unknown'} → ${origin.DomainName ?? 'unknown'}`,
      );
    }

    nodes.push({
      id: distId,
      type: 'cloudfront-distribution',
      label: aliases.length > 0 ? aliases[0] : distId,
      metadata: {
        domainName,
        aliases: aliases.join(', '),
        status: dist.Status ?? 'unknown',
        enabled: String(dist.Enabled ?? false),
        httpVersion: dist.HttpVersion ?? '',
        origins: originSummaries.join(' | '),
        webAclId: webAclId || 'none',
        viewerCert: dist.ViewerCertificate?.ACMCertificateArn ?? 'default',
      },
      region: 'us-east-1',
    });

    // CloudFront → origin edges
    for (const origin of dist.Origins?.Items ?? []) {
      const originDomain = origin.DomainName ?? '';
      edges.push({
        source: distId,
        target: `origin:${originDomain}`,
        label: `origin (${origin.Id ?? ''})`,
        edgeType: 'routes',
      });

      // Create a placeholder node for the origin
      nodes.push({
        id: `origin:${originDomain}`,
        type: 'nlb', // Origins are typically NLBs or S3
        label: originDomain,
        metadata: { originDomain },
        region: clients.region,
      });
    }

    // CloudFront → WAF reference
    if (webAclId) {
      edges.push({
        source: distId,
        target: webAclId,
        label: 'protected-by',
        edgeType: 'references',
      });

      // Discover WAF details
      try {
        const arnParts = webAclId.split('/');
        const webAclName = arnParts.length >= 4 ? arnParts[3] : webAclId;
        const webAclIdSegment = arnParts.length >= 5 ? arnParts[4] : '';

        const { WebACL } = await clients.wafv2Global.send(
          new GetWebACLCommand({
            Name: webAclName,
            Scope: 'CLOUDFRONT',
            Id: webAclIdSegment,
          }),
        );

        if (WebACL) {
          const ruleNames = (WebACL.Rules ?? [])
            .map((r) => r.Name ?? 'unknown')
            .join(', ');

          nodes.push({
            id: webAclId,
            type: 'waf-web-acl',
            label: WebACL.Name ?? webAclId,
            metadata: {
              ruleCount: String(WebACL.Rules?.length ?? 0),
              rules: ruleNames,
              defaultAction: WebACL.DefaultAction?.Allow ? 'ALLOW' : 'BLOCK',
              capacity: String(WebACL.Capacity ?? 0),
            },
            region: 'us-east-1',
          });
        }
      } catch {
        // WAF details may not be accessible; create a minimal node
        nodes.push({
          id: webAclId,
          type: 'waf-web-acl',
          label: 'WAF WebACL',
          metadata: { arn: webAclId },
          region: 'us-east-1',
        });
      }
    }

    // CloudFront → ACM cert reference
    const certArn = dist.ViewerCertificate?.ACMCertificateArn;
    if (certArn) {
      edges.push({
        source: distId,
        target: certArn,
        label: 'uses-cert',
        edgeType: 'references',
      });
    }
  }

  // --- ACM Certificates (us-east-1 for CloudFront) ---
  // Use a us-east-1 ACM client for CloudFront certs
  const acmGlobal = clients.acm; // Note: for CloudFront, certs must be in us-east-1
  const { CertificateSummaryList = [] } = await acmGlobal.send(
    new ListCertificatesCommand({}),
  );

  for (const cert of CertificateSummaryList) {
    const certArn = cert.CertificateArn ?? 'unknown';
    const domain = cert.DomainName ?? 'unknown';

    nodes.push({
      id: certArn,
      type: 'acm-certificate',
      label: domain,
      metadata: {
        domain,
        status: cert.Status ?? 'unknown',
        type: cert.Type ?? 'unknown',
        inUse: String(cert.InUse ?? false),
      },
      region: clients.region,
    });
  }

  return { nodes, edges };
}
