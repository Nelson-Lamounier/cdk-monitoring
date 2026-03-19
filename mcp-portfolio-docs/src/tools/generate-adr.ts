/**
 * @fileoverview Tool handler for `generate-adr`.
 *
 * Scans the repository for evidence files matching the ADR topic,
 * then generates the ADR document.
 *
 * @module tools/generate-adr
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

import { ADR_TOPICS } from '../data/adr-topics.js';
import { generateAdr } from '../generators/adr-generator.js';
import type { GeneratedDocument } from '../types/index.js';

/**
 * Generates an Architecture Decision Record.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param decisionId - ADR topic ID.
 * @param outputDir - Optional output directory override.
 * @returns Generated document with path and content.
 */
export async function handleGenerateAdr(
  repoPath: string,
  decisionId: string,
  outputDir?: string,
): Promise<GeneratedDocument> {
  const topic = ADR_TOPICS.find((t) => t.id === decisionId);
  if (!topic) {
    const validIds = ADR_TOPICS.map((t) => t.id).join(', ');
    throw new Error(`Unknown ADR decision "${decisionId}". Valid decisions: ${validIds}`);
  }

  // Find evidence files
  const evidenceFiles = await fg(topic.evidencePatterns as string[], {
    cwd: repoPath,
    ignore: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**', '**/.git/**'],
    onlyFiles: true,
  });

  const content = generateAdr(topic, evidenceFiles);

  const targetDir = outputDir ?? path.join(repoPath, 'docs', 'adrs');
  await fs.mkdir(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, `${topic.id}.md`);
  await fs.writeFile(outputPath, content, 'utf-8');

  return { outputPath, content, documentType: 'adr' };
}
