#!/usr/bin/env npx tsx
/**
 * Deploy Summary Script (per-stack)
 *
 * Generates a GitHub Actions step summary for a single CDK stack deployment.
 * This replaces the inline bash step in deploy-cdk-stack/action.yml.
 *
 * Usage:
 *   npx tsx scripts/deployment/deploy-summary.ts <stack-name> \
 *     --environment <env> --region <region> --account-id <id> \
 *     --deploy-status <status> [--deploy-duration <seconds>] \
 *     [--outputs-file <path>]
 *
 * Writes formatted markdown to $GITHUB_STEP_SUMMARY.
 *
 * Exit codes:
 *   0 = always (summary is informational, never block the pipeline)
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';

import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const stackName = args[0];

function getArg(flag: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] ?? '' : '';
}

const environment = getArg('--environment');
const region = getArg('--region');
const accountId = getArg('--account-id');
const deployStatus = getArg('--deploy-status');
const deployDuration = getArg('--deploy-duration');
const outputsFilePath = getArg('--outputs-file');

if (!stackName) {
  console.error('Usage: deploy-summary.ts <stack-name> --environment <env> --region <region> ...');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CDK_OUTPUTS_FILE = '/tmp/cdk-outputs/stack-outputs.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask all but last 4 chars of account ID */
function maskAccountId(id: string): string {
  if (id.length <= 4) return id;
  return `***${id.slice(-4)}`;
}

/** Read stack outputs from the CDK outputs file */
function readStackOutputs(): Array<{ key: string; value: string }> {
  if (!existsSync(CDK_OUTPUTS_FILE)) return [];

  try {
    const raw = readFileSync(CDK_OUTPUTS_FILE, 'utf-8');
    const allOutputs: Record<string, Record<string, string>> = JSON.parse(raw);
    const stackOutputs = allOutputs[stackName];
    if (!stackOutputs || Object.keys(stackOutputs).length === 0) return [];
    return Object.entries(stackOutputs).map(([key, value]) => ({
      key,
      value: String(value),
    }));
  } catch {
    return [];
  }
}

/** Write content to $GITHUB_STEP_SUMMARY */
function writeSummary(content: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, content);
  } else {
    // Local mode — print to stdout
    console.log(content);
  }
}

// ---------------------------------------------------------------------------
// Build summary
// ---------------------------------------------------------------------------
function buildSummary(): string {
  const lines: string[] = [];

  // Header
  lines.push('## CDK Stack Deployment');
  lines.push('');
  lines.push(`**Stack**: \`${stackName}\``);
  lines.push(`**Environment**: ${environment}`);
  lines.push(`**Region**: ${region}`);
  lines.push(`**Account**: \`${maskAccountId(accountId)}\``);
  lines.push('');

  if (deployStatus === 'success') {
    lines.push('### Status: ✓ Success');
    lines.push('');
    if (deployDuration) {
      lines.push(`Deployment completed in ${deployDuration}s`);
    } else {
      lines.push('Deployment completed successfully');
    }

    // Stack outputs
    const outputs = readStackOutputs();
    if (outputs.length > 0) {
      lines.push('');
      lines.push('### Stack Outputs');
      lines.push('');
      for (const o of outputs) {
        lines.push(`- **${o.key}**: \`${o.value}\``);
      }
    }

    // Outputs file location
    if (outputsFilePath) {
      lines.push('');
      lines.push(`Outputs saved to: \`${outputsFilePath}\``);
    }
  } else {
    lines.push('### Status: ✗ Failed');
    lines.push('');
    if (deployDuration) {
      lines.push(`Deployment failed after ${deployDuration}s`);
    } else {
      lines.push('Deployment failed');
    }
    lines.push('');
    lines.push('Check deployment logs for details.');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  logger.header(`Deploy Summary — ${stackName}`);

  const summary = buildSummary();
  writeSummary(summary);

  logger.success('Wrote deployment summary to $GITHUB_STEP_SUMMARY');
}

main();
