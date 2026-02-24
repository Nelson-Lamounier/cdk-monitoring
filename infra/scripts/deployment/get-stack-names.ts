#!/usr/bin/env npx tsx
/**
 * Get Stack Names CLI
 *
 * Outputs stack names as JSON for use in GitHub Actions workflows.
 * This eliminates hardcoded stack names by reading from the TypeScript source of truth.
 *
 * Usage:
 *   npx tsx scripts/deployment/get-stack-names.ts monitoring development
 *   npx tsx scripts/deployment/get-stack-names.ts nextjs development
 *
 * Output (JSON):
 *   {"vpc":"Monitoring-Vpc-development","sg":"Monitoring-SecurityGroup-development",...}
 */

import { projects, type Environment } from './stacks.js';

const [projectId, environment] = process.argv.slice(2);

if (!projectId || !environment) {
  console.error('Usage: get-stack-names.ts <project> <environment>');
  console.error('  Projects: monitoring, nextjs, org');
  console.error('  Environments: development, staging, production');
  process.exit(1);
}

const project = projects.find((p) => p.id === projectId);

if (!project) {
  console.error(`Unknown project: ${projectId}`);
  console.error(`Available: ${projects.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

// Build stack names object
const stackNames: Record<string, string> = {};

for (const stack of project.stacks) {
  stackNames[stack.id] = stack.getStackName(environment as Environment);
}

// Output as JSON for easy parsing in GitHub Actions
console.log(JSON.stringify(stackNames));
