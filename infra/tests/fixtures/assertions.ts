/**
 * @format
 * Reusable assertion helpers for CDK stack tests
 *
 * Common assertion patterns for Checkov compliance, tagging,
 * and standard CDK resource validation.
 */

/* eslint-disable jest/no-export */
// This file exports test helpers, not tests — jest/no-export does not apply.

import * as fs from 'fs';
import * as path from 'path';

import { Template, Match } from 'aws-cdk-lib/assertions';

import { DEFAULT_TAGS } from './constants';

/**
 * Collection of reusable stack assertions
 */
export const StackAssertions = {
    /**
     * Assert that a resource has standard monitoring tags
     */
    hasMonitoringTags(template: Template, resourceType: string): void {
        template.hasResourceProperties(resourceType, {
            Tags: Match.arrayWith([
                Match.objectLike({ Key: 'Purpose', Value: DEFAULT_TAGS.Purpose }),
                Match.objectLike({ Key: 'Application', Value: DEFAULT_TAGS.Application }),
            ]),
        });
    },

    /**
     * Assert that a KMS key has rotation enabled (CKV_AWS_7 compliance)
     */
    hasKmsKeyRotation(template: Template): void {
        template.hasResourceProperties('AWS::KMS::Key', {
            EnableKeyRotation: true,
        });
    },

    /**
     * Assert that a CloudWatch Log Group is encrypted (CKV_AWS_66 compliance)
     */
    hasEncryptedLogGroup(template: Template): void {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            KmsKeyId: Match.anyValue(),
        });
    },

    /**
     * Assert that a CloudWatch Log Group has retention (CKV_AWS_158 compliance)
     */
    hasLogGroupRetention(template: Template): void {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            RetentionInDays: Match.anyValue(),
        });
    },

    /**
     * Assert that a log group has both encryption and retention (full Checkov compliance)
     */
    hasSecureLogGroup(template: Template): void {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            RetentionInDays: Match.anyValue(),
            KmsKeyId: Match.anyValue(),
        });
    },

    /**
     * Assert that an EBS volume is encrypted
     */
    hasEncryptedVolume(template: Template): void {
        template.hasResourceProperties('AWS::EC2::Volume', {
            Encrypted: true,
        });
    },

    /**
     * Assert that an EC2 instance requires IMDSv2
     */
    hasImdsV2Required(template: Template): void {
        template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
            LaunchTemplateData: Match.objectLike({
                MetadataOptions: Match.objectLike({
                    HttpTokens: 'required',
                }),
            }),
        });
    },

    /**
     * Assert that VPC flow logging is enabled (CKV_AWS_111 compliance)
     */
    hasVpcFlowLogs(template: Template): void {
        template.hasResource('AWS::EC2::FlowLog', {
            Properties: Match.objectLike({
                TrafficType: 'ALL',
            }),
        });
    },

    /**
     * Assert that a CloudFormation output exists with optional properties
     */
    hasOutput(
        template: Template,
        outputId: string,
        expectedProps?: { description?: string; exportName?: string; value?: string }
    ): void {
        const matcher: Record<string, unknown> = {};
        if (expectedProps?.description) {
            matcher.Description = expectedProps.description;
        }
        if (expectedProps?.exportName) {
            matcher.Export = { Name: expectedProps.exportName };
        }
        if (expectedProps?.value) {
            matcher.Value = expectedProps.value;
        }
        template.hasOutput(outputId, matcher);
    },

    /**
     * Assert resource count for a given type
     */
    hasResourceCount(template: Template, resourceType: string, count: number): void {
        template.resourceCountIs(resourceType, count);
    },

    /**
     * Assert that a Name tag is applied with expected value
     */
    hasNameTag(template: Template, resourceType: string, expectedName: string): void {
        template.hasResourceProperties(resourceType, {
            Tags: Match.arrayWith([Match.objectLike({ Key: 'Name', Value: expectedName })]),
        });
    },
};

/**
 * Helper to check if ingress rules contain a specific port
 */
export function findIngressRulesByPort(
    template: Template,
    resourceType: 'AWS::EC2::SecurityGroup' | 'AWS::EC2::SecurityGroupIngress',
    port: number
): unknown[] {
    const resources = template.findResources(resourceType);

    if (resourceType === 'AWS::EC2::SecurityGroup') {
        const sgResource = Object.values(resources)[0] as { Properties?: { SecurityGroupIngress?: unknown[] } };
        const ingressRules = sgResource?.Properties?.SecurityGroupIngress || [];
        return (ingressRules as { FromPort?: number }[]).filter((r) => r.FromPort === port);
    }

    // For standalone ingress rules
    return Object.values(resources).filter((r) => {
        const props = (r as { Properties?: { FromPort?: number } }).Properties;
        return props?.FromPort === port;
    });
}

/**
 * Re-export Match for convenience in test files
 */
export { Match } from 'aws-cdk-lib/assertions';

// =============================================================================
// S3 Construct Enforcement Helpers
// =============================================================================

/** Violation detail from a source file scan */
export interface InlineBucketViolation {
    /** 1-indexed line number */
    line: number;
    /** Trimmed line content */
    content: string;
}

/**
 * Recursively collect all `.ts` source files under a directory.
 * Excludes `.d.ts` declaration files.
 */
export function collectTsFiles(dir: string): string[] {
    const results: string[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            results.push(...collectTsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            results.push(fullPath);
        }
    }

    return results;
}

/**
 * Scan a single file for inline `new s3.Bucket(` usage.
 * Skips comment lines (single-line `//`, block `*`, `/*`).
 *
 * @returns Array of violations with line numbers and content.
 */
export function findInlineBucketCreations(filePath: string): InlineBucketViolation[] {
    const source = fs.readFileSync(filePath, 'utf-8');
    const lines = source.split('\n');
    const violations: InlineBucketViolation[] = [];

    const pattern = /new\s+s3\.Bucket\s*\(/;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
        }

        if (pattern.test(lines[i])) {
            violations.push({ line: i + 1, content: trimmed });
        }
    }

    return violations;
}

/**
 * Options for `enforceNoInlineS3Buckets`.
 */
export interface EnforceS3ConstructOptions {
    /**
     * Absolute path to the source directory to scan.
     */
    sourceDir: string;

    /**
     * Relative paths (from `sourceDir`) of files that are allowed to use
     * `new s3.Bucket(`. Document the reason for each exception.
     *
     * @default empty (no exceptions)
     */
    allowedExceptions?: Set<string>;
}

/**
 * Registers enforcement tests that ensure no `.ts` file under `sourceDir`
 * contains raw `new s3.Bucket(` calls — forcing use of `S3BucketConstruct`.
 *
 * Call this inside a `describe()` block. It dynamically generates `it()` cases
 * for each source file found.
 *
 * @example
 * ```typescript
 * describe('S3 Construct Enforcement', () => {
 *     enforceNoInlineS3Buckets({
 *         sourceDir: path.resolve(__dirname, '../../../../lib/stacks/kubernetes'),
 *     });
 * });
 * ```
 */
export function enforceNoInlineS3Buckets(options: EnforceS3ConstructOptions): void {
    /* eslint-disable jest/require-top-level-describe */
    // This function generates it() calls intended to run inside the caller's describe().

    const { sourceDir, allowedExceptions = new Set() } = options;
    const tsFiles = collectTsFiles(sourceDir);

    // Sanity: make sure we actually found source files to scan
    it('should find TypeScript source files to scan', () => {
        expect(tsFiles.length).toBeGreaterThan(0);
    });

    // Filter out allowed exceptions
    const filesToTest = tsFiles.filter((file) => {
        const relativePath = path.relative(sourceDir, file);
        return !allowedExceptions.has(relativePath);
    });

    // Main enforcement: one test per source file
    it.each(filesToTest.map((f) => [path.relative(sourceDir, f), f]))(
        'should not use inline new s3.Bucket() in %s — use S3BucketConstruct instead',
        (_relativePath, absolutePath) => {
            const violations = findInlineBucketCreations(absolutePath as string);

            expect(violations).toStrictEqual([]);
        },
    );

    // Guard: ensure allowedExceptions only contains files that actually exist
    it('should not contain stale exception paths', () => {
        for (const exception of allowedExceptions) {
            const fullPath = path.join(sourceDir, exception);
            expect(fs.existsSync(fullPath)).toBe(true);
        }
    });

    /* eslint-enable jest/require-top-level-describe */
}
