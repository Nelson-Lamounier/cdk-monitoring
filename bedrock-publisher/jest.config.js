/** @format */

/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                useESM: false,
                tsconfig: {
                    module: 'commonjs',
                    moduleResolution: 'node',
                    verbatimModuleSyntax: false,
                },
            },
        ],
    },
    // Map .js extensions in imports to .ts files (NodeNext compatibility)
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    moduleFileExtensions: ['ts', 'js', 'json'],
    verbose: true,
};
