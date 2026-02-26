/**
 * @format
 * Monitoring Stacks - Central Export
 *
 * Provides modular stacks for the monitoring infrastructure.
 *
 * **Consolidated Architecture (2 stacks)**:
 * - StorageStack: EBS volume + Lifecycle Lambda
 * - ComputeStack: Security Group + EC2/ASG compute
 *
 * @deprecated The following are deprecated (use consolidated stacks):
 * - MonitoringSecurityGroupStack → Use MonitoringComputeStack
 * - MonitoringEbsStack → Use MonitoringStorageStack
 * - MonitoringEbsLifecycleStack → Use MonitoringStorageStack
 */

// New consolidated stacks (recommended)
export * from './storage/storage-stack';
export * from './compute/compute-stack';
export * from './ssm/ssm-stack';

// Legacy stacks (deprecated, kept for backward compatibility)


