/**
 * @fileoverview Zod schemas for all MCP tool input parameters.
 *
 * Each schema validates and documents the input for a specific tool.
 *
 * @module schemas/tool-params
 */

import { z } from 'zod';

/** Parameters for the `analyse-portfolio` tool. */
export const AnalysePortfolioSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  scope: z
    .string()
    .optional()
    .describe(
      'Optional scope for targeted analysis (e.g. "crossplane", "finops", "networking"). Omit for full repo scan.',
    ),
  outputDir: z
    .string()
    .optional()
    .describe('Optional output directory override. Defaults to docs/ or articles-draft/ based on mode.'),
};

/** Parameters for the `scan-repo` tool. */
export const ScanRepoSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  scope: z
    .string()
    .optional()
    .describe('Optional scope to limit scanning (e.g. "crossplane", "ci-cd")'),
};

/** Parameters for the `list-skills` tool. */
export const ListSkillsSchema = {
  category: z
    .string()
    .optional()
    .describe('Optional category ID to filter (e.g. "infrastructure-as-code"). Omit for all categories.'),
};

/** Parameters for the `generate-adr` tool. */
export const GenerateAdrSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  decision: z
    .string()
    .describe(
      'ADR decision ID (e.g. "self-managed-k8s-vs-eks", "cdk-over-terraform"). Use list-skills to see available topics.',
    ),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory override. Defaults to docs/adrs/.'),
};

/** Parameters for the `generate-runbook` tool. */
export const GenerateRunbookSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  scenario: z
    .string()
    .describe(
      'Runbook scenario ID (e.g. "instance-terminated", "pod-crashloop"). Use list-skills to see available scenarios.',
    ),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory override. Defaults to docs/runbooks/.'),
};

/** Parameters for the `generate-cost-breakdown` tool. */
export const GenerateCostBreakdownSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  monthlyBudget: z
    .number()
    .optional()
    .describe('Optional monthly budget in GBP for trade-off analysis'),
  pricingData: z
    .string()
    .optional()
    .describe('Optional JSON pricing data from the aws-pricing MCP server'),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory override. Defaults to docs/cost/.'),
};

/** Parameters for the `generate-decision-analysis` tool. */
export const GenerateDecisionAnalysisSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  decision: z
    .string()
    .describe(
      'Decision template ID (e.g. "hosting-platform", "iac-tool") or a free-form decision title for ad-hoc analysis.',
    ),
  options: z
    .string()
    .optional()
    .describe(
      'Optional JSON array of custom options. Each option: { id, name, description, prosAndCons: { pros: [], cons: [] }, scores: {}, risks: [], shortTermScore, longTermScore }. Overrides template options.',
    ),
  criteria: z
    .string()
    .optional()
    .describe(
      'Optional JSON array of custom criteria. Each criterion: { name, weight, description }. Weights should sum to 1. Overrides template criteria.',
    ),
  framework: z
    .enum(['weighted-matrix', 'pros-cons', 'risk-matrix'])
    .optional()
    .describe('Analysis framework to use. Defaults to "weighted-matrix".'),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory override. Defaults to docs/decisions/.'),
};

/** Parameters for the `generate-technical-doc` tool. */
export const GenerateTechnicalDocSchema = {
  repoPath: z.string().describe('Absolute path to the repository root'),
  title: z
    .string()
    .describe('Title for the generated document (e.g. "API Gateway Configuration Guide").'),
  sourceFiles: z
    .string()
    .describe(
      'JSON array of relative file paths to read as raw input (e.g. \'["src/index.ts", "docs/notes.md"]\').',
    ),
  audience: z
    .enum(['developer', 'operator', 'stakeholder', 'end-user'])
    .optional()
    .describe('Target audience. Adapts tone, detail level, and jargon. Defaults to "developer".'),
  style: z
    .enum(['api-reference', 'user-guide', 'runbook-polished', 'architecture-overview', 'tutorial'])
    .optional()
    .describe('Document style/format. Defaults to "api-reference".'),
  context: z
    .string()
    .optional()
    .describe('Additional context or instructions to guide the writer (e.g. "Focus on the authentication flow").'),
  glossary: z
    .string()
    .optional()
    .describe('Optional JSON object of term→definition pairs to include as a glossary section.'),
  outputDir: z
    .string()
    .optional()
    .describe('Output directory override. Defaults to docs/technical/.'),
};
