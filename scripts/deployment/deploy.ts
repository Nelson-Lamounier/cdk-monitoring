/**
 * Deploy Command
 *
 * Deploys CDK stacks to AWS with proper dependency ordering.
 */

import { buildCdkArgs, runCdk } from './exec.js';
import logger from './logger.js';
import { selectProjectAndStacks, confirmDestructiveAction } from './prompts.js';
import {
  getProject,
  getAllStacksForProject,
  defaults,
  profileMap,
  type Environment,
  type StackConfig,
  type ProjectConfig,
  type ExtraContext,
} from './stacks.js';

interface DeployOptions {
  project?: string;
  stack?: string;
  environment?: Environment;
  profile?: string;
  region?: string;
  accountId?: string;
  all?: boolean;
  skipConfirmation?: boolean;
  // CloudFront context options
  domainName?: string;
  hostedZoneId?: string;
  subjectAlternativeNames?: string[];
  crossAccountRoleArn?: string;
  // Org project context options
  hostedZoneIds?: string;
  trustedAccountIds?: string;
  // Generic context options
  additionalContext?: Record<string, string>;
}

export async function deployCommand(options: DeployOptions): Promise<void> {
  let project: ProjectConfig;
  let stacks: StackConfig[];
  let deployAll: boolean;
  let environment: Environment = options.environment ?? defaults.environment;

  // Interactive mode if no project specified
  if (!options.project) {
    const selection = await selectProjectAndStacks({
      actionVerb: 'deploy',
      allowMultiple: true,
      allowAll: true,
      promptForEnvironment: true,
      defaultEnvironment: environment,
    });

    project = selection.project;
    stacks = selection.stacks;
    deployAll = selection.all;
    environment = selection.environment;
  } else {
    // CLI mode - use provided options
    const foundProject = getProject(options.project);
    if (!foundProject) {
      logger.error(`Project not found: ${options.project}`);
      logger.info(`Available projects: monitoring, nextjs, org`);
      process.exit(1);
    }
    project = foundProject;

    if (options.all) {
      stacks = getAllStacksForProject(options.project);
      deployAll = true;
    } else if (options.stack) {
      const foundStack = project.stacks.find((s) => s.id === options.stack);
      if (!foundStack) {
        logger.error(`Stack not found: ${options.stack}`);
        logger.info(`Available stacks: ${project.stacks.map((s) => s.id).join(', ')}`);
        process.exit(1);
      }
      stacks = [foundStack];
      deployAll = false;
    } else {
      // Interactive stack selection for specified project
      const selection = await selectProjectAndStacks({
        actionVerb: 'deploy',
        allowMultiple: true,
        allowAll: true,
        promptForEnvironment: true,
        defaultEnvironment: environment,
      });
      stacks = selection.stacks;
      deployAll = selection.all;
      environment = selection.environment;
    }
  }

  // Build extra context from CLI options
  const extraContext: ExtraContext = {
    // CloudFront/Edge context
    domainName: options.domainName,
    hostedZoneId: options.hostedZoneId,
    subjectAlternativeNames: options.subjectAlternativeNames,
    crossAccountRoleArn: options.crossAccountRoleArn,
    // Org project context
    hostedZoneIds: options.hostedZoneIds,
    trustedAccountIds: options.trustedAccountIds,
    // Generic additional context
    additionalContext: options.additionalContext,
  };

  // Build context
  const context = project.cdkContext(environment, extraContext);
  const actualProfile = options.profile ?? profileMap[environment];

  // Show deployment plan
  const globalRegion = options.region ?? defaults.awsRegion;
  logger.header(`Deploy ${project.name} Stacks`);
  logger.keyValue('Environment', environment);
  logger.keyValue('Profile', actualProfile);
  logger.keyValue('Region', globalRegion);
  logger.blank();

  logger.info('Stacks to deploy:');
  stacks.forEach((stack) => {
    const regionNote = stack.region && stack.region !== globalRegion
      ? ` [${stack.region}]`
      : '';
    logger.listItem(`${stack.name} (${stack.getStackName(environment)})${regionNote}`);
  });
  logger.blank();

  // Confirmation for production
  if (environment === 'production' && !options.skipConfirmation) {
    const confirmed = await confirmDestructiveAction(
      'deploy to production',
      `${stacks.length} stack(s)`,
      environment
    );
    if (!confirmed) {
      logger.warn('Deployment cancelled');
      process.exit(0);
    }
  }

  // Deploy stacks
  if (deployAll) {
    // Use CDK's --all flag for proper dependency ordering
    logger.task('Deploying all stacks...');

    const args = buildCdkArgs({
      command: 'deploy',
      all: true,
      context,
      profile: actualProfile,
      region: options.region,
      accountId: options.accountId,
      requireApproval: 'never',
    });

    const result = await runCdk(args);

    if (result.exitCode !== 0) {
      logger.error('Deployment failed');
      process.exit(1);
    }
  } else {
    // Deploy selected stacks individually (preserves order from selection)
    for (const stack of stacks) {
      const stackName = stack.getStackName(environment);
      // Use per-stack region if defined, falling back to CLI option or default
      const stackRegion = stack.region ?? options.region;
      const regionLabel = stackRegion ? ` (${stackRegion})` : '';
      logger.task(`Deploying ${stack.name}${regionLabel}...`);

      const args = buildCdkArgs({
        command: 'deploy',
        stackNames: [stackName],
        exclusively: true,
        context,
        profile: actualProfile,
        region: stackRegion,
        accountId: options.accountId,
        requireApproval: 'never',
      });

      const result = await runCdk(args);

      if (result.exitCode !== 0) {
        logger.error(`Failed to deploy ${stack.name}`);
        process.exit(1);
      }

      logger.success(`${stack.name} deployed`);
    }
  }

  logger.blank();
  logger.success(`All ${project.name} stacks deployed successfully`);
}

export default deployCommand;
