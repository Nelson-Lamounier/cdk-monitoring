/**
 * kubernetes-app Jest Configuration
 *
 * Extends the shared base CJS config. The `validate-dashboards.test.ts` file
 * is excluded here because it is written for the native Node.js test runner
 * (`npx tsx --test`) and uses `import.meta` and `node:test` — both
 * incompatible with this ts-jest CJS setup.
 */
const { cjsConfig } = require('../jest.config.base.cjs');

module.exports = {
    ...cjsConfig,
    testPathIgnorePatterns: [
        ...(cjsConfig.testPathIgnorePatterns ?? ['/node_modules/']),
        // Uses `node:test` + `import.meta.dirname` — run via `npx tsx --test` instead.
        'validate-dashboards\\.test\\.ts',
    ],
};
