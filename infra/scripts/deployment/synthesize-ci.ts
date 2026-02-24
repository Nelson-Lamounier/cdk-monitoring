#!/usr/bin/env npx tsx
/**
 * Synthesize CI Script
 *
 * Runs CDK synth for a project and outputs stack names + metadata
 * for GitHub Actions workflows. Replaces inline bash in CI workflows.
 *
 * Usage:
 *   npx tsx scripts/deployment/synthesize-ci.ts monitoring development
 *   npx tsx scripts/deployment/synthesize-ci.ts nextjs staging --region us-east-1
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   timestamp, architecture, and stack names (e.g., storage, compute)
 *
 * Side effects:
 *   - Runs `cdk synth` and writes templates to cdk.out/
 *   - Writes synthesis-metadata.json to cdk.out/
 */

import { writeFileSync, appendFileSync } from 'fs';

import * as dotenv from 'dotenv';

import { buildCdkArgs, runCdk } from './exec.js';
import logger from './logger.js';
import {
  getProject,
  type Environment,
} from './stacks.js';

// Load .env for local development (CI sets env vars via workflow env: blocks)
dotenv.config();

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const projectId = args[0];
const environment = args[1] as Environment;

if (!projectId || !environment) {
  console.error('Usage: synthesize-ci.ts <project> <environment>');
  console.error('  Projects: monitoring, nextjs, org, shared');
  console.error('  Environments: development, staging, production');
  console.error('\n  Synth-time values (domain, secrets, etc.) come from:');
  console.error('    - Typed config files: lib/config/*/configurations.ts');
  console.error('    - Environment variables: bridged via app.ts');
  process.exit(1);
}

const project = getProject(projectId);
if (!project) {
  console.error(`Unknown project: ${projectId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helper: write to $GITHUB_OUTPUT (or stdout if not in CI)
// ---------------------------------------------------------------------------
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  // Always log for visibility
  logger.keyValue(key, value);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.setEnvironment(environment);
  logger.header(`Synthesize ${project!.name} (${environment})`);

  // Build CDK context (only project + environment; everything else is in typed config + env vars)
  const context = project!.cdkContext(environment);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // 1. Run CDK synth
  logger.task('Running CDK synth...');
  const synthArgs = buildCdkArgs({
    command: 'synth',
    all: true,
    context,
    quiet: true,
  });

  const result = await runCdk(synthArgs);
  if (result.exitCode !== 0) {
    logger.error('CDK synth failed');
    process.exit(1);
  }
  logger.success('CDK synth completed');

  // 2. Write synthesis metadata
  const commitSha = process.env.GITHUB_SHA ?? 'local';
  const shortSha = commitSha.slice(0, 8);
  const awsRegion = process.env.AWS_REGION ?? 'eu-west-1';

  const metadata = {
    commitSha,
    shortSha,
    timestamp,
    environment,
    region: awsRegion,
    project: projectId,
    stackCount: project!.stacks.length,
    architecture: `consolidated-${project!.stacks.length}-stack`,
  };

  writeFileSync('cdk.out/synthesis-metadata.json', JSON.stringify(metadata, null, 2));
  logger.success('Wrote synthesis-metadata.json');
  logger.debug(`Metadata: ${JSON.stringify(metadata)}`);

  // 3. Output stack names for downstream jobs
  logger.task('Stack names:');
  for (const stack of project!.stacks) {
    const stackName = stack.getStackName(environment);
    setOutput(stack.id, stackName);
    logger.listItem(`${stack.name}: ${stackName}`);
  }

  // 4. Output metadata
  setOutput('timestamp', timestamp);
  setOutput('architecture', metadata.architecture);

  // 5. Output edge_enabled for NextJS projects
  if (projectId === 'nextjs') {
    setOutput('edge_enabled', 'true');
  }

  logger.blank();
  logger.success(`Synthesis complete: ${project!.stacks.length} stacks for ${environment}`);
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
