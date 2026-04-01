/**
 * @format
 * Observability Stack Unit Tests
 *
 * Tests for KubernetesObservabilityStack:
 * - CloudWatch Dashboard resource creation
 * - Dashboard body contains expected metric widgets
 * - SSM parameter lookups for EBS volume
 * - Optional sections (Step Functions, Lambda, CloudFront)
 * - Stack outputs (dashboard name, console URL)
 */

import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import {
    KubernetesObservabilityStack,
} from '../../../../lib/stacks/kubernetes/observability-stack';
import type {
    KubernetesObservabilityStackProps,
} from '../../../../lib/stacks/kubernetes/observability-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Constants
// =============================================================================

const NAME_PREFIX = 'k8s-dev';
const SSM_PREFIX = '/k8s/development';
const DASHBOARD_NAME = `${NAME_PREFIX}-infrastructure`;

// =============================================================================
// Test Fixtures
// =============================================================================

function createObservabilityStack(
    overrides?: Partial<KubernetesObservabilityStackProps>,
): { stack: KubernetesObservabilityStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new KubernetesObservabilityStack(app, 'TestObservabilityStack', {
        env: TEST_ENV_EU,
        targetEnvironment: Environment.DEVELOPMENT,
        namePrefix: NAME_PREFIX,
        ssmPrefix: SSM_PREFIX,
        ...overrides,
    });

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesObservabilityStack', () => {
    // =========================================================================
    // Dashboard Resource
    // =========================================================================
    describe('Dashboard Resource', () => {
        it('should create 2 CloudWatch Dashboards (Infrastructure + Operations)', () => {
            const { template } = createObservabilityStack();
            template.resourceCountIs('AWS::CloudWatch::Dashboard', 2);
        });

        it('should use the correct dashboard name', () => {
            const { template } = createObservabilityStack();
            template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
                DashboardName: DASHBOARD_NAME,
            });
        });
    });

    // =========================================================================
    // Dashboard Widget Content
    // =========================================================================
    describe('Dashboard Widgets', () => {
        it('should include EC2 CPU Utilisation metrics for all 3 ASGs', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            // Verify all 3 ASG names appear in the dashboard body
            expect(dashboardBody).toContain(`${NAME_PREFIX}-asg`);
            expect(dashboardBody).toContain(`${NAME_PREFIX}-worker-asg`);
            expect(dashboardBody).toContain(`${NAME_PREFIX}-mon-worker-asg`);
        });

        it('should include NLB metrics', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).toContain('AWS/NetworkELB');
            expect(dashboardBody).toContain('ActiveFlowCount');
        });

        it('should include EC2 StatusCheckFailed metrics', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).toContain('StatusCheckFailed');
        });

        it('should include EC2 Network metrics', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).toContain('NetworkIn');
            expect(dashboardBody).toContain('NetworkOut');
        });
    });

    // =========================================================================
    // Optional Sections
    // =========================================================================
    describe('Dynamic Scope Sections', () => {
        it('should include Step Functions metrics using SEARCH expression', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).toContain('AWS/States');
            expect(dashboardBody).toContain('SEARCH');
            expect(dashboardBody).toContain('ExecutionsStarted');
            expect(dashboardBody).toContain('ExecutionsFailed');
        });

        it('should include Lambda metrics using SEARCH expression', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).toContain('AWS/Lambda');
            expect(dashboardBody).toContain('SEARCH');
            expect(dashboardBody).toContain('Errors');
        });

        it('should include CloudFront metrics when distributionId is provided', () => {
            const { template } = createObservabilityStack({
                cloudFrontDistributionId: 'E1234567890ABC',
            });
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).toContain('AWS/CloudFront');
            expect(dashboardBody).toContain('E1234567890ABC');
        });

        it('should NOT include CloudFront metrics when distributionId is omitted', () => {
            const { template } = createObservabilityStack();
            const dashboard = template.findResources('AWS::CloudWatch::Dashboard');
            const dashboardBody = getDashboardBody(dashboard);

            expect(dashboardBody).not.toContain('AWS/CloudFront');
        });
    });

    // =========================================================================
    // SSM Parameter Lookups
    // =========================================================================
    describe('SSM Parameters', () => {
        it('should NOT create any SSM parameters (reads only)', () => {
            const { template } = createObservabilityStack();

            // The stack resolves SSM parameters at deploy time via
            // valueForStringParameter — it should NOT create new ones.
            template.resourceCountIs('AWS::SSM::Parameter', 0);
        });
    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    describe('Stack Outputs', () => {
        it('should output the dashboard name', () => {
            const { template } = createObservabilityStack();
            template.hasOutput('DashboardName', {
                Value: DASHBOARD_NAME,
            });
        });

        it('should output the dashboard console URL', () => {
            const { template } = createObservabilityStack();
            template.hasOutput('DashboardUrl', {
                Value: Match.stringLikeRegexp('console\\.aws\\.amazon\\.com/cloudwatch'),
            });
        });
    });

    // =========================================================================
    // Stack Properties
    // =========================================================================
    describe('Stack Properties', () => {
        it('should expose the dashboard construct', () => {
            const { stack } = createObservabilityStack();
            expect(stack.dashboard).toBeDefined();
            expect(stack.dashboard.dashboardName).toBe(DASHBOARD_NAME);
        });

        it('should set the correct stack description', () => {
            const { stack } = createObservabilityStack();
            expect(stack.templateOptions.description).toContain('Pre-deployment CloudWatch dashboard');
            expect(stack.templateOptions.description).toContain('development');
        });
    });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract the dashboard body JSON string from a CloudFormation template.
 *
 * CloudWatch Dashboard bodies are stored as `Fn::Join` arrays in the
 * synthesised template. This helper flattens the array into a single
 * string for assertion matching.
 *
 * @param dashboardResources - Resources matching AWS::CloudWatch::Dashboard
 * @returns Flattened dashboard body string
 */
function getDashboardBody(
    dashboardResources: Record<string, Record<string, unknown>>,
): string {
    const resourceKey = Object.keys(dashboardResources)[0];
    const resource = dashboardResources[resourceKey];
    const properties = resource.Properties as Record<string, unknown>;
    const body = properties.DashboardBody;

    // CDK produces Fn::Join for the dashboard body
    if (typeof body === 'string') {
        return body;
    }

    // Flatten Fn::Join into a string for assertion matching
    return JSON.stringify(body);
}
