/**
 * @fileoverview Barrel export for Kubernetes MCP tool handlers.
 * @module tools/k8s
 */

export { registerListNamespaces } from './list-namespaces.js';
export { registerListResources } from './list-resources.js';
export { registerGetResource } from './get-resource.js';
export { registerDescribeResource } from './describe-resource.js';
export { registerApplyResource } from './apply-resource.js';
export { registerDeleteResource } from './delete-resource.js';
export { registerGetPodLogs } from './get-pod-logs.js';
export { registerExecInPod } from './exec-in-pod.js';
export { registerScaleResource } from './scale-resource.js';
export { registerGetEvents } from './get-events.js';
export { registerGetClusterInfo } from './get-cluster-info.js';
export { registerManageHelm } from './manage-helm.js';
