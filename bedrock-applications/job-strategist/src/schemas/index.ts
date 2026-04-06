/**
 * @format
 * Schema Barrel Export
 *
 * Re-exports all Zod schemas from the schemas directory.
 * Import from this file to access any schema or validated type.
 */

export {
    TriggerRequestSchema,
    type AnalyseRequest,
    type CoachRequest,
} from './trigger.schema.js';

export {
    AnalysisRecordSchema,
    ApplicationMetadataRecordSchema,
    FitRatingSchema,
    ApplicationRecommendationSchema,
    FIT_RATINGS,
    APPLICATION_RECOMMENDATIONS,
    type ValidatedAnalysisRecord,
    type ValidatedAnalysisMetadata,
    type ValidatedApplicationMetadata,
} from './dynamo-record.schema.js';

export {
    TriggerEnvSchema,
    DdbHandlerEnvSchema,
    type TriggerEnv,
    type DdbHandlerEnv,
} from './environment.schema.js';

export {
    StructuredResumeDataSchema,
    ResumeProfileSchema,
    ResumeExperienceSchema,
    ResumeSkillCategorySchema,
    ResumeEducationSchema,
    ResumeCertificationSchema,
    ResumeProjectSchema,
    ResumeAchievementSchema,
    type ValidatedResumeData,
} from './resume-data.schema.js';
