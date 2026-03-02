/**
 * @format
 * Kubernetes Data Stack Unit Tests
 *
 * Tests for the KubernetesDataStack:
 * - DynamoDB Personal Portfolio Table
 * - S3 Assets & Access Logs Buckets
 * - SSM Parameters (cross-stack references)
 */

import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../../../../lib/config';
import { KubernetesDataStack } from '../../../../lib/stacks/kubernetes/data-stack';
import {
    TEST_ENV_EU,
    createTestApp,
} from '../../../fixtures';

// =============================================================================
// Test Fixtures
// =============================================================================



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
