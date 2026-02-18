/**
 * Synth Command
 *
 * Synthesises CDK stacks and saves CloudFormation templates to cdk-outputs/
 *
 * The correct approach is to:
 * 1. Run `cdk synth` which generates templates in cdk.out/
 * 2. Read the generated templates from cdk.out/<stack-name>.template.json
 * 3. Convert to YAML and save to cdk-outputs/
 *
 * This avoids capturing console.log output mixed with template content.
 *
 * For optional stacks (CloudFront, WAF), you need to provide context:
 *   --domain-name=example.com --hosted-zone-id=Z123ABC
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import * as yaml from 'yaml';

import { buildCdkArgs, runCdk, getCdkProjectRoot } from './exec.js';
import logger from './logger.js';
import { selectProjectAndStacks } from './prompts.js';
import {
  getProject,
  getEffectiveStacks,
  isCloudFrontStack,
  getRequiredContextMessage,
  defaults,
  profileMap,
  type Environment,
  type StackConfig,
  type ProjectConfig,
  type ExtraContext,
} from './stacks.js';

interface SynthOptions {
  project?: string;
  stack?: string;
  environment?: Environment;
  profile?: string;
  all?: boolean;
  // CloudFront context options
  domainName?: string;
  hostedZoneId?: string;
  subjectAlternativeNames?: string[];
  /** Cross-account IAM role ARN for Route53 access */
  crossAccountRoleArn?: string;
}

/**
 * Read and convert a CloudFormation template from cdk.out to YAML
 */
async function readTemplateFromCdkOut(stackName: string): Promise<string | null> {
  try {
    // cdk.out is relative to project root
    const projectRoot = getCdkProjectRoot();
    const templatePath = join(projectRoot, defaults.cdkOutDir, `${stackName}.template.json`);
    const content = await readFile(templatePath, 'utf-8');
    const template = JSON.parse(content);
    // Convert to YAML with proper formatting
    return yaml.stringify(template, { indent: 2 });
  } catch {
    return null;
  }
}

export async function synthCommand(options: SynthOptions): Promise<void> {
  let project: ProjectConfig;
  let stacks: StackConfig[];
  let synthAll: boolean;
  let environment: Environment = options.environment ?? defaults.environment;

  // Build extra context from CLI options
  const extraContext: ExtraContext = {
    domainName: options.domainName,
    hostedZoneId: options.hostedZoneId,
    subjectAlternativeNames: options.subjectAlternativeNames,
    crossAccountRoleArn: options.crossAccountRoleArn,
  };

  const hasCloudFrontContext = !!(extraContext.domainName && extraContext.hostedZoneId && extraContext.crossAccountRoleArn);

  // Interactive mode if no project specified
  if (!options.project) {
    const selection = await selectProjectAndStacks({
      actionVerb: 'synthesise',
      allowMultiple: true,
      allowAll: true,
      promptForEnvironment: true,
      defaultEnvironment: environment,
    });

    project = selection.project;
    stacks = selection.stacks;
    synthAll = selection.all;
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
      // When "all", get effective stacks based on provided context
      // This excludes optional stacks if their required context isn't provided
      const { stacks: effectiveStacks, skipped } = getEffectiveStacks(
        options.project,
        extraContext
      );
      stacks = effectiveStacks;
      synthAll = true;

      // Warn about skipped optional stacks
      if (skipped.length > 0) {
        logger.blank();
        logger.yellow('⚠ Skipping optional stacks (no CloudFront context provided):');
        skipped.forEach((s) => {
          logger.listItem(`${s.name} - ${getRequiredContextMessage(s)}`);
        });
        logger.info(
          'To include CloudFront stacks, add: --domain-name=example.com --hosted-zone-id=Z123ABC'
        );
        logger.blank();
      }
    } else if (options.stack) {
      // Single stack mode
      const foundStack = project.stacks.find((s) => s.id === options.stack);
      if (!foundStack) {
        logger.error(`Stack not found: ${options.stack}`);
        logger.info(`Available stacks: ${project.stacks.map((s) => s.id).join(', ')}`);
        process.exit(1);
      }

      // Check if this is an optional stack that requires context
      if (isCloudFrontStack(options.stack) && !hasCloudFrontContext) {
        logger.error(`Stack "${foundStack.name}" requires CloudFront context.`);
        logger.blank();
        logger.info('Required options:');
        logger.listItem('--domain-name=example.com');
        logger.listItem('--hosted-zone-id=Z123ABC');
        if (foundStack.requiredContext?.includes('enableWaf')) {
          logger.listItem('--enable-waf');
        }
        logger.blank();
        logger.info('Example:');
        logger.dim(
          `  npx ts-node cli.ts synth -p nextjs -s ${options.stack} -e ${environment} \\`
        );
        logger.dim('    --domain-name=mysite.com --hosted-zone-id=Z123ABC');
        process.exit(1);
      }

      stacks = [foundStack];
      synthAll = false;
    } else {
      // Interactive stack selection for specified project
      const selection = await selectProjectAndStacks({
        actionVerb: 'synthesise',
        allowMultiple: true,
        allowAll: true,
        promptForEnvironment: true,
        defaultEnvironment: environment,
      });
      stacks = selection.stacks;
      synthAll = selection.all;
      environment = selection.environment;
    }
  }

  // Build context with extra CloudFront options
  const context = project.cdkContext(environment, extraContext);
  const actualProfile = options.profile ?? profileMap[environment];
  const projectRoot = getCdkProjectRoot();
  const outputDir = join(projectRoot, defaults.outputDir);

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  logger.header(`Synthesising ${project.name} Stacks`);
  logger.keyValue('Environment', environment);
  logger.keyValue('Profile', actualProfile);
  logger.keyValue('Output Directory', outputDir);

  if (hasCloudFrontContext) {
    logger.keyValue('CloudFront Domain', extraContext.domainName!);
    logger.keyValue('Hosted Zone ID', extraContext.hostedZoneId!);
    logger.keyValue('Cross-Account Role', extraContext.crossAccountRoleArn!);
    logger.keyValue('WAF', 'Enabled (mandatory)');
  }

  logger.blank();

  const synthesisedFiles: string[] = [];

  // Build stack names for synthesis
  const stackNames = stacks.map((s) => s.getStackName(environment));


  // Run synth - this generates templates in cdk.out/
  logger.task(`Synthesising ${synthAll ? `all ${stacks.length}` : stacks.length} stacks...`);

  const args = buildCdkArgs({
    command: 'synth',
    stackNames: synthAll ? undefined : stackNames,
    all: synthAll,
    context,
    profile: actualProfile,
    quiet: false, // Don't use quiet, we want to see progress
  });

  // Run synth without capturing output - let it print to console
  const result = await runCdk(args, { captureOutput: false });

  if (result.exitCode !== 0) {
   logger.error('Failed to synthesise stacks');
    process.exit(1);
  }

  logger.blank();
  logger.task('Saving templates to cdk-outputs/...');

  // Read templates from cdk.out and save as YAML
  for (const stack of stacks) {
    const stackName = stack.getStackName(environment);
    const yamlContent = await readTemplateFromCdkOut(stackName);

    if (yamlContent) {
      const outputPath = join(outputDir, `${stackName}.yaml`);
      await writeFile(outputPath, yamlContent, 'utf-8');
      synthesisedFiles.push(outputPath);
      logger.success(`${stack.name} → ${stackName}.yaml`);
    } else {
      logger.warn(`Template not found for ${stackName} in cdk.out/`);
    }
  }

  // Summary
  logger.blank();
  logger.header('Synthesis Complete');
  logger.green(`${synthesisedFiles.length} templates saved to ${outputDir}:`);
  synthesisedFiles.forEach((file) => {
    logger.listItem(file.replace(`${outputDir}/`, ''));
  });
}

export default synthCommand;
