/**
 * @fileoverview Shared Zod schemas for Kubernetes resource parameters.
 * These schemas are reused across multiple MCP tool handlers to ensure
 * consistent input validation and type inference.
 * @module schemas/k8s-params
 */

import { z } from 'zod';

/**
 * Schema for a Kubernetes namespace identifier.
 * Validates against K8s naming conventions: lowercase alphanumeric + hyphens,
 * max 63 characters.
 */
export const namespaceSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'Namespace must be lowercase alphanumeric with optional hyphens',
  })
  .describe('Kubernetes namespace to target. Omit to use the default context namespace.');

/**
 * Schema for a Kubernetes label selector string.
 * Supports equality-based and set-based selectors.
 *
 * @example "app=myapp,env=prod"
 * @example "app in (myapp,yourapp)"
 */
export const labelSelectorSchema = z
  .string()
  .min(1)
  .describe(
    'Kubernetes label selector (e.g. "app=myapp,env=prod" or "app in (myapp,yourapp)")',
  );

/**
 * Schema for a Kubernetes field selector string.
 *
 * @example "status.phase=Running"
 * @example "metadata.name=my-pod"
 */
export const fieldSelectorSchema = z
  .string()
  .min(1)
  .describe(
    'Kubernetes field selector (e.g. "status.phase=Running", "metadata.name=my-pod")',
  );

/**
 * Schema for a Kubernetes resource name.
 * Validates against K8s naming conventions.
 */
export const resourceNameSchema = z
  .string()
  .min(1)
  .max(253)
  .describe('Name of the Kubernetes resource');

/**
 * Schema for a Kubernetes API version string.
 *
 * @example "v1"
 * @example "apps/v1"
 * @example "networking.k8s.io/v1"
 */
export const apiVersionSchema = z
  .string()
  .min(1)
  .describe(
    'Kubernetes API version (e.g. "v1", "apps/v1", "networking.k8s.io/v1")',
  );

/**
 * Schema for a Kubernetes resource kind.
 *
 * @example "Pod"
 * @example "Deployment"
 * @example "Service"
 */
export const kindSchema = z
  .string()
  .min(1)
  .describe(
    'Kubernetes resource kind (e.g. "Pod", "Deployment", "Service", "Ingress")',
  );

/**
 * Schema for the number of log tail lines.
 */
export const tailLinesSchema = z
  .number()
  .int()
  .min(1)
  .max(10000)
  .default(100)
  .describe('Number of lines to retrieve from the end of the logs (default: 100)');

/**
 * Schema for a container name within a pod.
 */
export const containerNameSchema = z
  .string()
  .min(1)
  .describe('Name of the container within the pod');

/**
 * Schema for a shell command to execute in a pod.
 */
export const commandSchema = z
  .array(z.string())
  .min(1)
  .describe(
    'Command to execute as an array. First element is the command, rest are arguments. Example: ["ls", "-la", "/tmp"]',
  );

/**
 * Schema for replica count when scaling resources.
 */
export const replicaCountSchema = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .describe('Desired number of replicas');
