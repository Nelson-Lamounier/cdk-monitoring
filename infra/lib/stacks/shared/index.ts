/**
 * @format
 * Shared Stacks - Central Export
 *
 * Stacks that can be deployed across multiple accounts
 * (e.g., root account, shared services)
 *
 * NOTE: CrossAccountDnsRoleStack has been moved to lib/stacks/org/
 * Use: import { CrossAccountDnsRoleStack } from '../stacks/org'
 */

export { SecurityBaselineStack } from './security-baseline-stack';
export type { SecurityBaselineStackProps } from './security-baseline-stack';

export { FinOpsStack } from './finops-stack';
export type { FinOpsStackProps, BudgetConfig } from './finops-stack';

export { CrossplaneStack } from './crossplane-stack';
export type { CrossplaneStackProps } from './crossplane-stack';
