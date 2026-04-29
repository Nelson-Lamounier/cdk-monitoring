/**
 * @format
 * Default Configuration Values
 *
 * Centralized defaults extracted from stack implementations.
 * Uses UPPER_CASE for global constants as per AWS CDK best practices.
 */

// =============================================================================
// S3 Defaults (Global - non-environment-specific)
// =============================================================================

/**
 * S3 incomplete multipart upload expiration in days
 */
export const S3_INCOMPLETE_UPLOAD_EXPIRATION_DAYS = 7;

/**
 * S3 CORS configuration (global defaults)
 */
export const S3_CORS_DEFAULTS = {
    /** Max age for CORS preflight cache in seconds */
    maxAgeSeconds: 3000,
    /** Allowed headers */
    allowedHeaders: ['*'],
} as const;

/**
 * S3 storage class transition delay in days (0 = immediate)
 */
export const S3_STORAGE_TRANSITION_DAYS = 0;
