#!/usr/bin/env npx tsx
/**
 * Pre-flight Checks Script
 *
 * Validates deployment inputs, verifies AWS credentials, and optionally
 * checks CDK bootstrap status before a stack deployment. Replaces the
 * "Validate Inputs", "Verify AWS Credentials", and "Verify CDK Bootstrap"
 * bash steps in deploy-cdk-stack/action.yml.
 *
 * Usage:
 *   npx tsx scripts/deployment/preflight-checks.ts <stack-name> \
 *     --project <project> --environment <env> --region <region> \
 *     --account-id <id> --require-approval <approval> \
 *     [--verify-bootstrap]
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = validation or verification failed
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

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

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const project = getArg('--project');
const environment = getArg('--environment');
const region = getArg('--region');
const accountId = getArg('--account-id');
const requireApproval = getArg('--require-approval');
const verifyBootstrap = hasFlag('--verify-bootstrap');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_ENVIRONMENTS = ['development', 'staging', 'production'];
const VALID_APPROVALS = ['never', 'any-change', 'broadening'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask all but last 4 chars */
function mask(value: string): string {
  if (value.length <= 4) return value;
  return `***${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 1. Validate Inputs
// ---------------------------------------------------------------------------
function validateInputs(): boolean {
  logger.header('Validate Deployment Inputs');

  let valid = true;

  // Stack name
  if (!stackName) {
    logger.error('stack-name is required');
    valid = false;
  }

  // Environment
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    logger.error(`Invalid environment: ${environment}`);
    logger.info(`Valid environments: ${VALID_ENVIRONMENTS.join(', ')}`);
    logger.blank();
    logger.info('Note: This action is for deploying to target environments.');
    logger.info('For CI/CD pipeline validation, use CDK synth directly.');
    valid = false;
  }

  // AWS account ID format (12-digit number)
  if (!/^\d{12}$/.test(accountId)) {
    logger.error(`Invalid AWS account ID format: ${accountId}`);
    logger.info('Expected: 12-digit number');
    valid = false;
  }

  // AWS region format
  if (!/^[a-z]{2}-[a-z]+-\d{1}$/.test(region)) {
    logger.error(`Invalid AWS region format: ${region}`);
    logger.info('Expected format: eu-west-1, us-east-1, etc.');
    valid = false;
  }

  // require-approval value
  if (!VALID_APPROVALS.includes(requireApproval)) {
    logger.error(`Invalid require-approval: ${requireApproval}`);
    logger.info(`Valid values: ${VALID_APPROVALS.join(', ')}`);
    valid = false;
  }

  if (valid) {
    logger.success('Input validation passed');
    logger.blank();
    logger.info('Deployment Configuration:');
    logger.keyValue('Stack Name', stackName);
    logger.keyValue('Project', project);
    logger.keyValue('Environment', environment);
    logger.keyValue('Account ID', mask(accountId));
    logger.keyValue('Region', region);
    logger.keyValue('Approval', requireApproval);
  }

  return valid;
}

// ---------------------------------------------------------------------------
// 2. Verify AWS Credentials
// ---------------------------------------------------------------------------
async function verifyCredentials(): Promise<boolean> {
  logger.blank();
  logger.header('Verify AWS Credentials');

  const sts = new STSClient({ region });

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const currentAccount = identity.Account ?? '';

    logger.success(`Authenticated to AWS account: ${mask(currentAccount)}`);

    if (currentAccount !== accountId) {
      logger.blank();
      logger.warn(
        `Current account (${mask(currentAccount)}) differs from target (${mask(accountId)})`
      );
      logger.info('This may be expected for cross-account deployments via AssumeRole');
    }

    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Cannot retrieve AWS account information');
    logger.info(`AWS error: ${message}`);
    logger.blank();
    logger.info('Troubleshooting:');
    logger.info('  1. Verify AWS credentials are configured');
    logger.info('  2. Check IAM role trust policy allows GitHub OIDC');
    logger.info('  3. Ensure role has sts:GetCallerIdentity permission');
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. Verify CDK Bootstrap (optional)
// ---------------------------------------------------------------------------
async function verifyCdkBootstrap(): Promise<boolean> {
  logger.blank();
  logger.header('Verify CDK Bootstrap');

  logger.keyValue('Account', mask(accountId));
  logger.keyValue('Region', region);
  logger.blank();

  const cfn = new CloudFormationClient({ region });
  const bootstrapStack = 'CDKToolkit';

  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: bootstrapStack })
    );

    const status = response.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';

    if (!status.includes('COMPLETE')) {
      logger.error('CDK bootstrap stack is not in a healthy state');
      logger.keyValue('Status', status);
      return false;
    }

    logger.success(`CDK bootstrap verified: ${status}`);
    return true;
  } catch {
    logger.error('CDK bootstrap stack not found');
    logger.blank();
    logger.info('Please bootstrap the CDK environment:');
    logger.info(`  cdk bootstrap aws://${accountId}/${region}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // 1. Validate inputs (synchronous)
  if (!validateInputs()) {
    process.exit(1);
  }

  // 2. Verify AWS credentials
  const credentialsOk = await verifyCredentials();
  if (!credentialsOk) {
    process.exit(1);
  }

  // 3. Optionally verify CDK bootstrap
  if (verifyBootstrap) {
    const bootstrapOk = await verifyCdkBootstrap();
    if (!bootstrapOk) {
      process.exit(1);
    }
  }

  logger.blank();
  logger.success('All pre-flight checks passed');
}

main();
