/**
 * @fileoverview Output formatting utilities for AWS API responses.
 * Transforms raw API objects into clean, readable text optimised
 * for AI tool consumption — concise but information-rich.
 *
 * @module utils/format-output
 */

/**
 * Formats a DynamoDB item as a clean JSON string.
 *
 * @param item - A DynamoDB item (already unmarshalled by DocumentClient).
 * @returns Formatted JSON string.
 */
export function formatDynamoItem(item: Record<string, unknown>): string {
  return JSON.stringify(item, null, 2);
}

/**
 * Formats a list of DynamoDB items as a readable table or JSON array.
 *
 * @param items - Array of DynamoDB items.
 * @param maxItems - Maximum items to show before truncation.
 * @returns Formatted string representation.
 */
export function formatDynamoItems(
  items: Record<string, unknown>[],
  maxItems = 20,
): string {
  if (items.length === 0) {
    return 'No items found.';
  }

  const displayed = items.slice(0, maxItems);
  const output = JSON.stringify(displayed, null, 2);

  if (items.length > maxItems) {
    return `${output}\n\n... and ${items.length - maxItems} more items (truncated)`;
  }

  return output;
}

/**
 * Formats an HTTP response into a readable summary.
 *
 * @param status - HTTP status code.
 * @param headers - Response headers.
 * @param body - Response body string.
 * @returns Formatted HTTP response summary.
 */
export function formatHttpResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
): string {
  const parts: string[] = [
    `Status: ${status}`,
    '',
    'Headers:',
    ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'Body:',
    body.length > 2000 ? `${body.slice(0, 2000)}\n... (truncated, ${body.length} chars total)` : body,
  ];

  return parts.join('\n');
}

/**
 * Formats SSM parameters into a readable table.
 *
 * @param parameters - Array of SSM parameter objects.
 * @returns Formatted parameter listing.
 */
export function formatSsmParameters(
  parameters: Array<{ name: string; value: string; type: string }>,
): string {
  if (parameters.length === 0) {
    return 'No parameters found.';
  }

  const maxNameLen = Math.max(...parameters.map((p) => p.name.length));
  const header = `${'PARAMETER'.padEnd(maxNameLen)}  TYPE            VALUE`;
  const separator = '-'.repeat(header.length);

  const rows = parameters.map(
    (p) => `${p.name.padEnd(maxNameLen)}  ${p.type.padEnd(14)}  ${p.value}`,
  );

  return [header, separator, ...rows].join('\n');
}
