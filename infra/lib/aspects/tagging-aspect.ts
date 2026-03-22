/**
 * @format
 * Tagging Aspect — Single Source of Truth
 *
 * Applies exactly 7 kebab-case tags to every taggable resource.
 * No manual `.add()` calls in constructs — this Aspect is the ONLY
 * tag source, enforced at app level.
 *
 * Schema:
 *   project:      k8s-platform | bedrock | org | shared
 *   environment:  development | staging | production
 *   owner:        nelson-l
 *   component:    compute | networking | data | edge | iam | api | finops
 *   managed-by:   cdk
 *   version:      1.0.0
 *   cost-centre:  infrastructure | platform | application
 *
 * Design:
 * - All keys are lowercase kebab-case (CLI/Steampipe friendly)
 * - `managed-by` is hardcoded to 'cdk' (always true)
 * - `cost-centre` enables AWS Cost Explorer cost-allocation grouping
 * - No transient data (commit IDs, timestamps, run IDs) — that belongs in CI logs
 * - No per-resource identity tags — use CloudFormation resource type + stack name
 *
 * FinOps note:
 * Activate `cost-centre` as a user-defined cost-allocation tag in the
 * AWS Billing console → Cost Allocation Tags to enable Cost Explorer grouping.
 */

import * as cdk from 'aws-cdk-lib/core';

import { IConstruct } from 'constructs';

/**
 * Valid cost-centre values for cost-allocation grouping.
 * - infrastructure: shared VPC, networking, DNS, KMS
 * - platform: Kubernetes nodes, monitoring, ArgoCD
 * - application: workload-specific resources (APIs, data stores)
 */
export type CostCentre = 'infrastructure' | 'platform' | 'application';

/**
 * Tag configuration for the 7-tag schema.
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
    /**
     * Cost-allocation centre for AWS Cost Explorer grouping.
     * Must be activated in Billing console → Cost Allocation Tags.
     *
     * @default 'platform'
     */
    readonly costCentre?: CostCentre;
}

/**
 * Aspect that applies the 7-tag kebab-case schema to all taggable resources.
 *
 * @example
 * ```typescript
 * cdk.Aspects.of(stack).add(new TaggingAspect({
 *     environment: 'development',
 *     project: 'k8s-platform',
 *     owner: 'nelson-l',
 *     component: 'compute',
 *     version: '1.0.0',
 *     costCentre: 'platform',
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
            'cost-centre': config.costCentre ?? 'platform',
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
