/**
 * @fileoverview Code-quality scanner for TypeScript repositories.
 *
 * Scans TypeScript source files for common code hygiene issues:
 * - Missing JSDoc on exported functions/classes
 * - Usage of `any` type
 * - Missing `import type` for type-only imports
 * - Magic numbers and strings in logic
 * - Duplicated code blocks (hash-based DRY detection)
 *
 * @module scanners/code-quality-scanner
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import type {
  CodeQualityFinding,
  CodeQualityReport,
  FindingSeverity,
  ScannedFile,
} from '../types/index.js';

/** Maximum file size (in bytes) to scan for quality issues. */
const MAX_SCAN_SIZE = 512_000;

/** Minimum block size (lines) to consider for DRY violation detection. */
const DRY_BLOCK_SIZE = 4;

/** Score deductions per severity level. */
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  error: 3,
  warning: 1,
  info: 0.25,
};

/**
 * Rule definition for code-quality checking.
 *
 * @param line - The source line content.
 * @param lineNumber - 1-indexed line number.
 * @param lines - All lines in the file (for look-behind context).
 * @returns A finding if the rule is violated, or undefined.
 */
type RuleChecker = (
  line: string,
  lineNumber: number,
  lines: readonly string[],
) => Omit<CodeQualityFinding, 'file'> | undefined;

/**
 * Checks for exported functions/classes that lack a preceding JSDoc block.
 *
 * @param line - Current source line.
 * @param lineNumber - 1-indexed line number.
 * @param lines - All lines for context.
 * @returns A finding if JSDoc is missing, or undefined.
 */
const checkMissingJsDoc: RuleChecker = (line, lineNumber, lines) => {
  const exportMatch = /^export\s+(async\s+)?function\s+\w|^export\s+class\s+\w|^export\s+interface\s+\w/.test(
    line.trim(),
  );
  if (!exportMatch) return undefined;

  // Look backwards for a closing JSDoc comment
  for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 5); i--) {
    const prevLine = lines[i]?.trim() ?? '';
    if (prevLine.endsWith('*/')) return undefined;
    if (prevLine === '' || prevLine.startsWith('//')) continue;
    break;
  }

  return {
    line: lineNumber,
    rule: 'missing-jsdoc',
    message: 'Exported member lacks JSDoc/TSDoc documentation.',
    severity: 'warning',
  };
};

/**
 * Detects usage of the `any` type.
 *
 * @param line - Current source line.
 * @param lineNumber - 1-indexed line number.
 * @returns A finding if `any` is used, or undefined.
 */
const checkAnyUsage: RuleChecker = (line, lineNumber) => {
  const trimmed = line.trim();
  // Skip comments
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return undefined;

  if (/:\s*any\b|as\s+any\b|<any>/.test(line)) {
    return {
      line: lineNumber,
      rule: 'any-usage',
      message: 'Avoid using `any`. Use `unknown` or define a specific type.',
      severity: 'error',
    };
  }
  return undefined;
};

/**
 * Detects value-level imports that should use `import type`.
 *
 * Flags `import { X }` when the import name starts with an uppercase letter
 * and the file has no runtime usage of that identifier beyond type annotations.
 * Uses a simple heuristic: if the import line contains only names that look
 * like type identifiers (PascalCase) and there is no `new`, `extends`, or
 * function-call usage, it is likely a type-only import.
 *
 * @param line - Current source line.
 * @param lineNumber - 1-indexed line number.
 * @returns A finding if `import type` is likely missing, or undefined.
 */
const checkMissingImportType: RuleChecker = (line, lineNumber) => {
  // Only flag lines that are `import {` but NOT `import type {`
  if (!/^import\s+\{/.test(line.trim()) || /^import\s+type\s+/.test(line.trim())) {
    return undefined;
  }

  // Skip SDK client imports (commonly used as values)
  if (/@aws-sdk|@modelcontextprotocol|node:|fast-glob|zod/.test(line)) {
    return undefined;
  }

  // If importing only type-looking names from a types module
  if (/from\s+['"].*\/types/.test(line)) {
    return {
      line: lineNumber,
      rule: 'missing-import-type',
      message: 'Import from a types module should use `import type`.',
      severity: 'warning',
    };
  }

  return undefined;
};

/**
 * Detects magic numbers in logic (excluding common safe values).
 *
 * @param line - Current source line.
 * @param lineNumber - 1-indexed line number.
 * @returns A finding if a magic number is detected, or undefined.
 */
const checkMagicValues: RuleChecker = (line, lineNumber) => {
  const trimmed = line.trim();
  // Skip comments, imports, const declarations, and common safe lines
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('import') ||
    trimmed.startsWith('export const') ||
    trimmed.startsWith('const ')
  ) {
    return undefined;
  }

  // Look for numeric literals in comparisons/conditions (excluding 0, 1, 2, -1)
  const magicMatch = /(?:===?\s*|!==?\s*|>\s*|<\s*|>=\s*|<=\s*)(\d{2,})/.exec(trimmed);
  if (magicMatch) {
    return {
      line: lineNumber,
      rule: 'magic-number',
      message: `Magic number ${magicMatch[1]} should be extracted to a named constant.`,
      severity: 'info',
    };
  }

  return undefined;
};

/** All registered code-quality rules. */
const RULES: readonly RuleChecker[] = [
  checkMissingJsDoc,
  checkAnyUsage,
  checkMissingImportType,
  checkMagicValues,
];

/**
 * Scans a single TypeScript file for code-quality findings.
 *
 * @param absolutePath - Full path to the file.
 * @param relativePath - Relative path from repo root (for reporting).
 * @returns Array of findings for this file.
 */
async function scanFile(
  absolutePath: string,
  relativePath: string,
): Promise<CodeQualityFinding[]> {
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_SCAN_SIZE) return [];

    const content = await fs.readFile(absolutePath, 'utf-8');
    const lines = content.split('\n');
    const findings: CodeQualityFinding[] = [];

    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        const result = rule(lines[i], i + 1, lines);
        if (result) {
          findings.push({ ...result, file: relativePath });
        }
      }
    }

    return findings;
  } catch {
    return [];
  }
}

/**
 * Detects duplicated code blocks across files using content hashing.
 *
 * Splits each file into sliding windows of `DRY_BLOCK_SIZE` lines,
 * hashes each window, and flags blocks that appear in multiple files.
 *
 * @param fileContents - Map of relative path to file content string.
 * @returns Array of DRY-violation findings.
 */
function detectDryViolations(
  fileContents: ReadonlyMap<string, string>,
): CodeQualityFinding[] {
  const hashMap = new Map<string, { file: string; line: number }[]>();

  for (const [relativePath, content] of fileContents) {
    const lines = content.split('\n');
    if (lines.length < DRY_BLOCK_SIZE) continue;

    for (let i = 0; i <= lines.length - DRY_BLOCK_SIZE; i++) {
      const block = lines
        .slice(i, i + DRY_BLOCK_SIZE)
        .map((l) => l.trim())
        .join('\n');

      // Skip mostly-empty or trivial blocks
      if (block.replace(/\s/g, '').length < 40) continue;

      const hash = crypto.createHash('md5').update(block).digest('hex');
      const existing = hashMap.get(hash) ?? [];
      existing.push({ file: relativePath, line: i + 1 });
      hashMap.set(hash, existing);
    }
  }

  const findings: CodeQualityFinding[] = [];
  for (const [, locations] of hashMap) {
    // Only flag if the same block appears in different files
    const uniqueFiles = new Set(locations.map((l) => l.file));
    if (uniqueFiles.size < 2) continue;

    for (const loc of locations) {
      findings.push({
        file: loc.file,
        line: loc.line,
        rule: 'dry-violation',
        message: `Duplicated code block (${DRY_BLOCK_SIZE} lines) also found in: ${locations
          .filter((l) => l.file !== loc.file)
          .map((l) => `${l.file}:${l.line}`)
          .join(', ')}`,
        severity: 'warning',
      });
    }
  }

  return findings;
}

/**
 * Computes a quality score from findings.
 *
 * Starts at 100 and deducts points based on finding severity.
 * The score is clamped to a minimum of 0.
 *
 * @param totalFiles - Number of files scanned.
 * @param findings - All findings detected.
 * @returns Quality score between 0 and 100.
 */
function computeScore(
  totalFiles: number,
  findings: readonly CodeQualityFinding[],
): number {
  if (totalFiles === 0) return 100;

  const totalDeductions = findings.reduce(
    (sum, f) => sum + SEVERITY_WEIGHT[f.severity],
    0,
  );
  // Normalise deductions relative to file count
  const normalisedDeduction = (totalDeductions / totalFiles) * 10;
  return Math.max(0, Math.round(100 - normalisedDeduction));
}

/**
 * Scans all TypeScript files for code-quality issues and returns an aggregated report.
 *
 * @param scannedFiles - Files discovered by the repo scanner (filtered to .ts/.tsx).
 * @returns Aggregated code-quality report with findings and score.
 */
export async function scanCodeQuality(
  scannedFiles: readonly ScannedFile[],
): Promise<CodeQualityReport> {
  const tsFiles = scannedFiles.filter(
    (f) => f.relativePath.endsWith('.ts') || f.relativePath.endsWith('.tsx'),
  );

  // Phase 1: Per-file rule-based scanning
  const allFindings: CodeQualityFinding[] = [];
  const fileContents = new Map<string, string>();

  for (const file of tsFiles) {
    const findings = await scanFile(file.absolutePath, file.relativePath);
    allFindings.push(...findings);

    // Read content for DRY analysis
    try {
      const stat = await fs.stat(file.absolutePath);
      if (stat.size <= MAX_SCAN_SIZE) {
        const content = await fs.readFile(file.absolutePath, 'utf-8');
        fileContents.set(file.relativePath, content);
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Phase 2: Cross-file DRY violation detection
  const dryFindings = detectDryViolations(fileContents);
  allFindings.push(...dryFindings);

  // Build rule breakdown
  const findingsByRule: Record<string, number> = {};
  for (const finding of allFindings) {
    findingsByRule[finding.rule] = (findingsByRule[finding.rule] ?? 0) + 1;
  }

  const score = computeScore(tsFiles.length, allFindings);

  return {
    totalFiles: tsFiles.length,
    totalFindings: allFindings.length,
    findingsByRule,
    findings: allFindings,
    score,
  };
}
