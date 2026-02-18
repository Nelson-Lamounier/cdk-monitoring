#!/usr/bin/env npx tsx
/**
 * Rollback Script
 *
 * Rolls back a CloudFormation stack to its previous state when post-deploy
 * verification or smoke tests fail. Writes results to $GITHUB_STEP_SUMMARY.
 *
 * Usage:
 *   npx tsx scripts/deployment/rollback.ts <stack-name> --region <region>
 *
 * Exit codes:
 *   0 = rollback succeeded or was skipped (stack not in rollable state)
 *   1 = rollback failed
 */

import { appendFileSync } from 'fs';

import {
  CloudFormationClient,
  DescribeStacksCommand,
  RollbackStackCommand,
} from '@aws-sdk/client-cloudformation';

import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const stackName = args[0];
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');

if (!stackName) {
  console.error('Usage: rollback.ts <stack-name> [--region <region>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CloudFormation client
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getStackStatus(): Promise<string> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    return response.Stacks?.[0]?.StackStatus ?? 'NOT_FOUND';
  } catch {
    return 'NOT_FOUND';
  }
}

async function waitForRollback(timeoutMs: number = 600_000): Promise<string> {
  const start = Date.now();
  const pollInterval = 10_000; // 10 seconds

  while (Date.now() - start < timeoutMs) {
    const status = await getStackStatus();

    // Terminal states
    if (
      status === 'UPDATE_ROLLBACK_COMPLETE' ||
      status === 'UPDATE_COMPLETE' ||
      status === 'ROLLBACK_COMPLETE'
    ) {
      return status;
    }

    // Failed terminal states
    if (status.includes('FAILED')) {
      return status;
    }

    // Still in progress — wait and poll again
    logger.info(`  Status: ${status} (waiting...)`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return 'TIMEOUT';
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
// Write step summary
// ---------------------------------------------------------------------------
function writeSummary(result: 'success' | 'failure' | 'skipped', finalStatus: string, reason: string): void {
  const emoji = result === 'success' ? '✅' : result === 'failure' ? '❌' : '⏭️';

  const summary = `## ⚠️ Stack Rollback

**Stack**: \`${stackName}\`
**Region**: \`${region}\`
**Result**: ${emoji} ${result}
**Final Status**: \`${finalStatus}\`
**Reason**: ${reason}

### Manual Remediation (if rollback failed)
\`\`\`bash
# Check current status
aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].StackStatus'

# Manual rollback
aws cloudformation rollback-stack --stack-name ${stackName}

# Or re-deploy from last known good
npx cdk deploy ${stackName} --require-approval broadening
\`\`\`
`;

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, summary);
    logger.success('Wrote rollback summary to $GITHUB_STEP_SUMMARY');
  } else {
    console.log(summary);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`Rollback — ${stackName}`);

  // 1. Check current stack status
  const currentStatus = await getStackStatus();
  logger.info(`Current stack status: ${currentStatus}`);

  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning::Rolling back ${stackName} due to post-deploy verification failure`);
  }

  // 2. Only rollback if stack is in UPDATE_COMPLETE state
  if (currentStatus !== 'UPDATE_COMPLETE') {
    logger.warn(`Stack not in UPDATE_COMPLETE state (${currentStatus}), skipping rollback`);
    setOutput('result', 'skipped');
    writeSummary('skipped', currentStatus, `Stack not in rollable state (${currentStatus})`);
    return;
  }

  // 3. Initiate rollback
  logger.info('Initiating CloudFormation rollback...');
  try {
    await cfn.send(new RollbackStackCommand({ StackName: stackName }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to initiate rollback: ${message}`);
    setOutput('result', 'failure');
    writeSummary('failure', currentStatus, `Failed to initiate rollback: ${message}`);
    process.exit(1);
  }

  // 4. Wait for rollback to complete
  logger.info('Waiting for rollback to complete...');
  const finalStatus = await waitForRollback();
  logger.info(`Final stack status: ${finalStatus}`);

  // 5. Evaluate result
  if (
    finalStatus === 'UPDATE_ROLLBACK_COMPLETE' ||
    finalStatus === 'UPDATE_COMPLETE'
  ) {
    logger.success('Rollback completed successfully');
    setOutput('result', 'success');
    writeSummary('success', finalStatus, 'Rollback to previous configuration completed');
  } else {
    logger.error(`Rollback ended in unexpected state: ${finalStatus}`);
    setOutput('result', 'failure');
    writeSummary('failure', finalStatus, `Rollback ended in unexpected state`);

    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error::Rollback ended in unexpected state: ${finalStatus}`);
    }

    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  setOutput('result', 'failure');
  process.exit(1);
});
