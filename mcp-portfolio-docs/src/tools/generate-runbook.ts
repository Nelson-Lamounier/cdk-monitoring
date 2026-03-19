/**
 * @fileoverview Tool handler for `generate-runbook`.
 *
 * Scans the repository for evidence of automatic response mechanisms
 * and recovery monitoring, then generates the runbook document.
 *
 * @module tools/generate-runbook
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

import { RUNBOOK_SCENARIOS } from '../data/runbook-scenarios.js';
import { generateRunbook } from '../generators/runbook-generator.js';
import type { GeneratedDocument } from '../types/index.js';

/** Standard glob ignore patterns. */
const IGNORE_PATTERNS = ['**/node_modules/**', '**/dist/**', '**/cdk.out/**', '**/.git/**'];

/**
 * Generates a solo-operator runbook.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param scenarioId - Runbook scenario ID.
 * @param outputDir - Optional output directory override.
 * @returns Generated document with path and content.
 */
export async function handleGenerateRunbook(
  repoPath: string,
  scenarioId: string,
  outputDir?: string,
): Promise<GeneratedDocument> {
  const scenario = RUNBOOK_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    const validIds = RUNBOOK_SCENARIOS.map((s) => s.id).join(', ');
    throw new Error(`Unknown runbook scenario "${scenarioId}". Valid scenarios: ${validIds}`);
  }

  // Find evidence files
  const autoResponseFiles = await fg(scenario.autoResponseEvidence as string[], {
    cwd: repoPath,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
  });

  const recoveryFiles = await fg(scenario.recoveryEvidence as string[], {
    cwd: repoPath,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
  });

  const content = generateRunbook(scenario, autoResponseFiles, recoveryFiles);

  const targetDir = outputDir ?? path.join(repoPath, 'docs', 'runbooks');
  await fs.mkdir(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, `${scenario.id}.md`);
  await fs.writeFile(outputPath, content, 'utf-8');

  return { outputPath, content, documentType: 'runbook' };
}
