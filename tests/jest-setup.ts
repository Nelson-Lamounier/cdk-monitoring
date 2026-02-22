/**
 * Jest setup file for CDK monitoring tests
 * @format
 */

import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

// Increase timeout for CDK synthesis operations
jest.setTimeout(30000);

// Suppress CDK synthesis output noise in test logs
process.env.CDK_DEBUG = 'false';

// Skip Lambda asset bundling (esbuild) during tests.
// Without this, CDK's NodejsFunction tries to run esbuild during synthesis,
// which causes tests to hang. Bundling is only needed during actual deploys.
process.env.CDK_BUNDLING_STACKS = '[]';

// Ensure dist/lambda directory exists for Lambda asset tests
// Tests may run before build (e.g., CI), so create the directory if missing
const lambdaDistPath = resolve(__dirname, '..', 'dist', 'lambda');
if (!existsSync(lambdaDistPath)) {
    mkdirSync(lambdaDistPath, { recursive: true });
}
