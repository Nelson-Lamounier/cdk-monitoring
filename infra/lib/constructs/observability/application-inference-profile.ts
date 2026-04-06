/**
 * @format
 * Application Inference Profile Construct
 *
 * Reusable L2-style wrapper around `CfnApplicationInferenceProfile` to create
 * Bedrock Application Inference Profiles for granular FinOps cost tracking.
 *
 * Application Inference Profiles enable per-pipeline billing attribution in
 * AWS Cost Explorer by attaching cost-allocation tags directly to the
 * Bedrock inference boundary.
 *
 * Usage:
 * ```typescript
 * const profile = new ApplicationInferenceProfile(this, 'ArticleHaiku', {
 *     profileName: 'bedrock-dev-article-haiku',
 *     modelSourceArn: SYSTEM_INFERENCE_PROFILES.CLAUDE_HAIKU_4_5,
 *     description: 'Article pipeline research agent',
 *     tags: [{ key: 'cost-centre', value: 'application' }],
 * });
 * // Use profile.profileArn as the model ID in InvokeModel / Converse API
 * ```
 */

import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Props for ApplicationInferenceProfile
 */
export interface ApplicationInferenceProfileProps {
    /**
     * Profile name (alphanumeric, spaces, hyphens, underscores — max 64 chars).
     *
     * @remarks Must match pattern `^([0-9a-zA-Z][ _-]?)+$`
     */
    readonly profileName: string;

    /**
     * ARN of the system-defined inference profile or foundation model to copy from.
     *
     * Accepted formats:
     * - System inference profile: `arn:aws:bedrock:{region}::inference-profile/{model-id}`
     * - Foundation model: `arn:aws:bedrock:{region}::foundation-model/{model-id}`
     */
    readonly modelSourceArn: string;

    /**
     * Human-readable description of the profile's purpose.
     *
     * @remarks Must match pattern `^([0-9a-zA-Z:.][ _-]?)+$` (max 200 chars)
     */
    readonly description?: string;

    /**
     * Cost-allocation tags to attach to the profile.
     * These tags propagate to AWS Cost Explorer for billing attribution.
     */
    readonly tags?: cdk.CfnTag[];
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Reusable CDK construct for creating Bedrock Application Inference Profiles.
 *
 * Wraps the L1 `CfnApplicationInferenceProfile` with a clean typed interface
 * and exposes the profile ARN + ID for downstream consumption (Lambda env vars,
 * IAM policies).
 *
 * @remarks All properties on the underlying CloudFormation resource require
 * `Replacement` on update — changes to `profileName` or `modelSourceArn`
 * will trigger resource recreation.
 */
export class ApplicationInferenceProfile extends Construct {
    /** The ARN of the created Application Inference Profile */
    public readonly profileArn: string;

    /** The unique identifier of the created Application Inference Profile */
    public readonly profileId: string;

    constructor(scope: Construct, id: string, props: ApplicationInferenceProfileProps) {
        super(scope, id);

        const profile = new bedrock.CfnApplicationInferenceProfile(this, 'Profile', {
            inferenceProfileName: props.profileName,
            modelSource: {
                copyFrom: props.modelSourceArn,
            },
            description: props.description,
            tags: props.tags,
        });

        this.profileArn = profile.attrInferenceProfileArn;
        this.profileId = profile.attrInferenceProfileId;
    }
}
