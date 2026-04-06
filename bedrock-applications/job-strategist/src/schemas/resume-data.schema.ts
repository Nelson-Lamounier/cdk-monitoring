/**
 * @format
 * Resume Data Schema — Zod Runtime Validation (Option A: Full)
 *
 * Complete Zod schema for the `StructuredResumeData` type, validating
 * every field of the resume data loaded from DynamoDB.
 *
 * Used in the trigger handler to replace the unsafe
 * `as StructuredResumeData` cast on DynamoDB read results.
 *
 * @see trigger-handler.ts line 169
 * @see shared/src/strategist-types.ts StructuredResumeData
 */

import { z } from 'zod';

// =============================================================================
// NESTED SCHEMAS
// =============================================================================

/** Profile/contact information from the resume */
export const ResumeProfileSchema = z.object({
    name: z.string().min(1),
    title: z.string().min(1),
    email: z.string().email(),
    location: z.string().min(1),
    linkedin: z.string().optional(),
    github: z.string().optional(),
    website: z.string().optional(),
});

/** A single professional experience entry */
export const ResumeExperienceSchema = z.object({
    company: z.string().min(1),
    title: z.string().min(1),
    period: z.string().min(1),
    highlights: z.array(z.string()),
});

/** A skill category with grouped skills */
export const ResumeSkillCategorySchema = z.object({
    category: z.string().min(1),
    skills: z.array(z.string()),
});

/** Education entry */
export const ResumeEducationSchema = z.object({
    degree: z.string().min(1),
    institution: z.string().min(1),
    period: z.string().min(1),
});

/** Certification entry */
export const ResumeCertificationSchema = z.object({
    name: z.string().min(1),
    year: z.string().min(1),
    issuer: z.string().min(1),
});

/** Project entry */
export const ResumeProjectSchema = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    github: z.string().optional(),
});

/** Key achievement entry */
export const ResumeAchievementSchema = z.object({
    achievement: z.string().min(1),
});

// =============================================================================
// STRUCTURED RESUME DATA
// =============================================================================

/**
 * Full schema for the structured resume data stored in DynamoDB.
 *
 * Validates every field of the `StructuredResumeData` interface.
 * Uses `.default([])` for array fields to handle legacy records
 * that may not have all sections populated.
 */
export const StructuredResumeDataSchema = z.object({
    profile: ResumeProfileSchema,
    summary: z.string().default(''),
    experience: z.array(ResumeExperienceSchema).default([]),
    skills: z.array(ResumeSkillCategorySchema).default([]),
    education: z.array(ResumeEducationSchema).default([]),
    certifications: z.array(ResumeCertificationSchema).default([]),
    projects: z.array(ResumeProjectSchema).default([]),
    keyAchievements: z.array(ResumeAchievementSchema).default([]),
});

/** Validated StructuredResumeData — inferred from schema */
export type ValidatedResumeData = z.infer<typeof StructuredResumeDataSchema>;
