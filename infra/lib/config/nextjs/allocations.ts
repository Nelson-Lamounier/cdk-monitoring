/**
 * @format
 * NextJS Project - Resource Allocations
 *
 * Centralized resource allocations (CPU, memory, scaling) by environment.
 * Allocations are "how much" - compute resources, capacity, sizing.
 *
 * Usage:
 * ```typescript
 * import { getNextJsAllocations } from '../../config/nextjs';
 * const allocs = getNextJsAllocations(Environment.PRODUCTION);
 * const lambdaMem = allocs.lambda.memoryMiB; // 512
 * ```
 */

import { Environment } from '../environments';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Lambda function resource allocation
 */
export interface LambdaAllocation {
    readonly memoryMiB: number;
    readonly reservedConcurrency?: number;
}

/**
 * ECS task resource allocation
 */
export interface EcsAllocation {
    readonly cpu: number;
    readonly memoryMiB: number;
}

/**
 * ECS task definition allocation (includes security settings)
 */
export interface EcsTaskAllocation {
    readonly cpu: number;
    readonly memoryMiB: number;
    /** Tmpfs size for Next.js cache in MiB */
    readonly tmpfsSizeMiB: number;
    /** NOFILE ulimit (open file descriptors) */
    readonly nofileLimit: number;
    /** Graceful shutdown timeout in seconds */
    readonly stopTimeoutSeconds: number;
}

/**
 * Auto Scaling Group allocation
 */
export interface AsgAllocation {
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly desiredCapacity?: number;
}

/**
 * DynamoDB allocation
 */
export interface DynamoDbAllocation {
    readonly readCapacity?: number;
    readonly writeCapacity?: number;
}

/**
 * ECS service auto-scaling allocation
 */
export interface ServiceScalingAllocation {
    /** Minimum number of tasks */
    readonly minCapacity: number;
    /** Maximum number of tasks */
    readonly maxCapacity: number;
    /** CPU utilization target for scaling (0-100) */
    readonly cpuTargetUtilizationPercent: number;
    /** Memory utilization target for scaling (0-100) */
    readonly memoryTargetUtilizationPercent: number;
}

/**
 * Complete resource allocations for NextJS project
 */
export interface NextJsAllocations {
    readonly lambda: LambdaAllocation;
    readonly ecs: EcsAllocation;
    readonly ecsTask: EcsTaskAllocation;
    readonly asg: AsgAllocation;
    readonly dynamodb: DynamoDbAllocation;
    readonly serviceScaling: ServiceScalingAllocation;
}

// =============================================================================
// ALLOCATIONS BY ENVIRONMENT
// =============================================================================

/**
 * NextJS resource allocations by environment
 */
export const NEXTJS_ALLOCATIONS: Record<Environment, NextJsAllocations> = {
    [Environment.DEVELOPMENT]: {
        lambda: {
            memoryMiB: 256,
            reservedConcurrency: undefined, // No limit in dev
        },
        ecs: {
            cpu: 256,      // 0.25 vCPU
            memoryMiB: 512,
        },
        ecsTask: {
            cpu: 256,
            memoryMiB: 512,
            tmpfsSizeMiB: 128,
            nofileLimit: 65536,
            stopTimeoutSeconds: 30, // Faster turnover in dev
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 2,
            desiredCapacity: 1,
        },
        dynamodb: {
            // On-demand billing (no capacity units)
        },
        serviceScaling: {
            minCapacity: 1,
            maxCapacity: 4,
            cpuTargetUtilizationPercent: 70,
            memoryTargetUtilizationPercent: 80,
        },
    },

    [Environment.STAGING]: {
        lambda: {
            memoryMiB: 512,
            reservedConcurrency: undefined,
        },
        ecs: {
            cpu: 512,      // 0.5 vCPU
            memoryMiB: 1024,
        },
        ecsTask: {
            cpu: 512,
            memoryMiB: 1024,
            tmpfsSizeMiB: 256,
            nofileLimit: 65536,
            stopTimeoutSeconds: 60,
        },
        asg: {
            minCapacity: 1,
            maxCapacity: 3,
            desiredCapacity: 1,
        },
        dynamodb: {
            // On-demand billing
        },
        serviceScaling: {
            minCapacity: 1,
            maxCapacity: 6,
            cpuTargetUtilizationPercent: 70,
            memoryTargetUtilizationPercent: 80,
        },
    },

    [Environment.PRODUCTION]: {
        lambda: {
            memoryMiB: 512,
            reservedConcurrency: 10, // Limit concurrency for cost control
        },
        ecs: {
            cpu: 512,      // 0.5 vCPU
            memoryMiB: 1024,
        },
        ecsTask: {
            cpu: 512,
            memoryMiB: 1024,
            tmpfsSizeMiB: 256,
            nofileLimit: 65536,
            stopTimeoutSeconds: 120, // More time for graceful shutdown in prod
        },
        asg: {
            minCapacity: 2,
            maxCapacity: 4,
            desiredCapacity: 2,
        },
        dynamodb: {
            // On-demand billing
        },
        serviceScaling: {
            minCapacity: 2,
            maxCapacity: 10,
            cpuTargetUtilizationPercent: 70,
            memoryTargetUtilizationPercent: 80,
        },
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get NextJS allocations for an environment
 */
export function getNextJsAllocations(env: Environment): NextJsAllocations {
    return NEXTJS_ALLOCATIONS[env];
}

/**
 * Get Lambda allocation for an environment
 */
export function getLambdaAllocation(env: Environment): LambdaAllocation {
    return NEXTJS_ALLOCATIONS[env].lambda;
}

/**
 * Get ECS allocation for an environment
 */
export function getEcsAllocation(env: Environment): EcsAllocation {
    return NEXTJS_ALLOCATIONS[env].ecs;
}

/**
 * Get ECS task allocation for an environment
 */
export function getEcsTaskAllocation(env: Environment): EcsTaskAllocation {
    return NEXTJS_ALLOCATIONS[env].ecsTask;
}
