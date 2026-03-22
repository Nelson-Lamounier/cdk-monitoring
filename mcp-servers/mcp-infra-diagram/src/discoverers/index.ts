/**
 * @fileoverview Barrel export for all discoverers.
 * @module discoverers/index
 */

export { discoverVpcResources } from './vpc-discoverer.js';
export type { VpcDiscoveryOptions, VpcDiscoveryResult } from './vpc-discoverer.js';

export { discoverSecurityGroups } from './sg-discoverer.js';
export type { SgDiscoveryOptions, SgDiscoveryResult } from './sg-discoverer.js';

export { discoverLoadBalancers } from './lb-discoverer.js';
export type { LbDiscoveryOptions, LbDiscoveryResult } from './lb-discoverer.js';

export { discoverComputeResources } from './compute-discoverer.js';
export type { ComputeDiscoveryOptions, ComputeDiscoveryResult } from './compute-discoverer.js';

export { discoverEdgeResources } from './edge-discoverer.js';
export type { EdgeDiscoveryOptions, EdgeDiscoveryResult } from './edge-discoverer.js';

export { discoverK8sResources } from './k8s-discoverer.js';
export type { K8sDiscoveryOptions, K8sDiscoveryResult } from './k8s-discoverer.js';
