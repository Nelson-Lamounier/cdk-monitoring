#!/usr/bin/env npx tsx
/**
 * Verify Next.js Deployment Script
 *
 * Checks CloudFormation stack status for the Application stack,
 * discovers the ALB DNS from the Networking stack outputs,
 * and runs an HTTP health check against the ALB.
 *
 * Usage:
 *   npx tsx scripts/deployment/verify-nextjs.ts development
 *   npx tsx scripts/deployment/verify-nextjs.ts production --region eu-west-1
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   alb_dns        - ALB DNS name from Networking stack
 *   health_check_passed - true/false based on /api/health response
 *
 * Exit codes:
 *   0 = verification passed
 *   1 = verification failed
 */

import { appendFileSync } from 'fs';

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

import logger from './logger.js';
import {
  getProject,
  type Environment,
} from './stacks.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const environment = args[0] as Environment;
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');

if (!environment) {
  console.error('Usage: verify-nextjs.ts <environment> [--region <region>]');
  process.exit(1);
}

const project = getProject('nextjs');
if (!project) {
  console.error('NextJS project not found in stacks configuration');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AWS Client
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });

// ---------------------------------------------------------------------------
// Helper: write to $GITHUB_OUTPUT
// ---------------------------------------------------------------------------
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  logger.keyValue(key, value);
}

// ---------------------------------------------------------------------------
// Check CloudFormation stack status
// ---------------------------------------------------------------------------
async function checkStackStatus(stackName: string): Promise<{ status: string; healthy: boolean }> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    const status = response.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
    const healthy = status.includes('COMPLETE') && !status.includes('ROLLBACK');
    return { status, healthy };
  } catch {
    return { status: 'NOT_FOUND', healthy: false };
  }
}

// ---------------------------------------------------------------------------
// Get ALB DNS from Networking stack outputs
// ---------------------------------------------------------------------------
async function getAlbDns(stackName: string): Promise<string | undefined> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    const outputs = response.Stacks?.[0]?.Outputs ?? [];
    const albOutput = outputs.find((o) => o.OutputKey === 'AlbDnsName');
    return albOutput?.OutputValue || undefined;
  } catch (err) {
    logger.warn(`Could not get ALB DNS from stack: ${(err as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTTP health check
// ---------------------------------------------------------------------------
async function healthCheck(albDns: string): Promise<boolean> {
  const url = `http://${albDns}/api/health`;
  logger.task(`Health check: ${url}`);

  // Wait for service to stabilize
  logger.info('Waiting 30s for service to stabilize...');
  await new Promise((resolve) => setTimeout(resolve, 30_000));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (response.ok) {
      logger.success(`Health check passed: HTTP ${response.status}`);
      return true;
    }

    logger.warn(`Health check returned HTTP ${response.status}`);
    return false;
  } catch (err) {
    logger.warn(`Health check failed: ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`Verify NextJS Deployment (${environment})`);

  // Get stack configurations
  const applicationStack = project!.stacks.find((s) => s.id === 'application');
  const networkingStack = project!.stacks.find((s) => s.id === 'networking');

  if (!applicationStack || !networkingStack) {
    logger.error('Could not find application or networking stack configuration');
    process.exit(1);
  }

  const appStackName = applicationStack.getStackName(environment);
  const netStackName = networkingStack.getStackName(environment);

  // 1. Verify Application stack status
  logger.task(`Checking Application stack: ${appStackName}`);
  const appResult = await checkStackStatus(appStackName);

  if (appResult.healthy) {
    logger.success(`Application stack deployed: ${appResult.status}`);
  } else {
    logger.error(`Application stack status: ${appResult.status}`);
    process.exit(1);
  }

  // 2. Discover ALB DNS from Networking stack
  logger.task(`Getting ALB DNS from: ${netStackName}`);
  const albDns = await getAlbDns(netStackName);

  if (albDns && albDns !== 'None') {
    setOutput('alb_dns', albDns);
    logger.success(`ALB DNS: ${albDns}`);
  } else {
    logger.warn('No ALB DNS found in Networking stack outputs');
    setOutput('alb_dns', '');
  }

  // 3. Run health check if ALB DNS is available
  let passed = false;
  if (albDns && albDns !== 'None') {
    passed = await healthCheck(albDns);
  } else {
    logger.info('Skipping health check — no ALB DNS available');
  }

  setOutput('health_check_passed', String(passed));

  // Summary
  logger.blank();
  logger.table(
    ['Check', 'Result'],
    [
      ['Application Stack', appResult.healthy ? '✓ Healthy' : '✗ Failed'],
      ['ALB DNS', albDns ? `✓ ${albDns}` : '⚠ Not found'],
      ['Health Check', passed ? '✓ Passed' : '⚠ Failed/Skipped'],
    ]
  );

  logger.success('NextJS verification complete');
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
