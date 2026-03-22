/**
 * @fileoverview Tool handler for `generate-decision-analysis`.
 *
 * Resolves a decision template (or accepts custom parameters),
 * scans the repository for evidence, runs the decision analysis
 * engine, and writes the output document.
 *
 * @module tools/generate-decision-analysis
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

import { DECISION_TEMPLATES } from '../data/decision-templates.js';
import { generateDecisionAnalysis } from '../generators/decision-analysis-generator.js';
import type {
  DecisionAnalysis,
  DecisionCriterion,
  DecisionFramework,
  DecisionOption,
  GeneratedDocument,
} from '../types/index.js';
import { mergeOrWrite } from '../utils/document-merger.js';

/**
 * Generates a structured decision analysis document.
 *
 * If `decisionId` matches a predefined template, uses its options, criteria,
 * and evidence patterns. Custom options/criteria override the template.
 * If no template matches, creates an ad-hoc analysis with a placeholder structure.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param decisionId - Template ID or free-form decision title.
 * @param customOptions - Optional JSON string of custom options.
 * @param customCriteria - Optional JSON string of custom criteria.
 * @param framework - Analysis framework type (defaults to 'weighted-matrix').
 * @param outputDir - Optional output directory override.
 * @returns Generated document with path and content.
 */
export async function handleGenerateDecisionAnalysis(
  repoPath: string,
  decisionId: string,
  customOptions?: string,
  customCriteria?: string,
  framework?: DecisionFramework,
  outputDir?: string,
): Promise<GeneratedDocument> {
  const template = DECISION_TEMPLATES.find((t) => t.id === decisionId);
  const resolvedFramework = framework ?? 'weighted-matrix';

  // Resolve options — custom overrides template
  let options: readonly DecisionOption[];
  if (customOptions) {
    options = JSON.parse(customOptions) as DecisionOption[];
  } else if (template) {
    options = template.options;
  } else {
    throw new Error(
      `No template found for "${decisionId}" and no custom options provided. ` +
        `Available templates: ${DECISION_TEMPLATES.map((t) => t.id).join(', ')}`,
    );
  }

  // Resolve criteria — custom overrides template
  let criteria: readonly DecisionCriterion[];
  if (customCriteria) {
    criteria = JSON.parse(customCriteria) as DecisionCriterion[];
  } else if (template) {
    criteria = template.criteria;
  } else {
    criteria = [
      { name: 'Feasibility', weight: 0.25, description: 'How achievable is this option with current resources.' },
      { name: 'Impact', weight: 0.25, description: 'Expected positive impact on the project.' },
      { name: 'Risk', weight: 0.25, description: 'Level of risk involved.' },
      { name: 'Cost', weight: 0.25, description: 'Financial and time cost of implementation.' },
    ];
  }

  // Scan for evidence files
  const evidencePatterns = template?.evidencePatterns ?? [];
  let evidenceFiles: string[] = [];
  if (evidencePatterns.length > 0) {
    evidenceFiles = await fg(evidencePatterns as string[], {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**', '**/.git/**'],
      onlyFiles: true,
    });
  }

  // Calculate composite scores and determine recommendation
  const criteriaArray = [...criteria];
  const scored = options.map((opt) => {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const c of criteriaArray) {
      const score = opt.scores[c.name] ?? 0;
      weightedSum += score * c.weight;
      totalWeight += c.weight;
    }
    return { id: opt.id, composite: totalWeight > 0 ? weightedSum / totalWeight : 0 };
  });
  scored.sort((a, b) => b.composite - a.composite);

  const bestOption = scored[0];
  const runnerUp = scored.length > 1 ? scored[1] : undefined;
  const margin = runnerUp ? bestOption.composite - runnerUp.composite : bestOption.composite;
  const confidence = Math.min(100, Math.round(50 + margin * 25));

  const bestOptionData = options.find((o) => o.id === bestOption.id);
  let reasoning = `**${bestOptionData?.name ?? bestOption.id}** scores highest with a composite of ${bestOption.composite.toFixed(2)}/5.00.`;

  if (runnerUp) {
    const runnerUpData = options.find((o) => o.id === runnerUp.id);
    reasoning += ` The runner-up is **${runnerUpData?.name ?? runnerUp.id}** (${runnerUp.composite.toFixed(2)}/5.00).`;
  }

  // Build analysis object
  const analysis: DecisionAnalysis = {
    title: template?.title ?? decisionId,
    context: template?.context ?? `Decision analysis for: ${decisionId}`,
    framework: resolvedFramework,
    criteria,
    options,
    recommendedOptionId: bestOption.id,
    reasoning,
    confidence,
    evidenceFiles,
  };

  // Generate markdown
  const content = generateDecisionAnalysis(analysis);

  // Write output
  const targetDir = outputDir ?? path.join(repoPath, 'docs', 'decisions');
  await fs.mkdir(targetDir, { recursive: true });
  const fileSlug = template?.id ?? decisionId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const outputPath = path.join(targetDir, `${fileSlug}.md`);
  await mergeOrWrite(outputPath, content);

  return { outputPath, content, documentType: 'decision-analysis' };
}
