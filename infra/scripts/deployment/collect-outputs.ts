#!/usr/bin/env npx tsx
/**
 * Collect Stack Outputs Script
 *
 * Consolidates four separate bash steps from deploy-cdk-stack/action.yml:
 *   1. Create Outputs Directory
 *   2. Retrieve Stack Outputs (read CDK outputs file, convert format, write $GITHUB_OUTPUT)
 *   3. Debug Outputs Directory Input
 *   4. Save Outputs to File
 *
 * Usage:
 *   npx tsx scripts/deployment/collect-outputs.ts <stack-name> [--deploy-status <status>] [--outputs-dir <dir>]
 *
 * Examples:
 *   npx tsx scripts/deployment/collect-outputs.ts K8s-Compute-development --deploy-status success
 *   npx tsx scripts/deployment/collect-outputs.ts Monitoring-Compute-dev --deploy-status success --outputs-dir stack-outputs
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   stack_outputs  - JSON array of {OutputKey, OutputValue} objects
 *   file_path      - Path to saved outputs file (if --outputs-dir provided)
 *
 * Exit codes:
 *   0 = always (outputs are informational, never block the pipeline)
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const stackName = args[0];

const statusIdx = args.indexOf('--deploy-status');
const deployStatus = statusIdx !== -1 ? args[statusIdx + 1] : '';

const outputsDirIdx = args.indexOf('--outputs-dir');
const outputsDirInput = outputsDirIdx !== -1 ? args[outputsDirIdx + 1] : '';

if (!stackName) {
  console.error('Usage: collect-outputs.ts <stack-name> [--deploy-status <status>] [--outputs-dir <dir>]');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CDK_OUTPUTS_FILE = '/tmp/cdk-outputs/stack-outputs.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a key=value pair to $GITHUB_OUTPUT */
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

/** Resolve the workspace-relative outputs directory to an absolute path */
function resolveOutputsDir(relativePath: string): string {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  return join(workspace, relativePath);
}

/** Sanitise stack name for use in filenames */
function sanitiseForFilename(name: string): string {
  return name.replace(/[/:]/g, '-');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FormattedOutput {
  OutputKey: string;
  OutputValue: string;
}

// ---------------------------------------------------------------------------
// Step 1: Read CDK outputs file and extract stack outputs
// ---------------------------------------------------------------------------
function readStackOutputs(): FormattedOutput[] {
  if (!existsSync(CDK_OUTPUTS_FILE)) {
    logger.warn(`CDK outputs file not found at: ${CDK_OUTPUTS_FILE}`);
    logger.info('This may indicate the deployment succeeded but outputs were not captured.');
    return [];
  }

  logger.task('Reading CDK outputs file...');
  const raw = readFileSync(CDK_OUTPUTS_FILE, 'utf-8');

  let allOutputs: Record<string, Record<string, string>>;
  try {
    allOutputs = JSON.parse(raw);
  } catch {
    logger.warn('Failed to parse CDK outputs file');
    return [];
  }

  const stackOutputs = allOutputs[stackName];
  if (!stackOutputs || Object.keys(stackOutputs).length === 0) {
    logger.info(`No outputs found for stack: ${stackName}`);
    return [];
  }

  // Convert CDK format {"Key": "value"} → CFN format [{OutputKey, OutputValue}]
  return Object.entries(stackOutputs).map(([key, value]) => ({
    OutputKey: key,
    OutputValue: String(value),
  }));
}

// ---------------------------------------------------------------------------
// Step 2: Write outputs to $GITHUB_OUTPUT
// ---------------------------------------------------------------------------
function emitGitHubOutputs(outputs: FormattedOutput[]): void {
  const json = JSON.stringify(outputs);
  setOutput('stack_outputs', json);

  if (outputs.length > 0) {
    logger.success(`Retrieved ${outputs.length} stack output(s)`);
    logger.blank();
    for (const o of outputs) {
      logger.keyValue(o.OutputKey, o.OutputValue);
    }
  } else {
    logger.info('No stack outputs to emit');
  }
}

// ---------------------------------------------------------------------------
// Step 3: Save outputs to file (if outputs-dir provided)
// ---------------------------------------------------------------------------
function saveOutputsToFile(outputs: FormattedOutput[]): void {
  if (!outputsDirInput) {
    logger.debug('No --outputs-dir provided, skipping file save');
    return;
  }

  const outputsDir = resolveOutputsDir(outputsDirInput);

  // Always create directory (needed for artifact upload consistency)
  logger.task(`Creating outputs directory: ${outputsDir}`);
  mkdirSync(outputsDir, { recursive: true });

  if (!existsSync(outputsDir)) {
    logger.error('Failed to create outputs directory');
    return;
  }
  logger.success('Outputs directory created');

  // Only save file content if deployment succeeded
  if (deployStatus !== 'success') {
    logger.warn('Deployment did not succeed, skipping output file save');
    logger.info('Directory created for artifact upload consistency');
    return;
  }

  const safeStackName = sanitiseForFilename(stackName);
  const outputFile = join(outputsDir, `${safeStackName}-outputs.json`);

  // Prefer copying the full CDK outputs file
  if (existsSync(CDK_OUTPUTS_FILE)) {
    copyFileSync(CDK_OUTPUTS_FILE, outputFile);
    setOutput('file_path', outputFile);
    logger.success(`Outputs saved to: ${outputFile}`);
  } else if (outputs.length > 0) {
    // Fallback: write the formatted outputs
    writeFileSync(outputFile, JSON.stringify(outputs, null, 2));
    setOutput('file_path', outputFile);
    logger.success(`Outputs saved to: ${outputFile}`);
  } else {
    logger.warn('No outputs to save');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  logger.header(`Collect Outputs — ${stackName}`);
  logger.keyValue('Stack', stackName);
  logger.keyValue('Deploy Status', deployStatus || 'unknown');
  logger.keyValue('Outputs Dir', outputsDirInput || '(none)');
  logger.blank();

  // Only retrieve outputs if deployment succeeded
  let outputs: FormattedOutput[] = [];
  if (deployStatus === 'success') {
    outputs = readStackOutputs();
    emitGitHubOutputs(outputs);
  } else {
    logger.info('Deployment did not succeed — skipping output retrieval');
    setOutput('stack_outputs', '[]');
  }

  logger.blank();

  // Save to file (handles directory creation even on failure)
  saveOutputsToFile(outputs);

  logger.blank();
  logger.info('Output collection complete');
}

main();
