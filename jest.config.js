/** @format */

// Skip Lambda esbuild bundling during tests.
// Must be set HERE (not in setupFilesAfterEnv) because CDK's AssetStaging
// reads this env var when NodejsFunction is instantiated during synthesis.
// Setting it in jest-setup.ts is too late — Jest has already loaded the
// test file and its imports by then.
process.env.CDK_BUNDLING_STACKS = '[]';

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
