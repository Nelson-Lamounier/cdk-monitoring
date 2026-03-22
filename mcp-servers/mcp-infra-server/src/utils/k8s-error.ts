/**
 * @fileoverview Error handling utilities for Kubernetes API responses.
 * Maps K8s API errors to structured, descriptive MCP error responses
 * that AI tools can interpret and present to users.
 *
 * @module utils/error-handler
 */

/**
 * Shape of a K8s HTTP error — used for duck-typing since
 * `@kubernetes/client-node` v1.4 no longer exports `HttpError`.
 */
interface K8sHttpError {
  readonly statusCode: number;
  readonly body?: unknown;
  readonly message?: string;
}

/**
 * Structured error response returned by MCP tool handlers.
 */
export interface K8sErrorResponse {
  /** Whether the operation was successful */
  readonly success: false;
  /** HTTP status code from the K8s API */
  readonly statusCode: number;
  /** Human-readable error message */
  readonly message: string;
  /** Kubernetes error reason (e.g. 'NotFound', 'Forbidden') */
  readonly reason: string;
  /** Suggestions for resolving the error */
  readonly suggestion: string;
}

/**
 * Maps a Kubernetes API error to a structured error response.
 * Provides context-aware suggestions for common error scenarios.
 *
 * @param error - The error caught from a K8s API call.
 * @param operation - Description of the operation that failed (e.g. "listing pods in namespace default").
 * @returns A structured error response with status, message, and remediation suggestion.
 */
export function handleK8sError(error: unknown, operation: string): K8sErrorResponse {
  if (isHttpError(error)) {
    const statusCode = error.statusCode ?? 500;
    const body = parseErrorBody(error);

    return {
      success: false,
      statusCode,
      message: `Failed ${operation}: ${body.message}`,
      reason: body.reason,
      suggestion: getSuggestion(statusCode, body.reason, operation),
    };
  }

  // Non-HTTP errors (network issues, kubeconfig problems, etc.)
  const message = error instanceof Error ? error.message : String(error);

  return {
    success: false,
    statusCode: 0,
    message: `Failed ${operation}: ${message}`,
    reason: 'Unknown',
    suggestion: 'Verify that your kubeconfig is valid and the cluster is reachable.',
  };
}

/**
 * Duck-type guard to check if an error has the shape of a K8s HTTP error.
 * Works with both the legacy `HttpError` and the v1.4+ `ApiException`.
 *
 * @param error - Unknown error value.
 * @returns True if the error has a numeric `statusCode` property.
 */
function isHttpError(error: unknown): error is K8sHttpError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as K8sHttpError).statusCode === 'number'
  );
}

/**
 * Extracts the message and reason from a K8s API error body.
 *
 * @param error - A K8s HTTP error.
 * @returns Parsed message and reason strings.
 */
function parseErrorBody(error: K8sHttpError): { message: string; reason: string } {
  const { body } = error;

  if (typeof body === 'object' && body !== null) {
    const k8sBody = body as { message?: string; reason?: string };
    return {
      message: k8sBody.message ?? error.message ?? 'Unknown error',
      reason: k8sBody.reason ?? 'Unknown',
    };
  }

  return {
    message: error.message ?? 'Unknown error',
    reason: 'Unknown',
  };
}

const STATUS_SUGGESTIONS: Record<number, string> = {
  400: 'Check the request parameters — the resource name, namespace, or manifest may contain invalid values.',
  401: 'Authentication failed. Verify your kubeconfig credentials are valid and not expired.',
  403: 'Permission denied. The configured user/service account lacks RBAC permissions for this operation. Check ClusterRole/RoleBinding resources.',
  404: 'Resource not found. Verify the resource name, namespace, and API version are correct.',
  409: 'Conflict — the resource already exists or has been modified. Try fetching the latest version before updating.',
  422: 'The resource specification is invalid. Check the manifest for missing required fields or incorrect values.',
  429: 'API rate limit exceeded. Wait a moment and retry the operation.',
  500: 'Internal server error from the Kubernetes API. Check cluster health and API server logs.',
  503: 'The Kubernetes API server is unavailable. Check cluster connectivity and server health.',
};

/**
 * Returns a context-aware suggestion for resolving a K8s API error.
 *
 * @param statusCode - HTTP status code from the K8s API.
 * @param reason - Kubernetes error reason string.
 * @param operation - Description of the failed operation.
 * @returns A helpful suggestion string.
 */
function getSuggestion(statusCode: number, reason: string, operation: string): string {
  const baseSuggestion = STATUS_SUGGESTIONS[statusCode];

  if (baseSuggestion) {
    return baseSuggestion;
  }

  if (reason === 'NotFound') {
    return `The resource referenced in "${operation}" does not exist. Verify the name and namespace.`;
  }

  return `An unexpected error occurred during "${operation}". Check cluster connectivity and RBAC permissions.`;
}

/**
 * Formats a K8sErrorResponse into a string suitable for MCP tool output.
 *
 * @param error - The structured K8s error response.
 * @returns Formatted error string.
 */
export function formatErrorForMcp(error: K8sErrorResponse): string {
  return [
    `Error: ${error.message}`,
    `Reason: ${error.reason}`,
    `Status Code: ${error.statusCode}`,
    `Suggestion: ${error.suggestion}`,
  ].join('\n');
}
