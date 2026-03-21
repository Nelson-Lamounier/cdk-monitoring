/**
 * @fileoverview Zod schemas for MCP tool parameters.
 *
 * Defines validation schemas for all four tools:
 * discover-infrastructure, generate-mermaid, generate-python-diagram,
 * and generate-infra-doc.
 *
 * @module schemas/tool-params
 */

import { z } from 'zod';

/** Shared base parameters for all diagram tools. */
const baseParams = {
  region: z
    .string()
    .default('eu-west-1')
    .describe('AWS region to discover resources in'),
  vpcId: z
    .string()
    .optional()
    .describe('Optional VPC ID to scope discovery (omit for all VPCs)'),
  tags: z
    .record(z.string())
    .optional()
    .describe('Optional tag key-value pairs to filter resources (e.g. {"Project": "kubernetes"})'),
  includeK8s: z
    .boolean()
    .default(false)
    .describe('Whether to include Kubernetes cluster resources (pods, services, deployments)'),
};

/** Parameters for the discover-infrastructure tool. */
export const DiscoverInfrastructureSchema = z.object({
  ...baseParams,
});

/** Parameters for the generate-mermaid-diagram tool. */
export const GenerateMermaidSchema = z.object({
  ...baseParams,
  scope: z
    .enum(['full', 'networking', 'compute', 'edge'])
    .default('full')
    .describe('Diagram scope: full (everything), networking (VPC/SG/LB), compute (EC2/pods), edge (CloudFront/WAF)'),
});

/** Parameters for the generate-python-diagram tool. */
export const GeneratePythonDiagramSchema = z.object({
  ...baseParams,
  scope: z
    .enum(['full', 'networking', 'compute', 'edge'])
    .default('full')
    .describe('Diagram scope: full (everything), networking (VPC/SG/LB), compute (EC2/pods), edge (CloudFront/WAF)'),
  outputPath: z
    .string()
    .describe('Absolute file path for the generated Python script (e.g. /tmp/infra-diagram.py)'),
});

/** Parameters for the generate-infra-doc tool. */
export const GenerateInfraDocSchema = z.object({
  ...baseParams,
  scope: z
    .enum(['full', 'networking', 'compute', 'edge'])
    .default('full')
    .describe('Documentation scope: full (everything), networking (VPC/SG/LB), compute (EC2/pods), edge (CloudFront/WAF)'),
  mode: z
    .enum(['inventory', 'narrative'])
    .default('narrative')
    .describe('Documentation mode: inventory (factual tables/lists) or narrative (explains WHY each relationship exists)'),
});

