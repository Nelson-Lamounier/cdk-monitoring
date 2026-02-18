/**
 * @format
 * Monitoring Project - Resource Allocations
 *
 * Centralized resource allocations (CPU, memory, scaling) by environment.
 * Allocations are "how much" - compute resources, capacity, sizing.
 *
 * Usage:
 * ```typescript
 * import { getMonitoringAllocations } from '../../config/monitoring';
 * const allocs = getMonitoringAllocations(Environment.PRODUCTION);
 * const volumeSize = allocs.ebs.sizeGb; // 50
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * EC2 instance resource allocation
 */
export interface Ec2Allocation {
    readonly instanceClass: ec2.InstanceClass;
    readonly instanceSize: ec2.InstanceSize;
    readonly rootVolumeSizeGb: number;
}

/**
 * EBS data volume allocation
 */
export interface EbsAllocation {
    readonly sizeGb: number;
    readonly iops: number;
    readonly throughput: number;
}

/**
 * Auto Scaling Group allocation
 */
export interface MonitoringAsgAllocation {
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly desiredCapacity?: number;
    readonly targetCpuUtilization: number;
}

/**
 * Complete resource allocations for Monitoring project
 */
export interface MonitoringAllocations {
    readonly ec2: Ec2Allocation;
    readonly ebs: EbsAllocation;
    readonly asg: MonitoringAsgAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * Monitoring resource allocations by environment
 */
export const MONITORING_ALLOCATIONS: Record<Environment, MonitoringAllocations> = {
    [Environment.DEVELOPMENT]: {
        ec2: {
            instanceClass: ec2.InstanceClass.T3,
            instanceSize: ec2.InstanceSize.SMALL,
            rootVolumeSizeGb: 30,
        },
        ebs: {
            sizeGb: 30,
            iops: 3000,
            throughput: 125,
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 1,
            desiredCapacity: 1,
            targetCpuUtilization: 70,
        },
    },

    [Environment.STAGING]: {
        ec2: {
            instanceClass: ec2.InstanceClass.T3,
            instanceSize: ec2.InstanceSize.SMALL,
            rootVolumeSizeGb: 30,
        },
        ebs: {
            sizeGb: 30,
            iops: 3000,
            throughput: 125,
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 2,
            desiredCapacity: 1,
            targetCpuUtilization: 70,
        },
    },

    [Environment.PRODUCTION]: {
        ec2: {
            instanceClass: ec2.InstanceClass.T3,
            instanceSize: ec2.InstanceSize.MEDIUM,
            rootVolumeSizeGb: 30,
        },
        ebs: {
            sizeGb: 50,  // Larger for 30-90 day Prometheus retention
            iops: 3000,
            throughput: 125,
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 2,
            desiredCapacity: 1,
            targetCpuUtilization: 70,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get Monitoring allocations for an environment
 */
export function getMonitoringAllocations(env: Environment): MonitoringAllocations {
    return MONITORING_ALLOCATIONS[env];
}

/**
 * Get EC2 allocation for an environment
 */
export function getEc2Allocation(env: Environment): Ec2Allocation {
    return MONITORING_ALLOCATIONS[env].ec2;
}

/**
 * Get EBS allocation for an environment
 */
export function getEbsAllocation(env: Environment): EbsAllocation {
    return MONITORING_ALLOCATIONS[env].ebs;
}

/**
 * Get ASG allocation for an environment
 */
export function getMonitoringAsgAllocation(env: Environment): MonitoringAsgAllocation {
    return MONITORING_ALLOCATIONS[env].asg;
}
