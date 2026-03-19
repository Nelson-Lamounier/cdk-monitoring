/**
 * @fileoverview Audience-specific writing profiles for the Technical Writer tool.
 *
 * Each profile configures tone, detail level, jargon tolerance, default
 * section ordering, and formatting rules. The generator selects a profile
 * based on the `audience` parameter and adapts its output accordingly.
 *
 * @module data/writing-profiles
 */

import type { WritingProfile } from '../types/index.js';

/**
 * Pre-configured writing profiles for 4 target audiences.
 *
 * @remarks
 * Profiles are ordered by decreasing technical depth.
 */
export const WRITING_PROFILES: readonly WritingProfile[] = [
  {
    id: 'developer',
    label: 'Developer',
    tone: 'Technical and direct. Use precise terminology, show type signatures, and include code examples. Assume the reader writes code daily.',
    detailLevel: 'high',
    jargonTolerance: 'full',
    defaultSections: [
      'Overview',
      'Prerequisites',
      'API Reference',
      'Type Definitions',
      'Usage Examples',
      'Error Handling',
      'Configuration',
      'Source Files',
    ],
    formattingRules: [
      'Use fenced code blocks with language tags for all code',
      'Show function signatures with full type annotations',
      'Include inline code for variable names, types, and file paths',
      'Use tables for parameter/option listings',
      'Add JSDoc-style comments in code examples',
    ],
  },
  {
    id: 'operator',
    label: 'Operator / SRE',
    tone: 'Procedural and clear. Focus on actionable steps, commands, and verification. Assume the reader manages infrastructure.',
    detailLevel: 'medium',
    jargonTolerance: 'moderate',
    defaultSections: [
      'Overview',
      'Prerequisites',
      'Procedure',
      'Verification',
      'Rollback',
      'Troubleshooting',
      'Configuration Reference',
    ],
    formattingRules: [
      'Use numbered lists for sequential procedures',
      'Show shell commands in fenced code blocks with `bash` tag',
      'Highlight warnings and cautions with blockquote callouts',
      'Include expected output after each command',
      'Use tables for environment variables and config options',
    ],
  },
  {
    id: 'stakeholder',
    label: 'Stakeholder / Manager',
    tone: 'Business-friendly and outcome-focused. Emphasise impact, cost, and timelines. Define any technical terms used.',
    detailLevel: 'low',
    jargonTolerance: 'minimal',
    defaultSections: [
      'Executive Summary',
      'Business Impact',
      'Key Decisions',
      'Timeline & Milestones',
      'Cost Implications',
      'Risks & Mitigations',
      'Next Steps',
    ],
    formattingRules: [
      'Lead with outcomes and business value',
      'Use bullet points for key takeaways',
      'Define technical terms in parentheses on first use',
      'Include summary tables for comparisons',
      'Avoid code blocks — describe behaviour in plain English',
      'Use bold for key metrics and dates',
    ],
  },
  {
    id: 'end-user',
    label: 'End User',
    tone: 'Friendly, supportive, and patient. Provide step-by-step guidance with screenshots placeholders. Assume no technical background.',
    detailLevel: 'medium',
    jargonTolerance: 'none',
    defaultSections: [
      'Getting Started',
      'What You Will Need',
      'Step-by-Step Guide',
      'Tips & Best Practices',
      'Troubleshooting',
      'FAQ',
    ],
    formattingRules: [
      'Use numbered lists for every walkthrough',
      'Add screenshot placeholders with <!-- IMAGE: description -->',
      'Use simple language — avoid acronyms unless defined',
      'Include "What to expect" callouts before each step',
      'Use blockquotes for tips and helpful hints',
      'Keep paragraphs short — 2-3 sentences maximum',
    ],
  },
] as const;
