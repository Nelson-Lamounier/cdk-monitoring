#!/usr/bin/env npx tsx
/**
 * Drift Detection Script
 *
 * Runs `cdk diff` for all stacks in a project and writes the results
 * to $GITHUB_STEP_SUMMARY. Informational only — never blocks deployment.
 *
 * Usage:
 *   npx tsx scripts/deployment/drift-detection.ts monitoring staging --region eu-west-1
 *   npx tsx scripts/deployment/drift-detection.ts nextjs production --region eu-west-1
 *
 * Exit codes:
 *   0 = always (informational — does not block)
 */

import { appendFileSync } from 'fs';

import { buildCdkArgs, runCdk } from './exec.js';
import logger from './logger.js';
import {
  getProject,
  type Environment,
} from './stacks.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const projectId = args[0];
const environment = args[1] as Environment;
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');

if (!projectId || !environment) {
  console.error('Usage: drift-detection.ts <project> <environment> [--region <region>]');
  process.exit(1);
}

const project = getProject(projectId);
if (!project) {
  console.error(`Unknown project: ${projectId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DiffResult {
  stackName: string;
  displayName: string;
  status: 'no-changes' | 'changes' | 'new-stack' | 'error';
  output: string;
}

// ---------------------------------------------------------------------------
// Run cdk diff for a single stack
// ---------------------------------------------------------------------------
async function diffStack(stackName: string, displayName: string): Promise<DiffResult> {
  const cdkArgs = buildCdkArgs({
    command: 'diff',
    stackNames: [stackName],
    context: {
      env: environment,
      region,
      account: process.env.AWS_ACCOUNT_ID ?? '',
    },
  });

  const result = await runCdk(cdkArgs, { captureOutput: true });
  const combined = (result.stdout + '\n' + result.stderr).trim();

  // Exit code 0 = no differences
  if (result.exitCode === 0) {
    return { stackName, displayName, status: 'no-changes', output: combined };
  }

  // Exit code 1 = differences found (normal cdk diff behavior)
  if (result.exitCode === 1) {
    // Check if it's a new stack that hasn't been deployed yet
    if (combined.includes('has not been deployed') || combined.includes('does not exist')) {
      return { stackName, displayName, status: 'new-stack', output: combined };
    }
    return { stackName, displayName, status: 'changes', output: combined };
  }

  // Any other exit code = error
  return { stackName, displayName, status: 'error', output: combined };
}

// ---------------------------------------------------------------------------
// Build step summary markdown
// ---------------------------------------------------------------------------
function buildSummary(results: DiffResult[]): string {
  const lines: string[] = [
    '## 🔍 Infrastructure Drift Detection',
    '',
    `**Project**: ${project!.name}`,
    `**Environment**: ${environment}`,
    '',
  ];

  for (const result of results) {
    lines.push(`### \`${result.stackName}\``);
    lines.push('');

    switch (result.status) {
      case 'no-changes':
        lines.push('✅ No changes detected');
        break;

      case 'new-stack':
        lines.push('🆕 Stack has not been deployed yet');
        break;

      case 'changes':
        lines.push('<details>');
        lines.push('<summary>⚠️ Changes detected (click to expand)</summary>');
        lines.push('');
        lines.push('```diff');
        lines.push(result.output);
        lines.push('```');
        lines.push('</details>');
        break;

      case 'error':
        lines.push('❌ Diff failed');
        lines.push('');
        lines.push('```');
        lines.push(result.output);
        lines.push('```');
        break;
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Set GitHub Actions output
// ---------------------------------------------------------------------------
function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.setEnvironment(environment);
  logger.header(`Drift Detection — ${project!.name} (${environment})`);

  const stacks = project!.stacks;
  logger.info(`Running cdk diff for ${stacks.length} stack(s)...`);

  // Run diff for all stacks sequentially (CDK requires sequential execution)
  const results: DiffResult[] = [];
  for (const stack of stacks) {
    const stackName = stack.getStackName(environment);
    logger.info(`Diffing ${stack.name} (${stackName})...`);
    const result = await diffStack(stackName, stack.name);
    results.push(result);

    // Log inline result
    switch (result.status) {
      case 'no-changes':
        logger.success(`${stack.name}: No changes`);
        break;
      case 'changes':
        logger.warn(`${stack.name}: Changes detected`);
        break;
      case 'new-stack':
        logger.info(`${stack.name}: New stack (not yet deployed)`);
        break;
      case 'error':
        logger.warn(`${stack.name}: Diff failed`);
        break;
    }
  }

  // Build and write summary
  const summary = buildSummary(results);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, summary);
    logger.success('Wrote drift detection summary to $GITHUB_STEP_SUMMARY');
  } else {
    // Local mode — print to console
    console.log(summary);
  }

  // Set outputs
  const hasChanges = results.some((r) => r.status === 'changes');
  const hasErrors = results.some((r) => r.status === 'error');
  setOutput('has_changes', String(hasChanges));

  if (hasChanges) {
    // GitHub Actions annotation
    if (process.env.GITHUB_ACTIONS) {
      console.log('::notice::Infrastructure changes detected — review the step summary before approving deployment');
    }
    logger.warn('Infrastructure changes detected');
  }

  if (hasErrors) {
    if (process.env.GITHUB_ACTIONS) {
      console.log('::warning::Some stacks could not be diffed (new stacks or permission issues)');
    }
  }

  // Summary line
  const counts = {
    noChanges: results.filter((r) => r.status === 'no-changes').length,
    changes: results.filter((r) => r.status === 'changes').length,
    newStacks: results.filter((r) => r.status === 'new-stack').length,
    errors: results.filter((r) => r.status === 'error').length,
  };

  logger.blank();
  logger.info(
    `Results: ${counts.noChanges} unchanged, ${counts.changes} changed, ${counts.newStacks} new, ${counts.errors} errors`
  );

  // Always exit 0 — drift detection is informational
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  // Still exit 0 — drift detection should never block deployment
});
