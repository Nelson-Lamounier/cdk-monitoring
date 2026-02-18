/**
 * CDK Execution Utility
 *
 * Runs CDK commands with proper argument building.
 */

import { spawn } from 'child_process';

export interface CdkArgsOptions {
  command: 'synth' | 'deploy' | 'diff' | 'destroy' | 'list' | 'bootstrap';
  stackNames?: string[];
  all?: boolean;
  exclusively?: boolean;
  context?: Record<string, string>;
  profile?: string;
  region?: string;
  accountId?: string;
  requireApproval?: 'never' | 'broadening' | 'any-change';
  force?: boolean;
  quiet?: boolean;
}

export interface CdkResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Build CDK command arguments
 */
export function buildCdkArgs(options: CdkArgsOptions): string[] {
  const args: string[] = [options.command];

  // Stack names or --all
  if (options.all) {
    args.push('--all');
  } else if (options.stackNames?.length) {
    args.push(...options.stackNames);
  }

  // Exclusively flag (deploy only specified stacks, skip dependencies)
  if (options.exclusively) {
    args.push('--exclusively');
  }

  // Context arguments
  if (options.context) {
    Object.entries(options.context).forEach(([key, value]) => {
      args.push('-c', `${key}=${value}`);
    });
  }

  // AWS profile
  if (options.profile) {
    args.push('--profile', options.profile);
  }

  // Region (via context for CDK)
  if (options.region) {
    args.push('-c', `region=${options.region}`);
  }

  // Account ID (via context for CDK)
  if (options.accountId) {
    args.push('-c', `account=${options.accountId}`);
  }

  // Require approval
  if (options.requireApproval) {
    args.push('--require-approval', options.requireApproval);
  }

  // Force (for destroy)
  if (options.force) {
    args.push('--force');
  }

  // Quiet mode
  if (options.quiet) {
    args.push('--quiet');
  }

  return args;
}

/**
 * Run CDK command
 */
export async function runCdk(
  args: string[],
  options: { captureOutput?: boolean; cwd?: string } = {}
): Promise<CdkResult> {
  return new Promise((resolve) => {
    // Default to project root so CDK can find cdk.json
    const cwd = options.cwd || getCdkProjectRoot();

    // Use npx to run cdk
    const child = spawn('npx', ['cdk', ...args], {
      cwd,
      stdio: options.captureOutput ? 'pipe' : 'inherit',
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    if (options.captureOutput) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: error.message,
      });
    });
  });
}

/**
 * Run a shell command (for utilities like clean, test, etc.)
 */
export async function runCommand(
  command: string,
  args: string[] = [],
  options: { captureOutput?: boolean; cwd?: string } = {}
): Promise<CdkResult> {
  return new Promise((resolve) => {
    const cwd = options.cwd || process.cwd();

    const child = spawn(command, args, {
      cwd,
      stdio: options.captureOutput ? 'pipe' : 'inherit',
      shell: true,
    });

    let stdout = '';
    let stderr = '';

    if (options.captureOutput) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: error.message,
      });
    });
  });
}

/**
 * Get the root directory of the CDK project
 * Scripts are in scripts/deployment, so go up two levels from the script location
 */
export function getCdkProjectRoot(): string {
  // Use import.meta.url to get the current script's location
  const scriptDir = new URL('.', import.meta.url).pathname;
  // Go up two levels: scripts/deployment -> scripts -> project root
  return new URL('../..', `file://${scriptDir}`).pathname;
}
