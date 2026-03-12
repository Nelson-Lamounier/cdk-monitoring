/** @format */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import jestPlugin from "eslint-plugin-jest";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load custom rules (ES module import)
import localRules from "./.eslint-local-rules.mjs";

export default [
    // Base configurations
    js.configs.recommended,

    // Global ignores
    {
        ignores: [
            "node_modules/**",
            "cdk.out/**",
            "coverage/**",
            "*.js",
            "*.d.ts",
            "test-results/**",
            ".turbo/**",
            "dist/**",
            "build/**",
            "playground/**",
            "docs/api/**",
            "resume-data*.ts",
        ],
    },

    // JavaScript files configuration (for scripts and config files)
    {
        files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                console: "readonly",
                process: "readonly",
                require: "readonly",
                module: "readonly",
                __dirname: "readonly",
                __filename: "readonly",
            },
        },
        rules: {
            "no-console": "off",
            "prefer-const": "error",
            "no-var": "error",
        },
    },

    // TypeScript files configuration (base)
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                tsconfigRootDir: __dirname,
                // Support multiple tsconfig files common in CDK projects
                project: ["./tsconfig.json", "./tsconfig.dev.json"],
            },
        },
        plugins: {
            "@typescript-eslint": tseslint.plugin,
            import: importPlugin,
        },
        rules: {
            // TypeScript specific rules
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-require-imports": "warn",

            // Catch unhandled promise rejections - important for async code
            "@typescript-eslint/no-floating-promises": "error",

            // Import rules with CDK-specific grouping
            "import/order": [
                "error",
                {
                    groups: [
                        "builtin",
                        "external",
                        "internal",
                        "parent",
                        "sibling",
                        "index",
                    ],
                    "newlines-between": "always",
                    pathGroups: [
                        {
                            pattern: "aws-cdk-lib",
                            group: "external",
                            position: "after",
                        },
                        {
                            pattern: "aws-cdk-lib/**",
                            group: "external",
                            position: "after",
                        },
                        {
                            pattern: "constructs",
                            group: "external",
                            position: "after",
                        },
                    ],
                    pathGroupsExcludedImportTypes: ["builtin"],
                    alphabetize: {
                        order: "asc",
                        caseInsensitive: true,
                    },
                },
            ],

            // General rules
            "no-console": "warn",
            "prefer-const": "error",
            "no-var": "error",
        },
    },

    // CDK Infrastructure files (stacks, constructs)
    {
        files: ["lib/**/*.ts", "stacks/**/*.ts", "constructs/**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                tsconfigRootDir: __dirname,
                project: ["./tsconfig.json"],
            },
        },
        rules: {
            // CDK constructs often use complex object literals
            "@typescript-eslint/no-explicit-any": "warn",

            // CDK patterns sometimes require this
            "@typescript-eslint/no-this-alias": "off",

            // Allow console for CDK synth debugging (remove in strict mode)
            "no-console": "warn",

            // Ensure async CDK operations are awaited
            "@typescript-eslint/no-floating-promises": "error",

            // CDK often uses empty interfaces for props
            "@typescript-eslint/no-empty-interface": "off",
            "@typescript-eslint/no-empty-object-type": "off",
        },
    },

    // Lambda handlers - more relaxed rules for runtime code
    {
        files: ["lambda/**/*.ts", "handlers/**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                tsconfigRootDir: __dirname,
                project: "./tsconfig.json",
            },
        },
        rules: {
            // Console logging is essential for CloudWatch
            "no-console": "off",

            // Lambda handlers often work with dynamic AWS event types
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",

            // Critical: Catch unhandled promise rejections in async handlers
            "@typescript-eslint/no-floating-promises": "error",
            "require-await": "warn",

            // Encourage explicit return types for handler functions
            "@typescript-eslint/explicit-function-return-type": [
                "warn",
                {
                    allowExpressions: true,
                    allowTypedFunctionExpressions: true,
                    allowHigherOrderFunctions: true,
                },
            ],
        },
    },

    // Scripts - operational utilities
    {
        files: ["scripts/**/*.ts", "scripts/**/*.js"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                tsconfigRootDir: __dirname,
                project: "./tsconfig.json",
            },
        },
        rules: {
            "no-console": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
        },
    },

    // Test files configuration with Jest plugin
    {
        files: ["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts", "test/**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                tsconfigRootDir: __dirname,
                project: "./tsconfig.json",
            },
            globals: {
                // Jest globals
                describe: "readonly",
                test: "readonly",
                it: "readonly",
                expect: "readonly",
                beforeAll: "readonly",
                afterAll: "readonly",
                beforeEach: "readonly",
                afterEach: "readonly",
                jest: "readonly",
            },
        },
        plugins: {
            "@typescript-eslint": tseslint.plugin,
            import: importPlugin,
            jest: jestPlugin,
            local: localRules,
        },
        rules: {
            // Basic rules - relaxed for tests
            "no-console": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],

            // Use TypeScript version to avoid false positives with types
            "no-use-before-define": "off",
            "@typescript-eslint/no-use-before-define": [
                "error",
                {
                    variables: true,
                    functions: false, // Allow function hoisting
                    classes: true,
                    enums: true,
                    typedefs: false, // Allow type hoisting
                },
            ],

            // Jest recommended rules
            ...jestPlugin.configs.recommended.rules,

            // === Critical Jest Rules ===

            // Prevent .only from being committed (blocks CI)
            "jest/no-focused-tests": "error",

            // Prevent .skip from accumulating
            "jest/no-disabled-tests": "warn",

            // Ensure tests have assertions
            "jest/expect-expect": [
                "error",
                {
                    assertFunctionNames: [
                        "expect",
                        "expectCDK",
                        "expectTemplate",
                        // CDK Template assertion methods
                        "template.hasResource",
                        "template.hasResourceProperties",
                        "template.resourceCountIs",
                        "template.hasOutput",
                        "template.findResources",
                        "template.hasMapping",
                        "template.hasCondition",
                        "template.hasParameter",
                        "**.hasResource",
                        "**.hasResourceProperties",
                        "**.resourceCountIs",
                        "**.hasOutput",
                    ],
                },
            ],

            // === Test Structure Rules ===

            // No conditionals in tests - leads to flaky tests
            "jest/no-conditional-in-test": "error",

            // Validate describe/test callbacks
            "jest/valid-describe-callback": "error",
            "jest/valid-title": [
                "error",
                {
                    mustNotMatch: {
                        describe: "template\\.",
                        test: "^test$",
                    },
                    mustMatch: {
                        it: "^should",
                    },
                },
            ],

            // Async test best practices
            "jest/no-done-callback": "error",
            "jest/no-test-return-statement": "error",

            // Hook organization
            "jest/no-duplicate-hooks": "error",
            "jest/require-top-level-describe": "error",
            "jest/prefer-hooks-on-top": "error",

            // === CDK Snapshot Testing ===

            // Keep snapshots manageable
            "jest/no-large-snapshots": [
                "warn",
                {
                    maxSize: 100, // CDK templates can be larger
                    inlineMaxSize: 20,
                },
            ],

            // === Code Quality in Tests ===

            // Prefer modern Jest patterns
            "jest/prefer-to-have-length": "error",
            "jest/prefer-to-be": "error",
            "jest/prefer-to-contain": "error",
            "jest/prefer-strict-equal": "warn",

            // Avoid standalone expects
            "jest/no-standalone-expect": "error",

            // Custom local rules for template safety
            "local/no-template-in-describe": "error",
            "local/no-iife-in-describe": "error",
            "local/no-template-literal-title": "error",
        },
    },

    // CDK Integration/E2E tests - slightly different rules
    {
        files: ["tests/integration/**/*.ts", "tests/e2e/**/*.ts"],
        rules: {
            // Integration tests may need longer timeouts and conditional logic
            "jest/no-conditional-in-test": "warn",

            // Larger snapshots acceptable for full stack tests
            "jest/no-large-snapshots": [
                "warn",
                {
                    maxSize: 200,
                },
            ],
        },
    },

    // Deployment scripts - allow console for operational visibility
    {
        files: ["bin/**/*.ts"],
        rules: {
            "no-console": "off",
            "@typescript-eslint/no-require-imports": "off",

            // Bin files often have floating promises for async entry points
            "@typescript-eslint/no-floating-promises": "off",
        },
    },
];
