/**
 * @format
 * Jest Configuration — Integration Tests
 *
 * Separate config for post-deployment integration tests that call real
 * AWS APIs. Uses longer timeouts and a distinct testMatch pattern so
 * `npx jest` (unit tests) and integration tests don't interfere.
 *
 * Usage:
 *   npx jest --config jest.integration.config.js
 *   npx jest --config jest.integration.config.js --testPathPattern="kubernetes"
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    // ── Transform ────────────────────────────────────────────────────────
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                isolatedModules: true,
            },
        ],
    },

    // ── Test Discovery ───────────────────────────────────────────────────
    testMatch: ['**/tests/integration/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/'],

    // ── Timeouts ─────────────────────────────────────────────────────────
    // Integration tests call real AWS APIs — allow up to 60s per test
    testTimeout: 60_000,

    // ── Environment ──────────────────────────────────────────────────────
    testEnvironment: 'node',

    // ── Reporters ────────────────────────────────────────────────────────
    // Verbose output for CI visibility
    verbose: true,
};
