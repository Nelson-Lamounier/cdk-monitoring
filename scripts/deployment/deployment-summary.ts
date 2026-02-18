#!/usr/bin/env npx tsx
/**
 * Deployment Summary Script
 *
 * Generates a GitHub Actions step summary for monitoring deployments.
 * Reads deployment results from environment variables and writes
 * formatted markdown to $GITHUB_STEP_SUMMARY.
 *
 * Usage:
 *   npx tsx scripts/deployment/deployment-summary.ts monitoring development
 *
 * Environment variables read (set by GitHub Actions `needs` context):
 *   DEPLOY_<STACK_ID>_RESULT  - 'success', 'failure', 'skipped', 'cancelled'
 *   SECURITY_SCAN_RESULT     - security scan result
 *   VERIFY_RESULT            - post-deploy verification result
 *   SMOKE_TESTS_RESULT       - smoke tests result
 *   COMMIT_SHORT_SHA         - short commit SHA
 */

import { appendFileSync } from 'fs';

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
const awsRegion = process.env.AWS_REGION ?? 'eu-west-1';

if (!projectId || !environment) {
  console.error('Usage: deployment-summary.ts <project> <environment>');
  process.exit(1);
}

const project = getProject(projectId);
if (!project) {
  console.error(`Unknown project: ${projectId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helper: read deployment result from environment
// ---------------------------------------------------------------------------
function getResult(key: string, fallback = 'skipped'): string {
  return process.env[key] ?? fallback;
}

function resultEmoji(result: string): string {
  switch (result) {
    case 'success':
      return '✅';
    case 'failure':
      return '❌';
    case 'skipped':
      return '⏭️';
    case 'cancelled':
      return '🚫';
    default:
      return '❓';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  logger.setEnvironment(environment);
  const commitSha = process.env.COMMIT_SHORT_SHA ?? process.env.GITHUB_SHA?.slice(0, 8) ?? 'unknown';

  // Build stack results table
  const stackRows = project!.stacks.map((stack) => {
    const envKey = `DEPLOY_${stack.id.toUpperCase()}_RESULT`;
    const result = getResult(envKey);
    return `| ${stack.name} | ${stack.description} | ${resultEmoji(result)} ${result} |`;
  });

  // Verification results
  const securityScan = getResult('SECURITY_SCAN_RESULT');
  const verify = getResult('VERIFY_RESULT');
  const smokeTests = getResult('SMOKE_TESTS_RESULT');
  const rollback = getResult('ROLLBACK_RESULT');

  const summary = `## ${project!.name} Infrastructure Deployment

**Architecture**: Consolidated ${project!.stacks.length}-Stack (Shared VPC)
**Environment**: ${environment}
**Region**: ${awsRegion}
**Commit**: ${commitSha}

### Stack Deployment Status

| Stack | Description | Status |
|-------|-------------|--------|
${stackRows.join('\n')}

### Verification
- **Security Scan**: ${resultEmoji(securityScan)} ${securityScan}
- **Post-Deploy Verify**: ${resultEmoji(verify)} ${verify}
- **Smoke Tests**: ${resultEmoji(smokeTests)} ${smokeTests}
- **Rollback**: ${resultEmoji(rollback)} ${rollback}
`;

  // Write to $GITHUB_STEP_SUMMARY or stdout
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, summary);
    logger.success('Wrote deployment summary to $GITHUB_STEP_SUMMARY');
  } else {
    // Local mode - print to console
    console.log(summary);
  }

  // Check for failures
  const hasFailure = project!.stacks.some((stack) => {
    const envKey = `DEPLOY_${stack.id.toUpperCase()}_RESULT`;
    return getResult(envKey) === 'failure';
  });

  if (hasFailure) {
    logger.error('Deployment pipeline has failures');
    process.exit(1);
  }

  logger.success('All deployments completed successfully');
}

main();
