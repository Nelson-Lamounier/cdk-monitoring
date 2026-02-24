/**
 * @format
 * Shared test constants
 *
 * Centralized constants for CDK stack tests to ensure consistency
 * and reduce duplication across test files.
 */

/**
 * Standard AWS environment for testing
 * Uses a fake account ID that follows AWS account format
 */
export const TEST_ENV = {
    account: '123456789012',
    region: 'us-east-1',
} as const;

/**
 * EU region environment for testing (for stacks not requiring us-east-1)
 */
export const TEST_ENV_EU = {
    account: '123456789012',
    region: 'eu-west-1',
} as const;

/**
 * Create a test environment with custom region
 */
export function createTestEnv(region: string = 'us-east-1') {
    return {
        account: '123456789012',
        region,
    };
}

/**
 * Common CIDR blocks for security group testing
 * Note: Using mutable arrays for compatibility with stack props
 */
export const TEST_CIDRS = {
    /** Single host /32 CIDR */
    single: ['10.0.0.1/32'] as string[],
    /** Multiple CIDRs for testing multi-source rules */
    multiple: ['10.0.0.1/32', '192.168.1.0/24'] as string[],
    /** Network range CIDR */
    network: ['172.16.0.0/16'] as string[],
    /** Private RFC1918 ranges */
    private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as string[],
};

/**
 * Standard tags applied to monitoring resources
 */
export const DEFAULT_TAGS = {
    Purpose: 'Monitoring',
    Application: 'Prometheus-Grafana',
} as const;

/**
 * Default VPC configuration for testing
 */
export const DEFAULT_VPC_CONFIG = {
    maxAzs: 2,
    natGateways: 0,
} as const;

/**
 * Default monitoring ports
 */
export const MONITORING_PORTS = {
    grafana: 3000,
    prometheus: 9090,
    nodeExporter: 9100,
    ssh: 22,
} as const;
