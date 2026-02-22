#!/usr/bin/env npx tsx
/**
 * Sync Grafana Dashboards to S3 + EC2 Hot-Reload
 *
 * Decouples dashboard deployment from full CDK infrastructure deploy.
 * Syncs dashboard JSONs directly to S3, then triggers an SSM Run Command
 * on the monitoring EC2 instance to pull the update. Grafana's file-based
 * provisioning auto-detects changes within 30 seconds.
 *
 * Usage:
 *   npx tsx scripts/deployment/sync-dashboards.ts development
 *   npx tsx scripts/deployment/sync-dashboards.ts production --region eu-west-1 --profile prod-account
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   bucket           - S3 bucket name
 *   files_synced     - Number of dashboard files synced
 *   instance_id      - EC2 instance that was refreshed
 *   command_id       - SSM Run Command ID
 *
 * Exit codes:
 *   0 = sync completed successfully
 *   1 = fatal error
 */

import { appendFileSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

import {
  EC2Client,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

import { runCommand } from './exec.js';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const environment = args[0];
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');
const profileFlag = args.indexOf('--profile');
const profile = profileFlag !== -1 ? args[profileFlag + 1] : undefined;

// Set AWS_PROFILE so the SDK credential chain resolves named profile credentials.
// The --profile flag is an AWS CLI concept; SDK clients use the env var instead.
if (profile) {
  process.env.AWS_PROFILE = profile;
}

if (!environment) {
  console.error('Usage: sync-dashboards.ts <environment> [--region <region>] [--profile <profile>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// __dirname is available natively in CJS (no import.meta.url needed)
const PROJECT_ROOT = resolve(__dirname, '../..');
const DASHBOARDS_DIR = resolve(PROJECT_ROOT, 'scripts/monitoring/grafana/dashboards');
const S3_KEY_PREFIX = 'scripts/grafana/dashboards';

// Environment suffix mapping (CDK uses 'development' not 'dev' for stack names)
const envSuffix = environment;

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const ec2 = new EC2Client({ region });
const ssm = new SSMClient({ region });

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
// Validate dashboard JSON files
// ---------------------------------------------------------------------------
function validateDashboards(): string[] {
  logger.task('Validating dashboard JSON files...');

  const files = readdirSync(DASHBOARDS_DIR).filter((f) => f.endsWith('.json'));

  if (files.length === 0) {
    logger.error(`No dashboard JSON files found in ${DASHBOARDS_DIR}`);
    process.exit(1);
  }

  for (const file of files) {
    const filePath = resolve(DASHBOARDS_DIR, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      JSON.parse(content);
      logger.listItem(`${file} ✓`);
    } catch (err) {
      logger.error(`Invalid JSON in ${file}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  logger.success(`All ${files.length} dashboard files are valid JSON`);
  return files;
}

// ---------------------------------------------------------------------------
// Get S3 bucket name from CloudFormation stack resources
// ---------------------------------------------------------------------------
async function getBucketName(): Promise<string> {
  const stackName = `Monitoring-Compute-${envSuffix}`;
  logger.task(`Resolving S3 bucket from stack: ${stackName}`);

  try {
    // Fetch all stack resources as JSON, then filter in TypeScript
    // (avoids JMESPath shell-escaping issues with colons in AWS::S3::Bucket)
    const awsArgs = [
      'cloudformation', 'list-stack-resources',
      '--stack-name', stackName,
      '--output', 'json',
      '--region', region,
    ];
    if (profile) {
      awsArgs.push('--profile', profile);
    }

    const result = await runCommand('aws', awsArgs, { captureOutput: true });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to query stack resources: ${result.stderr}`);
    }

    const data = JSON.parse(result.stdout.trim());
    const summaries: { ResourceType: string; PhysicalResourceId: string }[] =
      data.StackResourceSummaries ?? [];

    const s3Bucket = summaries.find((r) => r.ResourceType === 'AWS::S3::Bucket');
    if (!s3Bucket) {
      throw new Error(`No S3 bucket found in stack ${stackName}`);
    }

    const bucketName = s3Bucket.PhysicalResourceId;
    logger.success(`Resolved bucket: ${bucketName}`);
    return bucketName;
  } catch (err) {
    logger.error(`Failed to resolve S3 bucket: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync dashboards to S3
// ---------------------------------------------------------------------------
async function syncToS3(bucket: string): Promise<number> {
  const s3Path = `s3://${bucket}/${S3_KEY_PREFIX}/`;
  logger.task(`Syncing dashboards to ${s3Path}`);

  const awsArgs = ['s3', 'sync', DASHBOARDS_DIR, s3Path, '--delete', '--size-only'];
  if (profile) {
    awsArgs.push('--profile', profile);
  }

  const result = await runCommand('aws', awsArgs, { captureOutput: true });

  if (result.exitCode !== 0) {
    logger.error(`S3 sync failed: ${result.stderr}`);
    process.exit(1);
  }

  // Count files from output lines
  const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
  const fileCount = lines.length;

  if (fileCount > 0) {
    logger.success(`Synced ${fileCount} file(s) to S3`);
  } else {
    logger.info('No changes detected — S3 already up to date');
  }

  return fileCount;
}

// ---------------------------------------------------------------------------
// Find monitoring EC2 instance
// ---------------------------------------------------------------------------
async function findMonitoringInstance(): Promise<string> {
  logger.task('Discovering monitoring EC2 instance...');

  try {
    const response = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: 'tag:Project', Values: ['Monitoring'] },
          { Name: 'instance-state-name', Values: ['running'] },
        ],
      })
    );

    const instances = response.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];

    if (instances.length === 0) {
      throw new Error('No running monitoring instance found (tag: Project=Monitoring)');
    }

    const instanceId = instances[0].InstanceId!;
    const nameTag = instances[0].Tags?.find((t) => t.Key === 'Name')?.Value ?? 'unnamed';
    logger.success(`Found instance: ${instanceId} (${nameTag})`);
    return instanceId;
  } catch (err) {
    logger.error(`Instance discovery failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Trigger dashboard sync on EC2 via SSM Run Command
// ---------------------------------------------------------------------------
async function triggerEc2Sync(instanceId: string, bucket: string): Promise<string> {
  logger.task(`Sending SSM Run Command to ${instanceId}...`);

  const syncCommand = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    'echo "=== Dashboard hot-reload triggered ==="',
    `aws s3 sync s3://${bucket}/${S3_KEY_PREFIX}/ /opt/monitoring/grafana/dashboards/ --delete --region ${region}`,
    'echo "Dashboard sync complete — Grafana will auto-detect within 30s"',
    'ls -la /opt/monitoring/grafana/dashboards/',
  ].join('\n');

  try {
    const response = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
          commands: [syncCommand],
        },
        TimeoutSeconds: 60,
        Comment: 'Sync Grafana dashboards from S3 (decoupled deploy)',
      })
    );

    const commandId = response.Command?.CommandId;
    if (!commandId) {
      throw new Error('SSM SendCommand returned no command ID');
    }

    logger.success(`SSM command sent: ${commandId}`);

    // Wait for command completion
    logger.task('Waiting for EC2 sync to complete...');
    let status = 'Pending';
    let attempts = 0;
    const maxAttempts = 12; // 60 seconds max

    while (status === 'Pending' || status === 'InProgress') {
      if (attempts >= maxAttempts) {
        logger.warn(`SSM command timed out after ${maxAttempts * 5}s — check AWS console`);
        return commandId;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempts++;

      try {
        const invocation = await ssm.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
          })
        );

        status = invocation.Status ?? 'Unknown';

        if (status === 'Success') {
          logger.success('EC2 dashboard sync completed successfully');
          if (invocation.StandardOutputContent) {
            logger.dim(invocation.StandardOutputContent);
          }
          return commandId;
        }

        if (status === 'Failed' || status === 'Cancelled' || status === 'TimedOut') {
          logger.error(`SSM command ${status}: ${invocation.StandardErrorContent ?? 'no details'}`);
          process.exit(1);
        }
      } catch {
        // GetCommandInvocation may throw if invocation isn't ready yet
        // (InvocationDoesNotExist), which is normal in the first few seconds
      }
    }

    return commandId;
  } catch (err) {
    logger.error(`SSM command failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.header(`Sync Grafana Dashboards (${environment})`);
  logger.keyValue('Region', region);
  logger.keyValue('Dashboards Dir', DASHBOARDS_DIR);
  if (profile) {
    logger.keyValue('Profile', profile);
  }
  logger.blank();

  // 1. Validate dashboard JSON files
  const files = validateDashboards();
  logger.blank();

  // 2. Resolve S3 bucket
  const bucket = await getBucketName();
  setOutput('bucket', bucket);
  logger.blank();

  // 3. Sync to S3
  const filesSynced = await syncToS3(bucket);
  setOutput('files_synced', String(filesSynced));
  logger.blank();

  // 4. Discover monitoring instance
  const instanceId = await findMonitoringInstance();
  setOutput('instance_id', instanceId);
  logger.blank();

  // 5. Trigger EC2 sync via SSM
  const commandId = await triggerEc2Sync(instanceId, bucket);
  setOutput('command_id', commandId);
  logger.blank();

  // Summary
  logger.table(
    ['Action', 'Result'],
    [
      ['Dashboard Files', `${files.length} validated`],
      ['S3 Bucket', bucket],
      ['Files Changed', String(filesSynced)],
      ['EC2 Instance', instanceId],
      ['SSM Command', commandId],
    ]
  );

  logger.success('Dashboard sync complete — changes visible in Grafana within ~30 seconds');
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
