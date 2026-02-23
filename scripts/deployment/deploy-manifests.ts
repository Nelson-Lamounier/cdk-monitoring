#!/usr/bin/env npx tsx
/**
 * Deploy K8s Manifests via SSM
 *
 * Shared script for deploying Kubernetes manifests to the k3s cluster
 * via SSM Run Command. Used by both monitoring and NextJS K8s pipelines.
 *
 * Steps:
 *   1. Find the k3s server instance (ASG query → SSM fallback)
 *   2. Wait for SSM Agent to be online
 *   3. Show boot diagnostics (user-data.log tail)
 *   4. Send the project-specific SSM deploy-manifests document
 *   5. Poll for completion with progress indicators
 *   6. Trigger ArgoCD sync (best-effort)
 *   7. Collect deployment logs and write to GITHUB_STEP_SUMMARY
 *
 * Usage:
 *   npx tsx scripts/deployment/deploy-manifests.ts monitoring development
 *   npx tsx scripts/deployment/deploy-manifests.ts nextjs production --region eu-west-1
 *
 * Environment:
 *   AWS_REGION            Override region (default: eu-west-1)
 *   GITHUB_STEP_SUMMARY   Path to GitHub Actions step summary file
 *   GITHUB_OUTPUT          Path to GitHub Actions output file
 *
 * Exit codes:
 *   0 = manifests deployed successfully (or skipped — no instance found)
 *   1 = deployment failed
 */

import { appendFileSync, existsSync } from 'fs';

import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  SendCommandCommand,
} from '@aws-sdk/client-ssm';

import logger from './logger.js';

// =============================================================================
// Types
// =============================================================================

type Project = 'monitoring' | 'nextjs';
type Environment = 'development' | 'production';

interface ProjectConfig {
  /** ASG name pattern: k8s-{env}-asg */
  asgName: string;
  /** SSM parameter for instance-id fallback */
  ssmInstancePath: string;
  /** SSM document name for deploy-manifests */
  ssmDocumentName: string;
  /** ArgoCD app name for sync trigger */
  argoAppName: string;
}

// =============================================================================
// CLI
// =============================================================================

const args = process.argv.slice(2);
const project = args[0] as Project;
const environment = args[1] as Environment;
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');

if (!project || !environment) {
  console.error('Usage: deploy-manifests.ts <project> <environment> [--region <region>]');
  console.error('  project:     monitoring | nextjs');
  console.error('  environment: development | production');
  process.exit(1);
}

if (!['monitoring', 'nextjs'].includes(project)) {
  console.error(`Unknown project: ${project}. Must be "monitoring" or "nextjs".`);
  process.exit(1);
}

if (!['development', 'production'].includes(environment)) {
  console.error(`Unknown environment: ${environment}. Must be "development" or "production".`);
  process.exit(1);
}

// =============================================================================
// Project Config
// =============================================================================

/**
 * Build project-specific configuration.
 *
 * Both projects target the same k3s server instance (where kubectl runs).
 * The ASG and SSM paths reference the k3s server, not the agent.
 *
 * SSM document naming (from unified CDK compute-stack, namePrefix = 'k8s-{env}'):
 *   - Monitoring: k8s-{env}-deploy-manifests
 *   - NextJS:     k8s-{env}-deploy-app-manifests
 */
function getProjectConfig(project: Project, env: Environment): ProjectConfig {
  const asgName = `k8s-${env}-asg`;
  const ssmInstancePath = `/k8s/${env}/instance-id`;

  if (project === 'monitoring') {
    return {
      asgName,
      ssmInstancePath,
      ssmDocumentName: `k8s-${env}-deploy-manifests`,
      argoAppName: 'monitoring',
    };
  }

  // NextJS: uses the dedicated app-manifests SSM document
  return {
    asgName,
    ssmInstancePath,
    ssmDocumentName: `k8s-${env}-deploy-app-manifests`,
    argoAppName: 'nextjs',
  };
}

// =============================================================================
// AWS Clients
// =============================================================================

const ssmClient = new SSMClient({ region });
const asgClient = new AutoScalingClient({ region });

// =============================================================================
// Constants
// =============================================================================

const SSM_AGENT_TIMEOUT = 300;    // seconds to wait for SSM Agent
const SSM_AGENT_POLL = 5;         // seconds between SSM Agent polls
const DEPLOY_TIMEOUT = 600;       // seconds to wait for SSM command
const DEPLOY_POLL = 10;           // seconds between SSM command polls
const BOOT_LOG_TIMEOUT = 30;      // seconds to wait for boot log command

// =============================================================================
// Step 1: Find Instance
// =============================================================================

/**
 * Find the k3s server instance ID.
 * Strategy: ASG query first (always up-to-date), SSM fallback second.
 */
async function findInstance(config: ProjectConfig): Promise<string | null> {
  logger.task('Finding k3s server instance...');
  logger.keyValue('ASG', config.asgName);

  // 1. ASG query — get the InService instance
  try {
    const response = await asgClient.send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [config.asgName],
      }),
    );

    const instances = response.AutoScalingGroups?.[0]?.Instances ?? [];
    const inService = instances.find((i) => i.LifecycleState === 'InService');

    if (inService?.InstanceId) {
      logger.success(`Instance found via ASG: ${inService.InstanceId}`);
      return inService.InstanceId;
    }

    logger.warn('No InService instance in ASG — trying SSM fallback');
  } catch (err) {
    logger.warn(`ASG query failed: ${(err as Error).message}`);
  }

  // 2. SSM fallback — read from parameter store
  logger.keyValue('SSM path', config.ssmInstancePath);
  try {
    const response = await ssmClient.send(
      new GetParameterCommand({ Name: config.ssmInstancePath }),
    );

    const instanceId = response.Parameter?.Value;
    if (instanceId) {
      logger.success(`Instance found via SSM: ${instanceId}`);
      return instanceId;
    }
  } catch {
    // Parameter not found
  }

  return null;
}

// =============================================================================
// Step 2: Wait for SSM Agent
// =============================================================================

/**
 * Poll until the SSM Agent on the instance reports "Online".
 */
async function waitForSsmAgent(instanceId: string): Promise<void> {
  logger.task(`Waiting for SSM Agent on ${instanceId}...`);

  let waited = 0;

  while (true) {
    try {
      const response = await ssmClient.send(
        new DescribeInstanceInformationCommand({
          Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
        }),
      );

      const status = response.InstanceInformationList?.[0]?.PingStatus;
      if (status === 'Online') {
        logger.success(`SSM Agent online (waited ${waited}s)`);
        return;
      }
    } catch {
      // Ignore — agent not registered yet
    }

    if (waited >= SSM_AGENT_TIMEOUT) {
      throw new Error(`SSM Agent not online after ${SSM_AGENT_TIMEOUT}s`);
    }

    await sleep(SSM_AGENT_POLL * 1000);
    waited += SSM_AGENT_POLL;
  }
}

// =============================================================================
// Step 3: Show Boot Diagnostics
// =============================================================================

/**
 * Fetch the last 80 lines of /var/log/user-data.log for boot diagnostics.
 */
async function showBootDiagnostics(instanceId: string): Promise<void> {
  logger.task('Fetching boot diagnostics (user-data.log)...');

  try {
    const sendResponse = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands: ['cat /var/log/user-data.log | tail -80'] },
      }),
    );

    const commandId = sendResponse.Command?.CommandId;
    if (!commandId) {
      logger.warn('Failed to send boot diagnostics command');
      return;
    }

    // Wait for completion
    let waited = 0;
    while (waited < BOOT_LOG_TIMEOUT) {
      await sleep(2000);
      waited += 2;

      try {
        const result = await ssmClient.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
          }),
        );

        if (result.Status === 'Success' || result.Status === 'Failed') {
          if (result.StandardOutputContent) {
            logger.verbose('=== User-Data Log (last 80 lines) ===');
            for (const line of result.StandardOutputContent.split('\n').slice(-30)) {
              logger.debug(line);
            }
            logger.verbose('=== End User-Data Log ===');
          }
          return;
        }
      } catch {
        // Not ready yet
      }
    }

    logger.warn('Boot diagnostics timed out — continuing');
  } catch (err) {
    logger.warn(`Could not retrieve boot logs: ${(err as Error).message}`);
  }
}

// =============================================================================
// Step 4: Deploy Manifests via SSM
// =============================================================================

/**
 * Send the project-specific SSM deploy-manifests document and poll to completion.
 * Returns the command ID for log collection.
 */
async function deployManifests(
  instanceId: string,
  config: ProjectConfig,
): Promise<string> {
  logger.task(`Deploying manifests via SSM: ${config.ssmDocumentName}`);
  logger.keyValue('Instance', instanceId);
  logger.keyValue('Document', config.ssmDocumentName);

  const sendResponse = await ssmClient.send(
    new SendCommandCommand({
      DocumentName: config.ssmDocumentName,
      Targets: [{ Key: 'instanceids', Values: [instanceId] }],
      TimeoutSeconds: DEPLOY_TIMEOUT,
    }),
  );

  const commandId = sendResponse.Command?.CommandId;
  if (!commandId) {
    throw new Error('Failed to send SSM command — no CommandId returned');
  }

  logger.keyValue('Command ID', commandId);

  // Set GitHub Actions output
  setOutput('command_id', commandId);

  // Poll for completion
  let waited = 0;

  while (true) {
    await sleep(DEPLOY_POLL * 1000);
    waited += DEPLOY_POLL;

    let status = 'InProgress';

    try {
      const result = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }),
      );
      status = result.Status ?? 'InProgress';

      if (status === 'Success') {
        logger.success('Manifest deployment completed successfully');
        return commandId;
      }

      if (['Failed', 'Cancelled', 'TimedOut'].includes(status)) {
        logger.error(`SSM command ${status}`);

        // Log stdout/stderr for debugging
        if (result.StandardOutputContent) {
          logger.info('--- SSM stdout ---');
          console.log(result.StandardOutputContent);
        }
        if (result.StandardErrorContent) {
          logger.info('--- SSM stderr ---');
          console.log(result.StandardErrorContent);
        }

        throw new Error(`SSM command ${status}`);
      }
    } catch (err) {
      if ((err as Error).message.startsWith('SSM command')) {
        throw err;
      }
      // GetCommandInvocation may throw if invocation isn't ready yet
    }

    if (waited >= DEPLOY_TIMEOUT) {
      throw new Error(`SSM command timed out after ${DEPLOY_TIMEOUT}s`);
    }

    logger.info(`  ⏳ Status: ${status} (${waited}s / ${DEPLOY_TIMEOUT}s)`);
  }
}

// =============================================================================
// Step 5: Trigger ArgoCD Sync
// =============================================================================

/**
 * Best-effort ArgoCD sync trigger. Non-blocking, non-fatal.
 */
async function triggerArgoSync(
  instanceId: string,
  appName: string,
): Promise<void> {
  logger.task(`Triggering ArgoCD sync for ${appName}...`);

  try {
    const command = `if command -v argocd &>/dev/null; then argocd app sync ${appName} --grpc-web 2>/dev/null || echo "ArgoCD sync skipped (not configured)"; else echo "ArgoCD not installed — skipping sync"; fi`;

    const response = await ssmClient.send(
      new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
        Targets: [{ Key: 'instanceids', Values: [instanceId] }],
        Parameters: { commands: [command] },
        TimeoutSeconds: 60,
      }),
    );

    if (response.Command?.CommandId) {
      logger.success(`ArgoCD sync triggered: ${response.Command.CommandId}`);
    } else {
      logger.warn('ArgoCD sync skipped (SSM command failed)');
    }
  } catch {
    logger.warn('ArgoCD sync skipped');
  }
}

// =============================================================================
// Step 6: Collect Deployment Logs
// =============================================================================

/**
 * Fetch SSM command output and write to GITHUB_STEP_SUMMARY.
 */
async function collectLogs(
  commandId: string,
  instanceId: string,
): Promise<void> {
  logger.task('Collecting deployment logs...');

  try {
    const result = await ssmClient.send(
      new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId,
      }),
    );

    // Write to GITHUB_STEP_SUMMARY
    writeSummary(`### 📋 Manifest Deployment — ${project} (${environment})`);
    writeSummary('```');
    writeSummary(result.StandardOutputContent ?? '(stdout unavailable)');
    writeSummary('```');

    if (result.StandardErrorContent && result.StandardErrorContent !== 'None') {
      writeSummary('### ⚠️ Manifest Deployment — stderr');
      writeSummary('```');
      writeSummary(result.StandardErrorContent);
      writeSummary('```');
    }

    logger.success('Deployment logs collected');
  } catch (err) {
    logger.warn(`Could not collect logs: ${(err as Error).message}`);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write a line to GITHUB_STEP_SUMMARY (no-op if not in CI) */
function writeSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath && existsSync(summaryPath)) {
    appendFileSync(summaryPath, line + '\n');
  }
}

/** Set a GitHub Actions output variable (no-op if not in CI) */
function setOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath && existsSync(outputPath)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  logger.setEnvironment(environment);
  logger.header(`Deploy K8s Manifests — ${project} (${environment})`);

  const config = getProjectConfig(project, environment);

  logger.keyValue('Project', project);
  logger.keyValue('Environment', environment);
  logger.keyValue('Region', region);
  logger.keyValue('SSM Document', config.ssmDocumentName);
  logger.blank();

  // Step 1: Find instance
  const instanceId = await findInstance(config);

  if (!instanceId) {
    logger.warn('No k3s server instance found — skipping manifest deployment');
    logger.info('First boot will apply manifests automatically via UserData');
    setOutput('skip', 'true');
    return;
  }

  setOutput('skip', 'false');
  setOutput('instance_id', instanceId);

  // Step 2: Wait for SSM Agent
  await waitForSsmAgent(instanceId);

  // Step 3: Boot diagnostics
  await showBootDiagnostics(instanceId);

  // Step 4: Deploy manifests
  const commandId = await deployManifests(instanceId, config);

  // Step 5: ArgoCD sync (best-effort)
  await triggerArgoSync(instanceId, config.argoAppName);

  // Step 6: Collect logs
  await collectLogs(commandId, instanceId);

  logger.blank();
  logger.success('Deploy-manifests completed');
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);

  // Still try to collect logs on failure
  writeSummary('### ❌ Deploy-Manifests Failed');
  writeSummary(`Error: ${err.message}`);

  process.exit(1);
});
