#!/usr/bin/env node
/**
 * @fileoverview MCP server entry point for portfolio documentation generation.
 *
 * Registers 8 tools via stdio transport:
 * - analyse-portfolio (full pipeline: scan → skills → coverage → document)
 * - scan-repo (dry-run scan returning JSON)
 * - list-skills (taxonomy viewer)
 * - generate-adr (Architecture Decision Records)
 * - generate-runbook (solo-operator runbooks)
 * - generate-cost-breakdown (resource cost analysis)
 * - generate-decision-analysis (weighted decision analysis)
 * - generate-technical-doc (raw-to-polished technical documentation)
 *
 * @module index
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  AnalysePortfolioSchema,
  ScanRepoSchema,
  ListSkillsSchema,
  GenerateAdrSchema,
  GenerateRunbookSchema,
  GenerateCostBreakdownSchema,
  GenerateDecisionAnalysisSchema,
  GenerateTechnicalDocSchema,
} from './schemas/tool-params.js';

import { handleAnalysePortfolio } from './tools/analyse-portfolio.js';
import { handleScanRepo } from './tools/scan-repo.js';
import { handleListSkills } from './tools/list-skills.js';
import { handleGenerateAdr } from './tools/generate-adr.js';
import { handleGenerateRunbook } from './tools/generate-runbook.js';
import { handleGenerateCostBreakdown } from './tools/generate-cost-breakdown.js';
import { handleGenerateDecisionAnalysis } from './tools/generate-decision-analysis.js';
import { handleGenerateTechnicalDoc } from './tools/generate-technical-doc.js';

/**
 * Creates and configures the MCP server with all 8 tools.
 *
 * @returns Configured McpServer instance.
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-portfolio-docs',
    version: '1.0.0',
  });

  // --- Tool 1: analyse-portfolio ---
  server.tool(
    'analyse-portfolio',
    'Analyse the repository and generate portfolio documentation. Full repo scan produces a skills overview; scoped scan produces a feature article.',
    AnalysePortfolioSchema,
    async ({ repoPath, scope, outputDir }) => {
      try {
        const result = await handleAnalysePortfolio(repoPath, scope, outputDir);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'success',
                  mode: scope ? `scoped (${scope})` : 'full-repo',
                  skillsDetected: result.detectedSkills.length,
                  coveragePercent: result.coverage.overallCoveragePercent,
                  outputPath: result.outputPath,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 2: scan-repo ---
  server.tool(
    'scan-repo',
    'Dry-run scan of the repository. Returns detected skills and evidence as JSON without writing files.',
    ScanRepoSchema,
    async ({ repoPath, scope }) => {
      try {
        const result = await handleScanRepo(repoPath, scope);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 3: list-skills ---
  server.tool(
    'list-skills',
    'List the skills taxonomy, available scopes, ADR topics, and runbook scenarios.',
    ListSkillsSchema,
    async ({ category }) => {
      try {
        const result = handleListSkills(category);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 4: generate-adr ---
  server.tool(
    'generate-adr',
    'Generate an Architecture Decision Record (ADR) with evidence from the repository.',
    GenerateAdrSchema,
    async ({ repoPath, decision, outputDir }) => {
      try {
        const result = await handleGenerateAdr(repoPath, decision, outputDir);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { status: 'success', documentType: result.documentType, outputPath: result.outputPath },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 5: generate-runbook ---
  server.tool(
    'generate-runbook',
    'Generate a solo-operator runbook for an incident scenario, with evidence from the repository.',
    GenerateRunbookSchema,
    async ({ repoPath, scenario, outputDir }) => {
      try {
        const result = await handleGenerateRunbook(repoPath, scenario, outputDir);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { status: 'success', documentType: result.documentType, outputPath: result.outputPath },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 6: generate-cost-breakdown ---
  server.tool(
    'generate-cost-breakdown',
    'Generate a cost breakdown document from CDK resource evidence. Optionally accepts pricing data from the aws-pricing MCP server.',
    GenerateCostBreakdownSchema,
    async ({ repoPath, monthlyBudget, pricingData, outputDir }) => {
      try {
        const result = await handleGenerateCostBreakdown(repoPath, monthlyBudget, pricingData, outputDir);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { status: 'success', documentType: result.documentType, outputPath: result.outputPath },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 7: generate-decision-analysis ---
  server.tool(
    'generate-decision-analysis',
    'Evaluate options systematically using weighted criteria, pros/cons analysis, risk assessment, and short-term/long-term impact. Returns a structured decision document with a clear recommendation.',
    GenerateDecisionAnalysisSchema,
    async ({ repoPath, decision, options, criteria, framework, outputDir }) => {
      try {
        const result = await handleGenerateDecisionAnalysis(
          repoPath,
          decision,
          options,
          criteria,
          framework,
          outputDir,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { status: 'success', documentType: result.documentType, outputPath: result.outputPath },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Tool 8: generate-technical-doc ---
  server.tool(
    'generate-technical-doc',
    'Transform raw inputs (code, markdown, engineering notes) into polished technical documentation. Adapts tone, detail level, and structure to the target audience (developer, operator, stakeholder, end-user).',
    GenerateTechnicalDocSchema,
    async ({ repoPath, title, sourceFiles, audience, style, context, glossary, outputDir }) => {
      try {
        const result = await handleGenerateTechnicalDoc(
          repoPath,
          title,
          sourceFiles,
          audience,
          style,
          context,
          glossary,
          outputDir,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { status: 'success', documentType: result.documentType, outputPath: result.outputPath },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/**
 * Main entry point — creates the MCP server and connects via stdio.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('mcp-portfolio-docs server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
