import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';

import { TaggingAspect } from '../src/tagging-aspect';

import type { TagConfig } from '../src/tagging-aspect';

// =============================================================================
// CONSTANTS
// =============================================================================

const EXPECTED_TAG_COUNT = 7;

const BASE_CONFIG: TagConfig = {
    environment: 'development',
    project: 'k8s-platform',
    owner: 'nelson-l',
    component: 'compute',
    version: '1.0.0',
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Synthesise a stack with the TaggingAspect applied and return the template.
 *
 * Uses an S3 Bucket as the taggable resource — it is lightweight and
 * reliably supports tags across all CDK versions.
 *
 * @param config - Tag configuration to apply
 * @returns CloudFormation template for assertion
 */
function synthesiseStack(config: TagConfig): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new s3.CfnBucket(stack, 'TagTarget');

    cdk.Aspects.of(stack).add(new TaggingAspect(config));

    return Template.fromStack(stack);
}

/**
 * Extract tags array from the first S3 bucket in a template.
 */
function extractTags(
    template: Template,
): Array<{ Key: string; Value: string }> {
    const resources = template.findResources('AWS::S3::Bucket');
    const bucketKey = Object.keys(resources)[0];
    return (resources[bucketKey]?.Properties?.Tags as Array<{
        Key: string;
        Value: string;
    }>) ?? [];
}

/**
 * Find a tag by key from a CloudFormation tag array.
 */
function findTag(
    tags: Array<{ Key: string; Value: string }>,
    key: string,
): { Key: string; Value: string } | undefined {
    return tags.find((t) => t.Key === key);
}

// =============================================================================
// TESTS
// =============================================================================

describe('TaggingAspect', () => {
    let tags: Array<{ Key: string; Value: string }>;

    beforeAll(() => {
        const template = synthesiseStack(BASE_CONFIG);
        tags = extractTags(template);
    });

    it(`should apply exactly ${EXPECTED_TAG_COUNT} tags`, () => {
        expect(tags).toHaveLength(EXPECTED_TAG_COUNT);
    });

    it('should set the project tag', () => {
        const tag = findTag(tags, 'project');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('k8s-platform');
    });

    it('should set the environment tag', () => {
        const tag = findTag(tags, 'environment');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('development');
    });

    it('should set the owner tag', () => {
        const tag = findTag(tags, 'owner');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('nelson-l');
    });

    it('should set the component tag', () => {
        const tag = findTag(tags, 'component');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('compute');
    });

    it('should hardcode managed-by to cdk', () => {
        const tag = findTag(tags, 'managed-by');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('cdk');
    });

    it('should set the version tag', () => {
        const tag = findTag(tags, 'version');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('1.0.0');
    });

    it('should default cost-centre to platform when omitted', () => {
        const tag = findTag(tags, 'cost-centre');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('platform');
    });

    it('should use custom cost-centre when provided', () => {
        const template = synthesiseStack({
            ...BASE_CONFIG,
            costCentre: 'infrastructure',
        });
        const customTags = extractTags(template);
        const tag = findTag(customTags, 'cost-centre');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('infrastructure');
    });

    it('should accept application as a valid cost-centre', () => {
        const template = synthesiseStack({
            ...BASE_CONFIG,
            costCentre: 'application',
        });
        const customTags = extractTags(template);
        const tag = findTag(customTags, 'cost-centre');
        expect(tag).toBeDefined();
        expect(tag!.Value).toBe('application');
    });
});
