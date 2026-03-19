// ---------------------------------------------------------------------------
// Mock CDK's local bundling (esbuild) during tests.
//
// CDK's NodejsFunction calls `spawnSync('bash', ['-c', 'yarn run esbuild ...'])`
// for local bundling. By intercepting calls that contain 'esbuild', we return a
// dummy success response and write a stub index.js to the output path.
//
// CDK's AssetStaging validates that bundling produced output — returning
// status 0 alone causes "Bundling did not produce any output". We parse the
// --outfile argument from the esbuild command and write a dummy module there.
//
// Must be set HERE (not in setupFilesAfterEnv) because CDK's AssetStaging reads
// bundling config when NodejsFunction is instantiated during synthesis.
// ---------------------------------------------------------------------------
const { spawnSync: realSpawnSync } = require('child_process');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

childProcess.spawnSync = function mockedSpawnSync(command, args, options) {
  const fullCmd = [command, ...(args || [])].join(' ');
  if (fullCmd.includes('esbuild')) {
    // Extract --outfile path from the esbuild command and write a stub
    const outfileMatch = fullCmd.match(/--outfile="?([^"\s]+)"?/);
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
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 10000,
  verbose: false,
  collectCoverage: false,
  coverageDirectory: "coverage",
  coverageReporters: [
    "text",
    "text-summary",
    "json",
    "json-summary", // Required for CI coverage summary
    "lcov",
    "html",
    "clover",
  ],

  // Only collect coverage from source files
  collectCoverageFrom: [
    "lib/**/*.ts",
    "!lib/**/*.d.ts",
    "!lib/**/*.test.ts",
    "!lib/**/__tests__/**",
    "!lib/**/__mocks__/**",
  ],

  // Exclude test files, config files, and build outputs from coverage
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/tests/",
    "/dist/",
    "/cdk.out/",
    "/coverage/",
    "\\.test\\.ts$",
    "\\.spec\\.ts$",
    "jest.config.js",
    "babel.config.js",
    "/\\.generated-templates/",
  ],

  // ── Coverage Thresholds ──
  // Enforced when running with --coverage (e.g. `just test-coverage`).
  // Branches kept at 60% because CDK stacks are heavily declarative
  // with many config paths that don't need branching tests.
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },

  reporters: ["default"],
  maxWorkers: 1,
  forceExit: true,
  setupFilesAfterEnv: ["<rootDir>/tests/jest-setup.ts"],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/lib/$1",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  // Ensure Jest globals are available
  globals: {
    "ts-jest": {
      useESM: false,
      // Skip type-checking during test transpilation.
      // Type safety is enforced separately by `just typecheck` (tsc --noEmit).
      // Without this, ts-jest compiles CDK's massive dependency graph with
      // full type-checking, causing edge-stack tests to hang.
      isolatedModules: true,
    },
  },
  // Add Jest environment for better TypeScript support
  testEnvironmentOptions: {
    node: {
      globals: true,
    },
  },
};
