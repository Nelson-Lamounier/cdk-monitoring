/**
 * @fileoverview Tool handler for `analyse-portfolio`.
 *
 * Orchestrates the full pipeline: scan → extract → match → generate.
 * Supports full-repo, scoped, and code-quality modes.
 *
 * @module tools/analyse-portfolio
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnalysisResult, ScopeProfile } from '../types/index.js';
import { SCOPE_PROFILES } from '../data/scope-profiles.js';
import { SKILLS_TAXONOMY } from '../data/skills-taxonomy.js';
import { scanRepository } from '../scanners/repo-scanner.js';
import { extractSkills } from '../scanners/skill-extractor.js';
import { scanCodeQuality } from '../scanners/code-quality-scanner.js';
import { matchAgainstMarket } from '../analysers/market-matcher.js';
import { generatePortfolioOverview } from '../generators/portfolio-overview.js';
import { generateFeatureArticle } from '../generators/feature-article.js';
import { generateCodeQualityReport } from '../generators/code-quality-report.js';
import { mergeOrWrite } from '../utils/document-merger.js';

/** The scope ID that triggers the code-quality scanner pipeline. */
const CODE_QUALITY_SCOPE_ID = 'code-quality';

/**
 * Resolves a scope profile by ID.
 *
 * @param scopeId - The scope identifier string.
 * @returns The matching scope profile.
 * @throws If the scope ID is not found.
 */
function resolveScope(scopeId: string): ScopeProfile {
  const profile = SCOPE_PROFILES.find((p) => p.id === scopeId);
  if (!profile) {
    const validIds = SCOPE_PROFILES.map((p) => p.id).join(', ');
    throw new Error(`Unknown scope "${scopeId}". Valid scopes: ${validIds}`);
  }
  return profile;
}

/**
 * Ensures output directory exists.
 *
 * @param dirPath - Directory path to create.
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Executes the analyse-portfolio pipeline.
 *
 * When the scope is `'code-quality'`, runs the specialised code-quality scanner
 * and generates a hygiene report instead of a feature article.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param scopeId - Optional scope ID for targeted analysis.
 * @param outputDir - Optional output directory override.
 * @returns Analysis result with generated markdown and output path.
 */
export async function handleAnalysePortfolio(
  repoPath: string,
  scopeId?: string,
  outputDir?: string,
): Promise<AnalysisResult> {
  const scope = scopeId ? resolveScope(scopeId) : undefined;

  // Step 1: Scan repository
  const scanResult = await scanRepository(repoPath, scope);

  // Step 2: Extract skills
  const filteredCategories = scope
    ? SKILLS_TAXONOMY.filter((cat) => scope.focusCategories.includes(cat.id))
    : undefined;

  const detectedSkills = await extractSkills(scanResult.files, filteredCategories);

  // Step 3: Match against market taxonomy
  const coverage = matchAgainstMarket(
    detectedSkills,
    scope?.focusCategories,
  );

  // Step 4: Generate markdown
  let markdownContent: string;
  let outputPath: string;

  if (scopeId === CODE_QUALITY_SCOPE_ID) {
    // Code-quality scope → specialised scanner + report
    const qualityReport = await scanCodeQuality(scanResult.files);
    markdownContent = generateCodeQualityReport(qualityReport);
    const targetDir = outputDir ?? path.join(repoPath, 'docs');
    await ensureDir(targetDir);
    outputPath = path.join(targetDir, 'code-quality-report.md');
  } else if (scope) {
    // Scoped scan → feature article → articles-draft/
    markdownContent = generateFeatureArticle(scope, detectedSkills, coverage);
    const targetDir = outputDir ?? path.join(repoPath, 'articles-draft');
    await ensureDir(targetDir);
    outputPath = path.join(targetDir, `${scope.id}-implementation.md`);
  } else {
    // Full scan → portfolio overview → docs/
    markdownContent = generatePortfolioOverview(coverage, detectedSkills);
    const targetDir = outputDir ?? path.join(repoPath, 'docs');
    await ensureDir(targetDir);
    outputPath = path.join(targetDir, 'portfolio-overview.md');
  }

  // Step 5: Write to disk (merge if file already exists)
  await mergeOrWrite(outputPath, markdownContent);

  return {
    detectedSkills,
    coverage,
    outputPath,
    markdownContent,
  };
}
