/**
 * @fileoverview Error handling utilities for MCP tool responses.
 * Provides consistent error formatting and AWS error extraction.
 *
 * @module utils/error-handler
 */

/**
 * Structured error response for MCP tool results.
 */
export interface McpErrorResponse {
  /** Human-readable error message */
  readonly message: string;
  /** AWS error code if applicable */
  readonly code?: string;
  /** HTTP status code if applicable */
  readonly statusCode?: number;
}

/**
 * Extracts a structured error response from an AWS SDK error or generic Error.
 *
 * @param error - The caught error object.
 * @returns A structured error response.
 */
export function handleAwsError(error: unknown): McpErrorResponse {
  if (error instanceof Error) {
    const awsError = error as Error & {
      $metadata?: { httpStatusCode?: number };
      name?: string;
      Code?: string;
    };

    return {
      message: awsError.message,
      code: awsError.name ?? awsError.Code,
      statusCode: awsError.$metadata?.httpStatusCode,
    };
  }

  return {
    message: String(error),
  };
}

/**
 * Formats an error into a string suitable for MCP tool text content.
 *
 * @param error - The caught error object.
 * @param context - Optional context string (e.g. tool name).
 * @returns Formatted error string.
 */
export function formatErrorForMcp(error: unknown, context?: string): string {
  const parsed = handleAwsError(error);
  const prefix = context ? `[${context}] ` : '';
  const codeSuffix = parsed.code ? ` (${parsed.code})` : '';
  const statusSuffix = parsed.statusCode ? ` [HTTP ${parsed.statusCode}]` : '';

  return `${prefix}Error: ${parsed.message}${codeSuffix}${statusSuffix}`;
}
