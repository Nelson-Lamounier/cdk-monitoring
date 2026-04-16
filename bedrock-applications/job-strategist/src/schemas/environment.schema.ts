/**
 * @format
 * Environment Variable Schemas — Zod Runtime Validation
 *
 * Validates required environment variables at module initialisation
 * (Lambda cold start). Failing fast on misconfiguration prevents
 * cryptic runtime errors deep in handler logic.
 *
 * Each handler imports and validates its own environment schema
 * at the module level, outside the handler function.
 */

import { z } from 'zod';

// =============================================================================
// TRIGGER HANDLER ENVIRONMENT
// =============================================================================

/**
 * Environment variables required by the trigger handler.
 *
 * All fields have sensible defaults for local development but will
 * throw descriptive errors if critical production values are missing.
 */
export const TriggerEnvSchema = z.object({
    /** Analysis state machine ARN — required for 'analyse' operation */
    ANALYSIS_STATE_MACHINE_ARN: z
        .string()
        .min(1, 'ANALYSIS_STATE_MACHINE_ARN is required'),
    /** Coaching state machine ARN — required for 'coach' operation */
    COACHING_STATE_MACHINE_ARN: z
        .string()
        .min(1, 'COACHING_STATE_MACHINE_ARN is required'),
    /** DynamoDB table name */
    TABLE_NAME: z
        .string()
        .min(1, 'TABLE_NAME is required'),
    /** S3 assets bucket — required for resume data fetching */
    ASSETS_BUCKET: z
        .string()
        .min(1, 'ASSETS_BUCKET is required'),
    /** Runtime environment */
    ENVIRONMENT: z
        .string()
        .default('development'),
    /** Allowed CORS origins */
    ALLOWED_ORIGINS: z
        .string()
        .default('*'),
});

// =============================================================================
// AGENT HANDLER ENVIRONMENT
// =============================================================================

/**
 * Environment variables required by agent-tier Lambda handlers.
 *
 * Used by strategist-handler, coach-handler, resume-builder-handler,
 * and research-handler. Each handler validates at cold start to
 * prevent cryptic runtime failures from missing CDK env injection.
 */
export const AgentHandlerEnvSchema = z.object({
    /** DynamoDB table name */
    TABLE_NAME: z
        .string()
        .min(1, 'TABLE_NAME is required'),
    /** Runtime environment name */
    ENVIRONMENT: z
        .string()
        .default('development'),
});

// =============================================================================
// PERSIST HANDLER ENVIRONMENT
// =============================================================================

/**
 * Environment variables required by persistence-tier Lambda handlers.
 *
 * Used by analysis-persist-handler and any handler that reads/writes
 * large artefacts from S3.
 */
export const PersistHandlerEnvSchema = z.object({
    /** DynamoDB table name */
    TABLE_NAME: z
        .string()
        .min(1, 'TABLE_NAME is required'),
    /** S3 assets bucket — required for analysisXml rehydration */
    ASSETS_BUCKET: z
        .string()
        .min(1, 'ASSETS_BUCKET is required'),
    /** Runtime environment name */
    ENVIRONMENT: z
        .string()
        .default('development'),
});

// =============================================================================
// DDB HANDLER ENVIRONMENT
// =============================================================================

/**
 * Environment variables required by handlers that access DynamoDB.
 *
 * Used by coach-loader-handler and analysis-persist-handler.
 */
export const DdbHandlerEnvSchema = z.object({
    /** DynamoDB table name */
    TABLE_NAME: z
        .string()
        .min(1, 'TABLE_NAME is required'),
});

// =============================================================================
// INFERRED TYPES
// =============================================================================

/** Validated trigger handler environment */
export type TriggerEnv = z.infer<typeof TriggerEnvSchema>;

/** Validated agent handler environment */
export type AgentHandlerEnv = z.infer<typeof AgentHandlerEnvSchema>;

/** Validated persist handler environment */
export type PersistHandlerEnv = z.infer<typeof PersistHandlerEnvSchema>;

/** Validated DDB handler environment */
export type DdbHandlerEnv = z.infer<typeof DdbHandlerEnvSchema>;

