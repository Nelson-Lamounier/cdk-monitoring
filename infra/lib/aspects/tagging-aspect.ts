import * as cdk from 'aws-cdk-lib/core';

import { IConstruct } from 'constructs';

import { Environment } from '../config/environments';

/**
 * Tag configuration for resources
 */
export interface TagConfig {
    readonly environment: Environment;
    readonly project: string;
    readonly owner: string;
    readonly costCenter?: string;
}

/**
 * Aspect that applies consistent tags to all taggable resources.
 * Uses direct tag manager manipulation to avoid priority conflicts.
 */
export class TaggingAspect implements cdk.IAspect {
    private readonly tags: Record<string, string>;

    constructor(config: TagConfig) {
        this.tags = {
            Environment: config.environment,
            Project: config.project,
            Owner: config.owner,
            ManagedBy: 'CDK',
            ...(config.costCenter && { CostCenter: config.costCenter }),
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

/**
 * Helper function to apply tagging at app level using Tags.of() 
 * This is the recommended approach for applying tags across the entire app
 */
export function applyTagging(scope: IConstruct, config: TagConfig): void {
    const tags: Record<string, string> = {
        Environment: config.environment,
        Project: config.project,
        Owner: config.owner,
        ManagedBy: 'CDK',
        ...(config.costCenter && { CostCenter: config.costCenter }),
    };

    Object.entries(tags).forEach(([key, value]) => {
        cdk.Tags.of(scope).add(key, value);
    });
}
