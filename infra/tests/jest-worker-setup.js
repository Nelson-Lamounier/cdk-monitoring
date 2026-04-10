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

// __dirname is infra/tests/ — move up one level to infra/
const infraRoot = path.resolve(__dirname, '..');
process.chdir(infraRoot);
