/**
 * @format
 * Monitoring Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, backup) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getMonitoringConfigs } from '../../config/monitoring';
 * const configs = getMonitoringConfigs(Environment.PRODUCTION);
 * const backup = configs.backup.enabled; // true
 * ```
 */

import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { Environment } from '../environments';

// =============================================================================
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

/**
 * Read a value from process.env at synth time.
 * Returns undefined if the variable is not set.
 */
function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

/**
 * Read a JSON-encoded map from process.env.
 * Returns undefined if the variable is not set.
 */
function fromEnvJson<T>(key: string): T | undefined {
    const value = process.env[key];
    if (!value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

/**
 * Read a comma-separated list from process.env.
 * Returns undefined if the variable is not set.
 */
function fromEnvList(key: string): string[] | undefined {
    const value = process.env[key];
    return value ? value.split(',').map(s => s.trim()) : undefined;
}

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Backup configuration (DLM snapshots)
 */
export interface BackupConfig {
    readonly enabled: boolean;
    readonly retentionDays: number;
}

/**
 * Security Group configuration
 */
export interface SecurityGroupConfig {
    readonly ssmOnlyAccess: boolean;
    readonly allowSsh: boolean;
}

/**
 * EC2/ASG configuration
 */
export interface ComputeConfig {
    readonly detailedMonitoring: boolean;
    readonly useSignals: boolean;
    readonly signalsTimeoutMinutes: number;
}

/**
 * Prometheus retention configuration
 */
export interface PrometheusConfig {
    readonly retentionDays: number;
}

/**
 * Steampipe cross-account configuration.
 * Maps connection names to AWS account IDs for the aggregator.
 *
 * Supplied via STEAMPIPE_ACCOUNTS env var as JSON:
 *   STEAMPIPE_ACCOUNTS='{"nextjs_dev":"222222222222","nextjs_staging":"333333333333"}'
 */
export interface SteampipeAccountConfig {
    readonly [connectionName: string]: string; // connectionName → AWS account ID
}

/**
 * Complete resource configurations for Monitoring project
 */
export interface MonitoringConfigs {
    // =========================================================================
    // Synth-time context (values that vary per environment at synth time)
    // =========================================================================

    /**
     * Trusted CIDRs for security group ingress.
     * Safe defaults in committed config; personal IPs supplied via env var bridge.
     */
    readonly trustedCidrs: string[];

    /**
     * Grafana admin password.
     * undefined in committed config — supplied via GRAFANA_ADMIN_PASSWORD env var
     * in CI, or defaults to 'admin' in non-production at factory level.
     */
    readonly grafanaAdminPassword?: string;

    /**
     * Steampipe cross-account connections.
     * Maps connection names to AWS account IDs.
     * Supplied via STEAMPIPE_ACCOUNTS env var as JSON.
     * The monitoring account uses the EC2 instance role (no account ID needed).
     */
    readonly steampipeAccounts?: SteampipeAccountConfig;

    // =========================================================================
    // Resource behavior (policies, retention, limits)
    // =========================================================================

    readonly backup: BackupConfig;
    readonly securityGroup: SecurityGroupConfig;
    readonly compute: ComputeConfig;
    readonly prometheus: PrometheusConfig;
    readonly logRetention: logs.RetentionDays;
    readonly isProduction: boolean;
    readonly removalPolicy: cdk.RemovalPolicy;
    readonly createKmsKeys: boolean;
}

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Monitoring resource configurations by environment
 */
export const MONITORING_CONFIGS: Record<Environment, MonitoringConfigs> = {
    [Environment.DEVELOPMENT]: {
        // Synth-time context (env var > default)
        trustedCidrs: fromEnvList('ALLOWED_IP_RANGE') ?? ['0.0.0.0/0'],
        grafanaAdminPassword: fromEnv('GRAFANA_ADMIN_PASSWORD'),  // Defaults to 'admin' at factory level
        steampipeAccounts: fromEnvJson<SteampipeAccountConfig>('STEAMPIPE_ACCOUNTS'),

        // Resource behavior
        backup: {
            enabled: true,  // DLM snapshots even in dev (~$1/mo)
            retentionDays: 7,
        },
        securityGroup: {
            ssmOnlyAccess: true,  // SSM port forwarding for all environments
            allowSsh: false,       // Use SSM Session Manager instead
        },
        compute: {
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 10,
        },
        prometheus: {
            retentionDays: 15,
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,  // Use free AWS-managed keys
    },

    [Environment.STAGING]: {
        // Synth-time context (env var > default)
        trustedCidrs: fromEnvList('ALLOWED_IP_RANGE') ?? [],
        grafanaAdminPassword: fromEnv('GRAFANA_ADMIN_PASSWORD'),
        steampipeAccounts: fromEnvJson<SteampipeAccountConfig>('STEAMPIPE_ACCOUNTS'),

        // Resource behavior
        backup: {
            enabled: true,
            retentionDays: 14,
        },
        securityGroup: {
            ssmOnlyAccess: true,
            allowSsh: false,
        },
        compute: {
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 15,
        },
        prometheus: {
            retentionDays: 30,
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        // Synth-time context (env var > default)
        trustedCidrs: fromEnvList('ALLOWED_IP_RANGE') ?? [],
        grafanaAdminPassword: fromEnv('GRAFANA_ADMIN_PASSWORD'),  // Required in production
        steampipeAccounts: fromEnvJson<SteampipeAccountConfig>('STEAMPIPE_ACCOUNTS'),

        // Resource behavior
        backup: {
            enabled: true,
            retentionDays: 30,
        },
        securityGroup: {
            ssmOnlyAccess: true,
            allowSsh: false,
        },
        compute: {
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 15,
        },
        prometheus: {
            retentionDays: 90,
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,  // Customer-managed keys for compliance
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Monitoring configurations for an environment
 */
export function getMonitoringConfigs(env: Environment): MonitoringConfigs {
    return MONITORING_CONFIGS[env];
}


