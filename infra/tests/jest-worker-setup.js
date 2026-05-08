/**
 * jest-worker-setup.js — Worker-Process CWD Fix
 *
 * Jest spawns separate worker processes for each test suite. When Jest is
 * invoked from the monorepo root (e.g. via the `bedrock-applications` project
 * aggregator), the workers' process.cwd() is the repo root rather than the
 * `infra/` package directory.
 *
 * CDK's NodejsFunction resolves Lambda entry file paths relative to
 * process.cwd(), calling fs.existsSync() *before* bundling. This causes a
 * ValidationError for every Lambda construct when cwd is wrong.
 *
 * This file is listed under `setupFiles` in jest.config.js, which means it
 * runs inside EACH worker process before any test framework setup. It
 * unconditionally changes the worker's cwd to the infra package root
 * (__dirname resolves to `infra/tests/` — one level up is `infra/`).
 *
 * @format
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');

// __dirname is infra/tests/ — move up one level to infra/
const infraRoot = path.resolve(__dirname, '..');
process.chdir(infraRoot);

// CDK's NodejsFunction calls fs.existsSync() on Lambda entry paths before
// synthesis. Stub it out for the bedrock-applications tree so tests can
// synthesize stacks that reference handlers in a sibling repo that is not
// checked out alongside this one. The esbuild spawnSync intercept in
// jest.config.js already prevents real bundling.
const realExistsSync = fs.existsSync;
fs.existsSync = function stubbedExistsSync(p) {
    if (typeof p === 'string' && p.includes('bedrock-applications')) {
        return true;
    }
    return realExistsSync(p);
};
