// ---------------------------------------------------------------------------
// Mock CDK's local bundling (esbuild) during tests.
// ---------------------------------------------------------------------------
const { spawnSync: realSpawnSync } = require('child_process');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { cjsConfig } = require('../jest.config.base.cjs');

// ---------------------------------------------------------------------------
// Ensure the working directory is the infra package root.
// When Jest runs from the monorepo root (e.g. via bedrock-applications project
// aggregation), process.cwd() is the repo root. CDK's NodejsFunction resolves
// Lambda entry paths relative to cwd, so we must be in `infra/`.
// ---------------------------------------------------------------------------
process.chdir(__dirname);

childProcess.spawnSync = function mockedSpawnSync(command, args, options) {
  const fullCmd = [command, ...(args || [])].join(' ');
  if (fullCmd.includes('esbuild')) {
    const outfileMatch = fullCmd.match(/--outfile="?([^"\\s]+)"?/);
    if (outfileMatch) {
      const outfile = outfileMatch[1];
      fs.mkdirSync(path.dirname(outfile), { recursive: true });
      fs.writeFileSync(outfile, 'module.exports = {};');
    }
    return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), output: [null, Buffer.from(''), Buffer.from('')] };
  }
  return realSpawnSync(command, args, options);
};

module.exports = {
  ...cjsConfig,
  roots: ["<rootDir>/tests", "<rootDir>/lambda"],
  testMatch: ["**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/cdk\.out/", "/tests/integration/"],
  // setupFiles runs in EACH worker process before the test framework is installed.
  // This ensures process.cwd() is the infra root in every worker, regardless of
  // where Jest was launched from (repo root vs infra/ directly).
  setupFiles: ["<rootDir>/tests/jest-worker-setup.js"],
  setupFilesAfterEnv: ["<rootDir>/tests/jest-setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/lib/$1",
  },
};
