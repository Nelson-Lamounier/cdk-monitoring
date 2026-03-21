/**
 * @fileoverview Document merger utility — update-not-replace file writing.
 *
 * When generating documentation, if an output file already exists this utility
 * merges the new content into the existing document at the H2 heading level:
 *
 * - **Generated sections** (present in both old and new) are refreshed.
 * - **Hand-written sections** (present only in old) are preserved.
 * - **New sections** (present only in new) are appended.
 *
 * A `<!-- Last updated: ISO timestamp -->` comment is added/refreshed at the top.
 *
 * @module utils/document-merger
 */

import fs from 'node:fs/promises';

/** Regex to match H2 headings in markdown. */
const H2_REGEX = /^## .+$/;

/** Regex to match the auto-generated timestamp comment. */
const TIMESTAMP_REGEX = /^<!--\s*Last updated:.*-->$/;

/**
 * Represents a parsed section of a markdown document.
 *
 * Each section starts with an H2 heading and includes all content
 * up to (but not including) the next H2 heading.
 */
interface MarkdownSection {
  /** The H2 heading text (e.g. `## Summary`). */
  readonly heading: string;
  /** Full content of the section including the heading. */
  readonly content: string;
}

/**
 * Parses markdown content into a preamble (content before the first H2)
 * and an ordered list of H2-level sections.
 *
 * @param content - Raw markdown string.
 * @returns Parsed preamble and sections.
 */
function parseIntoSections(content: string): {
  preamble: string;
  sections: MarkdownSection[];
} {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  const preambleLines: string[] = [];
  let currentHeading: string | undefined;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (H2_REGEX.test(line)) {
      // Flush previous section
      if (currentHeading !== undefined) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join('\n'),
        });
      }
      currentHeading = line;
      currentLines = [line];
    } else if (currentHeading !== undefined) {
      currentLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  // Flush the last section
  if (currentHeading !== undefined) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join('\n'),
    });
  }

  return {
    preamble: preambleLines.join('\n'),
    sections,
  };
}

/**
 * Refreshes or inserts a `<!-- Last updated: ... -->` timestamp in a preamble.
 *
 * @param preamble - Existing preamble content.
 * @returns Updated preamble with current timestamp.
 */
function refreshTimestamp(preamble: string): string {
  const timestamp = `<!-- Last updated: ${new Date().toISOString()} -->`;
  const lines = preamble.split('\n');

  // Replace existing timestamp or prepend
  const timestampIndex = lines.findIndex((line) => TIMESTAMP_REGEX.test(line.trim()));
  if (timestampIndex >= 0) {
    lines[timestampIndex] = timestamp;
  } else {
    lines.unshift(timestamp);
  }

  return lines.join('\n');
}

/**
 * Merges new markdown content into an existing document.
 *
 * Preserves hand-written sections from the existing document while
 * refreshing generated sections with new content. Sections are identified
 * by their H2 headings.
 *
 * @param existingContent - Content of the existing file.
 * @param newContent - Newly generated content.
 * @returns Merged markdown string.
 */
export function mergeDocuments(
  existingContent: string,
  newContent: string,
): string {
  const existing = parseIntoSections(existingContent);
  const updated = parseIntoSections(newContent);

  // Build a map of new sections by heading
  const newSectionMap = new Map<string, MarkdownSection>();
  for (const section of updated.sections) {
    newSectionMap.set(section.heading, section);
  }

  // Track which new sections have been consumed
  const consumedHeadings = new Set<string>();

  // Start with the new preamble (refreshed timestamp + title)
  const mergedPreamble = refreshTimestamp(updated.preamble || existing.preamble);
  const mergedSections: string[] = [mergedPreamble];

  // 1. Walk through existing sections in order
  for (const existingSection of existing.sections) {
    const replacement = newSectionMap.get(existingSection.heading);
    if (replacement) {
      // Generated section → refresh with new content
      mergedSections.push(replacement.content);
      consumedHeadings.add(existingSection.heading);
    } else {
      // Hand-written section → preserve as-is
      mergedSections.push(existingSection.content);
    }
  }

  // 2. Append any new sections not present in the existing document
  for (const newSection of updated.sections) {
    if (!consumedHeadings.has(newSection.heading)) {
      mergedSections.push(newSection.content);
    }
  }

  return mergedSections.join('\n');
}

/**
 * Writes content to a file, merging with existing content if the file exists.
 *
 * This is the primary API for all generators. It replaces direct `fs.writeFile`
 * calls to ensure documentation is updated rather than overwritten.
 *
 * @param outputPath - Absolute path to the output file.
 * @param newContent - Newly generated markdown content.
 */
export async function mergeOrWrite(
  outputPath: string,
  newContent: string,
): Promise<void> {
  let existingContent: string | undefined;

  try {
    existingContent = await fs.readFile(outputPath, 'utf-8');
  } catch {
    // File does not exist — will create new
  }

  if (existingContent) {
    const merged = mergeDocuments(existingContent, newContent);
    await fs.writeFile(outputPath, merged, 'utf-8');
  } else {
    await fs.writeFile(outputPath, newContent, 'utf-8');
  }
}
