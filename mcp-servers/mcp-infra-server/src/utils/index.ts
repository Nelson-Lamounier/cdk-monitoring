/**
 * @fileoverview Barrel export for all utility modules.
 *
 * Exposes both Kubernetes and AWS utility functions under
 * domain-specific names to avoid conflicts.
 *
 * @module utils
 */

// K8s utilities
export {
  formatResourceTable,
  formatMetadata,
  formatPodConditions,
  formatContainerStatuses,
  formatResourceAsJson,
} from './k8s-format.js';

export {
  handleK8sError,
  formatErrorForMcp as formatK8sErrorForMcp,
} from './k8s-error.js';

export type { K8sErrorResponse } from './k8s-error.js';

// AWS utilities
export {
  formatDynamoItem,
  formatDynamoItems,
  formatHttpResponse,
  formatSsmParameters,
} from './aws-format.js';

export {
  handleAwsError,
  formatErrorForMcp as formatAwsErrorForMcp,
} from './aws-error.js';

export type { McpErrorResponse } from './aws-error.js';
