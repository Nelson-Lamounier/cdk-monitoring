/**
 * @format
 * NextJS Edge Stack Unit Tests
 *
 * Tests for the consolidated NextJsEdgeStack:
 * - WAF Web ACL creation
 * - ACM Certificate
 * - CloudFront Distribution
 * - Stack outputs and SSM parameters
 *
 * Note: Uses a helper stack to provide imported resources and avoid cyclic dependencies.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import {
    NextJsEdgeStack,
    NextJsEdgeStackProps,
} from '../../../../lib/stacks/nextjs/edge/edge-stack';
import {
    TEST_ENV,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper to create NextJsEdgeStack for testing.
 */
function createEdgeStack(
    props?: Partial<NextJsEdgeStackProps>,
): { stack: NextJsEdgeStack; template: Template } {
    const app = createTestApp();

    const stack = new NextJsEdgeStack(app, 'TestEdgeStack', {
        env: TEST_ENV,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        domainName: props?.domainName ?? 'dev.example.com',
        hostedZoneId: props?.hostedZoneId ?? 'Z1234567890ABC',
        crossAccountRoleArn:
            props?.crossAccountRoleArn ?? 'arn:aws:iam::123456789012:role/Route53Role',
        albDnsSsmPath: '/nextjs/development/alb-dns-name',
        assetsBucketSsmPath: '/nextjs/development/assets-bucket-name',
        namePrefix: props?.namePrefix ?? 'nextjs',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

describe('NextJsEdgeStack', () => {
    describe('WAF Web ACL', () => {
        it('should create a WAF Web ACL', () => {
            const { template } = createEdgeStack();
            template.resourceCountIs('AWS::WAFv2::WebACL', 1);
        });

        it('should use CLOUDFRONT scope', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Scope: 'CLOUDFRONT',
            });
        });

        it('should have default allow action', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                DefaultAction: Match.objectLike({
                    Allow: {},
                }),
            });
        });

        it('should include managed rules', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Name: 'AWSManagedRulesCommonRuleSet',
                    }),
                ]),
            });
        });
    });

    describe('ACM Certificate', () => {
        it('should create custom resources (ACM cert + S3 auto-delete)', () => {
            const { template } = createEdgeStack();
            template.resourceCountIs('AWS::CloudFormation::CustomResource', 2);
        });

        it('should create validation Lambda', () => {
            const { stack } = createEdgeStack();
            expect(stack.validationLambda).toBeDefined();
        });
    });

    describe('CloudFront Distribution', () => {
        it('should create a CloudFront distribution', () => {
            const { template } = createEdgeStack();
            template.resourceCountIs('AWS::CloudFront::Distribution', 1);
        });

        it('should configure S3 origin in CloudFront distribution', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    Origins: Match.arrayWith([
                        Match.objectLike({
                            DomainName: Match.anyValue(),
                        }),
                    ]),
                }),
            });
        });

        it('should use HTTPS redirect', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    DefaultCacheBehavior: Match.objectLike({
                        ViewerProtocolPolicy: 'redirect-to-https',
                    }),
                }),
            });
        });
    });

    describe('SSM Parameters', () => {
        it('should create SSM parameter for certificate ARN', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs/development/acm-certificate-arn',
            });
        });

        it('should create SSM parameter for WAF ARN', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs/development/cloudfront/waf-arn',
            });
        });

        it('should create SSM parameter for distribution domain', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/nextjs/development/cloudfront/distribution-domain',
            });
        });
    });

    describe('Stack Properties', () => {
        it('should expose certificateArn property', () => {
            const { stack } = createEdgeStack();
            expect(stack.certificateArn).toBeDefined();
        });

        it('should expose webAcl property', () => {
            const { stack } = createEdgeStack();
            expect(stack.webAcl).toBeDefined();
        });

        it('should expose webAclArn property', () => {
            const { stack } = createEdgeStack();
            expect(stack.webAclArn).toBeDefined();
        });

        it('should expose distribution property', () => {
            const { stack } = createEdgeStack();
            expect(stack.distribution).toBeDefined();
        });

        // NOTE: originAccessIdentity was replaced by Origin Access Control (OAC)
        // OAC is automatically managed by CDK and not exposed as a property

        it('should expose targetEnvironment property', () => {
            const { stack } = createEdgeStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });
    });

    describe('Stack Outputs', () => {
        it('should export certificate ARN', () => {
            const { template } = createEdgeStack();
            template.hasOutput('CertificateArn', {});
        });

        it('should export WAF ARN', () => {
            const { template } = createEdgeStack();
            template.hasOutput('WebAclArn', {});
        });

        it('should export distribution ID', () => {
            const { template } = createEdgeStack();
            template.hasOutput('DistributionId', {});
        });

        it('should export distribution domain name', () => {
            const { template } = createEdgeStack();
            template.hasOutput('DistributionDomainName', {});
        });
    });

    describe('Validation', () => {
        it('should NOT throw if domainName not provided (soft-fail via annotation)', () => {
            const app = new cdk.App();

            expect(
                () =>
                    new NextJsEdgeStack(app, 'E', {
                        env: TEST_ENV,
                        targetEnvironment: Environment.DEVELOPMENT,
                        domainName: '',
                        hostedZoneId: 'Z123',
                        crossAccountRoleArn: 'arn:aws:iam::123:role/Role',
                        albDnsSsmPath: '/nextjs/development/alb-dns-name',
                        assetsBucketSsmPath: '/nextjs/development/assets-bucket-name',
                    })
            ).not.toThrow();
        });
    });

    describe('Helper Methods', () => {
        it('should generate cache invalidation command', () => {
            const { stack } = createEdgeStack();
            const cmd = stack.getCacheInvalidationCommand(['/*']);
            expect(cmd).toContain('aws cloudfront create-invalidation');
            expect(cmd).toContain('--distribution-id');
        });
    });

    describe('Lambda IAM Permissions', () => {
        it('should grant ACM permissions to validation Lambda', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'acm:RequestCertificate',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('should grant STS AssumeRole permission', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sts:AssumeRole',
                        }),
                    ]),
                }),
            });
        });
    });

    describe('Custom Resource Properties', () => {
        it('should pass domain name to custom resource', () => {
            const { template } = createEdgeStack({ domainName: 'staging.example.com' });
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                DomainName: 'staging.example.com',
            });
        });

        it('should pass hosted zone ID to custom resource', () => {
            const { template } = createEdgeStack({ hostedZoneId: 'ZTEST123' });
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                HostedZoneId: 'ZTEST123',
            });
        });

        it('should pass cross-account role ARN to custom resource', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                CrossAccountRoleArn: 'arn:aws:iam::123456789012:role/Route53Role',
            });
        });
    });
});

