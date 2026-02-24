/**
 * @format
 * ECR Repository Construct
 *
 * Reusable ECR repository construct with lifecycle policies and environment-based
 * tag mutability for container image storage.
 */

import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../../config/environments';

/**
 * Props for EcrRepositoryConstruct
 */
export interface EcrRepositoryConstructProps {
    /** Repository name (must be lowercase) */
    readonly repositoryName: string;
    /** Target environment - determines tag mutability @default DEV */
    readonly environment?: Environment;
    /** Override tag mutability (defaults based on environment) */
    readonly imageTagMutability?: 'MUTABLE' | 'IMMUTABLE';
    /** Enable scan on push @default true */
    readonly scanOnPush?: boolean;
    /** Days before untagged images expire @default 30 */
    readonly untaggedImageExpiryDays?: number;
    /** Maximum number of tagged images to keep @default 50 */
    readonly maxTaggedImages?: number;
    /** Resource name prefix @default 'nextjs' */
    readonly namePrefix?: string;
    /** Removal policy @default RETAIN */
    readonly removalPolicy?: cdk.RemovalPolicy;
    /** Use KMS encryption instead of AES256 @default false */
    readonly useKmsEncryption?: boolean;
}

/**
 * Reusable ECR repository construct
 *
 * Features:
 * - Environment-based tag mutability (dev=MUTABLE, staging/prod=IMMUTABLE)
 * - Lifecycle policies for image cleanup
 * - Scan on push enabled by default
 * - AES256 encryption by default
 *
 * @example
 * ```typescript
 * const ecr = new EcrRepositoryConstruct(this, 'FrontendRepo', {
 *     repositoryName: 'nextjs-frontend',
 *     environment: Environment.DEVELOPMENT,
 * });
 * ```
 */
export class EcrRepositoryConstruct extends Construct {
    /** The ECR repository */
    public readonly repository: ecr.Repository;

    constructor(scope: Construct, id: string, props: EcrRepositoryConstructProps) {
        super(scope, id);

        const environment = props.environment ?? Environment.DEVELOPMENT;
        const scanOnPush = props.scanOnPush ?? true;
        const untaggedExpiryDays = props.untaggedImageExpiryDays ?? 30;
        const maxTaggedImages = props.maxTaggedImages ?? 50;
        const useKmsEncryption = props.useKmsEncryption ?? false;

        // Determine tag mutability
        // Default: MUTABLE for all environments (enables Option B deployment strategy)
        // Option B: Frontend pushes 'latest' tag, calls ecs:UpdateService --force-new-deployment
        // Override with imageTagMutability: 'IMMUTABLE' if strict versioning is required
        let tagMutability: ecr.TagMutability;
        if (props.imageTagMutability) {
            tagMutability = props.imageTagMutability === 'MUTABLE'
                ? ecr.TagMutability.MUTABLE
                : ecr.TagMutability.IMMUTABLE;
        } else {
            // MUTABLE by default for all environments to support Option B deployment
            tagMutability = ecr.TagMutability.MUTABLE;
        }

        // Create lifecycle rules
        const lifecycleRules: ecr.LifecycleRule[] = [
            // Rule 1: Remove untagged images after N days
            {
                rulePriority: 1,
                description: `Remove untagged images after ${untaggedExpiryDays} days`,
                tagStatus: ecr.TagStatus.UNTAGGED,
                maxImageAge: cdk.Duration.days(untaggedExpiryDays),
            },
            // Rule 2: Keep only N most recent tagged images
            {
                rulePriority: 2,
                description: `Keep only ${maxTaggedImages} most recent tagged images`,
                tagStatus: ecr.TagStatus.ANY,
                maxImageCount: maxTaggedImages,
            },
        ];

        // Create repository
        this.repository = new ecr.Repository(this, 'Repository', {
            repositoryName: props.repositoryName.toLowerCase(),
            imageScanOnPush: scanOnPush,
            imageTagMutability: tagMutability,
            encryption: useKmsEncryption
                ? ecr.RepositoryEncryption.KMS
                : ecr.RepositoryEncryption.AES_256,
            removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
            lifecycleRules,
        });

        // Apply tags
        cdk.Tags.of(this.repository).add('Environment', environment);
        cdk.Tags.of(this.repository).add('Application', 'NextJS');
        cdk.Tags.of(this.repository).add('ManagedBy', 'CDK');
    }

    /**
     * Get the repository URI for docker push/pull
     */
    get repositoryUri(): string {
        return this.repository.repositoryUri;
    }

    /**
     * Grant pull permissions to a grantee
     */
    grantPull(grantee: iam.IGrantable): iam.Grant {
        return this.repository.grantPull(grantee);
    }

    /**
     * Grant push permissions to a grantee
     */
    grantPush(grantee: iam.IGrantable): iam.Grant {
        return this.repository.grantPush(grantee);
    }

    /**
     * Grant pull and push permissions to a grantee
     */
    grantPullPush(grantee: iam.IGrantable): iam.Grant {
        return this.repository.grantPullPush(grantee);
    }
}
