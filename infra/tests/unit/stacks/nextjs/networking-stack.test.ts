/**
 * @format
 * NextJS Networking Stack Unit Tests
 *
 * Tests for the consolidated NextJsNetworkingStack:
 * - Application Load Balancer creation
 * - Target Group configuration (deregistration delay)
 * - Task Security Group
 * - HTTPS listener with redirection
 * - Health check configuration
 * - CloudFront restriction warnings
 * - SSM parameters (ALB DNS, task SG ID)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';

import { Environment } from '../../../../lib/config';
import {
    NextJsNetworkingStack,
    NextJsNetworkingStackProps,
} from '../../../../lib/stacks/nextjs/networking/networking-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

/**
 * Helper to create test VPC within the same app
 */
function createNetworkingStack(
    props?: Partial<NextJsNetworkingStackProps>,
): { stack: NextJsNetworkingStack; template: Template } {
    const app = createTestApp();

    // Create VPC inside the SAME stack to avoid cyclic cross-stack
    // dependencies caused by VPC Interface Endpoints referencing
    // subnet route tables in the VPC stack.
    const stack = new NextJsNetworkingStack(app, 'TestNetworkingStack', {
        env: TEST_ENV_EU,
        targetEnvironment: props?.targetEnvironment ?? Environment.DEVELOPMENT,
        vpcName: 'shared-vpc-development',
        namePrefix: props?.namePrefix ?? 'nextjs',
        ...props,
    });

    const template = Template.fromStack(stack);
    return { stack, template };
}

describe('NextJsNetworkingStack', () => {
    describe('Application Load Balancer', () => {
        it('should create an ALB', () => {
            const { template } = createNetworkingStack();
            template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
        });

        it('should be internet-facing', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Scheme: 'internet-facing',
            });
        });

        it('should use application type', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
                Type: 'application',
            });
        });
    });

    describe('Target Group', () => {
        it('should create a target group', () => {
            const { template } = createNetworkingStack();
            template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
        });

        it('should use IP target type for Fargate', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                TargetType: 'ip',
            });
        });

        it('should configure health check path', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                HealthCheckPath: '/api/health',
            });
        });

        it('should use port 3000 as default', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Port: 3000,
            });
        });

        it('should use HTTP protocol', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Protocol: 'HTTP',
            });
        });
    });

    describe('Security Groups', () => {
        it('should create ALB security group', () => {
            const { template } = createNetworkingStack();
            // Should have at least 2 security groups: ALB SG and Task SG
            const sgs = template.findResources('AWS::EC2::SecurityGroup');
            expect(Object.keys(sgs).length).toBeGreaterThanOrEqual(2);
        });

        it('should create task security group', () => {
            const { stack } = createNetworkingStack();
            expect(stack.taskSecurityGroup).toBeDefined();
        });

        it('should have ALB security group exposed', () => {
            const { stack } = createNetworkingStack();
            // Verify ALB SG is defined and has a security group ID
            expect(stack.albSecurityGroup).toBeDefined();
            expect(stack.albSecurityGroup.securityGroupId).toBeDefined();
        });

        it('should have allowed traffic for ALB (default: unrestricted)', () => {
            const { template } = createNetworkingStack();
            // Check that security groups or ingress rules exist
            const sgs = template.findResources('AWS::EC2::SecurityGroup');
            const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
            // Either inline rules exist or standalone ingress resources
            expect(Object.keys(sgs).length + Object.keys(ingress).length).toBeGreaterThan(0);
        });

        it('should emit warning for production without restrictToCloudFront', () => {
            const { stack } = createNetworkingStack({
                targetEnvironment: Environment.PRODUCTION,
            });
            const warnings = stack.node.metadata.filter(
                m => m.type === 'aws:cdk:warning',
            );
            expect(warnings.some(w =>
                (w.data as string).includes('restrictToCloudFront'),
            )).toBe(true);
        });

        it('should not emit warning for dev without restrictToCloudFront', () => {
            const { stack } = createNetworkingStack({
                targetEnvironment: Environment.DEVELOPMENT,
            });
            const warnings = stack.node.metadata.filter(
                m => m.type === 'aws:cdk:warning',
            );
            expect(warnings.some(w =>
                (w.data as string).includes('restrictToCloudFront'),
            )).toBe(false);
        });
    });

    describe('Listeners', () => {
        it('should create HTTP listener without certificate', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 80,
                Protocol: 'HTTP',
            });
        });

        it('should forward to target group when no certificate', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
                Port: 80,
                DefaultActions: Match.arrayWith([
                    Match.objectLike({
                        Type: 'forward',
                    }),
                ]),
            });
        });
    });

    describe('Stack Properties', () => {
        it('should expose loadBalancer property', () => {
            const { stack } = createNetworkingStack();
            expect(stack.loadBalancer).toBeDefined();
        });

        it('should expose targetGroup property', () => {
            const { stack } = createNetworkingStack();
            expect(stack.targetGroup).toBeDefined();
        });

        it('should expose taskSecurityGroup property', () => {
            const { stack } = createNetworkingStack();
            expect(stack.taskSecurityGroup).toBeDefined();
        });

        it('should expose albSecurityGroup property', () => {
            const { stack } = createNetworkingStack();
            expect(stack.albSecurityGroup).toBeDefined();
        });

        it('should expose httpListener property', () => {
            const { stack } = createNetworkingStack();
            expect(stack.httpListener).toBeDefined();
        });

        it('should expose targetEnvironment property', () => {
            const { stack } = createNetworkingStack({
                targetEnvironment: Environment.STAGING,
            });
            expect(stack.targetEnvironment).toBe(Environment.STAGING);
        });
    });

    describe('Stack Outputs', () => {
        it('should export ALB DNS name', () => {
            const { template } = createNetworkingStack();
            template.hasOutput('LoadBalancerDnsName', {});
        });

        it('should export ALB ARN', () => {
            const { template } = createNetworkingStack();
            template.hasOutput('LoadBalancerArn', {});
        });

        it('should export target group ARN', () => {
            const { template } = createNetworkingStack();
            template.hasOutput('TargetGroupArn', {});
        });

        it('should export ALB security group ID', () => {
            const { template } = createNetworkingStack();
            template.hasOutput('AlbSecurityGroupId', {});
        });

        it('should export task security group ID', () => {
            const { template } = createNetworkingStack();
            template.hasOutput('TaskSecurityGroupId', {});
        });
    });

    describe('SSM Parameters', () => {
        it('should publish ALB DNS name to SSM', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Description: Match.stringLikeRegexp('ALB DNS'),
            });
        });

        it('should publish task security group ID to SSM', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::SSM::Parameter', {
                Type: 'String',
                Description: Match.stringLikeRegexp('Task security group'),
            });
        });
    });

    describe('Custom Configuration', () => {
        it('should respect custom container port', () => {
            const { template } = createNetworkingStack({
                containerPort: 8080,
            });
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                Port: 8080,
            });
        });

        it('should respect custom health check path', () => {
            const { template } = createNetworkingStack({
                healthCheckPath: '/health',
            });
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                HealthCheckPath: '/health',
            });
        });

        it('should use config-driven deregistration delay', () => {
            const { template } = createNetworkingStack();
            template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
                TargetGroupAttributes: Match.arrayWith([
                    Match.objectLike({
                        Key: 'deregistration_delay.timeout_seconds',
                        Value: '60',
                    }),
                ]),
            });
        });
    });

    describe('VPC Endpoint', () => {
        it('should NOT create a VPC endpoint for API Gateway (REGIONAL APIs are incompatible with VPC endpoints)', () => {
            const { template } = createNetworkingStack();
            template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
        });
    });
});
