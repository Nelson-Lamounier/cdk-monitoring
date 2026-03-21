/**
 * @fileoverview Utility helpers for the infrastructure diagram MCP server.
 *
 * Provides error formatting, tag-based resource filtering, and
 * human-readable label builders.
 *
 * @module utils/helpers
 */

/**
 * Formats an AWS SDK error into a user-friendly MCP response string.
 *
 * @param error - The caught error (unknown type).
 * @param toolName - The tool name for context in the error message.
 * @returns Formatted error string.
 */
export function formatAwsError(error: unknown, toolName: string): string {
  if (error instanceof Error) {
    const name = error.name ?? 'Error';
    return `[${toolName}] ${name}: ${error.message}`;
  }
  return `[${toolName}] Unknown error: ${String(error)}`;
}

/**
 * Extracts the 'Name' tag value from an AWS resource tag array.
 *
 * @param tags - AWS tag array from describe calls.
 * @returns The Name tag value, or undefined if not present.
 */
export function getNameTag(
  tags?: ReadonlyArray<{ Key?: string; Value?: string }>,
): string | undefined {
  return tags?.find((t) => t.Key === 'Name')?.Value;
}

/**
 * Builds a human-readable label from a resource ID and optional name.
 *
 * @param id - Resource ID (e.g. 'vpc-0abc123').
 * @param name - Optional human-readable name.
 * @returns Label string: 'name (id)' or just 'id'.
 */
export function buildLabel(id: string, name?: string): string {
  return name ? `${name} (${id})` : id;
}

/**
 * Checks whether an AWS resource's tags match a filter.
 *
 * @param resourceTags - The resource's tag array.
 * @param filterTags - Key-value pairs that must all match.
 * @returns True if all filter tags are present with matching values.
 */
export function matchesTags(
  resourceTags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
  filterTags: Record<string, string> | undefined,
): boolean {
  if (!filterTags || Object.keys(filterTags).length === 0) return true;
  if (!resourceTags) return false;

  return Object.entries(filterTags).every(([key, value]) =>
    resourceTags.some((t) => t.Key === key && t.Value === value),
  );
}

/**
 * Shortens an AWS resource ID for compact diagram labels.
 *
 * @param id - Full resource ID (e.g. 'subnet-0abcdef1234567890').
 * @param prefixLength - Characters to keep from the prefix. Default: 4.
 * @returns Shortened ID (e.g. 'subnet-0abc...7890').
 */
export function shortenId(id: string, prefixLength = 4): string {
  const parts = id.split('-');
  if (parts.length < 2) return id;
  const prefix = parts[0];
  const hash = parts.slice(1).join('-');
  if (hash.length <= prefixLength * 2) return id;
  return `${prefix}-${hash.slice(0, prefixLength)}...${hash.slice(-prefixLength)}`;
}
