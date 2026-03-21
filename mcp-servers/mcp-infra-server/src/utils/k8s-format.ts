/**
 * @fileoverview Output formatting utilities for Kubernetes API responses.
 * Transforms raw K8s API objects into clean, readable text optimised
 * for AI tool consumption — concise but information-rich.
 *
 * @module utils/format-output
 */

import type { V1ObjectMeta, V1Pod, V1PodCondition } from '@kubernetes/client-node';

/**
 * Formats a Kubernetes resource's metadata into a concise summary line.
 *
 * @param meta - The V1ObjectMeta from a Kubernetes resource.
 * @returns A formatted string with name, namespace, and creation timestamp.
 */
export function formatMetadata(meta?: V1ObjectMeta): string {
  if (!meta) {
    return 'No metadata available';
  }

  const parts: string[] = [];

  if (meta.name) {
    parts.push(`Name: ${meta.name}`);
  }
  if (meta.namespace) {
    parts.push(`Namespace: ${meta.namespace}`);
  }
  if (meta.creationTimestamp) {
    parts.push(`Created: ${meta.creationTimestamp.toISOString()}`);
  }
  if (meta.labels && Object.keys(meta.labels).length > 0) {
    const labelStr = Object.entries(meta.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`Labels: ${labelStr}`);
  }

  return parts.join('\n');
}

/**
 * Formats a list of Kubernetes resources into a table-like text output.
 *
 * @param items - Array of K8s resource objects with metadata.
 * @param columns - Column definitions mapping header names to value extractors.
 * @returns Formatted text table with aligned columns.
 */
export function formatResourceTable(
  items: Array<{ metadata?: V1ObjectMeta; [key: string]: unknown }>,
  columns: Array<{ header: string; value: (item: Record<string, unknown>) => string }>,
): string {
  if (items.length === 0) {
    return 'No resources found.';
  }

  const headers = columns.map((c) => c.header);
  const rows = items.map((item) =>
    columns.map((c) => c.value(item as unknown as Record<string, unknown>)),
  );

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  // Build header row
  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  // Build data rows
  const dataRows = rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  '),
  );

  return [headerRow, separator, ...dataRows].join('\n');
}

/**
 * Formats pod status conditions into a human-readable summary.
 *
 * @param conditions - Array of V1PodCondition from a pod's status.
 * @returns Formatted conditions text.
 */
export function formatPodConditions(conditions?: V1PodCondition[]): string {
  if (!conditions || conditions.length === 0) {
    return 'No conditions available.';
  }

  return conditions
    .map((c) => {
      const status = c.status === 'True' ? '✓' : '✗';
      const reason = c.reason ? ` (${c.reason})` : '';
      return `  ${status} ${c.type}: ${c.status}${reason}`;
    })
    .join('\n');
}

/**
 * Formats a pod's container statuses into a readable summary.
 *
 * @param pod - The V1Pod object.
 * @returns Formatted container status text.
 */
export function formatContainerStatuses(pod: V1Pod): string {
  const containers = pod.status?.containerStatuses;

  if (!containers || containers.length === 0) {
    return 'No container statuses available.';
  }

  return containers
    .map((c) => {
      const ready = c.ready ? '✓ Ready' : '✗ Not Ready';
      const restarts = `Restarts: ${c.restartCount}`;

      let state = 'Unknown';
      if (c.state?.running) {
        state = `Running (since ${c.state.running.startedAt?.toISOString() ?? 'unknown'})`;
      } else if (c.state?.waiting) {
        state = `Waiting: ${c.state.waiting.reason ?? 'unknown'}`;
      } else if (c.state?.terminated) {
        state = `Terminated: ${c.state.terminated.reason ?? 'unknown'} (exit ${c.state.terminated.exitCode})`;
      }

      return `  ${c.name}: ${ready} | ${state} | ${restarts}`;
    })
    .join('\n');
}

/**
 * Formats any generic Kubernetes resource as a YAML-like text representation.
 * Strips managed fields and other noisy metadata for cleaner output.
 *
 * @param resource - A raw K8s resource object.
 * @returns Clean JSON string representation suitable for AI consumption.
 */
export function formatResourceAsJson(resource: Record<string, unknown>): string {
  // Remove noisy metadata fields
  const cleaned = { ...resource };

  if (cleaned.metadata && typeof cleaned.metadata === 'object') {
    const meta = { ...(cleaned.metadata as Record<string, unknown>) };
    delete meta.managedFields;
    delete meta.selfLink;
    cleaned.metadata = meta;
  }

  return JSON.stringify(cleaned, null, 2);
}
