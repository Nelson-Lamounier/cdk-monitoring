/**
 * CDK Execution Utility — Thin Wrapper
 *
 * CDK-coupled wrapper around the shared `@repo/script-utils/exec.js`
 * execution engine. This module:
 *
 *   - Re-exports generic execution types for convenience
 *   - Provides {@link buildCdkArgs} to translate typed options into CLI args
 *   - Provides {@link runCdk} to invoke `npx cdk` with sensible defaults
 *   - Provides {@link getCdkProjectRoot} to locate the `infra/` directory
 *
 * Scripts that only need generic process execution should import directly
 * from `@repo/script-utils/exec.js` instead.
 *
 * @module
 */

import { resolve } from 'path';

import {
  executeChildProcess,
  type CommandResult,
  type ExecuteOptions,
} from '@repo/script-utils/exec.js';

// Re-export shared types and functions for backward compatibility
export { executeChildProcess, runCommand, type CommandResult, type ExecuteOptions } from '@repo/script-utils/exec.js';

/**
 * Alias for backward compatibility — existing consumers reference
 * `CdkResult` in their type annotations.
 */
export type CdkResult = CommandResult;

// =============================================================================
// CDK Argument Builder
// =============================================================================

/**
 * Typed options for building CDK CLI arguments.
 *
 * Consumers pass a `CdkArgsOptions` object to {@link buildCdkArgs},
 * which translates it into a `string[]` suitable for `npx cdk`.
 */
export interface CdkArgsOptions {
  /** CDK command to run */
  command: 'synth' | 'deploy' | 'diff' | 'destroy' | 'list' | 'bootstrap';
  /** Specific stack names to target */
  stackNames?: string[];
  /** Target all stacks */
  all?: boolean;
  /** Deploy only specified stacks, skip dependencies */
  exclusively?: boolean;
  /** CDK context key-value pairs (`-c key=value`) */
  context?: Record<string, string>;
  /** AWS CLI profile */
  profile?: string;
  /** AWS region (passed as CDK context) */
  region?: string;
  /** AWS account ID (passed as CDK context) */
  accountId?: string;
  /** Approval level for security-sensitive changes */
  requireApproval?: 'never' | 'broadening' | 'any-change';
  /** Force destroy without confirmation */
  force?: boolean;
  /** Suppress non-error output */
  quiet?: boolean;
  /** Deploy method: `'direct'` avoids ChangeSetNotFoundException in CI */
  method?: 'direct' | 'change-set';
  /** Progress display style */
  progress?: 'events' | 'bar';
  /** Path to write CDK stack outputs JSON */
  outputsFile?: string;
  /** CloudFormation tags to apply to all resources */
  tags?: Record<string, string>;
  /** If `true`, `cdk diff` exits with code 1 when differences are found */
  fail?: boolean;
}

/**
 * Translate a typed options object into a CDK CLI argument array.
 *
 * @param options - Typed CDK command options.
 * @returns A `string[]` ready to pass to `npx cdk`.
 *
 * @example
 * ```ts
 * const args = buildCdkArgs({
 *   command: 'deploy',
 *   stackNames: ['MyStack'],
 *   exclusively: true,
 *   requireApproval: 'never',
 *   method: 'direct',
 * });
 * // → ['deploy', 'MyStack', '--exclusively', '--require-approval', 'never', '--method=direct']
 * ```
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
    for (const [key, value] of Object.entries(options.context)) {
      args.push('-c', `${key}=${value}`);
    }
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

  // Deploy method (direct bypasses changesets)
  if (options.method) {
    args.push(`--method=${options.method}`);
  }

  // Progress display
  if (options.progress) {
    args.push('--progress', options.progress);
  }

  // Outputs file
  if (options.outputsFile) {
    args.push('--outputs-file', options.outputsFile);
  }

  // CloudFormation tags
  if (options.tags) {
    for (const [key, value] of Object.entries(options.tags)) {
      args.push('--tags', `${key}=${value}`);
    }
  }

  // Fail flag (makes `cdk diff` exit 1 on differences)
  if (options.fail) {
    args.push('--fail');
  }

  return args;
}

// =============================================================================
// CDK Runner
// =============================================================================

/**
 * Run a CDK command using `npx cdk` with the given arguments.
 *
 * Delegates to the shared {@link executeChildProcess} from
 * `@repo/script-utils/exec.js`. Defaults the working directory to
 * the CDK project root (where `cdk.json` lives).
 *
 * @param args    - CDK CLI arguments (typically from {@link buildCdkArgs}).
 * @param options - Execution options (capture output, override cwd).
 * @returns A promise that resolves with the {@link CommandResult}.
 *
 * @example
 * ```ts
 * const args = buildCdkArgs({ command: 'synth', all: true });
 * const result = await runCdk(args, { captureOutput: true });
 * ```
 */
export async function runCdk(
  args: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  return executeChildProcess('npx', ['cdk', ...args], {
    ...options,
    cwd: options.cwd ?? getCdkProjectRoot(),
  });
}

// =============================================================================
// CDK Project Root
// =============================================================================

/**
 * Resolve the root directory of the CDK project (where `cdk.json` lives).
 *
 * Scripts live in `infra/scripts/deployment/`, so this goes up two levels
 * from `__dirname`. Uses `__dirname` because `infra/` is CommonJS (no
 * `"type": "module"` in `infra/package.json`).
 *
 * @returns Absolute path to the CDK project root.
 */
export function getCdkProjectRoot(): string {
  return resolve(__dirname, '../..');
}
