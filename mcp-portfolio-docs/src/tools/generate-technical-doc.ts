/**
 * @fileoverview Tool handler for `generate-technical-doc`.
 *
 * Reads raw source files from the repository, classifies their content type,
 * resolves the writing profile for the target audience, and delegates to
 * the generator to produce polished documentation.
 *
 * @module tools/generate-technical-doc
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { WRITING_PROFILES } from '../data/writing-profiles.js';
import { detectContentType, generateTechnicalDoc } from '../generators/technical-doc-generator.js';
import type {
  DocumentAudience,
  DocumentStyle,
  GeneratedDocument,
  SourceFileContent,
  TechnicalDocConfig,
} from '../types/index.js';
import { mergeOrWrite } from '../utils/document-merger.js';

/** Maximum file size to read (100 KB). Larger files are skipped. */
const MAX_FILE_SIZE_BYTES = 100 * 1024;

/**
 * Generates a polished technical document from raw source files.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param title - Document title.
 * @param sourceFilesJson - JSON array of relative file paths.
 * @param audience - Target audience (defaults to 'developer').
 * @param style - Document style (defaults to 'api-reference').
 * @param context - Optional additional context/instructions.
 * @param glossaryJson - Optional JSON object of term→definition pairs.
 * @param outputDir - Optional output directory override.
 * @returns Generated document with path and content.
 * @throws Error if sourceFiles JSON is invalid or no files can be read.
 */
export async function handleGenerateTechnicalDoc(
  repoPath: string,
  title: string,
  sourceFilesJson: string,
  audience?: DocumentAudience,
  style?: DocumentStyle,
  context?: string,
  glossaryJson?: string,
  outputDir?: string,
): Promise<GeneratedDocument> {
  // Parse source file paths
  let filePaths: string[];
  try {
    filePaths = JSON.parse(sourceFilesJson) as string[];
  } catch {
    throw new Error(
      `Invalid sourceFiles JSON. Expected an array of relative file paths, e.g. '["src/index.ts", "docs/notes.md"]'.`,
    );
  }

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('sourceFiles must be a non-empty JSON array of file paths.');
  }

  // Parse optional glossary
  let glossary: Record<string, string> | undefined;
  if (glossaryJson) {
    try {
      glossary = JSON.parse(glossaryJson) as Record<string, string>;
    } catch {
      throw new Error('Invalid glossary JSON. Expected an object of term→definition pairs.');
    }
  }

  // Resolve writing profile
  const resolvedAudience = audience ?? 'developer';
  const profile = WRITING_PROFILES.find((p) => p.id === resolvedAudience);
  if (!profile) {
    throw new Error(
      `Unknown audience "${resolvedAudience}". Valid audiences: ${WRITING_PROFILES.map((p) => p.id).join(', ')}`,
    );
  }

  // Read source files
  const sources: SourceFileContent[] = [];
  const skippedFiles: string[] = [];

  for (const relativePath of filePaths) {
    const absolutePath = path.resolve(repoPath, relativePath);

    try {
      const stat = await fs.stat(absolutePath);

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        skippedFiles.push(`${relativePath} (exceeds ${MAX_FILE_SIZE_BYTES / 1024}KB)`);
        continue;
      }

      const content = await fs.readFile(absolutePath, 'utf-8');
      const contentType = detectContentType(relativePath);

      sources.push({ relativePath, content, contentType });
    } catch {
      skippedFiles.push(`${relativePath} (not found or unreadable)`);
    }
  }

  if (sources.length === 0) {
    throw new Error(
      `No source files could be read. Skipped: ${skippedFiles.join(', ')}. ` +
        'Ensure paths are relative to the repository root.',
    );
  }

  // Build configuration
  const resolvedStyle: DocumentStyle = style ?? 'api-reference';
  const config: TechnicalDocConfig = {
    title,
    audience: resolvedAudience,
    style: resolvedStyle,
    sources,
    context: skippedFiles.length > 0
      ? `${context ?? ''}\n\n> **Note:** ${skippedFiles.length} file(s) were skipped: ${skippedFiles.join(', ')}`
      : context,
    glossary,
  };

  // Generate document
  const content = generateTechnicalDoc(config, profile);

  // Write output
  const targetDir = outputDir ?? path.join(repoPath, 'docs', 'technical');
  await fs.mkdir(targetDir, { recursive: true });
  const fileSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const outputPath = path.join(targetDir, `${fileSlug}.md`);
  await mergeOrWrite(outputPath, content);

  return { outputPath, content, documentType: 'technical-doc' };
}
