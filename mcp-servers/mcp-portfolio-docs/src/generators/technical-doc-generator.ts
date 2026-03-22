/**
 * @fileoverview Transforms raw source content into polished technical documentation.
 *
 * Core engine for the Technical Writer tool. It:
 * 1. Classifies each source file (code, markdown, config, notes)
 * 2. Extracts structured content (headings, code blocks, functions, comments)
 * 3. Organises content into audience-appropriate sections
 * 4. Applies tone and formatting rules from the writing profile
 * 5. Injects glossary definitions when provided
 *
 * @module generators/technical-doc-generator
 */

import type {
  DocumentStyle,
  SourceFileContent,
  TechnicalDocConfig,
  WritingProfile,
} from '../types/index.js';

/** Extension → content type mapping. */
const EXTENSION_TYPE_MAP: Record<string, SourceFileContent['contentType']> = {
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.java': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.sh': 'code',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.yaml': 'config',
  '.yml': 'config',
  '.json': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.env': 'config',
  '.txt': 'notes',
};

/** Style → introductory guidance for each document format. */
const STYLE_INTROS: Record<DocumentStyle, string> = {
  'api-reference':
    'This document provides a comprehensive API reference derived from the source code and engineering notes below.',
  'user-guide':
    'This guide walks you through the key features and usage patterns, based on the source material listed below.',
  'runbook-polished':
    'This operational runbook provides step-by-step procedures extracted and refined from the source files below.',
  'architecture-overview':
    'This document describes the system architecture, derived from the code structure and engineering specifications below.',
  tutorial:
    'This tutorial provides a hands-on walkthrough, built from the examples and documentation in the source files below.',
};

/**
 * Detects the content type of a file based on its extension.
 *
 * @param filePath - Relative file path.
 * @returns Detected content type.
 */
export function detectContentType(filePath: string): SourceFileContent['contentType'] {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_TYPE_MAP[ext] ?? 'notes';
}

/**
 * Extracts function/export signatures from TypeScript/JavaScript source.
 *
 * @param content - Raw file content.
 * @returns Array of extracted signatures.
 */
function extractSignatures(content: string): string[] {
  const signatures: string[] = [];
  const patterns = [
    /^export\s+(?:async\s+)?function\s+\w+[^{]*/gm,
    /^export\s+(?:const|let)\s+\w+\s*[=:][^;{]*/gm,
    /^export\s+(?:interface|type)\s+\w+[^{]*/gm,
    /^export\s+class\s+\w+[^{]*/gm,
  ];

  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) {
      signatures.push(...matches.map((m) => m.trim()));
    }
  }

  return signatures;
}

/**
 * Extracts JSDoc/TSDoc comment blocks from source code.
 *
 * @param content - Raw file content.
 * @returns Array of cleaned comment blocks.
 */
function extractDocComments(content: string): string[] {
  const comments: string[] = [];
  const docBlockPattern = /\/\*\*[\s\S]*?\*\//g;
  const matches = content.match(docBlockPattern);

  if (matches) {
    for (const block of matches) {
      const cleaned = block
        .replace(/\/\*\*\s*\n?/, '')
        .replace(/\s*\*\//, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim();
      if (cleaned.length > 10) {
        comments.push(cleaned);
      }
    }
  }

  return comments;
}

/**
 * Extracts markdown headings and their content from a markdown file.
 *
 * @param content - Raw markdown content.
 * @returns Array of heading→content pairs.
 */
function extractMarkdownSections(content: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = content.split('\n');
  let currentHeading = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = /^(#{1,4})\s+(.+)/.exec(line);
    if (headingMatch) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      }
      currentHeading = headingMatch[2];
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  }

  return sections;
}

/**
 * Extracts key-value pairs from config files (YAML/JSON/TOML).
 *
 * @param content - Raw config content.
 * @param filePath - File path for format detection.
 * @returns Array of key descriptions.
 */
function extractConfigKeys(content: string, filePath: string): string[] {
  const keys: string[] = [];

  if (filePath.endsWith('.json')) {
    const topLevelKeys = content.match(/"(\w+)"\s*:/g);
    if (topLevelKeys) {
      keys.push(...topLevelKeys.map((k) => k.replace(/[":\s]/g, '')));
    }
  } else {
    // YAML-like: extract top-level keys
    const yamlKeys = content.match(/^[a-zA-Z]\w*:/gm);
    if (yamlKeys) {
      keys.push(...yamlKeys.map((k) => k.replace(':', '')));
    }
  }

  return [...new Set(keys)].slice(0, 20);
}

/**
 * Generates a polished technical document from raw source files.
 *
 * @param config - Full document configuration.
 * @param profile - Writing profile for the target audience.
 * @returns Markdown string.
 */
export function generateTechnicalDoc(config: TechnicalDocConfig, profile: WritingProfile): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split('T')[0];

  // Header
  lines.push(`# ${config.title}`);
  lines.push('');
  lines.push(`**Date:** ${date}`);
  lines.push(`**Audience:** ${profile.label}`);
  lines.push(`**Style:** ${formatStyle(config.style)}`);
  lines.push('');

  // Table of contents
  const sections = profile.defaultSections;
  lines.push('## Table of Contents');
  lines.push('');
  for (const [idx, section] of sections.entries()) {
    const anchor = section.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    lines.push(`${idx + 1}. [${section}](#${anchor})`);
  }
  lines.push('');

  // Style-specific intro
  lines.push(`> ${STYLE_INTROS[config.style]}`);
  lines.push('');

  // Additional context
  if (config.context) {
    lines.push('> **Writer Context:** ' + config.context);
    lines.push('');
  }

  // Classify and process sources
  const codeSources = config.sources.filter((s) => s.contentType === 'code');
  const markdownSources = config.sources.filter((s) => s.contentType === 'markdown');
  const configSources = config.sources.filter((s) => s.contentType === 'config');
  const noteSources = config.sources.filter((s) => s.contentType === 'notes');

  // Generate each section based on the profile
  for (const sectionName of sections) {
    lines.push(`## ${sectionName}`);
    lines.push('');
    lines.push(...renderSection(sectionName, config, profile, codeSources, markdownSources, configSources, noteSources));
    lines.push('');
  }

  // Glossary
  if (config.glossary && Object.keys(config.glossary).length > 0) {
    lines.push('## Glossary');
    lines.push('');
    lines.push('| Term | Definition |');
    lines.push('|:---|:---|');
    const sortedTerms = Object.entries(config.glossary).sort(([a], [b]) => a.localeCompare(b));
    for (const [term, definition] of sortedTerms) {
      lines.push(`| **${term}** | ${definition} |`);
    }
    lines.push('');
  }

  // Source files listing
  lines.push('## Source Files');
  lines.push('');
  lines.push('> This document was generated from the following source files:');
  lines.push('');
  for (const source of config.sources) {
    lines.push(`- \`${source.relativePath}\` *(${source.contentType})*`);
  }
  lines.push('');

  // Writing profile metadata
  lines.push('---');
  lines.push('');
  lines.push(`*Generated by mcp-portfolio-docs — Technical Writer (${profile.label} profile).*`);

  return lines.join('\n');
}

/**
 * Renders content for a single section based on the audience profile.
 *
 * @param sectionName - The section heading.
 * @param config - Document configuration.
 * @param profile - Writing profile.
 * @param codeSources - Source files classified as code.
 * @param markdownSources - Source files classified as markdown.
 * @param configSources - Source files classified as config.
 * @param noteSources - Source files classified as notes.
 * @returns Array of markdown lines for the section.
 */
function renderSection(
  sectionName: string,
  config: TechnicalDocConfig,
  profile: WritingProfile,
  codeSources: readonly SourceFileContent[],
  markdownSources: readonly SourceFileContent[],
  configSources: readonly SourceFileContent[],
  noteSources: readonly SourceFileContent[],
): string[] {
  const content: string[] = [];
  const lower = sectionName.toLowerCase();

  // --- Overview / Executive Summary ---
  if (lower.includes('overview') || lower.includes('executive summary') || lower.includes('getting started')) {
    if (markdownSources.length > 0) {
      const firstMd = markdownSources[0];
      const mdSections = extractMarkdownSections(firstMd.content);
      const firstParagraph = mdSections.length > 0 ? mdSections[0].body.split('\n\n')[0] : '';
      if (firstParagraph) {
        content.push(firstParagraph);
        content.push('');
      }
    }

    if (codeSources.length > 0) {
      content.push(`This documentation covers **${codeSources.length}** source file(s) and **${markdownSources.length + noteSources.length}** documentation file(s).`);
      content.push('');
    }

    if (config.context) {
      content.push(config.context);
      content.push('');
    }

    if (content.length === 0) {
      content.push(`*Provide source files or context to populate this section.*`);
      content.push('');
    }
  }

  // --- API Reference / Type Definitions ---
  else if (lower.includes('api reference') || lower.includes('type definition')) {
    for (const source of codeSources) {
      const signatures = extractSignatures(source.content);
      if (signatures.length > 0) {
        content.push(`### From \`${source.relativePath}\``);
        content.push('');
        content.push('```typescript');
        content.push(signatures.join('\n\n'));
        content.push('```');
        content.push('');
      }
    }
    if (content.length === 0) {
      content.push('*No API signatures were extracted from the provided source files.*');
      content.push('');
    }
  }

  // --- Usage Examples / Step-by-Step Guide ---
  else if (lower.includes('usage example') || lower.includes('step-by-step') || lower.includes('tutorial')) {
    const docComments = codeSources.flatMap((s) => extractDocComments(s.content));
    const examples = docComments.filter((c) => c.includes('@example') || c.includes('Example'));

    if (examples.length > 0) {
      for (const [idx, example] of examples.entries()) {
        content.push(`### Example ${idx + 1}`);
        content.push('');
        content.push(example);
        content.push('');
      }
    } else {
      // Fall back to markdown examples
      for (const source of markdownSources) {
        const codeBlocks = source.content.match(/```[\s\S]*?```/g);
        if (codeBlocks) {
          content.push(`### From \`${source.relativePath}\``);
          content.push('');
          for (const block of codeBlocks.slice(0, 4)) {
            content.push(block);
            content.push('');
          }
        }
      }
    }

    if (content.length === 0) {
      content.push('*No usage examples were found in the source files. Consider adding `@example` JSDoc tags to your code.*');
      content.push('');
    }
  }

  // --- Prerequisites / What You Will Need ---
  else if (lower.includes('prerequisit') || lower.includes('what you will need')) {
    // Extract from markdown prerequisites sections
    for (const source of markdownSources) {
      const mdSections = extractMarkdownSections(source.content);
      const prereqSection = mdSections.find((s) =>
        s.heading.toLowerCase().includes('prerequisit') || s.heading.toLowerCase().includes('requirement'),
      );
      if (prereqSection) {
        content.push(prereqSection.body);
        content.push('');
      }
    }

    // Extract package dependencies from config
    for (const source of configSources) {
      if (source.relativePath.includes('package.json')) {
        const keys = extractConfigKeys(source.content, source.relativePath);
        if (keys.includes('dependencies')) {
          content.push('### Dependencies');
          content.push('');
          content.push(`See \`${source.relativePath}\` for the full dependency list.`);
          content.push('');
        }
      }
    }

    if (content.length === 0) {
      content.push('*No prerequisites detected. Add a "Prerequisites" section to your source markdown files.*');
      content.push('');
    }
  }

  // --- Configuration / Configuration Reference ---
  else if (lower.includes('configuration') || lower.includes('config')) {
    for (const source of configSources) {
      const keys = extractConfigKeys(source.content, source.relativePath);
      if (keys.length > 0) {
        content.push(`### \`${source.relativePath}\``);
        content.push('');
        content.push('| Key | Description |');
        content.push('|:---|:---|');
        for (const key of keys) {
          content.push(`| \`${key}\` | *Extracted from config — add description* |`);
        }
        content.push('');
      }
    }
    if (content.length === 0) {
      content.push('*No configuration files were provided.*');
      content.push('');
    }
  }

  // --- Error Handling / Troubleshooting ---
  else if (lower.includes('error') || lower.includes('troubleshoot')) {
    const errorComments = codeSources.flatMap((s) => extractDocComments(s.content));
    const throwsBlocks = errorComments.filter((c) => c.includes('@throws') || c.includes('Error'));

    if (throwsBlocks.length > 0) {
      for (const block of throwsBlocks.slice(0, 6)) {
        content.push(`- ${block.split('\n')[0]}`);
      }
      content.push('');
    }

    // Check markdown for troubleshooting sections
    for (const source of markdownSources) {
      const mdSections = extractMarkdownSections(source.content);
      const troubleSection = mdSections.find((s) =>
        s.heading.toLowerCase().includes('troubleshoot') || s.heading.toLowerCase().includes('error'),
      );
      if (troubleSection) {
        content.push(troubleSection.body);
        content.push('');
      }
    }

    if (content.length === 0) {
      content.push('*No error handling documentation found. Consider adding `@throws` tags to your code.*');
      content.push('');
    }
  }

  // --- Procedure / Verification / Rollback ---
  else if (lower.includes('procedure') || lower.includes('verification') || lower.includes('rollback')) {
    for (const source of markdownSources) {
      const mdSections = extractMarkdownSections(source.content);
      const matched = mdSections.find((s) => s.heading.toLowerCase().includes(lower));
      if (matched) {
        content.push(matched.body);
        content.push('');
      }
    }

    // Look for shell commands in notes
    for (const source of noteSources) {
      const shellCommands = source.content.match(/^\$\s+.+$/gm) ?? source.content.match(/^>\s+.+$/gm);
      if (shellCommands) {
        content.push('```bash');
        content.push(shellCommands.slice(0, 8).join('\n'));
        content.push('```');
        content.push('');
      }
    }

    if (content.length === 0) {
      content.push(`*No ${lower} content was found in the source files.*`);
      content.push('');
    }
  }

  // --- Business Impact / Cost / Key Decisions / Risks ---
  else if (
    lower.includes('business impact') ||
    lower.includes('cost') ||
    lower.includes('key decision') ||
    lower.includes('risk') ||
    lower.includes('timeline') ||
    lower.includes('next step')
  ) {
    for (const source of [...markdownSources, ...noteSources]) {
      const mdSections = extractMarkdownSections(source.content);
      const matched = mdSections.filter(
        (s) =>
          s.heading.toLowerCase().includes(lower.split(' ')[0]) ||
          s.heading.toLowerCase().includes(lower),
      );
      for (const section of matched) {
        content.push(section.body);
        content.push('');
      }
    }

    if (content.length === 0) {
      content.push(`*No ${sectionName.toLowerCase()} content was found. Provide relevant source files or context.*`);
      content.push('');
    }
  }

  // --- FAQ ---
  else if (lower.includes('faq')) {
    content.push('*No FAQ content has been extracted. Add questions and answers to your source documentation.*');
    content.push('');
  }

  // --- Tips & Best Practices ---
  else if (lower.includes('tip') || lower.includes('best practice')) {
    const docComments = codeSources.flatMap((s) => extractDocComments(s.content));
    const remarks = docComments.filter((c) => c.includes('@remarks') || c.includes('Note:') || c.includes('TIP:'));

    for (const remark of remarks.slice(0, 6)) {
      content.push(`> 💡 ${remark.split('\n')[0]}`);
      content.push('');
    }

    if (content.length === 0) {
      content.push('*No tips or best practices were extracted. Add `@remarks` JSDoc tags for tips.*');
      content.push('');
    }
  }

  // --- Catch-all for unmatched sections ---
  else {
    // Search all markdown sources for a matching heading
    for (const source of [...markdownSources, ...noteSources]) {
      const mdSections = extractMarkdownSections(source.content);
      const matched = mdSections.find((s) =>
        s.heading.toLowerCase().includes(lower) || lower.includes(s.heading.toLowerCase()),
      );
      if (matched) {
        content.push(matched.body);
        content.push('');
      }
    }

    if (content.length === 0) {
      content.push(`*Content for "${sectionName}" will be populated from your source files. Ensure relevant headings exist in your source markdown.*`);
      content.push('');
    }
  }

  // Append profile formatting rules as HTML comment guidance
  if (profile.formattingRules.length > 0 && content.some((l) => l.includes('*No ') || l.includes('will be populated'))) {
    content.push('<!-- FORMATTING GUIDANCE:');
    for (const rule of profile.formattingRules) {
      content.push(`  - ${rule}`);
    }
    content.push('-->');
    content.push('');
  }

  return content;
}

/**
 * Formats a document style enum value for display.
 *
 * @param style - The style type.
 * @returns Human-readable label.
 */
function formatStyle(style: DocumentStyle): string {
  const labels: Record<DocumentStyle, string> = {
    'api-reference': 'API Reference',
    'user-guide': 'User Guide',
    'runbook-polished': 'Polished Runbook',
    'architecture-overview': 'Architecture Overview',
    tutorial: 'Tutorial',
  };
  return labels[style];
}
