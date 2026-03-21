/**
 * @fileoverview Barrel export for client factories.
 * @module clients
 */

export { createK8sClients, getCurrentContextName, getClusterServerUrl } from './k8s-client.js';
export { createAwsClients } from './aws-client.js';

export type { K8sClients } from './k8s-client.js';
export type { AwsClients } from './aws-client.js';
