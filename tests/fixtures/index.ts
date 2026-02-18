/**
 * @format
 * Test Fixtures - Central Export
 *
 * This module provides reusable test fixtures for CDK stack tests.
 * Import from this file to access all fixtures in one place.
 *
 * @example
 * ```typescript
 * import {
 *   createTestApp,
 *   createMockVpcWithSg,
 *   TEST_ENV,
 *   StackAssertions,
 *   Match,
 * } from '../../fixtures';
 * ```
 */

// Constants
export {
    TEST_ENV,
    TEST_ENV_EU,
    createTestEnv,
    TEST_CIDRS,
    DEFAULT_TAGS,
    DEFAULT_VPC_CONFIG,
    MONITORING_PORTS,
} from './constants';

// CDK App and Stack helpers
export {
    createTestApp,
    createHelperStack,
    createStackWithTemplate,
    createStackWithHelper,
    type StackFactoryResult,
    type StackWithHelperResult,
} from './test-app';

// Mock AWS resources
export {
    createMockVpc,
    createMockSecurityGroup,
    createMockVpcWithSg,
    createMockKmsKey,
    getFirstAvailabilityZone,
    type MockVpcOptions,
    type MockKmsKeyOptions,
    type VpcWithSecurityGroup,
} from './mock-resources';

// Assertion helpers
export {
    StackAssertions,
    findIngressRulesByPort,
    Match,
} from './assertions';
