/**
 * @format
 * Kubernetes Data Stack Unit Tests
 *
 * Tests for the KubernetesDataStack:
 * - Golden AMI SSM Parameter seeding (Day-0 fix)
 * - DynamoDB Personal Portfolio Table
 * - S3 Assets & Access Logs Buckets
 * - SSM Parameters (cross-stack references)
 *
 * NOTE: This file focuses on the Golden AMI SSM parameter seeding,
 * which was moved from the Compute stack to avoid a Day-0 circular
 * dependency. Other test cases are scaffolded with it.todo().
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { getK8sConfigs } from '../../../../lib/config/kubernetes';
import { KubernetesDataStack } from '../../../../lib/stacks/kubernetes/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_CONFIGS = getK8sConfigs(Environment.DEVELOPMENT);

/**
 * Helper to create KubernetesDataStack with sensible defaults.
 */
function createDataStack(
    overrides?: Partial<ConstructorParameters<typeof KubernetesDataStack>[2]>,
): { stack: KubernetesDataStack; template: Template; app: cdk.App } {
    const app = createTestApp();

    const stack = new KubernetesDataStack(
        app,
        'TestK8sDataStack',
        {
            targetEnvironment: Environment.DEVELOPMENT,
            projectName: 'k8s',
            env: TEST_ENV_EU,
            goldenAmiSsmPath: TEST_CONFIGS.image.amiSsmPath,
            parentImageSsmPath: TEST_CONFIGS.image.parentImageSsmPath,
            ...overrides,
        },
    );

    const template = Template.fromStack(stack);
    return { stack, template, app };
}

// =============================================================================
// Tests
// =============================================================================

describe('KubernetesDataStack', () => {

    // =========================================================================
    // Golden AMI SSM Parameter — Day-0 Seed
    //
    // The Compute stack's LaunchTemplate uses fromSsmParameter() which
    // creates a {{resolve:ssm:...}} dynamic reference. CloudFormation
    // resolves this BEFORE creating any resources. By seeding the parameter
    // in the Data stack (deployed first), we guarantee it exists.
    //
    // REGRESSION GUARD: SSM parameter with dataType 'aws:ec2:image'
    // MUST hold a valid AMI ID — arbitrary placeholders like
    // 'PENDING_FIRST_BUILD' cause CREATE_FAILED (timeout).
    // =========================================================================
    describe('Golden AMI SSM Parameter (Day-0 seed)', () => {
        const { template } = createDataStack();

        type SsmCfnResource = { Properties?: { DataType?: string; Value?: unknown; Name?: string } };
        let goldenAmiParam: [string, SsmCfnResource] | undefined;
        let paramValue: unknown;

        beforeAll(() => {
            const ssmParameters = template.findResources('AWS::SSM::Parameter');
            goldenAmiParam = Object.entries(ssmParameters).find(([, resource]) => {
                const props = (resource as SsmCfnResource).Properties;
                return props?.DataType === 'aws:ec2:image';
            }) as [string, SsmCfnResource] | undefined;

            paramValue = goldenAmiParam?.[1]?.Properties?.Value;
        });

        it('should create an SSM parameter with dataType aws:ec2:image', () => {
            expect(goldenAmiParam).toBeDefined();
        });

        it('should set the correct SSM parameter name', () => {
            expect(goldenAmiParam?.[1]?.Properties?.Name).toBe(
                TEST_CONFIGS.image.amiSsmPath,
            );
        });

        it('should NOT use a placeholder string as the initial value', () => {
            const invalidPlaceholders = [
                'PENDING_FIRST_BUILD',
                'PLACEHOLDER',
                'TBD',
                'NONE',
            ];

            expect(invalidPlaceholders).not.toContain(
                String(paramValue).toUpperCase(),
            );
        });

        it('should resolve the initial value from the parent AMI SSM parameter', () => {
            // CDK synthesizes ssm.StringParameter.valueForStringParameter
            // as a { Ref: ... } to a CloudFormation Parameter backed by SSM,
            // NOT a {{resolve:ssm:...}} dynamic reference.
            expect(paramValue).toStrictEqual(
                expect.objectContaining({ Ref: expect.stringContaining('SsmParameterValue') }),
            );
        });
    });

    // =========================================================================
    // Golden AMI SSM Parameter — Conditional (not provided)
    // =========================================================================
    describe('Golden AMI SSM Parameter (not provided)', () => {
        const { template } = createDataStack({
            goldenAmiSsmPath: undefined,
            parentImageSsmPath: undefined,
        });

        it('should NOT create the Golden AMI SSM parameter when paths are omitted', () => {
            type SsmCfnResource = { Properties?: { DataType?: string } };
            const ssmParameters = template.findResources('AWS::SSM::Parameter');
            const goldenAmiParam = Object.entries(ssmParameters).find(([, resource]) => {
                const props = (resource as SsmCfnResource).Properties;
                return props?.DataType === 'aws:ec2:image';
            });

            expect(goldenAmiParam).toBeUndefined();
        });
    });

    // =========================================================================
    // DynamoDB
    // =========================================================================
    describe('DynamoDB Portfolio Table', () => {
        it.todo('should create a DynamoDB table with pk/sk keys');

        it.todo('should create GSI1 and GSI2');

        it.todo('should enable point-in-time recovery');
    });

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    describe('S3 Buckets', () => {
        it.todo('should create an assets bucket');

        it.todo('should create an access logs bucket');

        it.todo('should block public access on assets bucket');
    });

    // =========================================================================
    // SSM Parameters
    // =========================================================================
    describe('SSM Parameters', () => {
        it.todo('should create SSM parameter for table name');

        it.todo('should create SSM parameter for assets bucket name');

        it.todo('should create SSM parameter for AWS region');
    });

    // =========================================================================
    // Tags
    // =========================================================================
    describe('Tags', () => {
        it.todo('should tag resources with Stack=KubernetesData');

        it.todo('should tag resources with Layer=Data');
    });
});
