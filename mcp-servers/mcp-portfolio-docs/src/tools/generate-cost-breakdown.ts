/**
 * @fileoverview Tool handler for `generate-cost-breakdown`.
 *
 * Scans the repo for AWS resources, generates a cost breakdown document,
 * and optionally integrates pricing data from the aws-pricing MCP server.
 *
 * @module tools/generate-cost-breakdown
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { GeneratedDocument } from '../types/index.js';
import { SKILLS_TAXONOMY } from '../data/skills-taxonomy.js';
import { scanRepository } from '../scanners/repo-scanner.js';
import { extractSkills } from '../scanners/skill-extractor.js';
import { generateCostBreakdown } from '../generators/cost-breakdown-generator.js';
import { mergeOrWrite } from '../utils/document-merger.js';

/**
 * Generates a cost breakdown document.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param monthlyBudget - Optional monthly budget in GBP.
 * @param pricingData - Optional JSON pricing data from aws-pricing MCP.
 * @param outputDir - Optional output directory override.
 * @returns Generated document with path and content.
 */
export async function handleGenerateCostBreakdown(
  repoPath: string,
  monthlyBudget?: number,
  pricingData?: string,
  outputDir?: string,
): Promise<GeneratedDocument> {
  // Scan for resource evidence
  const scanResult = await scanRepository(repoPath);
  const detectedSkills = await extractSkills(scanResult.files, SKILLS_TAXONOMY);

  const content = generateCostBreakdown(detectedSkills, monthlyBudget, pricingData);

  const targetDir = outputDir ?? path.join(repoPath, 'docs', 'cost');
  await fs.mkdir(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, 'cost-breakdown.md');
  await mergeOrWrite(outputPath, content);

  return { outputPath, content, documentType: 'cost-breakdown' };
}
