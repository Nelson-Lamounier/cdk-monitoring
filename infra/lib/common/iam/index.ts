/**
 * @format
 * IAM Constructs - Central Export
 *
 * Reusable IAM constructs for service-account provisioning.
 *
 * Note: IAM roles for applications should typically be created directly
 * in stacks rather than as reusable constructs. See:
 * - lib/stacks/shared/cross-account-dns-role-stack.ts
 */

export { CrossplaneIamConstruct } from './crossplane-iam-construct';
export type { CrossplaneIamConstructProps } from './crossplane-iam-construct';
