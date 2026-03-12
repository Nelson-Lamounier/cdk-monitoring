/**
 * @format
 * Tagging Aspect — Single Source of Truth
 *
 * Applies exactly 6 kebab-case tags to every taggable resource.
 * No manual `.add()` calls in constructs — this Aspect is the ONLY
 * tag source, enforced at app level.
 *
 * Schema:
 *   project:     k8s-platform | bedrock | org | shared
 *   environment: development | staging | production
 *   owner:       nelson-l
 *   component:   compute | networking | data | edge | iam | api
 *   managed-by:  cdk
 *   version:     1.0.0
 *
 * Design:
 * - All keys are lowercase kebab-case (CLI/Steampipe friendly)
 * - `managed-by` is hardcoded to 'cdk' (always true)
 * - No transient data (commit IDs, timestamps, run IDs) — that belongs in CI logs
 * - No per-resource identity tags — use CloudFormation resource type + stack name
 */

import * as cdk from 'aws-cdk-lib/core';

import { IConstruct } from 'constructs';

/**
 * Tag configuration for the 6-tag schema.
 * All values except `managed-by` are caller-provided.
 */
export interface TagConfig {
    /** Full environment name (e.g. 'development') */
    readonly environment: string;
    /** Project identifier (e.g. 'k8s-platform', 'bedrock') */
    readonly project: string;
    /** Owner shorthand (e.g. 'nelson-l') */
    readonly owner: string;
    /** Stack-level component (e.g. 'compute', 'networking', 'data') */
    readonly component: string;
    /** Semantic version of the infrastructure (e.g. '1.0.0') */
    readonly version: string;
}

/**
 * Aspect that applies the 6-tag kebab-case schema to all taggable resources.
 *
 * @example
 * ```typescript
 * cdk.Aspects.of(stack).add(new TaggingAspect({
 *     environment: 'development',
 *     project: 'k8s-platform',
 *     owner: 'nelson-l',
 *     component: 'compute',
 *     version: '1.0.0',
 * }));
 * ```
 */
export class TaggingAspect implements cdk.IAspect {
    private readonly tags: Record<string, string>;

    constructor(config: TagConfig) {
        this.tags = {
            'project': config.project,
            'environment': config.environment,
            'owner': config.owner,
            'component': config.component,
            'managed-by': 'cdk',
            'version': config.version,
        };
    }

    public visit(node: IConstruct): void {
        if (cdk.TagManager.isTaggable(node)) {
            Object.entries(this.tags).forEach(([key, value]) => {
                node.tags.setTag(key, value);
            });
        }
    }
}
