/**
 * @fileoverview Generates cost breakdown documents.
 *
 * Produces a resource inventory linked to CDK constructs, a trade-off
 * analysis table, and FinOps maturity indicators. Accepts optional
 * pricing data from the aws-pricing MCP server.
 *
 * @module generators/cost-breakdown-generator
 */

import type { DetectedSkill } from '../types/index.js';

/** Resources detected from CDK/infra patterns. */
interface DetectedResource {
  readonly service: string;
  readonly evidence: readonly string[];
}

/**
 * Extracts AWS resource types from detected skills.
 *
 * @param detectedSkills - Skills with evidence from the repo scan.
 * @returns Array of detected AWS resources.
 */
function extractResources(detectedSkills: readonly DetectedSkill[]): DetectedResource[] {
  const serviceMap: Record<string, string[]> = {};

  const resourceSkills = [
    'ec2-management', 'vpc-networking', 'load-balancing', 'dynamodb',
    's3', 'sqs', 'secrets-manager', 'aws-lambda', 'step-functions',
    'cloudwatch', 'bedrock', 'dns-tls', 'guardduty',
  ];

  for (const skill of detectedSkills) {
    if (resourceSkills.includes(skill.skillId)) {
      const service = skill.skillName;
      if (!serviceMap[service]) {
        serviceMap[service] = [];
      }
      serviceMap[service].push(...skill.evidence);
    }
  }

  return Object.entries(serviceMap).map(([service, evidence]) => ({
    service,
    evidence: [...new Set(evidence)],
  }));
}

/**
 * Parses optional external pricing data from the aws-pricing MCP.
 *
 * @param pricingDataJson - Optional JSON string with pricing data.
 * @returns Parsed pricing entries, or empty array.
 */
function parsePricingData(
  pricingDataJson?: string,
): ReadonlyArray<{ service: string; monthlyEstimate: string; details: string }> {
  if (!pricingDataJson) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(pricingDataJson);
    if (Array.isArray(parsed)) {
      return parsed.map((entry: Record<string, unknown>) => ({
        service: String(entry['service'] ?? 'Unknown'),
        monthlyEstimate: String(entry['monthlyEstimate'] ?? 'N/A'),
        details: String(entry['details'] ?? ''),
      }));
    }
  } catch {
    // Invalid JSON — return empty
  }
  return [];
}

/**
 * Generates a cost breakdown markdown document.
 *
 * @param detectedSkills - Skills detected with evidence.
 * @param monthlyBudget - Optional monthly budget in GBP.
 * @param pricingDataJson - Optional pricing data from aws-pricing MCP.
 * @returns Markdown string for the cost breakdown document.
 */
export function generateCostBreakdown(
  detectedSkills: readonly DetectedSkill[],
  monthlyBudget?: number,
  pricingDataJson?: string,
): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0];
  const resources = extractResources(detectedSkills);
  const pricingEntries = parsePricingData(pricingDataJson);

  lines.push('# Cost Breakdown');
  lines.push('');
  lines.push(`**Generated:** ${date}`);
  lines.push('');
  lines.push('> Resource inventory derived from CDK constructs and infrastructure code in this repository.');
  lines.push('');

  // Budget summary
  if (monthlyBudget) {
    lines.push(`**Monthly Budget:** £${monthlyBudget.toLocaleString('en-GB')}`);
    lines.push('');
  }

  // Resource inventory
  lines.push('## Resource Inventory');
  lines.push('');
  lines.push('| AWS Service | Evidence | CDK Source |');
  lines.push('| :--- | :--- | :--- |');

  for (const resource of resources) {
    const topEvidence = resource.evidence.slice(0, 2).map((e) => `\`${e}\``).join(', ');
    lines.push(`| ${resource.service} | ${topEvidence} | — |`);
  }
  lines.push('');

  // Pricing data (from external aws-pricing MCP, if provided)
  if (pricingEntries.length > 0) {
    lines.push('## Estimated Monthly Costs');
    lines.push('');
    lines.push('> Pricing data provided by the aws-pricing MCP server.');
    lines.push('');
    lines.push('| Service | Monthly Estimate | Details |');
    lines.push('| :--- | :--- | :--- |');
    for (const entry of pricingEntries) {
      lines.push(`| ${entry.service} | ${entry.monthlyEstimate} | ${entry.details} |`);
    }
    lines.push('');
  } else {
    lines.push('## Estimated Monthly Costs');
    lines.push('');
    lines.push('> No pricing data provided. Ask the AI assistant to call the `aws-pricing` MCP server');
    lines.push('> and pass the results to this tool\'s `pricingData` parameter.');
    lines.push('');
  }

  // Trade-off analysis
  lines.push('## Trade-Off Analysis');
  lines.push('');
  lines.push('| Decision | Cost Impact | Operational Impact |');
  lines.push('| :--- | :--- | :--- |');
  lines.push('| Self-managed K8s over EKS | Lower (no EKS control plane fee) | Higher operational overhead |');
  lines.push('| Single-node cluster | Minimal compute cost | No HA — acceptable for portfolio |');
  lines.push('| Spot instances (if used) | ~60-70% savings on compute | Requires termination handling |');
  lines.push('');

  // FinOps maturity
  lines.push('## FinOps Maturity Indicators');
  lines.push('');

  const finopsSkills = detectedSkills.filter((s) =>
    ['finops', 'opencost', 'automated-testing'].includes(s.skillId),
  );

  if (finopsSkills.length > 0) {
    lines.push('| Indicator | Status | Evidence |');
    lines.push('| :--- | :--- | :--- |');
    for (const skill of finopsSkills) {
      const evidence = skill.evidence.slice(0, 2).map((e) => `\`${e}\``).join(', ');
      lines.push(`| ${skill.skillName} | ✅ Implemented | ${evidence} |`);
    }
  } else {
    lines.push('| Indicator | Status |');
    lines.push('| :--- | :--- |');
    lines.push('| Cost monitoring | ⏳ Not yet detected |');
    lines.push('| Budget alerts | ⏳ Not yet detected |');
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('*Generated by mcp-portfolio-docs — resource inventory is evidence-based, pricing from external source.*');

  return lines.join('\n');
}
