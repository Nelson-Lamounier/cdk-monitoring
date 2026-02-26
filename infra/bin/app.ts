#!/usr/bin/env node
/**
 * @format
 * CDK Multi-Project Infrastructure Entry Point
 *
 * Slim orchestrator: parses project/environment, delegates ALL context
 * resolution (VPC, env vars, secrets, CloudFront) to the project factory,
 * then applies cross-cutting aspects (tagging, compliance, DynamoDB guard).
 *
 * Usage:
 *   npx cdk synth -c project=monitoring -c environment=dev
 *   npx cdk synth -c project=nextjs -c environment=prod
 *   npx cdk synth -c project=org -c environment=prod -c hostedZoneIds=Z123 -c trustedAccountIds=111,222
 */

import * as cdk from 'aws-cdk-lib/core';

import { applyCdkNag, applyCommonSuppressions, CompliancePack, TaggingAspect, EnforceReadOnlyDynamoDbAspect } from '../lib/aspects';
import { Environment, isValidEnvironment } from '../lib/config';
import { isValidProject, getProjectConfig, Project } from '../lib/config/projects';
import { getProjectFactoryFromContext } from '../lib/factories/project-registry';

const app = new cdk.App();

// ============================================================================
// 1. Parse & Validate Project + Environment
// ============================================================================

const projectContext = app.node.tryGetContext('project') as string | undefined;
const environmentContext = app.node.tryGetContext('environment') as string | undefined;

if (!projectContext || !isValidProject(projectContext)) {
    throw new Error(
        'Project context required. Use: -c project=monitoring|nextjs|shared|org -c environment=dev|staging|prod'
    );
}

if (!environmentContext || !isValidEnvironment(environmentContext)) {
    throw new Error(
        `Environment required. Use: -c project=${projectContext} -c environment=dev|staging|prod`
    );
}

const environment = environmentContext as Environment;
const projectConfig = getProjectConfig(projectContext as Project);

console.log(`=== Project: ${projectConfig.namespace} | Environment: ${environment} ===`);

// ============================================================================
// 2. Create All Stacks
//
// ALL config flows via a single mechanism — no bridging needed in app.ts:
//   CI:    GitHub vars/secrets → workflow env: block → process.env
//   Local: .env file → dotenv → process.env
//
// Edge config (DOMAIN_NAME, HOSTED_ZONE_ID, CROSS_ACCOUNT_ROLE_ARN),
// email/secrets (NOTIFICATION_EMAIL, SES_FROM_EMAIL, VERIFICATION_SECRET),
// and all other values are resolved by typed config via fromEnv().
// CDK context is reserved for structural routing only (project, environment).
// ============================================================================

const factory = getProjectFactoryFromContext(projectContext, environment);
const { stacks } = factory.createAllStacks(app, {
    environment,
});

// ============================================================================
// 4. Cross-Cutting Aspects
// ============================================================================

// Tagging — enforces consistent 5-key schema across all resources
cdk.Aspects.of(app).add(new TaggingAspect({
    environment,
    project: projectConfig.namespace || projectConfig.displayName,
    owner: process.env.PROJECT_OWNER ?? 'Nelson Lamounier',
    costCenter: process.env.COST_CENTER,
}));

// DynamoDB guard — prevents accidental write permissions on ECS task roles
// SSR (task role) = read-only | API Gateway → Lambda = read-write
if (projectContext === 'nextjs') {
    cdk.Aspects.of(app).add(new EnforceReadOnlyDynamoDbAspect({
        failOnViolation: true,
        roleNamePattern: 'taskrole',
    }));
}

// CDK-Nag compliance checks
const enableNagChecks = app.node.tryGetContext('nagChecks') !== 'false';
if (enableNagChecks) {
    applyCdkNag(app, {
        packs: [CompliancePack.AWS_SOLUTIONS],
        verbose: false,
        reports: true,
    });
    stacks.forEach(stack => applyCommonSuppressions(stack));
}

// ============================================================================
// 4. Summary
// ============================================================================

const stackNames = stacks.map(s => `  - ${s.stackName}`).join('\n');
console.log(`\nStacks created:\n${stackNames}\n`);
