/**
 * @fileoverview Repository file scanner.
 *
 * Walks the project tree using fast-glob, categorises files by type
 * (CDK construct, Helm chart, CI workflow, etc.), and returns a
 * structured scan result for downstream skill extraction.
 *
 * @module scanners/repo-scanner
 */

import fg from 'fast-glob';
import path from 'node:path';

import type { FileCategory, ScanResult, ScannedFile, ScopeProfile } from '../types/index.js';

/** Directories to always exclude from scanning. */
const EXCLUDE_DIRS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cdk.out/**',
  '**/.git/**',
  '**/.yarn/**',
  '**/coverage/**',
  '**/.gemini/**',
];

/**
 * Pattern-to-category mapping rules, evaluated in order.
 * First match wins.
 */
const CATEGORY_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly category: FileCategory }> = [
  { pattern: /\/argocd-apps\/.*\.ya?ml$/, category: 'argocd-app' },
  { pattern: /crossplane.*xrd|x-.*\.ya?ml$/, category: 'crossplane-xrd' },
  { pattern: /Chart\.ya?ml$/, category: 'helm-chart' },
  { pattern: /values\.ya?ml$/, category: 'helm-values' },
  { pattern: /\.github\/workflows\/.*\.ya?ml$/, category: 'ci-workflow' },
  { pattern: /Dockerfile/, category: 'dockerfile' },
  { pattern: /dashboards\/.*\.json$/, category: 'grafana-dashboard' },
  { pattern: /lib\/stacks\/.*\.ts$/, category: 'cdk-stack' },
  { pattern: /lib\/common\/.*\.ts$/, category: 'cdk-construct' },
  { pattern: /lib\/constructs\/.*\.ts$/, category: 'cdk-construct' },
  { pattern: /cdk\.json$/, category: 'cdk-config' },
  { pattern: /kubernetes-app\/.*\.ya?ml$/, category: 'k8s-manifest' },
  { pattern: /package\.json$/, category: 'package-manifest' },
  { pattern: /\.test\.ts$|\.spec\.ts$/, category: 'test-file' },
  { pattern: /\.md$/, category: 'documentation' },
  { pattern: /\.ts$/, category: 'typescript-source' },
  { pattern: /\.tf$/, category: 'terraform' },
  { pattern: /scripts\//, category: 'script' },
];

/**
 * Categorises a file based on its relative path.
 *
 * @param relativePath - File path relative to repo root.
 * @returns The most specific matching category.
 */
function categoriseFile(relativePath: string): FileCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(relativePath)) {
      return rule.category;
    }
  }
  return 'other';
}

/**
 * Scans the repository and returns categorised files.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param scope - Optional scope profile to limit the scan.
 * @returns Structured scan result with files grouped by category.
 */
export async function scanRepository(
  repoPath: string,
  scope?: ScopeProfile,
): Promise<ScanResult> {
  const patterns = scope
    ? scope.includePatterns.map((p) => p)
    : ['**/*'];

  const filePaths = await fg(patterns, {
    cwd: repoPath,
    ignore: EXCLUDE_DIRS,
    dot: false,
    onlyFiles: true,
    absolute: false,
  });

  const files: ScannedFile[] = filePaths.map((relativePath) => ({
    relativePath,
    absolutePath: path.resolve(repoPath, relativePath),
    category: categoriseFile(relativePath),
  }));

  // Build category counts
  const categoryCounts = {} as Record<FileCategory, number>;
  for (const file of files) {
    categoryCounts[file.category] = (categoryCounts[file.category] ?? 0) + 1;
  }

  return {
    files,
    totalFiles: files.length,
    categoryCounts,
  };
}
