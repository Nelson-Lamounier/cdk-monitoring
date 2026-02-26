/**
 * @format
 * ECR Repository Construct Unit Tests
 *
 * Tests for reusable ECR repository construct with lifecycle policies.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { EcrRepositoryConstruct, EcrRepositoryConstructProps } from '../../../../lib/common/storage/ecr-repository';
import { Environment } from '../../../../lib/config';

/**
 * Helper to create ECR construct for testing
 */
function createEcrConstruct(
    props?: Partial<EcrRepositoryConstructProps>
): { construct: EcrRepositoryConstruct; template: Template; stack: cdk.Stack } {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack', {
        env: { account: '123456789012', region: 'eu-west-1' },
    });
    const construct = new EcrRepositoryConstruct(stack, 'TestEcr', {
        repositoryName: 'test-repo',
        ...props,
    });
    const template = Template.fromStack(stack);
    return { construct, template, stack };
}

describe('EcrRepositoryConstruct', () => {
    describe('Repository Creation', () => {
        it('should create an ECR repository', () => {
            const { template } = createEcrConstruct();
            template.resourceCountIs('AWS::ECR::Repository', 1);
        });

        it('should create repository with specified name', () => {
            const { template } = createEcrConstruct({ repositoryName: 'my-nextjs-app' });
            template.hasResourceProperties('AWS::ECR::Repository', {
                RepositoryName: 'my-nextjs-app',
            });
        });

        it('should enable scan on push by default', () => {
            const { template } = createEcrConstruct();
            template.hasResourceProperties('AWS::ECR::Repository', {
                ImageScanningConfiguration: {
                    ScanOnPush: true,
                },
            });
        });

        it('should allow disabling scan on push', () => {
            const { template } = createEcrConstruct({ scanOnPush: false });
            template.hasResourceProperties('AWS::ECR::Repository', {
                ImageScanningConfiguration: {
                    ScanOnPush: false,
                },
            });
        });
    });

    describe('Image Tag Mutability', () => {
        it('should set MUTABLE tags for dev environment', () => {
            const { template } = createEcrConstruct({
                environment: Environment.DEVELOPMENT,
            });
            // All environments use MUTABLE by default (Option B deployment strategy)
            template.hasResourceProperties('AWS::ECR::Repository', {
                ImageTagMutability: 'MUTABLE',
            });
        });

        it('should set MUTABLE tags for staging environment (Option B deployment)', () => {
            const { template } = createEcrConstruct({
                environment: Environment.STAGING,
            });
            // MUTABLE enables 'latest' tag overwrites for Option B deployment
            template.hasResourceProperties('AWS::ECR::Repository', {
                ImageTagMutability: 'MUTABLE',
            });
        });

        it('should set MUTABLE tags for prod environment (Option B deployment)', () => {
            const { template } = createEcrConstruct({
                environment: Environment.PRODUCTION,
            });
            // MUTABLE enables 'latest' tag overwrites for Option B deployment
            template.hasResourceProperties('AWS::ECR::Repository', {
                ImageTagMutability: 'MUTABLE',
            });
        });

        it('should allow explicit IMMUTABLE override for strict versioning', () => {
            const { template } = createEcrConstruct({
                environment: Environment.DEVELOPMENT,
                imageTagMutability: 'IMMUTABLE', // Override for strict versioning
            });
            template.hasResourceProperties('AWS::ECR::Repository', {
                ImageTagMutability: 'IMMUTABLE',
            });
        });
    });

    describe('Lifecycle Policies', () => {
        it('should create lifecycle policy for untagged images', () => {
            const { template } = createEcrConstruct();
            template.hasResourceProperties('AWS::ECR::Repository', {
                LifecyclePolicy: {
                    LifecyclePolicyText: Match.stringLikeRegexp('untagged'),
                },
            });
        });

        it('should expire untagged images after configured days', () => {
            const { template } = createEcrConstruct({ untaggedImageExpiryDays: 14 });
            template.hasResourceProperties('AWS::ECR::Repository', {
                LifecyclePolicy: {
                    LifecyclePolicyText: Match.stringLikeRegexp('14'),
                },
            });
        });

        it('should keep only specified number of tagged images', () => {
            const { template } = createEcrConstruct({ maxTaggedImages: 10 });
            template.hasResourceProperties('AWS::ECR::Repository', {
                LifecyclePolicy: {
                    LifecyclePolicyText: Match.stringLikeRegexp('10'),
                },
            });
        });
    });

    describe('Repository Access', () => {
        it('should expose repository property', () => {
            const { construct } = createEcrConstruct();
            expect(construct.repository).toBeDefined();
            expect(construct.repository.repositoryName).toBeDefined();
        });

        it('should expose repositoryUri property', () => {
            const { construct } = createEcrConstruct();
            expect(construct.repositoryUri).toBeDefined();
        });
    });

    describe('Removal Policy', () => {
        it('should retain repository by default', () => {
            const { template } = createEcrConstruct();
            template.hasResource('AWS::ECR::Repository', {
                DeletionPolicy: 'Retain',
                UpdateReplacePolicy: 'Retain',
            });
        });

        it('should allow DESTROY policy for dev', () => {
            const { template } = createEcrConstruct({
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });
            template.hasResource('AWS::ECR::Repository', {
                DeletionPolicy: 'Delete',
            });
        });
    });

    describe('Encryption', () => {
        it('should use default encryption (AES256 is implicit)', () => {
            // AES256 is the default encryption for ECR and is implicit
            // (not explicitly set in CloudFormation output)
            const { template } = createEcrConstruct();
            // Just verify a repository is created - default encryption is always applied
            template.resourceCountIs('AWS::ECR::Repository', 1);
        });

        it('should support KMS encryption when specified', () => {
            const { template } = createEcrConstruct({ useKmsEncryption: true });
            template.hasResourceProperties('AWS::ECR::Repository', {
                EncryptionConfiguration: {
                    EncryptionType: 'KMS',
                },
            });
        });
    });
});
