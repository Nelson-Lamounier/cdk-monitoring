/**
 * Interactive Prompts
 *
 * Inquirer-based prompts for project, environment, and stack selection.
 */

import inquirer from 'inquirer';

import logger from './logger.js';
import {
  projects,
  getProject,
  defaults,
  type Environment,
  type StackConfig,
  type ProjectConfig,
} from './stacks.js';

// =============================================================================
// TYPES
// =============================================================================

export interface SelectionResult {
  project: ProjectConfig;
  stacks: StackConfig[];
  environment: Environment;
  all: boolean;
}

export interface SelectProjectAndStacksOptions {
  actionVerb?: string; // e.g., 'deploy', 'synthesise', 'destroy'
  allowMultiple?: boolean;
  allowAll?: boolean;
  promptForEnvironment?: boolean;
  defaultEnvironment?: Environment;
}

// =============================================================================
// PROMPTS
// =============================================================================

/**
 * Select a project interactively
 */
export async function selectProject(): Promise<ProjectConfig> {
  const { projectId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'projectId',
      message: 'Select project:',
      choices: projects.map((p) => ({
        name: `${p.name} - ${p.description}`,
        value: p.id,
        short: p.name,
      })),
    },
  ]);

  return getProject(projectId)!;
}

/**
 * Select environment interactively
 */
export async function selectEnvironment(
  defaultEnv: Environment = defaults.environment
): Promise<Environment> {
  const { environment } = await inquirer.prompt([
    {
      type: 'list',
      name: 'environment',
      message: 'Select environment:',
      choices: [
        { name: '🟢 development', value: 'development' },
        { name: '🟡 staging', value: 'staging' },
        { name: '🔴 production', value: 'production' },
      ],
      default: defaultEnv,
    },
  ]);

  return environment;
}

/**
 * Select stacks from a project interactively
 */
export async function selectStacks(
  project: ProjectConfig,
  options: { allowMultiple?: boolean; allowAll?: boolean; actionVerb?: string } = {}
): Promise<{ stacks: StackConfig[]; all: boolean }> {
  const { allowMultiple = true, allowAll = true, actionVerb = 'select' } = options;

  // Build choices
  const stackChoices = project.stacks.map((s) => ({
    name: `${s.name}${s.optional ? ' (optional)' : ''}`,
    value: s.id,
    short: s.id,
  }));

  if (allowAll) {
    stackChoices.unshift({
      name: `📦 All stacks (${project.stacks.length} stacks)`,
      value: '__ALL__',
      short: 'All',
    });
  }

  if (allowMultiple) {
    // Checkbox for multiple selection
    const { selectedIds } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedIds',
        message: `Select stacks to ${actionVerb}:`,
        choices: stackChoices,
        validate: (input: string[]) => {
          if (input.length === 0) {
            return 'Please select at least one stack';
          }
          return true;
        },
      },
    ]);

    if (selectedIds.includes('__ALL__')) {
      return { stacks: project.stacks, all: true };
    }

    const stacks = project.stacks.filter((s) => selectedIds.includes(s.id));
    return { stacks, all: false };
  } else {
    // List for single selection
    const { selectedId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedId',
        message: `Select stack to ${actionVerb}:`,
        choices: stackChoices,
      },
    ]);

    if (selectedId === '__ALL__') {
      return { stacks: project.stacks, all: true };
    }

    const stack = project.stacks.find((s) => s.id === selectedId)!;
    return { stacks: [stack], all: false };
  }
}

/**
 * Combined prompt for project and stacks selection
 */
export async function selectProjectAndStacks(
  options: SelectProjectAndStacksOptions = {}
): Promise<SelectionResult> {
  const {
    actionVerb = 'select',
    allowMultiple = true,
    allowAll = true,
    promptForEnvironment = true,
    defaultEnvironment = defaults.environment,
  } = options;

  // 1. Select project
  const project = await selectProject();

  // 2. Select environment
  let environment = defaultEnvironment;
  if (promptForEnvironment) {
    environment = await selectEnvironment(defaultEnvironment);
  }

  // 3. Select stacks
  const { stacks, all } = await selectStacks(project, {
    allowMultiple,
    allowAll,
    actionVerb,
  });

  return { project, stacks, environment, all };
}

/**
 * Confirm an action
 */
export async function confirmAction(
  message: string,
  defaultValue = false
): Promise<boolean> {
  const { confirmed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: defaultValue,
    },
  ]);

  return confirmed;
}

/**
 * Confirm a destructive action (with extra warning)
 */
export async function confirmDestructiveAction(
  action: string,
  resourceName: string,
  environment: Environment
): Promise<boolean> {
  logger.blank();
  logger.yellow(`⚠️  You are about to ${action}:`);
  logger.keyValue('Resource', resourceName);
  logger.keyValue('Environment', environment);
  logger.blank();

  if (environment === 'production') {
    logger.red('🚨 THIS IS A PRODUCTION ENVIRONMENT 🚨');
    logger.blank();

    // Require typing the environment name for production
    const { confirmation } = await inquirer.prompt([
      {
        type: 'input',
        name: 'confirmation',
        message: 'Type "production" to confirm:',
      },
    ]);

    return confirmation === 'production';
  }

  return confirmAction(`Proceed with ${action}?`, false);
}

/**
 * Select AWS profile
 */
export async function selectProfile(
  defaultProfile: string
): Promise<string> {
  const { useDefault } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useDefault',
      message: `Use profile "${defaultProfile}"?`,
      default: true,
    },
  ]);

  if (useDefault) {
    return defaultProfile;
  }

  const { profile } = await inquirer.prompt([
    {
      type: 'input',
      name: 'profile',
      message: 'Enter AWS profile name:',
      default: defaultProfile,
    },
  ]);

  return profile;
}
