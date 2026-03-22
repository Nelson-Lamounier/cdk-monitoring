/**
 * @fileoverview Skill extractor — maps scanned files to detected skills.
 *
 * Uses two detection strategies:
 * 1. **Path matching** — File paths match glob-like patterns from the taxonomy.
 * 2. **Content matching** — File contents match regex patterns (for key files only).
 *
 * Every detected skill includes the evidence file paths that proved it.
 *
 * @module scanners/skill-extractor
 */

import fs from 'node:fs/promises';

import type { DetectedSkill, EvidenceSnippet, ScannedFile, SkillCategory } from '../types/index.js';
import { SKILLS_TAXONOMY } from '../data/skills-taxonomy.js';

/** Maximum file size (in bytes) to read for content pattern matching. */
const MAX_CONTENT_SCAN_SIZE = 512_000;

/** File extensions worth scanning for content patterns. */
const CONTENT_SCANNABLE_EXTENSIONS = new Set([
  '.ts', '.js', '.json', '.yaml', '.yml', '.md', '.cjs', '.mjs',
]);

/**
 * Tests whether a relative file path matches a glob-like detection pattern.
 *
 * Supports `**` (any path segment) and `*` (any characters within a segment).
 *
 * @param relativePath - File path relative to repo root.
 * @param pattern - Glob-like pattern from the taxonomy.
 * @returns True if the path matches the pattern.
 */
function pathMatchesPattern(relativePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(regexStr).test(relativePath);
}

/**
 * Checks whether a file's contents match any of the given content patterns.
 *
 * @param absolutePath - Full path to the file.
 * @param contentPatterns - Regex pattern strings to test.
 * @returns True if any pattern matches the file content.
 */
async function contentMatchesPatterns(
  absolutePath: string,
  contentPatterns: readonly string[],
): Promise<boolean> {
  try {
    const ext = absolutePath.substring(absolutePath.lastIndexOf('.'));
    if (!CONTENT_SCANNABLE_EXTENSIONS.has(ext)) {
      return false;
    }

    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_CONTENT_SCAN_SIZE) {
      return false;
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    return contentPatterns.some((pattern) => new RegExp(pattern, 'i').test(content));
  } catch {
    return false;
  }
}

/**
 * Extracts detected skills from scanned files using the skills taxonomy.
 *
 * For each skill in the taxonomy, checks:
 * 1. Whether any scanned files match the skill's detection patterns (path-based).
 * 2. For matched files that are content-scannable, whether their contents
 *    match the skill's content patterns.
 *
 * @param scannedFiles - Files discovered by the repo scanner.
 * @param categories - Optional filtered categories (for scoped scans).
 * @returns Array of detected skills, each with evidence file paths.
 */
export async function extractSkills(
  scannedFiles: readonly ScannedFile[],
  categories?: readonly SkillCategory[],
): Promise<DetectedSkill[]> {
  const taxonomy = categories ?? SKILLS_TAXONOMY;
  const detectedSkills: DetectedSkill[] = [];

  for (const category of taxonomy) {
    for (const skill of category.skills) {
      const evidenceFiles: string[] = [];

      // Phase 1: Path-based detection
      for (const file of scannedFiles) {
        const pathMatch = skill.detectionPatterns.some((pattern) =>
          pathMatchesPattern(file.relativePath, pattern),
        );

        if (pathMatch) {
          // Phase 2: Content-based confirmation (if content patterns exist)
          if (skill.contentPatterns && skill.contentPatterns.length > 0) {
            const contentMatch = await contentMatchesPatterns(
              file.absolutePath,
              skill.contentPatterns,
            );
            if (contentMatch) {
              evidenceFiles.push(file.relativePath);
            }
          } else {
            // No content patterns — path match is sufficient
            evidenceFiles.push(file.relativePath);
          }
        }
      }

      if (evidenceFiles.length > 0) {
        detectedSkills.push({
          skillId: skill.id,
          skillName: skill.name,
          categoryId: category.id,
          demand: skill.demand,
          evidence: [...new Set(evidenceFiles)], // Deduplicate
        });
      }
    }
  }

  return detectedSkills;
}

/** Maximum lines to include in an evidence snippet. */
const MAX_SNIPPET_LINES = 150;

/** Maximum number of evidence files to read. */
const MAX_EVIDENCE_FILES = 50;

/**
 * Reads content previews for evidence files referenced by detected skills.
 *
 * Deduplicates file paths across all skills and reads the first N lines
 * of each file, producing structured snippets for the AI caller.
 *
 * @param detectedSkills - Skills with evidence file paths.
 * @param scannedFiles - Full set of scanned files (for category lookup).
 * @param repoPath - Absolute path to the repository root.
 * @returns Array of evidence snippets with content previews.
 */
export async function readEvidenceSnippets(
  detectedSkills: readonly DetectedSkill[],
  scannedFiles: readonly ScannedFile[],
  repoPath: string,
): Promise<EvidenceSnippet[]> {
  // Collect unique evidence paths
  const uniquePaths = new Set<string>();
  for (const skill of detectedSkills) {
    for (const evidencePath of skill.evidence) {
      uniquePaths.add(evidencePath);
    }
  }

  // Build a lookup map for file categories
  const categoryMap = new Map<string, ScannedFile['category']>();
  for (const file of scannedFiles) {
    categoryMap.set(file.relativePath, file.category);
  }

  // Read snippets (capped at MAX_EVIDENCE_FILES)
  const snippets: EvidenceSnippet[] = [];
  const pathsToRead = [...uniquePaths].slice(0, MAX_EVIDENCE_FILES);

  for (const relativePath of pathsToRead) {
    try {
      const absolutePath = `${repoPath}/${relativePath}`;
      const content = await fs.readFile(absolutePath, 'utf-8');
      const allLines = content.split('\n');
      const preview = allLines.slice(0, MAX_SNIPPET_LINES).join('\n');

      snippets.push({
        relativePath,
        category: categoryMap.get(relativePath) ?? 'other',
        contentPreview: preview,
        totalLines: allLines.length,
      });
    } catch {
      // Skip unreadable files silently
    }
  }

  return snippets;
}
