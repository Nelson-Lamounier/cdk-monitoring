/**
 * @fileoverview Generates structured decision analysis documents.
 *
 * Produces markdown with:
 * - Executive summary and recommendation
 * - Weighted scoring matrix
 * - Pros/cons analysis per option
 * - Risk assessment matrix (probability × impact)
 * - Short-term vs long-term impact comparison
 *
 * @module generators/decision-analysis-generator
 */

import type {
  DecisionAnalysis,
  DecisionCriterion,
  DecisionOption,
  DecisionFramework,
  RiskAssessment,
} from '../types/index.js';

/** Numeric mapping for risk levels used in severity calculation. */
const RISK_LEVEL_MAP: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Calculates the weighted composite score for an option.
 *
 * @param option - The option to score.
 * @param criteria - Evaluation criteria with weights.
 * @returns Composite score (0–5 range).
 */
function calculateCompositeScore(
  option: DecisionOption,
  criteria: readonly DecisionCriterion[],
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const criterion of criteria) {
    const score = option.scores[criterion.name] ?? 0;
    weightedSum += score * criterion.weight;
    totalWeight += criterion.weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Determines the recommended option and generates reasoning.
 *
 * @param options - All options with scores.
 * @param criteria - Evaluation criteria.
 * @returns Tuple of [recommendedOptionId, reasoning, confidence].
 */
function determineRecommendation(
  options: readonly DecisionOption[],
  criteria: readonly DecisionCriterion[],
): [string, string, number] {
  const scored = options.map((opt) => ({
    option: opt,
    composite: calculateCompositeScore(opt, criteria),
  }));

  scored.sort((a, b) => b.composite - a.composite);

  const best = scored[0];
  const runnerUp = scored.length > 1 ? scored[1] : undefined;

  const margin = runnerUp ? best.composite - runnerUp.composite : best.composite;
  const confidence = Math.min(100, Math.round(50 + margin * 25));

  const topCriteria = [...criteria]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((c) => c.name);

  const strongPoints = topCriteria
    .filter((name) => (best.option.scores[name] ?? 0) >= 4)
    .join(', ');

  let reasoning = `**${best.option.name}** scores highest with a composite of ${best.composite.toFixed(2)}/5.00.`;

  if (strongPoints) {
    reasoning += ` It excels in ${strongPoints}.`;
  }

  if (runnerUp) {
    reasoning += ` The runner-up, **${runnerUp.option.name}** (${runnerUp.composite.toFixed(2)}/5.00),`;
    const runnerUpStrong = topCriteria
      .filter((name) => (runnerUp.option.scores[name] ?? 0) > (best.option.scores[name] ?? 0))
      .join(', ');
    if (runnerUpStrong) {
      reasoning += ` leads in ${runnerUpStrong} but falls short overall.`;
    } else {
      reasoning += ` is a viable alternative but does not outperform in any top-weighted criterion.`;
    }
  }

  return [best.option.id, reasoning, confidence];
}

/**
 * Renders a risk severity badge from probability × impact.
 *
 * @param probability - Risk probability level.
 * @param impact - Risk impact level.
 * @returns Severity label: LOW, MODERATE, HIGH, or CRITICAL.
 */
function riskSeverity(
  probability: RiskAssessment['probability'],
  impact: RiskAssessment['impact'],
): string {
  const score = RISK_LEVEL_MAP[probability] * RISK_LEVEL_MAP[impact];
  if (score >= 6) return '🔴 CRITICAL';
  if (score >= 4) return '🟠 HIGH';
  if (score >= 2) return '🟡 MODERATE';
  return '🟢 LOW';
}

/**
 * Generates a full decision analysis markdown document.
 *
 * @param analysis - The complete decision analysis data.
 * @returns Markdown string.
 */
export function generateDecisionAnalysis(analysis: DecisionAnalysis): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0];

  // Header
  lines.push(`# Decision Analysis: ${analysis.title}`);
  lines.push('');
  lines.push(`**Date:** ${date}`);
  lines.push(`**Framework:** ${formatFramework(analysis.framework)}`);
  lines.push(`**Confidence:** ${analysis.confidence}%`);
  lines.push('');

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(analysis.context);
  lines.push('');
  const recommended = analysis.options.find((o) => o.id === analysis.recommendedOptionId);
  lines.push(`> **Recommendation:** ${recommended?.name ?? analysis.recommendedOptionId}`);
  lines.push('>');
  lines.push(`> ${analysis.reasoning}`);
  lines.push('');

  // Options Overview
  lines.push('## Options Under Evaluation');
  lines.push('');
  lines.push('| Option | Description | Short-Term | Long-Term |');
  lines.push('|:---|:---|:---:|:---:|');
  for (const opt of analysis.options) {
    const marker = opt.id === analysis.recommendedOptionId ? ' ✅' : '';
    lines.push(
      `| **${opt.name}**${marker} | ${opt.description} | ${renderScore(opt.shortTermScore)} | ${renderScore(opt.longTermScore)} |`,
    );
  }
  lines.push('');

  // Evaluation Criteria
  lines.push('## Evaluation Criteria');
  lines.push('');
  lines.push('| Criterion | Weight | Description |');
  lines.push('|:---|:---:|:---|');
  for (const criterion of analysis.criteria) {
    lines.push(`| ${criterion.name} | ${(criterion.weight * 100).toFixed(0)}% | ${criterion.description} |`);
  }
  lines.push('');

  // Weighted Scoring Matrix
  lines.push('## Weighted Scoring Matrix');
  lines.push('');
  const criterionNames = analysis.criteria.map((c) => c.name);
  const headerCells = criterionNames.map((n) => {
    const shortName = n.length > 15 ? n.slice(0, 13) + '…' : n;
    return shortName;
  });
  lines.push(`| Option | ${headerCells.join(' | ')} | **Composite** |`);
  lines.push(`|:---|${headerCells.map(() => ':---:').join('|')}|:---:|`);

  for (const opt of analysis.options) {
    const scores = criterionNames.map((name) => renderScore(opt.scores[name] ?? 0));
    const composite = calculateCompositeScore(opt, analysis.criteria);
    const marker = opt.id === analysis.recommendedOptionId ? ' ✅' : '';
    lines.push(`| **${opt.name}**${marker} | ${scores.join(' | ')} | **${composite.toFixed(2)}** |`);
  }
  lines.push('');

  // Pros & Cons
  lines.push('## Pros & Cons Analysis');
  lines.push('');
  for (const opt of analysis.options) {
    lines.push(`### ${opt.name}`);
    lines.push('');
    lines.push('**Advantages:**');
    for (const pro of opt.prosAndCons.pros) {
      lines.push(`- ✅ ${pro}`);
    }
    lines.push('');
    lines.push('**Trade-offs:**');
    for (const con of opt.prosAndCons.cons) {
      lines.push(`- ⚠️ ${con}`);
    }
    lines.push('');
  }

  // Risk Assessment
  lines.push('## Risk Assessment');
  lines.push('');
  lines.push('| Option | Risk | Probability | Impact | Severity | Mitigation |');
  lines.push('|:---|:---|:---:|:---:|:---:|:---|');
  for (const opt of analysis.options) {
    for (const risk of opt.risks) {
      const severity = riskSeverity(risk.probability, risk.impact);
      lines.push(
        `| ${opt.name} | ${risk.risk} | ${risk.probability} | ${risk.impact} | ${severity} | ${risk.mitigation} |`,
      );
    }
  }
  lines.push('');

  // Short-Term vs Long-Term
  lines.push('## Short-Term vs Long-Term Impact');
  lines.push('');
  lines.push('| Option | Short-Term (1–3 months) | Long-Term (6–12 months) | Delta |');
  lines.push('|:---|:---:|:---:|:---:|');
  for (const opt of analysis.options) {
    const delta = opt.longTermScore - opt.shortTermScore;
    const deltaLabel = delta > 0 ? `📈 +${delta}` : delta < 0 ? `📉 ${delta}` : '➡️ 0';
    lines.push(`| ${opt.name} | ${renderScore(opt.shortTermScore)} | ${renderScore(opt.longTermScore)} | ${deltaLabel} |`);
  }
  lines.push('');

  // Evidence
  if (analysis.evidenceFiles.length > 0) {
    lines.push('## Repository Evidence');
    lines.push('');
    lines.push('> Files in this repository that inform this decision:');
    lines.push('');
    for (const file of analysis.evidenceFiles.slice(0, 12)) {
      lines.push(`- \`${file}\``);
    }
    if (analysis.evidenceFiles.length > 12) {
      lines.push(`- *(+${analysis.evidenceFiles.length - 12} additional files)*`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('*Generated by mcp-portfolio-docs — Decision Analyst. Scores are pre-populated from templates and can be adjusted by the agent.*');

  return lines.join('\n');
}

/**
 * Renders a numeric score (1–5) as a visual bar.
 *
 * @param score - Numeric score.
 * @returns String like "████░ 4/5".
 */
function renderScore(score: number): string {
  const filled = '█'.repeat(Math.round(score));
  const empty = '░'.repeat(5 - Math.round(score));
  return `${filled}${empty} ${score}/5`;
}

/**
 * Formats a framework enum value for display.
 *
 * @param framework - The framework type.
 * @returns Human-readable label.
 */
function formatFramework(framework: DecisionFramework): string {
  const labels: Record<DecisionFramework, string> = {
    'weighted-matrix': 'Weighted Scoring Matrix',
    'pros-cons': 'Pros & Cons Analysis',
    'risk-matrix': 'Risk-Based Assessment',
  };
  return labels[framework];
}
