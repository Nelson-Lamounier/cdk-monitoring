/**
 * @fileoverview Tool handler for `scan-repo`.
 *
 * Dry-run tool — scans the repository and returns detected skills
 * as JSON without writing any files. Useful for previewing what
 * the analyse-portfolio tool would generate.
 *
 * @module tools/scan-repo
 */

import type { ScopeProfile } from '../types/index.js';
import { SCOPE_PROFILES } from '../data/scope-profiles.js';
import { SKILLS_TAXONOMY } from '../data/skills-taxonomy.js';
import { scanRepository } from '../scanners/repo-scanner.js';
import { extractSkills } from '../scanners/skill-extractor.js';
import { matchAgainstMarket } from '../analysers/market-matcher.js';

/**
 * Scans the repo and returns detected skills without writing files.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param scopeId - Optional scope ID for targeted scanning.
 * @returns JSON-serialisable scan result with skills and coverage.
 */
export async function handleScanRepo(
  repoPath: string,
  scopeId?: string,
): Promise<{
  readonly filesScanned: number;
  readonly skillsDetected: number;
  readonly skills: ReadonlyArray<{
    id: string;
    name: string;
    category: string;
    demand: string;
    evidenceCount: number;
    topEvidence: readonly string[];
  }>;
  readonly coveragePercent: number;
  readonly scope: string;
}> {
  let scope: ScopeProfile | undefined;

  if (scopeId) {
    scope = SCOPE_PROFILES.find((p) => p.id === scopeId);
    if (!scope) {
      const validIds = SCOPE_PROFILES.map((p) => p.id).join(', ');
      throw new Error(`Unknown scope "${scopeId}". Valid scopes: ${validIds}`);
    }
  }

  const scanResult = await scanRepository(repoPath, scope);

  const filteredCategories = scope
    ? SKILLS_TAXONOMY.filter((cat) => scope.focusCategories.includes(cat.id))
    : undefined;

  const detectedSkills = await extractSkills(scanResult.files, filteredCategories);
  const coverage = matchAgainstMarket(detectedSkills, scope?.focusCategories);

  return {
    filesScanned: scanResult.totalFiles,
    skillsDetected: detectedSkills.length,
    skills: detectedSkills.map((s) => ({
      id: s.skillId,
      name: s.skillName,
      category: s.categoryId,
      demand: s.demand,
      evidenceCount: s.evidence.length,
      topEvidence: s.evidence.slice(0, 3),
    })),
    coveragePercent: coverage.overallCoveragePercent,
    scope: scopeId ?? 'full-repo',
  };
}
