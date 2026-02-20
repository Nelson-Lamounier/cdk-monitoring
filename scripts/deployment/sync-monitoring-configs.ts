#!/usr/bin/env npx tsx
/**
 * Sync Monitoring Configs to S3 + EC2 Hot-Reload
 *
 * Decouples monitoring configuration from full CDK infrastructure deploy.
 * Syncs all monitoring configs (dashboards, Prometheus, Loki, Promtail,
 * Tempo, Grafana provisioning) to S3, then triggers intelligent per-service
 * reloads via SSM Run Command on the monitoring EC2 instance.
 *
 * Reload strategy:
 *   - Dashboards:          Grafana auto-detects (~30s), no action needed
 *   - Prometheus:          Hot-reload via lifecycle API (POST /-/reload)
 *   - Grafana provisioning: docker restart grafana
 *   - Loki/Promtail/Tempo: docker restart <service>
 *   - docker-compose.yml:  docker compose up -d (recreates changed services)
 *
 * Usage:
 *   npx tsx scripts/deployment/sync-monitoring-configs.ts development
 *   npx tsx scripts/deployment/sync-monitoring-configs.ts production --region eu-west-1 --profile prod-account
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   bucket           - S3 bucket name
 *   files_synced     - Number of files synced
 *   instance_id      - EC2 instance that was refreshed
 *   command_id       - SSM Run Command ID
 *   services_reloaded - Comma-separated list of reloaded services
 *
 * Exit codes:
 *   0 = sync completed successfully
 *   1 = fatal error
 */

import { appendFileSync, readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

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

if (profile) {
  process.env.AWS_PROFILE = profile;
}

if (!environment) {
  console.error('Usage: sync-monitoring-configs.ts <environment> [--region <region>] [--profile <profile>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const MONITORING_DIR = resolve(PROJECT_ROOT, 'scripts/monitoring');
const S3_KEY_PREFIX = 'scripts';

const envSuffix = environment;

// ---------------------------------------------------------------------------
// Config category definitions
// ---------------------------------------------------------------------------
interface ConfigCategory {
  /** Human-readable name */
  name: string;
  /** Path relative to scripts/monitoring/ */
  path: string;
  /** Reload command(s) to run on EC2 */
  reloadCommands: string[];
  /** File extensions to validate */
  validationExts?: string[];
}

const CONFIG_CATEGORIES: ConfigCategory[] = [
  {
    name: 'Grafana Dashboards',
    path: 'grafana/dashboards',
    // Grafana auto-detects file changes within 30s — no action needed
    reloadCommands: [],
    validationExts: ['.json'],
  },
  {
    name: 'Grafana Provisioning',
    path: 'grafana/provisioning',
    reloadCommands: ['docker restart grafana'],
    validationExts: ['.yml', '.yaml'],
  },
  {
    name: 'Prometheus',
    path: 'prometheus',
    // Prometheus lifecycle API for zero-downtime reload
    reloadCommands: ['curl -sS -f -X POST http://localhost:9090/-/reload && echo "Prometheus config reloaded"'],
    validationExts: ['.yml', '.yaml'],
  },
  {
    name: 'Loki',
    path: 'loki',
    reloadCommands: ['docker restart loki'],
    validationExts: ['.yml', '.yaml'],
  },
  {
    name: 'Promtail',
    path: 'promtail',
    reloadCommands: ['docker restart promtail'],
    validationExts: ['.yml', '.yaml'],
  },
  {
    name: 'Tempo',
    path: 'tempo',
    reloadCommands: ['docker restart tempo'],
    validationExts: ['.yml', '.yaml'],
  },
  {
    name: 'Steampipe',
    path: 'steampipe',
    reloadCommands: ['docker restart steampipe'],
    validationExts: ['.spc'],
  },
];

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
// Validate config files
// ---------------------------------------------------------------------------
function validateConfigs(): number {
  logger.task('Validating configuration files...');
  let totalFiles = 0;

  for (const category of CONFIG_CATEGORIES) {
    const dir = resolve(MONITORING_DIR, category.path);
    if (!existsSync(dir)) {
      continue;
    }

    const files = getAllFiles(dir).filter((f) => {
      if (!category.validationExts) return true;
      return category.validationExts.includes(extname(f));
    });

    for (const file of files) {
      const ext = extname(file);
      const content = readFileSync(file, 'utf-8');

      if (ext === '.json') {
        try {
          JSON.parse(content);
          logger.listItem(`${file.replace(MONITORING_DIR + '/', '')} (JSON OK)`);
          totalFiles++;
        } catch (err) {
          logger.error(`Invalid JSON: ${file}: ${(err as Error).message}`);
          process.exit(1);
        }
      } else if (ext === '.yml' || ext === '.yaml') {
        // Basic YAML validation — check it's not empty and has content
        if (content.trim().length === 0) {
          logger.error(`Empty YAML file: ${file}`);
          process.exit(1);
        }
        logger.listItem(`${file.replace(MONITORING_DIR + '/', '')} (YAML OK)`);
        totalFiles++;
      }
    }
  }

  logger.success(`Validated ${totalFiles} configuration files`);
  return totalFiles;
}

// ---------------------------------------------------------------------------
// Recursively get all files in a directory
// ---------------------------------------------------------------------------
function getAllFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Get S3 bucket name from CloudFormation stack resources
// ---------------------------------------------------------------------------
async function getBucketName(): Promise<string> {
  const stackName = `Monitoring-Compute-${envSuffix}`;
  logger.task(`Resolving S3 bucket from stack: ${stackName}`);

  try {
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
// Sync all monitoring configs to S3
// ---------------------------------------------------------------------------
async function syncToS3(bucket: string): Promise<{ fileCount: number; changedPaths: string[] }> {
  const s3Path = `s3://${bucket}/${S3_KEY_PREFIX}/`;
  logger.task(`Syncing monitoring configs to ${s3Path}`);

  const awsArgs = ['s3', 'sync', MONITORING_DIR, s3Path, '--delete', '--size-only'];
  if (profile) {
    awsArgs.push('--profile', profile);
  }

  const result = await runCommand('aws', awsArgs, { captureOutput: true });

  if (result.exitCode !== 0) {
    logger.error(`S3 sync failed: ${result.stderr}`);
    process.exit(1);
  }

  // Parse aws s3 sync output to detect which paths changed
  const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
  const changedPaths = lines
    .map((line) => {
      // aws s3 sync output: "upload: ./path/to/file to s3://bucket/key"
      //                  or  "delete: s3://bucket/key"
      const uploadMatch = line.match(/upload:\s+\.\/(.+?)\s+to/);
      const deleteMatch = line.match(/delete:\s+s3:\/\/.+?\/scripts\/(.+)/);
      return uploadMatch?.[1] ?? deleteMatch?.[1] ?? '';
    })
    .filter((p) => p.length > 0);

  if (changedPaths.length > 0) {
    logger.success(`Synced ${changedPaths.length} file(s) to S3`);
    for (const p of changedPaths) {
      logger.listItem(p);
    }
  } else {
    logger.info('No changes detected - S3 already up to date');
  }

  return { fileCount: changedPaths.length, changedPaths };
}

// ---------------------------------------------------------------------------
// Determine which services need reload based on changed paths
// ---------------------------------------------------------------------------
function determineReloads(changedPaths: string[]): { services: string[]; commands: string[] } {
  const commands: string[] = [];
  const services: string[] = [];

  for (const category of CONFIG_CATEGORIES) {
    const categoryChanged = changedPaths.some((p) => p.startsWith(category.path));
    if (categoryChanged && category.reloadCommands.length > 0) {
      services.push(category.name);
      commands.push(...category.reloadCommands);
    }
    if (categoryChanged && category.reloadCommands.length === 0) {
      services.push(`${category.name} (auto-detected)`);
    }
  }

  // Check if docker-compose.yml changed
  if (changedPaths.some((p) => p === 'docker-compose.yml')) {
    services.push('Docker Compose');
    // docker compose up -d will recreate only changed services
    commands.push('cd /opt/monitoring && docker compose up -d');
  }

  return { services, commands };
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
// Trigger config sync + reload on EC2 via SSM Run Command
// ---------------------------------------------------------------------------
async function triggerEc2Reload(
  instanceId: string,
  bucket: string,
  reloadCommands: string[],
): Promise<string> {
  logger.task(`Sending SSM Run Command to ${instanceId}...`);

  // Build the SSM command:
  // 1. Always sync from S3 first
  // 2. Then run targeted reload commands
  const commandLines = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    'echo "=== Monitoring config sync triggered ==="',
    '',
    '# Step 1: Pull latest configs from S3',
    `aws s3 sync s3://${bucket}/${S3_KEY_PREFIX}/ /opt/monitoring/ --delete --region ${region}`,
    'echo "S3 sync complete"',
    '',
  ];

  if (reloadCommands.length > 0) {
    commandLines.push('# Step 2: Reload affected services');
    for (const cmd of reloadCommands) {
      commandLines.push(`echo "Running: ${cmd}"`);
      commandLines.push(cmd);
    }
  } else {
    commandLines.push('# No service reloads needed (dashboard-only changes are auto-detected by Grafana)');
  }

  commandLines.push('');
  commandLines.push('echo "=== Config sync complete ==="');
  commandLines.push('ls -la /opt/monitoring/grafana/dashboards/');

  try {
    const response = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: {
          commands: [commandLines.join('\n')],
        },
        TimeoutSeconds: 120,
        Comment: `Sync monitoring configs (${reloadCommands.length} reload(s))`,
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
    const maxAttempts = 24; // 120 seconds max

    while (status === 'Pending' || status === 'InProgress') {
      if (attempts >= maxAttempts) {
        logger.warn(`SSM command timed out after ${maxAttempts * 5}s - check AWS console`);
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
          logger.success('EC2 config sync completed successfully');
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
        // GetCommandInvocation may throw InvocationDoesNotExist in the first few seconds
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
  logger.header(`Sync Monitoring Configs (${environment})`);
  logger.keyValue('Region', region);
  logger.keyValue('Monitoring Dir', MONITORING_DIR);
  if (profile) {
    logger.keyValue('Profile', profile);
  }
  logger.blank();

  // 1. Validate config files
  const totalFiles = validateConfigs();
  logger.blank();

  // 2. Resolve S3 bucket
  const bucket = await getBucketName();
  setOutput('bucket', bucket);
  logger.blank();

  // 3. Sync to S3 and detect changes
  const { fileCount, changedPaths } = await syncToS3(bucket);
  setOutput('files_synced', String(fileCount));
  logger.blank();

  // 4. Determine which services need reload
  const { services, commands: reloadCommands } = determineReloads(changedPaths);

  if (services.length > 0) {
    logger.task('Services to reload:');
    for (const svc of services) {
      logger.listItem(svc);
    }
  } else if (fileCount > 0) {
    logger.info('No service reloads needed');
  }
  setOutput('services_reloaded', services.join(',') || 'none');
  logger.blank();

  // 5. Discover monitoring instance
  const instanceId = await findMonitoringInstance();
  setOutput('instance_id', instanceId);
  logger.blank();

  // 6. Trigger EC2 sync + reload via SSM
  const commandId = await triggerEc2Reload(instanceId, bucket, reloadCommands);
  setOutput('command_id', commandId);
  logger.blank();

  // Summary
  logger.table(
    ['Action', 'Result'],
    [
      ['Config Files', `${totalFiles} validated`],
      ['S3 Bucket', bucket],
      ['Files Changed', String(fileCount)],
      ['Services Reloaded', services.join(', ') || 'none (auto-detected)'],
      ['EC2 Instance', instanceId],
      ['SSM Command', commandId],
    ]
  );

  logger.success('Monitoring config sync complete');
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
