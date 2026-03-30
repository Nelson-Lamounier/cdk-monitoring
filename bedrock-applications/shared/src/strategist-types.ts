/**
 * @format
 * Job Application Strategist — Shared Types
 *
 * Core type definitions for the 3-agent strategist pipeline:
 *   1. Research Agent — KB retrieval, resume parsing, gap analysis
 *   2. Strategist Agent — 5-phase analysis, document crafting
 *   3. Interview Coach — Stage-specific preparation
 *
 * These types define the data contracts for Step Functions state
 * passing and DynamoDB entity persistence.
 *
 * All types are JSON-serialisable and fit within the 256KB Step
 * Functions payload limit.
 */

import type { AgentResult } from './types.js';

// =============================================================================
// ENUMS & DOMAIN TYPES
// =============================================================================

/**
 * Interview stage progression.
 *
 * Each stage drives the Interview Coach Agent's preparation strategy.
 */
export type InterviewStage =
    | 'applied'
    | 'phone-screen'
    | 'technical-1'
    | 'technical-2'
    | 'behavioural'
    | 'system-design'
    | 'take-home'
    | 'final-round'
    | 'offer'
    | 'rejected'
    | 'withdrawn';

/**
 * Application lifecycle status for DynamoDB tracking.
 */
export type ApplicationStatus =
    | 'analysing'       // Pipeline is running
    | 'analysis-ready'  // Analysis complete, awaiting review
    | 'interview-prep'  // User is preparing for interviews
    | 'applied'          // Application submitted
    | 'interviewing'     // Active interview process
    | 'offer-received'   // Offer extended
    | 'accepted'         // Offer accepted
    | 'rejected'         // Application rejected
    | 'withdrawn';       // Application withdrawn by candidate

/**
 * Overall fit rating for a job application.
 */
export type FitRating = 'STRONG FIT' | 'REASONABLE FIT' | 'STRETCH' | 'REACH';

/**
 * Application recommendation from the Strategist Agent.
 */
export type ApplicationRecommendation =
    | 'APPLY'
    | 'APPLY WITH CAVEATS'
    | 'STRETCH APPLICATION'
    | 'NOT RECOMMENDED';

/**
 * Skill verification depth level.
 */
export type SkillDepth = 'surface' | 'working' | 'expert';

/**
 * Gap type classification.
 */
export type GapType = 'hard' | 'soft';

/**
 * Gap impact severity.
 */
export type GapSeverity = 'blocking' | 'significant' | 'minor';

// =============================================================================
// STRATEGIST PIPELINE CONTEXT
// =============================================================================

/**
 * Correlation context for the Strategist Step Functions pipeline.
 *
 * Similar to PipelineContext but specific to job application analysis.
 */
export interface StrategistPipelineContext {
    /** Unique pipeline execution ID */
    readonly pipelineId: string;

    /** Job application slug (kebab-case, e.g. 'acme-senior-devops-2026-03') */
    readonly applicationSlug: string;

    /** Raw job description text (user input) */
    readonly jobDescription: string;

    /** Target company name (extracted or provided) */
    readonly targetCompany: string;

    /** Target role title */
    readonly targetRole: string;

    /** Current interview stage (for Coach Agent) */
    readonly interviewStage: InterviewStage;

    /** S3 bucket for pipeline artefacts */
    readonly bucket: string;

    /** Runtime environment */
    readonly environment: string;

    /** Cumulative token usage across all agents */
    cumulativeTokens: {
        input: number;
        output: number;
        thinking: number;
    };

    /** Cumulative estimated cost in USD */
    cumulativeCostUsd: number;

    /** ISO timestamp of pipeline start */
    readonly startedAt: string;
}

// =============================================================================
// RESEARCH AGENT OUTPUT
// =============================================================================

/**
 * A verified skill match from the candidate's evidence sources.
 */
export interface VerifiedMatch {
    /** The skill or technology */
    readonly skill: string;
    /** Source citation (project name, role, repository) */
    readonly sourceCitation: string;
    /** Depth of expertise */
    readonly depth: SkillDepth;
    /** How recently the skill was used */
    readonly recency: string;
}

/**
 * A partial skill match that needs framing.
 */
export interface PartialMatch {
    /** The skill or technology */
    readonly skill: string;
    /** Description of the gap */
    readonly gapDescription: string;
    /** Transferable foundation that bridges the gap */
    readonly transferableFoundation: string;
    /** Suggested framing for applications */
    readonly framingSuggestion: string;
}

/**
 * A skill gap identified by the Research Agent.
 */
export interface SkillGap {
    /** The missing skill or technology */
    readonly skill: string;
    /** Gap classification */
    readonly gapType: GapType;
    /** Impact on application viability */
    readonly impactSeverity: GapSeverity;
    /** Assessment of whether this gap is disqualifying */
    readonly disqualifyingAssessment: string;
}

/**
 * A hard or soft requirement extracted from the job description.
 */
export interface JobRequirement {
    /** The skill or qualification */
    readonly skill: string;
    /** Context from the JD (e.g. "5+ years production experience") */
    readonly context: string;
    /** Whether not meeting this requirement is likely disqualifying */
    readonly disqualifying?: boolean;
}

/**
 * Technology inventory extracted from the job description.
 */
export interface TechnologyInventory {
    readonly languages: string[];
    readonly frameworks: string[];
    readonly infrastructure: string[];
    readonly tools: string[];
    readonly methodologies: string[];
}

/**
 * Experience signals extracted from the job description.
 */
export interface ExperienceSignals {
    /** Expected years of experience (e.g. "3-5") */
    readonly yearsExpected: string;
    /** Required domain experience (e.g. "fintech") */
    readonly domainExperience: string;
    /** Leadership expectations */
    readonly leadershipExpectation: string;
    /** Scale indicators (e.g. "100k+ users") */
    readonly scaleIndicators: string;
}

/**
 * Complete output from the Strategist Research Agent.
 */
export interface StrategistResearchResult {
    /** Extracted target role title */
    readonly targetRole: string;
    /** Extracted target company name */
    readonly targetCompany: string;
    /** Assessed seniority level */
    readonly seniority: string;
    /** Role domain classification */
    readonly domain: string;

    /** Requirements extracted from the JD */
    readonly hardRequirements: JobRequirement[];
    readonly softRequirements: JobRequirement[];
    readonly implicitRequirements: string[];

    /** Technology inventory from the JD */
    readonly technologyInventory: TechnologyInventory;

    /** Experience signals from the JD */
    readonly experienceSignals: ExperienceSignals;

    /** Skills verified against KB and resume data */
    readonly verifiedMatches: VerifiedMatch[];

    /** Skills with partial evidence */
    readonly partialMatches: PartialMatch[];

    /** Skills with no evidence */
    readonly gaps: SkillGap[];

    /** Overall fit assessment */
    readonly overallFitRating: FitRating;

    /** One-paragraph honest assessment */
    readonly fitSummary: string;

    /** Raw resume text retrieved from DynamoDB */
    readonly resumeData: string;

    /** Concatenated KB passages with source citations */
    readonly kbContext: string;
}

// =============================================================================
// STRATEGIST AGENT OUTPUT
// =============================================================================

/**
 * Complete XML analysis output from the Strategist Agent.
 *
 * This is the raw XML string; the handler parses specific sections
 * as needed. The full XML is persisted to DynamoDB for admin review.
 */
export interface StrategistAnalysisResult {
    /** The full XML analysis (raw string) */
    readonly analysisXml: string;

    /** Extracted metadata for quick DynamoDB queries */
    readonly metadata: {
        readonly candidateName: string;
        readonly targetRole: string;
        readonly targetCompany: string;
        readonly analysisDate: string;
        readonly overallFitRating: FitRating;
        readonly applicationRecommendation: ApplicationRecommendation;
    };

    /** Generated cover letter (extracted from XML for convenience) */
    readonly coverLetter: string;

    /** Resume tailoring suggestions count */
    readonly resumeAdditions: number;
    readonly resumeReframes: number;
    readonly eslCorrections: number;
}

// =============================================================================
// INTERVIEW COACH OUTPUT
// =============================================================================

/**
 * A single interview question with preparation framework.
 */
export interface InterviewQuestion {
    /** Likely question text */
    readonly question: string;
    /** STAR-based answer framework using verified experience */
    readonly answerFramework: string;
    /** Source project from KB */
    readonly sourceProject: string;
    /** Difficulty level */
    readonly difficulty: 'easy' | 'medium' | 'hard';
    /** Key points to hit in the answer */
    readonly keyPoints: string[];
}

/**
 * A difficult or gap-probing question with bridge strategy.
 */
export interface DifficultQuestion {
    /** The challenging question */
    readonly question: string;
    /** Framework for honest positioning */
    readonly answerFramework: string;
    /** Strategy for bridging from gap to strength */
    readonly bridgeStrategy: string;
}

/**
 * A technical preparation checklist item.
 */
export interface TechnicalPrepItem {
    /** Topic to prepare */
    readonly topic: string;
    /** Priority level */
    readonly priority: 'high' | 'medium' | 'low';
    /** Why this topic matters for the interview */
    readonly rationale: string;
    /** Suggested preparation resources */
    readonly suggestedResources: string[];
}

/**
 * A question to ask the interviewer.
 */
export interface QuestionToAsk {
    /** The question text */
    readonly question: string;
    /** Why this question demonstrates good candidacy */
    readonly rationale: string;
}

/**
 * Complete output from the Interview Coach Agent.
 */
export interface InterviewCoachResult {
    /** Current interview stage */
    readonly stage: InterviewStage;
    /** Human-readable stage description */
    readonly stageDescription: string;

    /** Technical questions with preparation frameworks */
    readonly technicalQuestions: InterviewQuestion[];
    /** Behavioural questions with STAR-based answers */
    readonly behaviouralQuestions: InterviewQuestion[];
    /** Difficult or gap-probing questions */
    readonly difficultQuestions: DifficultQuestion[];
    /** Technical preparation checklist */
    readonly technicalPrepChecklist: TechnicalPrepItem[];
    /** Questions to ask the interviewer */
    readonly questionsToAsk: QuestionToAsk[];
    /** Stage-specific coaching notes */
    readonly coachingNotes: string;
}

// =============================================================================
// DYNAMODB ENTITY — JOB APPLICATION RECORD
// =============================================================================

/**
 * DynamoDB entity for tracking job applications.
 *
 * Entity schema:
 *   pk: APPLICATION#<slug>
 *   sk: METADATA — current analysis state and lifecycle status
 *   sk: ANALYSIS#<pipelineId> — versioned full analysis XML
 *   sk: INTERVIEW#<stage> — stage-specific interview prep
 *
 * GSI1 (status-date):
 *   gsi1pk: APP_STATUS#<status>
 *   gsi1sk: <YYYY-MM-DD>#<slug>
 *
 * GSI2 (company):
 *   gsi2pk: COMPANY#<company>
 *   gsi2sk: <YYYY-MM-DD>#<slug>
 */
export interface JobApplicationRecord {
    /** Partition key: APPLICATION#<slug> */
    readonly pk: string;
    /** Sort key: METADATA | ANALYSIS#<id> | INTERVIEW#<stage> */
    readonly sk: string;

    /** Application lifecycle status */
    readonly status: ApplicationStatus;
    /** Pipeline execution ID */
    readonly pipelineId: string;
    /** Application slug */
    readonly applicationSlug: string;
    /** Target company */
    readonly targetCompany: string;
    /** Target role title */
    readonly targetRole: string;
    /** Overall fit rating */
    readonly fitRating: FitRating;
    /** Application recommendation */
    readonly recommendation: ApplicationRecommendation;
    /** Current interview stage */
    readonly interviewStage: InterviewStage;

    /** ISO timestamp of creation */
    readonly createdAt: string;
    /** ISO timestamp of last update */
    readonly updatedAt: string;
    /** Runtime environment */
    readonly environment: string;

    /** GSI1 partition key: APP_STATUS#<status> */
    readonly gsi1pk: string;
    /** GSI1 sort key: <YYYY-MM-DD>#<slug> */
    readonly gsi1sk: string;

    /** GSI2 partition key: COMPANY#<company> */
    readonly gsi2pk?: string;
    /** GSI2 sort key: <YYYY-MM-DD>#<slug> */
    readonly gsi2sk?: string;

    /** Full analysis XML (only on ANALYSIS# sort key items) */
    readonly analysisXml?: string;
    /** Interview prep JSON (only on INTERVIEW# sort key items) */
    readonly interviewPrep?: string;
}

// =============================================================================
// STEP FUNCTIONS STATE SHAPES
// =============================================================================

/**
 * Input to the Strategist Research Handler.
 */
export interface StrategistResearchHandlerInput {
    readonly context: StrategistPipelineContext;
}

/**
 * Output from Research Handler, input to Strategist Handler.
 */
export interface StrategistWriterHandlerInput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
}

/**
 * Output from Strategist Handler, input to Coach Handler.
 */
export interface StrategistCoachHandlerInput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
}

/**
 * Terminal output from the Strategist Pipeline.
 */
export interface StrategistPipelineOutput {
    readonly context: StrategistPipelineContext;
    readonly research: AgentResult<StrategistResearchResult>;
    readonly analysis: AgentResult<StrategistAnalysisResult>;
    readonly coaching: AgentResult<InterviewCoachResult>;
    /** Final application status written to DynamoDB */
    readonly applicationStatus: ApplicationStatus;
}
