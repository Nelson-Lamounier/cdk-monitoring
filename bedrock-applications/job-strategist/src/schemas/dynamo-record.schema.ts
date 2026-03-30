/**
 * @format
 * DynamoDB Record Schemas — Zod Runtime Validation
 *
 * Validates DynamoDB record shapes consumed by the job-strategist
 * handlers. Replaces unsafe `record['field'] as Type` casts with
 * strict schema-based parsing at the data retrieval boundary.
 *
 * @see coach-loader-handler.ts — AnalysisRecordSchema
 * @see trigger-handler.ts — ApplicationMetadataRecordSchema
 */

import { z } from 'zod';

// =============================================================================
// DOMAIN ENUMS (RUNTIME)
// =============================================================================

/**
 * Fit rating values — runtime-validated variant of the `FitRating` union type.
 */
export const FIT_RATINGS = [
    'STRONG FIT',
    'REASONABLE FIT',
    'STRETCH',
    'REACH',
] as const;

/**
 * Application recommendation values — runtime-validated variant
 * of the `ApplicationRecommendation` union type.
 */
export const APPLICATION_RECOMMENDATIONS = [
    'APPLY',
    'APPLY WITH CAVEATS',
    'STRETCH APPLICATION',
    'NOT RECOMMENDED',
] as const;

export const FitRatingSchema = z.enum(FIT_RATINGS);
export const ApplicationRecommendationSchema = z.enum(APPLICATION_RECOMMENDATIONS);

// =============================================================================
// RESUME SUGGESTIONS (NESTED IN ANALYSIS RECORD)
// =============================================================================

/** Addition suggestion within the analysis record */
const AdditionSuggestionSchema = z.object({
    section: z.string(),
    suggestedBullet: z.string(),
    sourceCitation: z.string(),
});

/** Reframe suggestion within the analysis record */
const ReframeSuggestionSchema = z.object({
    original: z.string(),
    suggested: z.string(),
    rationale: z.string(),
});

/** ESL correction within the analysis record */
const EslCorrectionSchema = z.object({
    original: z.string(),
    corrected: z.string(),
});

/** Resume suggestions aggregate */
const ResumeSuggestionsSchema = z.object({
    additions: z.array(AdditionSuggestionSchema).default([]),
    reframes: z.array(ReframeSuggestionSchema).default([]),
    eslCorrections: z.array(EslCorrectionSchema).default([]),
});

// =============================================================================
// ANALYSIS METADATA (NESTED IN ANALYSIS RECORD)
// =============================================================================

/** Metadata sub-object within the ANALYSIS# DynamoDB record */
const AnalysisMetadataSchema = z.object({
    candidateName: z.string().default(''),
    targetRole: z.string().default(''),
    targetCompany: z.string().default(''),
    analysisDate: z.string().default(''),
    overallFitRating: FitRatingSchema.catch('STRETCH'),
    applicationRecommendation: ApplicationRecommendationSchema.catch('APPLY WITH CAVEATS'),
});

// =============================================================================
// ANALYSIS RECORD (FULL DDB RECORD)
// =============================================================================

/**
 * Schema for the ANALYSIS# DynamoDB record consumed by coach-loader-handler.
 *
 * Validates all fields extracted from the DynamoDB record, using
 * `.default()` and `.catch()` for backward-compatible parsing of
 * records that may predate schema additions.
 */
export const AnalysisRecordSchema = z.object({
    /** DynamoDB sort key — e.g. 'ANALYSIS#exec-name-1234567890' */
    sk: z.string(),

    /** Full XML analysis output */
    analysisXml: z.string(),

    /** Extracted metadata for quick queries */
    metadata: AnalysisMetadataSchema,

    /** Generated cover letter */
    coverLetter: z.string().default(''),

    /** Structured per-item resume suggestions */
    resumeSuggestions: ResumeSuggestionsSchema.default({
        additions: [],
        reframes: [],
        eslCorrections: [],
    }),

    /** @deprecated — backward-compatible count fields */
    resumeAdditions: z.number().default(0),
    /** @deprecated — backward-compatible count fields */
    resumeReframes: z.number().default(0),
    /** @deprecated — backward-compatible count fields */
    eslCorrections: z.number().default(0),
});

// =============================================================================
// APPLICATION METADATA RECORD
// =============================================================================

/**
 * Schema for the APPLICATION# METADATA DynamoDB record.
 *
 * Used by the trigger handler to reconstruct pipeline context
 * when starting the coaching pipeline for an existing application.
 *
 * Only validates the fields actually read by the handler.
 */
export const ApplicationMetadataRecordSchema = z.object({
    /** Job description text (stored with the analysis) */
    jobDescription: z.string().default(''),
    /** Target company name */
    targetCompany: z.string().default(''),
    /** Target role title */
    targetRole: z.string().default(''),
    /** Resume ID used in the original analysis */
    resumeId: z.string().default(''),
});

// =============================================================================
// INFERRED TYPES
// =============================================================================

/** Validated analysis record from DynamoDB */
export type ValidatedAnalysisRecord = z.infer<typeof AnalysisRecordSchema>;

/** Validated analysis metadata sub-object */
export type ValidatedAnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;

/** Validated application metadata record */
export type ValidatedApplicationMetadata = z.infer<typeof ApplicationMetadataRecordSchema>;
