#!/usr/bin/env npx tsx
/**
 * Verify Deployment Script
 *
 * Checks CloudFormation stack statuses using the AWS SDK and outputs
 * SSM port-forwarding commands for monitoring access.
 *
 * Usage:
 *   npx tsx scripts/deployment/verify-deployment.ts monitoring development
 *   npx tsx scripts/deployment/verify-deployment.ts monitoring production --region eu-west-1
 *
 * Exit codes:
 *   0 = all stacks healthy
 *   1 = one or more stacks failed
 */

import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

import logger, { LogLevel } from './logger.js';
import {
  getProject,
  type Environment,
  type StackConfig,
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
  console.error('Usage: verify-deployment.ts <project> <environment> [--region <region>]');
  process.exit(1);
}

const project = getProject(projectId);
if (!project) {
  console.error(`Unknown project: ${projectId}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
const asg = new AutoScalingClient({ region });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StackVerification {
  stack: StackConfig;
  stackName: string;
  status: string;
  healthy: boolean;
}

// ---------------------------------------------------------------------------
// Verify stack statuses
// ---------------------------------------------------------------------------
async function verifyStack(stack: StackConfig): Promise<StackVerification> {
  const stackName = stack.getStackName(environment);
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    const status = response.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
    const healthy = status.includes('COMPLETE') && !status.includes('ROLLBACK');
    return { stack, stackName, status, healthy };
  } catch {
    return { stack, stackName, status: 'NOT_FOUND', healthy: false };
  }
}

// ---------------------------------------------------------------------------
// Get SSM access commands for compute stacks
// ---------------------------------------------------------------------------
async function getSSMAccessInfo(stackName: string): Promise<void> {
  try {
    const response = await cfn.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    const outputs = response.Stacks?.[0]?.Outputs ?? [];

    // Look for ASG name in outputs
    const asgOutput = outputs.find((o) => o.OutputKey === 'AsgName');
    if (asgOutput?.OutputValue) {
      const asgName = asgOutput.OutputValue;

      // Get instance ID from ASG
      const asgResponse = await asg.send(
        new DescribeAutoScalingGroupsCommand({
          AutoScalingGroupNames: [asgName],
        })
      );
      const instanceId =
        asgResponse.AutoScalingGroups?.[0]?.Instances?.[0]?.InstanceId;

      if (instanceId) {
        if (logger.isEnabled(LogLevel.VERBOSE)) {
          logger.blank();
          logger.verbose('SSM Port Forwarding (ASG mode)');
          logger.verbose(`Instance: ${instanceId}`);
          logger.blank();
          logger.verboseKeyValue(
            'Grafana',
            `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'`
          );
          logger.verboseKeyValue(
            'Prometheus',
            `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["9090"],"localPortNumber":["9090"]}'`
          );
          logger.verboseKeyValue(
            'Loki',
            `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3100"],"localPortNumber":["3100"]}'`
          );
        }
      }
      return;
    }

    // Look for direct Instance ID in outputs
    const instanceOutput = outputs.find((o) => o.OutputKey === 'InstanceId');
    if (instanceOutput?.OutputValue) {
      const instanceId = instanceOutput.OutputValue;
      if (logger.isEnabled(LogLevel.VERBOSE)) {
        logger.blank();
        logger.verbose('SSM Port Forwarding (Single Instance mode)');
        logger.verbose(`Instance: ${instanceId}`);
        logger.blank();
        logger.verboseKeyValue(
          'Grafana',
          `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'`
        );
      }
    }
  } catch (err) {
    logger.warn(`Could not retrieve SSM access info: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.setEnvironment(environment);
  logger.header(`Verify ${project!.name} Deployment (${environment})`);

  // Verify all stacks in parallel
  const results = await Promise.all(
    project!.stacks.map((stack) => verifyStack(stack))
  );

  // Display results as table
  const allHealthy = results.every((r) => r.healthy);

  logger.table(
    ['Stack', 'CloudFormation Name', 'Status'],
    results.map((r) => [
      `${r.healthy ? '✓' : '✗'} ${r.stack.name}`,
      r.stackName,
      r.status,
    ])
  );

  // SSM access info for compute stacks
  const computeResult = results.find(
    (r) => r.stack.id === 'compute' && r.healthy
  );
  if (computeResult) {
    await getSSMAccessInfo(computeResult.stackName);
  }

  if (!allHealthy) {
    const failed = results.filter((r) => !r.healthy);
    logger.error(
      `${failed.length}/${results.length} stacks failed verification`
    );
    process.exit(1);
  }

  logger.blank();
  logger.success(
    `All ${results.length} stacks verified successfully`
  );
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
