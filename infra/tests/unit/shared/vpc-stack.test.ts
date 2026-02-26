/**
 * @format
 * SharedVpcStack Unit Tests
 *
 * Tests for the shared VPC infrastructure used by all projects.
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../lib/config';
import { SharedVpcStack, SharedVpcStackProps } from '../../../lib/shared';

const TEST_ENV = {
    account: '123456789012',
    region: 'eu-west-1',
};

/**
 * Helper to create a SharedVpcStack for testing
 */
function createSharedVpcStack(
    props?: Partial<Omit<SharedVpcStackProps, 'targetEnvironment'>> & { targetEnvironment?: Environment }
): { stack: SharedVpcStack; template: Template } {
    const app = new cdk.App();
    const stack = new SharedVpcStack(app, 'TestSharedVpcStack', {
        env: TEST_ENV,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        ...props,
    });
    const template = Template.fromStack(stack);
    return { stack, template };
}

describe('SharedVpcStack', () => {
    describe('VPC Resource Creation', () => {
        it('should create a VPC resource', () => {
            const { template } = createSharedVpcStack();
            template.resourceCountIs('AWS::EC2::VPC', 1);
        });

        it('should create VPC with correct default CIDR block', () => {
            const { template } = createSharedVpcStack();
            template.hasResourceProperties('AWS::EC2::VPC', {
                CidrBlock: '10.0.0.0/16',
            });
        });

        it('should create VPC with custom CIDR when provided', () => {
            const { template } = createSharedVpcStack({ cidr: '172.16.0.0/16' });
            template.hasResourceProperties('AWS::EC2::VPC', {
                CidrBlock: '172.16.0.0/16',
            });
        });

        it('should create public subnets in multiple AZs', () => {
            const { template } = createSharedVpcStack({ maxAzs: 2 });
            template.resourceCountIs('AWS::EC2::Subnet', 2);
        });

        it('should not create NAT Gateways (cost optimization)', () => {
            const { template } = createSharedVpcStack();
            template.resourceCountIs('AWS::EC2::NatGateway', 0);
        });
    });

    describe('Environment Configuration', () => {
        it('should set targetEnvironment property', () => {
            const { stack } = createSharedVpcStack({ targetEnvironment: Environment.STAGING });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });

        it('should include environment in VPC name', () => {
            const { template } = createSharedVpcStack({ targetEnvironment: Environment.DEVELOPMENT });
            template.hasResourceProperties('AWS::EC2::VPC', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'Name', Value: Match.stringLikeRegexp('shared-vpc-dev') }),
                ]),
            });
        });

        it('should work with all environment types', () => {
            [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION].forEach(env => {
                const { stack } = createSharedVpcStack({ targetEnvironment: env });
                expect(stack.targetEnvironment).toBe(env);
            });
        });
    });

    describe('Gateway Endpoints', () => {
        it('should create S3 Gateway Endpoint by default', () => {
            const { template } = createSharedVpcStack();
            template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
                ServiceName: Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                        Match.arrayWith([Match.stringLikeRegexp('s3')]),
                    ]),
                }),
                VpcEndpointType: 'Gateway',
            });
        });

        it('should create DynamoDB Gateway Endpoint by default', () => {
            const { template } = createSharedVpcStack();
            template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
                ServiceName: Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                        Match.arrayWith([Match.stringLikeRegexp('dynamodb')]),
                    ]),
                }),
                VpcEndpointType: 'Gateway',
            });
        });

        it('should skip S3 endpoint when disabled', () => {
            const { template } = createSharedVpcStack({
                gatewayEndpoints: { enableS3Endpoint: false, enableDynamoDbEndpoint: true },
            });
            // Should only have DynamoDB endpoint
            template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
        });
    });

    describe('Flow Logs', () => {
        it('should create flow logs when configured', () => {
            const { template } = createSharedVpcStack({
                flowLogConfig: { createEncryptionKey: false },
            });
            template.hasResource('AWS::EC2::FlowLog', {});
        });

        it('should create KMS key for flow logs when encryption enabled', () => {
            const { template } = createSharedVpcStack({
                flowLogConfig: { createEncryptionKey: true },
            });
            template.hasResource('AWS::KMS::Key', {});
            template.hasResource('AWS::EC2::FlowLog', {});
        });

        it('should not create flow logs when not configured', () => {
            const { template } = createSharedVpcStack();
            template.resourceCountIs('AWS::EC2::FlowLog', 0);
        });
    });

    describe('Stack Outputs', () => {
        it('should output VPC ID (without export to avoid coupling)', () => {
            const { template } = createSharedVpcStack({ targetEnvironment: Environment.DEVELOPMENT });
            // Outputs exist but are NOT exported (to avoid cross-stack coupling)
            template.hasOutput('VpcId', {});
        });

        it('should output VPC CIDR (without export to avoid coupling)', () => {
            const { template } = createSharedVpcStack({ targetEnvironment: Environment.DEVELOPMENT });
            // Outputs exist but are NOT exported (to avoid cross-stack coupling)
            template.hasOutput('VpcCidr', {});
        });
    });

    describe('VPC Property Access', () => {
        it('should expose vpc property', () => {
            const { stack } = createSharedVpcStack();
            expect(stack.vpc).toBeDefined();
            expect(stack.vpc.vpcId).toBeDefined();
        });
    });
});
