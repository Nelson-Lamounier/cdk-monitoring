#!/usr/bin/env node

/**
 * CDK Infrastructure CLI
 *
 * A TypeScript-based CLI for managing multi-project CDK infrastructure.
 * Replaces the Makefile with typed, interactive commands.
 *
 * Usage:
 *   yarn cdk:synth              # Interactive mode
 *   yarn cdk:synth --project monitoring --stack vpc
 *   yarn cdk:deploy --project nextjs --all
 */

import { Command } from 'commander';
import * as dotenv from 'dotenv';

import { deployCommand } from './deploy.js';
import { buildCdkArgs, runCdk, runCommand } from './exec.js';
import logger from './logger.js';
import { selectProjectAndStacks, confirmDestructiveAction } from './prompts.js';
import { reconfigureMonitoring } from './reconfigure-monitoring.js';
import { projects, defaults, profileMap, type Environment } from './stacks.js';
import { synthCommand } from './synth.js';

// Load environment variables from .env file
dotenv.config();

const program = new Command();

program
  .name('cdk-cli')
  .description('Multi-project CDK Infrastructure CLI')
  .version('1.0.0');

// =============================================================================
// CDK COMMANDS
// =============================================================================

program
  .command('synth')
  .description('Synthesise CDK stacks and save CloudFormation templates')
  .option('-p, --project <project>', 'Project ID (monitoring, nextjs, org)')
  .option('-s, --stack <stack>', 'Stack ID (vpc, data, compute, networking, application, api, edge)')
  .option('-e, --environment <env>', 'Environment (development, staging, production)')
  .option('--profile <profile>', 'AWS profile to use')
  .option('-a, --all', 'Synth all stacks in the project')
  // CloudFront context options for optional stacks
  .option('--domain-name <domain>', 'Domain name for CloudFront (e.g., mysite.com)')
  .option('--hosted-zone-id <id>', 'Route53 Hosted Zone ID')
  .option('--sans <domains>', 'Subject Alternative Names (comma-separated)')
  .option('--cross-account-role-arn <arn>', 'IAM role ARN for cross-account Route53 access')
  .action(async (options) => {
    await synthCommand({
      project: options.project,
      stack: options.stack,
      environment: options.environment as Environment,
      profile: options.profile,
      all: options.all,
      // CloudFront context
      domainName: options.domainName,
      hostedZoneId: options.hostedZoneId,
      subjectAlternativeNames: options.sans?.split(',').map((s: string) => s.trim()),
      crossAccountRoleArn: options.crossAccountRoleArn,
    });
  });

program
  .command('deploy')
  .description('Deploy CDK stacks to AWS')
  .option('-p, --project <project>', 'Project ID (monitoring, nextjs, org)')
  .option('-s, --stack <stack>', 'Stack ID (vpc, data, compute, networking, application, api, edge)')
  .option('-e, --environment <env>', 'Environment (development, staging, production)')
  .option('--profile <profile>', 'AWS profile to use')
  .option('--region <region>', 'AWS region')
  .option('--account-id <accountId>', 'AWS account ID')
  .option('-a, --all', 'Deploy all stacks in the project')
  .option('-y, --yes', 'Skip confirmation prompts')
  // Generic context option for arbitrary key=value pairs
  .option('-c, --context <key=value...>', 'Additional CDK context (can be used multiple times)')
  // CloudFront context options for optional stacks
  .option('--domain-name <domain>', 'Domain name for CloudFront (e.g., mysite.com)')
  .option('--hosted-zone-id <id>', 'Route53 Hosted Zone ID')
  .option('--sans <domains>', 'Subject Alternative Names (comma-separated)')
  .option('--cross-account-role-arn <arn>', 'IAM role ARN for cross-account Route53 access')
  // Org project context options
  .option('--hosted-zone-ids <ids>', 'Comma-separated list of hosted zone IDs (for Org project)')
  .option('--trusted-account-ids <ids>', 'Comma-separated list of trusted account IDs (for Org project)')
  .action(async (options) => {
    // Parse generic context options (key=value pairs)
    const genericContext: Record<string, string> = {};
    if (options.context) {
      for (const kv of options.context) {
        const [key, ...valueParts] = kv.split('=');
        if (key && valueParts.length > 0) {
          genericContext[key] = valueParts.join('=');
        }
      }
    }

    await deployCommand({
      project: options.project,
      stack: options.stack,
      environment: options.environment as Environment,
      profile: options.profile,
      region: options.region,
      accountId: options.accountId,
      all: options.all,
      skipConfirmation: options.yes,
      // CloudFront context
      domainName: options.domainName,
      hostedZoneId: options.hostedZoneId,
      subjectAlternativeNames: options.sans?.split(',').map((s: string) => s.trim()),
      crossAccountRoleArn: options.crossAccountRoleArn,
      // Org project context
      hostedZoneIds: options.hostedZoneIds,
      trustedAccountIds: options.trustedAccountIds,
      // Generic context
      additionalContext: genericContext,
    });
  });

program
  .command('diff')
  .description('Show differences between deployed and local stacks')
  .option('-p, --project <project>', 'Project ID (monitoring, nextjs, org)')
  .option('-s, --stack <stack>', 'Stack ID (vpc, data, compute, networking, application, api, edge)')
  .option('-e, --environment <env>', 'Environment (development, staging, production)')
  .option('--profile <profile>', 'AWS profile to use')
  .option('-a, --all', 'Diff all stacks in the project')
  .action(async (options) => {
    const environment = (options.environment as Environment) ?? defaults.environment;

    if (!options.project) {
      // Interactive mode
      const selection = await selectProjectAndStacks({
        actionVerb: 'diff',
        allowMultiple: true,
        allowAll: true,
        promptForEnvironment: true,
        defaultEnvironment: environment,
      });

      const context = selection.project.cdkContext(selection.environment);
      const stackNames = selection.all
        ? []
        : selection.stacks.map((s) => s.getStackName(selection.environment));

      const args = buildCdkArgs({
        command: 'diff',
        stackNames: selection.all ? undefined : stackNames,
        all: selection.all,
        context,
        profile: options.profile,
      });

      await runCdk(args);
    } else {
      // CLI mode
      logger.info('Diff command in CLI mode - use -p and -s options');
    }
  });

program
  .command('destroy')
  .description('Destroy CDK stacks (with safety confirmations)')
  .option('-p, --project <project>', 'Project ID (monitoring, nextjs, org)')
  .option('-s, --stack <stack>', 'Stack ID (vpc, data, compute, networking, application, api, edge)')
  .option('-e, --environment <env>', 'Environment (development, staging, production)')
  .option('--profile <profile>', 'AWS profile to use')
  .option('-a, --all', 'Destroy all stacks in the project')
  .option('-f, --force', 'Skip confirmation prompts (dangerous!)')
  .action(async (options) => {
    const environment = (options.environment as Environment) ?? defaults.environment;

    // Interactive mode
    const selection = await selectProjectAndStacks({
      actionVerb: 'destroy',
      allowMultiple: true,
      allowAll: true,
      promptForEnvironment: true,
      defaultEnvironment: environment,
    });

    // Get the profile - use provided or lookup from profileMap
    const actualProfile = options.profile ?? profileMap[selection.environment];
    
    if (!actualProfile) {
      logger.error(`No AWS profile configured for environment: ${selection.environment}`);
      logger.info('Provide --profile flag or configure profileMap in stacks.ts');
      process.exit(1);
    }

    // Require confirmation
    if (!options.force) {
      const confirmed = await confirmDestructiveAction(
        'DESTROY',
        `${selection.stacks.length} stack(s) in ${selection.project.name}`,
        selection.environment
      );
      if (!confirmed) {
        logger.warn('Destroy cancelled');
        process.exit(0);
      }
    }

    logger.keyValue('Profile', actualProfile);
    logger.keyValue('Environment', selection.environment);
    logger.blank();

    const context = selection.project.cdkContext(selection.environment);
    const args = buildCdkArgs({
      command: 'destroy',
      stackNames: selection.all
        ? undefined
        : selection.stacks.map((s) => s.getStackName(selection.environment)),
      all: selection.all,
      context,
      profile: actualProfile,
      force: true,
    });

    await runCdk(args);
  });

program
  .command('list')
  .description('List available stacks')
  .option('-p, --project <project>', 'Project ID (monitoring, nextjs, org)')
  .option('-a, --all', 'List all projects')
  .action(async (options) => {
    if (options.all || !options.project) {
      // List all projects and stacks
      logger.header('Available Stacks');

      for (const project of projects) {
        logger.info(`${project.name} (${project.id})`);
        logger.dim(`  ${project.description}`);
        project.stacks.forEach((stack) => {
          const optional = stack.optional ? ' [optional]' : '';
          logger.listItem(`${stack.id}: ${stack.name}${optional}`);
        });
        logger.blank();
      }
    }
  });

// =============================================================================
// CROSS-ACCOUNT COMMANDS
// =============================================================================

program
  .command('setup-dns-role')
  .description('Deploy CrossAccountDnsRoleStack to root account (one-time setup)')
  .requiredOption('--profile <profile>', 'AWS profile for root account')
  .requiredOption('--hosted-zone-ids <ids>', 'Comma-separated Route53 hosted zone IDs to allow access')
  .requiredOption('--trusted-account-ids <ids>', 'Comma-separated AWS account IDs to trust')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .action(async (options) => {
    logger.header('Setup Cross-Account DNS Role');
    logger.keyValue('Profile', options.profile);
    logger.keyValue('Region', options.region);
    logger.keyValue('Hosted Zone IDs', options.hostedZoneIds);
    logger.keyValue('Trusted Account IDs', options.trustedAccountIds);
    logger.blank();

    logger.warn('This will deploy to your ROOT AWS account.');
    logger.warn('Make sure you are using the correct profile!');
    logger.blank();

    const confirmed = await confirmDestructiveAction(
      'deploy to root account',
      'CrossAccountDnsRoleStack',
      'production'
    );

    if (!confirmed) {
      logger.warn('Setup cancelled');
      process.exit(0);
    }

    const context = {
      project: 'org',
      environment: 'production',
      hostedZoneIds: options.hostedZoneIds,
      trustedAccountIds: options.trustedAccountIds,
    };

    logger.task('Deploying CrossAccountDnsRoleStack...');

    const args = buildCdkArgs({
      command: 'deploy',
      stackNames: ['Org-DnsRole-production'],
      context,
      profile: options.profile,
      region: options.region,
      requireApproval: 'never',
    });

    const result = await runCdk(args);

    if (result.exitCode !== 0) {
      logger.error('Failed to deploy DNS role stack');
      process.exit(1);
    }

    logger.blank();
    logger.success('CrossAccountDnsRoleStack deployed successfully!');
    logger.blank();

    // Retrieve stack outputs using AWS CLI
    logger.task('Retrieving stack outputs...');
    const stackName = 'Org-DnsRole-production';
    const awsResult = await runCommand('aws', [
      'cloudformation', 'describe-stacks',
      '--stack-name', stackName,
      '--profile', options.profile,
      '--region', options.region,
      '--query', 'Stacks[0].Outputs',
      '--output', 'json',
    ]);

    let roleArn = '';
    const hostedZoneId = options.hostedZoneIds.split(',')[0].trim();

    if (awsResult.exitCode === 0 && awsResult.stdout) {
      try {
        const outputs = JSON.parse(awsResult.stdout);
        const roleArnOutput = outputs.find((o: { OutputKey: string }) => o.OutputKey === 'RoleArnOutput');
        if (roleArnOutput) {
          roleArn = roleArnOutput.OutputValue;
        }
      } catch {
        logger.warn('Could not parse stack outputs');
      }
    }

    logger.blank();
    logger.header('Deployment Complete - Copy These Values');
    logger.blank();

    if (roleArn) {
      logger.success(`Cross-Account Role ARN: ${roleArn}`);
    } else {
      logger.dim('Role ARN: Check CloudFormation console for RoleArnOutput');
    }
    logger.keyValue('Hosted Zone ID', hostedZoneId);

    logger.blank();
    logger.info('Use these values when deploying CloudFront:');
    logger.blank();
    logger.dim('  yarn cdk:deploy -p nextjs -a -e development \\');
    logger.dim(`    --domain-name=YOUR_DOMAIN \\`);
    logger.dim(`    --hosted-zone-id=${hostedZoneId} \\`);
    if (roleArn) {
      logger.dim(`    --cross-account-role-arn=${roleArn}`);
    } else {
      logger.dim('    --cross-account-role-arn=<role-arn-from-console>');
    }
  });

program
  .command('get-dns-role')
  .description('Get CrossAccountDnsRoleStack outputs (role ARN and hosted zone ID)')
  .requiredOption('--profile <profile>', 'AWS profile for root account')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .action(async (options) => {
    logger.header('Get Cross-Account DNS Role Info');
    logger.blank();

    const stackName = 'Org-DnsRole-production';
    logger.task(`Retrieving outputs from ${stackName}...`);

    const awsResult = await runCommand('aws', [
      'cloudformation', 'describe-stacks',
      '--stack-name', stackName,
      '--profile', options.profile,
      '--region', options.region,
      '--query', 'Stacks[0]',
      '--output', 'json',
    ]);

    if (awsResult.exitCode !== 0) {
      logger.error(`Failed to get stack info. Is the stack deployed in ${options.region}?`);
      logger.dim('Run setup-dns-role first to deploy the stack.');
      process.exit(1);
    }

    if (!awsResult.stdout) {
      logger.error('No stack output received');
      process.exit(1);
    }

    let roleArn = '';
    let hostedZoneIds = '';

    try {
      const stack = JSON.parse(awsResult.stdout);
      const outputs = stack.Outputs || [];
      const params = stack.Parameters || [];

      const roleArnOutput = outputs.find((o: { OutputKey: string }) => o.OutputKey === 'RoleArnOutput');
      if (roleArnOutput) {
        roleArn = roleArnOutput.OutputValue;
      }

      // Try to get hosted zone IDs from parameters or tags
      const hostedZoneParam = params.find((p: { ParameterKey: string }) => 
        p.ParameterKey.includes('hostedZoneIds')
      );
      if (hostedZoneParam) {
        hostedZoneIds = hostedZoneParam.ParameterValue;
      }
    } catch {
      logger.error('Could not parse stack info');
      process.exit(1);
    }

    logger.blank();
    logger.header('Stack Outputs - Copy These Values');
    logger.blank();

    if (roleArn) {
      logger.success(`Cross-Account Role ARN: ${roleArn}`);
    } else {
      logger.warn('Role ARN not found in outputs');
    }

    if (hostedZoneIds) {
      logger.keyValue('Hosted Zone IDs', hostedZoneIds);
    }

    logger.blank();
    logger.info('Use these values when deploying CloudFront:');
    logger.blank();
    logger.dim('  yarn cdk:deploy -p nextjs -a -e development \\');
    logger.dim('    --domain-name=YOUR_DOMAIN \\');
    logger.dim('    --hosted-zone-id=YOUR_HOSTED_ZONE_ID \\');
    if (roleArn) {
      logger.dim(`    --cross-account-role-arn=${roleArn}`);
    } else {
      logger.dim('    --cross-account-role-arn=<role-arn>');
    }
  });

// =============================================================================
// BOOTSTRAP COMMANDS
// =============================================================================

program
  .command('bootstrap')
  .description('Bootstrap CDK in an AWS account with custom execution policies')
  .requiredOption('--account <account>', 'AWS account ID to bootstrap')
  .requiredOption('--profile <profile>', 'AWS profile to use')
  .option('--region <region>', 'AWS region', 'eu-west-1')
  .option('--qualifier <qualifier>', 'CDK qualifier', 'hnb659fds')
  .option('--skip-policies', 'Skip IAM policy creation/update')
  .action(async (options) => {
    const { account, profile, region, qualifier, skipPolicies } = options;
    
    logger.header('CDK Bootstrap');
    logger.keyValue('Account', account);
    logger.keyValue('Profile', profile);
    logger.keyValue('Region', region);
    logger.keyValue('Qualifier', qualifier);
    logger.blank();

    // Verify credentials
    logger.task('Verifying AWS credentials...');
    const stsResult = await runCommand('aws', [
      'sts', 'get-caller-identity',
      '--profile', profile,
      '--query', 'Account',
      '--output', 'text',
    ], { captureOutput: true });

    if (stsResult.exitCode !== 0 || !stsResult.stdout?.trim()) {
      logger.error(`Cannot authenticate with profile: ${profile}`);
      process.exit(1);
    }

    const currentAccount = stsResult.stdout.trim();
    if (currentAccount !== account) {
      logger.warn(`Profile points to account ${currentAccount}, expected ${account}`);
      logger.warn('Proceeding with actual account...');
    }
    logger.success(`Authenticated to account: ${currentAccount}`);
    logger.blank();

    let cdkPolicyArn = `arn:aws:iam::${currentAccount}:policy/CDKCloudFormationEx`;

    if (!skipPolicies) {
      // Create/update IAM policies
      logger.task('Creating/updating IAM policies...');
      
      const policyDir = new URL('../bootstrap/policies/', import.meta.url).pathname;
      
      for (const policyName of ['CDKCloudFormationEx', 'AssumeCDKRoles']) {
        const policyFile = `${policyDir}${policyName}.json`;
        const policyArn = `arn:aws:iam::${currentAccount}:policy/${policyName}`;
        
        // Check if policy exists using get-policy (more reliable than list-policies)
        const getResult = await runCommand('aws', [
          'iam', 'get-policy',
          '--policy-arn', policyArn,
          '--profile', profile,
        ], { captureOutput: true });

        const policyExists = getResult.exitCode === 0;

        if (!policyExists) {
          // Create policy
          logger.task(`Creating policy: ${policyName}...`);
          const createResult = await runCommand('aws', [
            'iam', 'create-policy',
            '--policy-name', policyName,
            '--policy-document', `file://${policyFile}`,
            '--profile', profile,
          ], { captureOutput: true });

          if (createResult.exitCode !== 0) {
            logger.error(`Failed to create policy: ${policyName}`);
            logger.dim(createResult.stderr || '');
            process.exit(1);
          }
          logger.success(`Created policy: ${policyName}`);
          
          if (policyName === 'CDKCloudFormationEx') {
            cdkPolicyArn = policyArn;
          }
        } else {
          // Update policy version
          logger.task(`Updating policy: ${policyName}...`);
          
          // Check version count (AWS limit: 5)
          const versionsResult = await runCommand('aws', [
            'iam', 'list-policy-versions',
            '--policy-arn', policyArn,
            '--query', 'length(Versions)',
            '--output', 'text',
            '--profile', profile,
          ], { captureOutput: true });

          const versionCount = parseInt(versionsResult.stdout?.trim() || '0', 10);

          if (versionCount >= 5) {
            // Delete oldest non-default version
            const oldestResult = await runCommand('aws', [
              'iam', 'list-policy-versions',
              '--policy-arn', policyArn,
              '--query', "Versions[?IsDefaultVersion==`false`] | [-1].VersionId",
              '--output', 'text',
              '--profile', profile,
            ], { captureOutput: true });

            const oldestVersion = oldestResult.stdout?.trim();
            if (oldestVersion && oldestVersion !== 'None') {
              await runCommand('aws', [
                'iam', 'delete-policy-version',
                '--policy-arn', policyArn,
                '--version-id', oldestVersion,
                '--profile', profile,
              ], { captureOutput: true });
            }
          }

          const updateResult = await runCommand('aws', [
            'iam', 'create-policy-version',
            '--policy-arn', policyArn,
            '--policy-document', `file://${policyFile}`,
            '--set-as-default',
            '--profile', profile,
          ], { captureOutput: true });

          if (updateResult.exitCode !== 0) {
            logger.warn(`Could not update policy: ${policyName}`);
          } else {
            logger.success(`Updated policy: ${policyName}`);
          }

          if (policyName === 'CDKCloudFormationEx') {
            cdkPolicyArn = policyArn;
          }
        }
      }
    }

    logger.blank();
    logger.task('Running CDK bootstrap...');
    logger.dim(`  cdk bootstrap aws://${currentAccount}/${region}`);
    logger.blank();

    // Run CDK bootstrap from /tmp to bypass the project's cdk.json
    // (which requires project context we don't have for bootstrap)
    const bootstrapResult = await runCommand('cdk', [
      'bootstrap',
      `aws://${currentAccount}/${region}`,
      '--profile', profile,
      '--cloudformation-execution-policies', cdkPolicyArn,
      '--qualifier', qualifier,
      '--toolkit-stack-name', 'CDKToolkit',
    ], { cwd: '/tmp' });

    if (bootstrapResult.exitCode !== 0) {
      logger.error('CDK bootstrap failed');
      logger.dim(bootstrapResult.stderr || '');
      process.exit(1);
    }

    logger.blank();
    logger.success('CDK bootstrap complete!');
    logger.blank();
    logger.info('You can now deploy stacks to this account:');
    logger.dim(`  yarn cli deploy -p monitoring -e development --profile ${profile}`);
  });

// =============================================================================
// MONITORING CONFIG SYNC COMMAND
// =============================================================================

program
  .command('sync-configs')
  .description('Sync monitoring configs to S3 + EC2 (no full infrastructure deploy needed)')
  .option('-e, --environment <env>', 'Environment (development, staging, production)')
  .option('--profile <profile>', 'AWS profile to use')
  .option('--region <region>', 'AWS region')
  .action(async (options) => {
    const environment = (options.environment as Environment) ?? defaults.environment;
    const actualProfile = options.profile ?? profileMap[environment];
    const region = options.region ?? defaults.awsRegion;

    logger.header('Sync Monitoring Configs');
    logger.keyValue('Environment', environment);
    logger.keyValue('Profile', actualProfile);
    logger.keyValue('Region', region);
    logger.blank();

    const scriptArgs = [
      'scripts/deployment/sync-monitoring-configs.ts',
      environment,
      '--region', region,
    ];
    if (actualProfile) {
      scriptArgs.push('--profile', actualProfile);
    }

    const result = await runCommand('npx', ['tsx', ...scriptArgs]);
    if (result.exitCode !== 0) {
      logger.error('Monitoring config sync failed');
      process.exit(1);
    }
  });

// =============================================================================
// RECONFIGURE MONITORING COMMAND
// =============================================================================

program
  .command('reconfigure-monitoring')
  .description('Re-run monitoring stack configuration via SSM (no EC2 replacement needed)')
  .option('-e, --environment <env>', 'Environment (development, staging, production)')
  .option('--profile <profile>', 'AWS profile to use')
  .option('--region <region>', 'AWS region')
  .option('--timeout <seconds>', 'Timeout in seconds', '600')
  .action(async (options) => {
    const environment = (options.environment as Environment) ?? defaults.environment;
    const actualProfile = options.profile ?? profileMap[environment];
    const region = options.region ?? defaults.awsRegion;

    await reconfigureMonitoring({
      environment,
      profile: actualProfile,
      region,
      timeoutSeconds: parseInt(options.timeout, 10),
    });
  });

// =============================================================================
// STEAMPIPE CROSS-ACCOUNT ROLE DEPLOYMENT
// =============================================================================

program
  .command('deploy-steampipe-roles')
  .description('Deploy SteampipeReadOnly IAM role to target AWS accounts for cross-account governance')
  .requiredOption('--monitoring-account <id>', 'AWS Account ID of the monitoring (production) account')
  .option('--accounts <json>', 'JSON map of connection names to account IDs (default: reads STEAMPIPE_ACCOUNTS env var)')
  .option('--region <region>', 'AWS region', defaults.awsRegion)
  .option('--external-id <id>', 'External ID for role trust', 'steampipe-governance')
  .option('--dry-run', 'Print commands without executing')
  .action(async (options) => {
    const monitoringAccountId = options.monitoringAccount as string;
    const region = options.region as string;
    const externalId = options.externalId as string;
    const dryRun = options.dryRun === true;

    // Read account map: CLI arg > env var
    let accountMap: Record<string, string>;
    if (options.accounts) {
      accountMap = JSON.parse(options.accounts as string);
    } else if (process.env.STEAMPIPE_ACCOUNTS) {
      accountMap = JSON.parse(process.env.STEAMPIPE_ACCOUNTS);
    } else {
      logger.error('No accounts specified. Use --accounts or set STEAMPIPE_ACCOUNTS env var.');
      logger.info('Example: STEAMPIPE_ACCOUNTS=\'{"nextjs_dev":"222222222222","nextjs_prod":"444444444444"}\'');
      process.exit(1);
    }

    const templatePath = 'scripts/monitoring/steampipe/steampipe-readonly-role.yml';
    const stackName = 'SteampipeReadOnlyRole';

    logger.header('Deploy Steampipe Cross-Account Roles');
    logger.keyValue('Monitoring Account', monitoringAccountId);
    logger.keyValue('External ID', externalId);
    logger.keyValue('Template', templatePath);
    logger.keyValue('Region', region);
    logger.keyValue('Target Accounts', String(Object.keys(accountMap).length));
    if (dryRun) logger.warn('DRY RUN — commands will be printed but not executed');
    logger.blank();

    // Map connection names to AWS CLI profiles
    // Convention: connection name "nextjs_dev" → profile lookup via environment mapping
    const connectionToProfile: Record<string, string> = {
      nextjs_dev: profileMap.development,
      nextjs_staging: profileMap.staging,
      nextjs_prod: profileMap.production,
      org: profileMap.production,
    };

    let deployed = 0;
    let skipped = 0;

    for (const [connectionName, accountId] of Object.entries(accountMap)) {
      // Skip monitoring account — it uses its own instance role
      if (accountId === monitoringAccountId) {
        logger.info(`Skipping ${connectionName} (${accountId}) — monitoring account uses instance role`);
        skipped++;
        continue;
      }

      const awsProfile = connectionToProfile[connectionName];
      if (!awsProfile) {
        logger.warn(`No profile mapping for "${connectionName}" — skipping. Add mapping in cli.ts connectionToProfile.`);
        skipped++;
        continue;
      }

      logger.task(`Deploying to ${connectionName} (${accountId}) via profile ${awsProfile}...`);

      const deployArgs = [
        'cloudformation', 'deploy',
        '--template-file', templatePath,
        '--stack-name', stackName,
        '--parameter-overrides',
        `MonitoringAccountId=${monitoringAccountId}`,
        `ExternalId=${externalId}`,
        '--capabilities', 'CAPABILITY_NAMED_IAM',
        '--profile', awsProfile,
        '--region', region,
        '--no-fail-on-empty-changeset',
      ];

      if (dryRun) {
        logger.info(`  aws ${deployArgs.join(' ')}`);
      } else {
        const result = await runCommand('aws', deployArgs);
        if (result.exitCode !== 0) {
          logger.error(`Failed to deploy to ${connectionName} (${accountId})`);
          process.exit(1);
        }
        logger.success(`Deployed SteampipeReadOnly to ${connectionName} (${accountId})`);
      }
      deployed++;
    }

    logger.blank();
    logger.table(
      ['Metric', 'Value'],
      [
        ['Accounts Deployed', String(deployed)],
        ['Accounts Skipped', String(skipped)],
        ['Stack Name', stackName],
        ['Monitoring Account', monitoringAccountId],
      ]
    );

    if (!dryRun) {
      logger.blank();
      logger.success('Cross-account roles deployed. Redeploy SSM stack to regenerate Steampipe config:');
      logger.info('  yarn cli deploy -p monitoring -s ssm -e production');
    }
  });

// =============================================================================
// UTILITY COMMANDS
// =============================================================================

program
  .command('build')
  .description('Build TypeScript')
  .action(async () => {
    logger.task('Building TypeScript...');
    const result = await runCommand('yarn', ['tsc']);
    if (result.exitCode === 0) {
      logger.success('Build complete');
    } else {
      logger.error('Build failed');
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Run tests')
  .option('-w, --watch', 'Watch mode')
  .option('-c, --coverage', 'With coverage')
  .action(async (options) => {
    const args = ['jest'];
    if (options.watch) args.push('--watch');
    if (options.coverage) args.push('--coverage');

    await runCommand('yarn', args);
  });

program
  .command('lint')
  .description('Run ESLint')
  .option('--fix', 'Auto-fix issues')
  .action(async (options) => {
    logger.task('Running ESLint...');
    const args = ['eslint', '.'];
    if (options.fix) args.push('--fix');

    const result = await runCommand('yarn', args);
    if (result.exitCode === 0) {
      logger.success('Lint passed');
    } else {
      logger.error('Lint failed');
      process.exit(1);
    }
  });

program
  .command('typecheck')
  .description('Run TypeScript type checking')
  .action(async () => {
    logger.task('Running TypeScript type check...');
    const result = await runCommand('yarn', ['tsc', '--noEmit']);
    if (result.exitCode === 0) {
      logger.success('Type check passed');
    } else {
      logger.error('Type check failed');
      process.exit(1);
    }
  });

program
  .command('audit')
  .description('Run security audit on dependencies')
  .option('--include-deprecations', 'Include deprecation warnings (excluded by default)')
  .option('--severity <level>', 'Minimum severity to report (info, low, moderate, high, critical)', 'high')
  .option('--ignore <ids...>', 'Advisory IDs to ignore')
  .action(async (options) => {
    logger.task('Running security audit...');
    
    // By default, ignore deprecations as they are not actual security vulnerabilities
    // Deprecations like 'glob' and 'inflight' from transitive deps are expected
    const auditArgs = ['npm', 'audit', '--all', '--recursive'];
    if (!options.includeDeprecations) {
      auditArgs.push('--no-deprecations');
    }

    // Severity filter — default to 'high' to avoid failing CI on moderate
    // transitive-only advisories that cannot be resolved (e.g. ajv@6.x in eslint)
    if (options.severity) {
      auditArgs.push('--severity', options.severity);
    }

    // Explicit advisory ignores
    if (options.ignore && options.ignore.length > 0) {
      for (const id of options.ignore) {
        auditArgs.push('--ignore', id);
      }
    }
    
    const result = await runCommand('yarn', auditArgs);
    if (result.exitCode === 0) {
      logger.success('Audit passed - no vulnerabilities found');
    } else {
      logger.error('Audit found vulnerabilities');
      process.exit(1);
    }
  });

program
  .command('security-scan')
  .description('Run Checkov IaC security scan against synthesized templates')
  .option('--synth', 'Auto-synthesize if cdk.out/ does not exist')
  .option('--output-dir <dir>', 'Output directory for reports', 'security-reports')
  .option('--framework <framework>', 'Checkov framework', 'cloudformation')
  .action(async (options) => {
    logger.header('IaC Security Scan (Checkov)');

    // 1. Check Checkov is installed
    logger.task('Checking for Checkov...');
    const checkovCheck = await runCommand('checkov', ['--version'], { captureOutput: true });
    if (checkovCheck.exitCode !== 0) {
      logger.error('Checkov is not installed. Install it with:');
      logger.info('  pip install checkov');
      logger.info('  or: brew install checkov');
      process.exit(1);
    }
    logger.success(`Checkov ${checkovCheck.stdout.trim()} found`);

    // 2. Check cdk.out/ exists
    const fs = await import('fs');
    const cdkOutPath = 'cdk.out';
    if (!fs.existsSync(cdkOutPath)) {
      if (options.synth) {
        logger.task('cdk.out/ not found — running cdk synth...');
        const synthResult = await runCdk(buildCdkArgs({ command: 'synth', all: true, quiet: true }));
        if (synthResult.exitCode !== 0) {
          logger.error('CDK synthesis failed');
          process.exit(1);
        }
        logger.success('Synthesis complete');
      } else {
        logger.error('cdk.out/ not found. Run "yarn cli synth" first or use --synth flag.');
        process.exit(1);
      }
    }

    // Count templates
    const templates = fs.readdirSync(cdkOutPath).filter((f: string) => f.endsWith('.template.json'));
    logger.info(`Found ${templates.length} CloudFormation templates`);

    // 3. Build Checkov command
    logger.task('Running Checkov security scan...');
    const checkovArgs = [
      '--directory', cdkOutPath,
      '--framework', options.framework,
      '--compact',
      '--quiet',
    ];

    // Use custom config if it exists
    const configPath = '.checkov/config.yaml';
    if (fs.existsSync(configPath)) {
      checkovArgs.push('--config-file', configPath);
      logger.info(`Using config: ${configPath}`);
    }

    // Output directory
    const outputDir = options.outputDir;
    fs.mkdirSync(outputDir, { recursive: true });
    checkovArgs.push('-o', 'cli', '-o', 'json', '--output-file-path', outputDir);

    const result = await runCommand('checkov', checkovArgs);

    // 4. Parse results
    const jsonReportPath = `${outputDir}/results_json.json`;
    if (fs.existsSync(jsonReportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
        const passed = report.summary?.passed ?? 0;
        const failed = report.summary?.failed ?? 0;
        logger.blank();
        logger.info(`Passed: ${passed}  |  Failed: ${failed}`);
        logger.info(`Reports saved to: ${outputDir}/`);
      } catch {
        // JSON parsing failed — Checkov output may be non-standard
        logger.info(`Reports saved to: ${outputDir}/`);
      }
    }

    if (result.exitCode === 0) {
      logger.success('Security scan passed — no findings');
    } else {
      logger.warn('Security scan found findings (review reports above)');
      // Don't exit(1) — local scans are informational
    }
  });

program
  .command('validate')
  .description('Validate synthesized CloudFormation templates with cfn-lint')
  .option('--synth', 'Auto-synthesize if cdk.out/ does not exist')
  .action(async (options) => {
    logger.header('CloudFormation Template Validation');

    // 1. Check cfn-lint is installed
    logger.task('Checking for cfn-lint...');
    const cfnLintCheck = await runCommand('cfn-lint', ['--version'], { captureOutput: true });
    if (cfnLintCheck.exitCode !== 0) {
      logger.error('cfn-lint is not installed. Install it with:');
      logger.info('  pip install cfn-lint');
      logger.info('  or: brew install cfn-lint');
      process.exit(1);
    }
    logger.success(`cfn-lint ${cfnLintCheck.stdout.trim()} found`);

    // 2. Check cdk.out/ exists
    const fs = await import('fs');
    const cdkOutPath = 'cdk.out';
    if (!fs.existsSync(cdkOutPath)) {
      if (options.synth) {
        logger.task('cdk.out/ not found — running cdk synth --strict...');
        const synthArgs = buildCdkArgs({ command: 'synth', all: true, quiet: true });
        synthArgs.push('--strict');
        const synthResult = await runCdk(synthArgs);
        if (synthResult.exitCode !== 0) {
          logger.error('CDK synthesis failed');
          process.exit(1);
        }
        logger.success('Synthesis complete');
      } else {
        logger.error('cdk.out/ not found. Run "yarn cli synth" first or use --synth flag.');
        process.exit(1);
      }
    }

    // Count templates
    const templates = fs.readdirSync(cdkOutPath).filter((f: string) => f.endsWith('.template.json'));
    logger.info(`Found ${templates.length} CloudFormation templates`);

    // 3. Run cfn-lint
    logger.task('Running cfn-lint...');
    const result = await runCommand('cfn-lint', [`${cdkOutPath}/**/*.template.json`]);

    if (result.exitCode === 0) {
      logger.success('All templates passed validation');
    } else {
      logger.error('Template validation failed (see errors above)');
      process.exit(1);
    }
  });

program
  .command('clean')
  .description('Clean build artifacts')
  .action(async () => {
    logger.task('Cleaning build artifacts...');
    await runCommand('rm', ['-rf', 'dist', 'cdk.out', 'cdk-outputs', '*.js', '*.d.ts']);
    logger.success('Clean complete');
  });

program
  .command('health')
  .description('Run full code health check (lint, build, test)')
  .action(async () => {
    logger.header('Code Health Check');

    logger.task('Running lint...');
    const lint = await runCommand('yarn', ['eslint', '.']);
    if (lint.exitCode !== 0) {
      logger.error('Lint failed');
      process.exit(1);
    }
    logger.success('Lint passed');

    logger.task('Building TypeScript...');
    const build = await runCommand('yarn', ['tsc']);
    if (build.exitCode !== 0) {
      logger.error('Build failed');
      process.exit(1);
    }
    logger.success('Build passed');

    logger.task('Running tests...');
    const test = await runCommand('yarn', ['jest', '--passWithNoTests']);
    if (test.exitCode !== 0) {
      logger.error('Tests failed');
      process.exit(1);
    }
    logger.success('Tests passed');

    logger.blank();
    logger.success('All health checks passed!');
  });

// Parse and execute
program.parse();
