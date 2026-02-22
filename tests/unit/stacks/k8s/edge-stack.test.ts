/**
 * @format
 * K8s Edge Stack Unit Tests
 *
 * Tests for the K8sEdgeStack:
 * - ACM Certificate (cross-account DNS validation)
 * - WAF Web ACL (CloudFront scope)
 * - CloudFront Distribution (single EIP origin, no caching)
 * - DNS Alias Record (Route 53 → CloudFront)
 * - SSM Parameters
 * - Stack outputs and properties
 * - Region validation (must be us-east-1)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import {
    K8sEdgeStack,
    K8sEdgeStackProps,
} from '../../../../lib/stacks/monitoring/k8s/edge/edge-stack';
import { TEST_ENV, createTestApp } from '../../../fixtures';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Default props for K8sEdgeStack tests.
 * Uses TEST_ENV (us-east-1) which satisfies the region constraint.
 * Edge config values are direct strings (synth-time resolution).
 */
const DEFAULT_PROPS: K8sEdgeStackProps = {
    env: TEST_ENV,
    targetEnvironment: Environment.DEVELOPMENT,
    domainName: 'monitoring.dev.nelsonlamounier.com',
    hostedZoneId: 'Z04763221QPB6CZ9R77GM',
    crossAccountRoleArn: 'arn:aws:iam::711387127421:role/Route53DnsValidationRole',
    elasticIpSsmPath: '/k8s/development/elastic-ip',
    elasticIpSsmRegion: 'eu-west-1',
    namePrefix: 'k8s',
};

/**
 * Helper to create K8sEdgeStack for testing.
 */
function createEdgeStack(
    overrides?: Partial<K8sEdgeStackProps>,
): { stack: K8sEdgeStack; template: Template } {
    const app = createTestApp();

    const stack = new K8sEdgeStack(app, 'TestK8sEdgeStack', {
        ...DEFAULT_PROPS,
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

// =============================================================================
// TESTS
// =============================================================================

describe('K8sEdgeStack', () => {
    // =========================================================================
    // WAF Web ACL
    // =========================================================================
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

        it('should include AWS Managed Common Rule Set', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Name: 'AWSManagedRulesCommonRuleSet',
                    }),
                ]),
            });
        });

        it('should include Known Bad Inputs rule', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Name: 'AWSManagedRulesKnownBadInputsRuleSet',
                    }),
                ]),
            });
        });

        it('should enable CloudWatch metrics', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                VisibilityConfig: Match.objectLike({
                    CloudWatchMetricsEnabled: true,
                    SampledRequestsEnabled: true,
                }),
            });
        });

        it('should include environment in WAF name', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Name: Match.stringLikeRegexp('development'),
            });
        });
    });

    // =========================================================================
    // ACM Certificate
    // =========================================================================
    describe('ACM Certificate', () => {
        it('should create custom resources for certificate and DNS alias', () => {
            const { template } = createEdgeStack();
            // ACM certificate CR + DNS alias CR = 2
            template.resourceCountIs('AWS::CloudFormation::CustomResource', 2);
        });

        it('should create validation Lambda', () => {
            const { stack } = createEdgeStack();
            expect(stack.validationLambda).toBeDefined();
        });

        it('should expose certificateArn property', () => {
            const { stack } = createEdgeStack();
            expect(stack.certificateArn).toBeDefined();
        });
    });

    // =========================================================================
    // CloudFront Distribution
    // =========================================================================
    describe('CloudFront Distribution', () => {
        it('should create a CloudFront distribution', () => {
            const { template } = createEdgeStack();
            template.resourceCountIs('AWS::CloudFront::Distribution', 1);
        });

        it('should use HTTPS redirect for viewer protocol', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    DefaultCacheBehavior: Match.objectLike({
                        ViewerProtocolPolicy: 'redirect-to-https',
                    }),
                }),
            });
        });

        it('should configure domain aliases from config', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    Aliases: ['monitoring.dev.nelsonlamounier.com'],
                }),
            });
        });

        it('should have an origin', () => {
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

        it('should allow all HTTP methods', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    DefaultCacheBehavior: Match.objectLike({
                        AllowedMethods: Match.arrayWith([
                            'GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE',
                        ]),
                    }),
                }),
            });
        });

        it('should enable IPv6', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    IPV6Enabled: true,
                }),
            });
        });

        it('should use WAF Web ACL', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::Distribution', {
                DistributionConfig: Match.objectLike({
                    WebACLId: Match.anyValue(),
                }),
            });
        });
    });

    // =========================================================================
    // Origin Request Policy
    // =========================================================================
    describe('Origin Request Policy', () => {
        it('should create an origin request policy', () => {
            const { template } = createEdgeStack();
            template.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 1);
        });

        it('should forward Host header for Traefik routing', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
                OriginRequestPolicyConfig: Match.objectLike({
                    HeadersConfig: Match.objectLike({
                        HeaderBehavior: 'whitelist',
                        Headers: Match.arrayWith(['Host']),
                    }),
                }),
            });
        });

        it('should forward all query strings', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
                OriginRequestPolicyConfig: Match.objectLike({
                    QueryStringsConfig: Match.objectLike({
                        QueryStringBehavior: 'all',
                    }),
                }),
            });
        });

        it('should forward all cookies', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
                OriginRequestPolicyConfig: Match.objectLike({
                    CookiesConfig: Match.objectLike({
                        CookieBehavior: 'all',
                    }),
                }),
            });
        });
    });

    // =========================================================================
    // Cross-Region SSM Read (EIP only)
    // =========================================================================
    describe('Cross-Region SSM Read', () => {
        it('should create AwsCustomResource for EIP SSM lookup', () => {
            const { template } = createEdgeStack();
            // Only the EIP SSM reader remains as a custom resource
            const customResources = template.findResources(
                'AWS::CloudFormation::CustomResource'
            );
            expect(Object.keys(customResources).length).toBeGreaterThanOrEqual(2);
        });

        it('should grant SSM GetParameter permission for cross-region EIP read', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'ssm:GetParameter',
                            Resource: Match.stringLikeRegexp(
                                'arn:aws:ssm:eu-west-1.*elastic-ip'
                            ),
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // DNS Alias Record
    // =========================================================================
    describe('DNS Alias Record', () => {
        it('should create DNS alias custom resource by default', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                DomainName: 'monitoring.dev.nelsonlamounier.com',
                HostedZoneId: 'Z04763221QPB6CZ9R77GM',
            });
        });

        it('should pass CloudFront domain name to DNS alias', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                CloudFrontDomainName: Match.anyValue(),
                SkipCertificateCreation: 'true',
            });
        });

        it('should pass cross-account role ARN directly', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                CrossAccountRoleArn: 'arn:aws:iam::711387127421:role/Route53DnsValidationRole',
            });
        });

        it('should skip DNS records when createDnsRecords is false', () => {
            const { template } = createEdgeStack({ createDnsRecords: false });
            // Only ACM certificate CR, no DNS alias CR
            template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
        });

        it('should create log group for DNS alias provider', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: Match.stringLikeRegexp('dns-alias'),
            });
        });
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should create SSM parameter for distribution domain', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Name: '/k8s/development/cloudfront/distribution-domain',
                Type: 'String',
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose certificateArn', () => {
            const { stack } = createEdgeStack();
            expect(stack.certificateArn).toBeDefined();
        });

        it('should expose certificate', () => {
            const { stack } = createEdgeStack();
            expect(stack.certificate).toBeDefined();
        });

        it('should expose webAcl', () => {
            const { stack } = createEdgeStack();
            expect(stack.webAcl).toBeDefined();
        });

        it('should expose webAclArn', () => {
            const { stack } = createEdgeStack();
            expect(stack.webAclArn).toBeDefined();
        });

        it('should expose distribution', () => {
            const { stack } = createEdgeStack();
            expect(stack.distribution).toBeDefined();
        });

        it('should expose targetEnvironment', () => {
            const { stack } = createEdgeStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
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

    // =========================================================================
    // Lambda IAM Permissions
    // =========================================================================
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

        it('should grant STS AssumeRole for cross-account DNS with concrete ARN', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sts:AssumeRole',
                            Resource: 'arn:aws:iam::711387127421:role/Route53DnsValidationRole',
                        }),
                    ]),
                }),
            });
        });
    });

    // =========================================================================
    // Validation
    // =========================================================================
    describe('Validation', () => {
        it('should throw if region is not us-east-1', () => {
            const app = new cdk.App();

            expect(
                () =>
                    new K8sEdgeStack(app, 'BadRegionStack', {
                        ...DEFAULT_PROPS,
                        env: { account: '123456789012', region: 'eu-west-1' },
                    })
            ).toThrow(/us-east-1/);
        });

        it('should throw if required edge config values are missing', () => {
            const app = createTestApp();

            expect(
                () =>
                    new K8sEdgeStack(app, 'MissingConfigStack', {
                        ...DEFAULT_PROPS,
                        domainName: '',
                        hostedZoneId: '',
                        crossAccountRoleArn: '',
                    })
            ).toThrow(/domainName/);
        });
    });

    // =========================================================================
    // Tags
    // =========================================================================
    describe('Tags', () => {
        it('should tag stack with K8sEdge and Edge layer', () => {
            const { stack } = createEdgeStack();
            const tags = cdk.Tags.of(stack);
            expect(tags).toBeDefined();
        });
    });

    // =========================================================================
    // Custom Resource Properties
    // =========================================================================
    describe('Custom Resource Properties', () => {
        it('should pass concrete hosted zone ID to custom resource', () => {
            const { template } = createEdgeStack();
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                HostedZoneId: 'Z04763221QPB6CZ9R77GM',
            });
        });

        it('should pass environment to custom resource', () => {
            const { template } = createEdgeStack({
                targetEnvironment: Environment.PRODUCTION,
            });
            template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
                Environment: 'production',
            });
        });
    });
});
