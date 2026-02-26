#!/usr/bin/env npx tsx
/**
 * CDK Deploy Script
 *
 * Deploys a single CDK stack with provenance tags, output capture,
 * and GitHub Actions integration. Replaces the inline bash in
 * deploy-cdk-stack/action.yml for consistency with other TS scripts.
 *
 * Usage:
 *   npx tsx scripts/deployment/deploy.ts <stack-name> <project> <environment>
 *   npx tsx scripts/deployment/deploy.ts K8s-Compute-development k8s development --require-approval never
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   status        - deployment result (success|failure)
 *   duration      - deployment duration in seconds
 *
 * Environment variables consumed:
 *   GITHUB_SHA, GITHUB_RUN_ID, GITHUB_ACTOR, GITHUB_REPOSITORY,
 *   GITHUB_WORKFLOW — used for SLSA-inspired provenance tags
 *
 * Exit codes:
 *   0 = deployment successful
 *   1 = deployment failed
 */

import { appendFileSync, mkdirSync } from 'fs';

import * as dotenv from 'dotenv';

import { buildCdkArgs, runCdk } from './exec.js';
import logger from './logger.js';

// Load .env for local development (CI sets env vars via workflow env: blocks)
dotenv.config();

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const stackName = args[0];
const project = args[1];
const environment = args[2];

// Parse optional flags
const approvalIdx = args.indexOf('--require-approval');
const requireApproval = approvalIdx !== -1
  ? (args[approvalIdx + 1] as 'never' | 'broadening' | 'any-change')
  : 'never';

if (!stackName || !project || !environment) {
  console.error('Usage: deploy.ts <stack-name> <project> <environment> [--require-approval never|broadening|any-change]');
  console.error('');
  console.error('Examples:');
  console.error('  deploy.ts Monitoring-K8s-Compute-development k8s development');
  console.error('  deploy.ts Monitoring-Compute-production monitoring production --require-approval broadening');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helper: write to $GITHUB_OUTPUT
// ---------------------------------------------------------------------------
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

// ---------------------------------------------------------------------------
// Build provenance tags (SLSA-inspired audit metadata)
// ---------------------------------------------------------------------------
function buildProvenanceTags(): Record<string, string> {
  return {
    DeployCommit: process.env.GITHUB_SHA ?? 'local',
    DeployRunId: process.env.GITHUB_RUN_ID ?? '0',
    DeployActor: process.env.GITHUB_ACTOR ?? 'local',
    DeployRepo: process.env.GITHUB_REPOSITORY ?? 'local',
    DeployTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    DeployWorkflow: process.env.GITHUB_WORKFLOW ?? 'manual',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`Deploy ${stackName}`);
  logger.keyValue('Stack', stackName);
  logger.keyValue('Project', project);
  logger.keyValue('Environment', environment);
  logger.keyValue('Approval', requireApproval);
  logger.blank();

  // Prepare outputs directory
  const outputsDir = '/tmp/cdk-outputs';
  mkdirSync(outputsDir, { recursive: true });
  const outputsFile = `${outputsDir}/stack-outputs.json`;

  // Build CDK args
  const cdkArgs = buildCdkArgs({
    command: 'deploy',
    stackNames: [stackName],
    exclusively: true,
    context: { project, environment },
    requireApproval,
    method: 'direct',
    progress: 'events',
    outputsFile,
    tags: buildProvenanceTags(),
  });

  logger.task('Executing CDK deploy...');
  logger.debug(`cdk ${cdkArgs.join(' ')}`);
  logger.blank();

  // Execute deployment with timing
  const startTime = Date.now();
  const result = await runCdk(cdkArgs);
  const duration = Math.round((Date.now() - startTime) / 1000);

  // Write outputs for GitHub Actions
  if (result.exitCode === 0) {
    setOutput('status', 'success');
    setOutput('duration', String(duration));
    logger.blank();
    logger.success(`Stack deployment successful (${duration}s)`);
  } else {
    setOutput('status', 'failure');
    setOutput('duration', String(duration));
    logger.blank();
    logger.error(`Stack deployment failed (exit code: ${result.exitCode}, duration: ${duration}s)`);
    process.exit(result.exitCode);
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  setOutput('status', 'failure');
  process.exit(1);
});
