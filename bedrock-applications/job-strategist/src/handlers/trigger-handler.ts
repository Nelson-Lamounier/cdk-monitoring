/**
 * @format
 * Strategist Trigger Handler — API Gateway → Step Functions
 *
 * Lambda handler triggered by the Admin Dashboard API. Supports two
 * pipeline operations:
 *
 * 1. **Analyse** — Full analysis pipeline (Research → Strategist → Persist).
 *    Creates a new APPLICATION# record and runs resume tailoring.
 *
 * 2. **Coach** — Coaching pipeline (Load Analysis → Coach → Persist).
 *    Loads an existing analysis and generates stage-specific interview prep.
 *
 * Input: API Gateway event with JSON body
 * Output: API Gateway response with pipelineId and status
 *
 * Security: All external inputs are validated via Zod schemas at the
 * API Gateway boundary. No unsafe `as` casts on user-supplied data.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ZodError } from 'zod';

import type {
    StrategistPipelineContext,
    StrategistResearchHandlerInput,
    StrategistCoachLoaderInput,
} from '../../../shared/src/index.js';

import { log } from '../../../shared/src/index.js';

import {
    TriggerRequestSchema,
    type AnalyseRequest,
    type CoachRequest,
} from '../schemas/trigger.schema.js';
import { StructuredResumeDataSchema } from '../schemas/resume-data.schema.js';
import { ApplicationMetadataRecordSchema } from '../schemas/dynamo-record.schema.js';
import { TriggerEnvSchema } from '../schemas/environment.schema.js';

// =============================================================================
// ENVIRONMENT VALIDATION (FAIL-FAST ON COLD START)
// =============================================================================

/**
 * Validates all required environment variables at module init.
 *
 * If any critical variable is missing, the Lambda will throw immediately
 * during cold start rather than producing cryptic errors mid-execution.
 */
const env = TriggerEnvSchema.parse(process.env);

/** Step Functions — Analysis state machine ARN */
const ANALYSIS_STATE_MACHINE_ARN = env.ANALYSIS_STATE_MACHINE_ARN;

/** Step Functions — Coaching state machine ARN */
const COACHING_STATE_MACHINE_ARN = env.COACHING_STATE_MACHINE_ARN;

/** DynamoDB table for job application tracking */
const TABLE_NAME = env.TABLE_NAME;

/** S3 bucket for pipeline artefacts */
const ASSETS_BUCKET = env.ASSETS_BUCKET;

/** Runtime environment */
const ENVIRONMENT = env.ENVIRONMENT;

/** Allowed CORS origins */
const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

// =============================================================================
// CLIENTS
// =============================================================================

const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

/**
 * Build a CORS-enabled API Gateway response.
 *
 * @param statusCode - HTTP status code
 * @param body - Response body object
 * @returns API Gateway response
 */
function buildResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': ALLOWED_ORIGINS,
            'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
        },
        body: JSON.stringify(body),
    };
}

/**
 * Formats Zod validation errors into a user-friendly message.
 *
 * Reveals field names and constraints but masks raw values
 * to prevent accidental PII or injection content echoing.
 *
 * @param error - ZodError from failed schema parsing
 * @returns Formatted error message string
 */
function formatZodError(error: ZodError): string {
    return error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
}

// =============================================================================
// ANALYSE OPERATION
// =============================================================================

/**
 * Handle the 'analyse' operation — full analysis pipeline.
 *
 * 1. Generates an application slug from company + role
 * 2. Fetches structured resume data from DynamoDB (Zod-validated)
 * 3. Writes an initial 'analysing' record to DynamoDB
 * 4. Starts the Analysis State Machine
 *
 * @param body - Zod-validated analyse request body
 * @returns API Gateway response with pipelineId
 */
async function handleAnalyse(body: AnalyseRequest): Promise<APIGatewayProxyResultV2> {
    // Generate slug and execution name
    const slug = `${body.targetCompany}-${body.targetRole}`
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, '')
        .substring(0, 60);

    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);
    const executionName = `${slug}-${Date.now()}`;

    log('INFO', 'Analyse triggered', { handler: 'strategist-trigger', slug, targetRole: body.targetRole, resumeId: body.resumeId || 'none' });

    // Fetch structured resume from DynamoDB — Zod-validated.
    // Skipped when resumeId is empty (build-from-scratch mode).
    let resumeData: ReturnType<typeof StructuredResumeDataSchema.parse> | null = null;

    if (body.resumeId) {
        log('INFO', 'Fetching resume', { handler: 'strategist-trigger', resumeId: body.resumeId });
        const resumeResult = await ddbClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `RESUME#${body.resumeId}`,
                sk: 'METADATA',
            },
        }));

        if (resumeResult.Item) {
            const rawResumeData = resumeResult.Item['data'] ?? resumeResult.Item;
            const parseResult = StructuredResumeDataSchema.safeParse(rawResumeData);

            if (parseResult.success) {
                resumeData = parseResult.data;
                log('INFO', 'Resume loaded', { handler: 'strategist-trigger', profileName: resumeData.profile.name });
            } else {
                log('WARN', 'Resume data failed validation — pipeline will run without resume baseline', {
                    handler: 'strategist-trigger', error: formatZodError(parseResult.error),
                });
            }
        } else {
            log('WARN', 'Resume not found — pipeline will run without resume baseline', { handler: 'strategist-trigger', resumeId: body.resumeId });
        }
    } else {
        log('INFO', 'No resume ID provided — build-from-scratch mode', { handler: 'strategist-trigger' });
    }

    // Build pipeline context
    const pipelineContext: StrategistPipelineContext = {
        pipelineId: executionName,
        operation: 'analyse',
        applicationSlug: slug,
        jobDescription: body.jobDescription,
        targetCompany: body.targetCompany,
        targetRole: body.targetRole,
        resumeId: body.resumeId,
        resumeData,
        interviewStage: 'applied',
        bucket: ASSETS_BUCKET,
        environment: ENVIRONMENT,
        includeCoverLetter: body.includeCoverLetter,
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt: now,
    };

    // Start Analysis State Machine first so we have the executionArn to store
    log('INFO', 'Starting analysis execution', { handler: 'strategist-trigger', executionName });

    const sfnInput: StrategistResearchHandlerInput = {
        context: pipelineContext,
    };

    const result = await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: ANALYSIS_STATE_MACHINE_ARN,
        name: executionName,
        input: JSON.stringify(sfnInput),
    }));

    log('INFO', 'Analysis execution started', { handler: 'strategist-trigger', executionArn: result.executionArn ?? 'unknown' });

    // Upsert the METADATA record — UpdateCommand preserves existing fields on re-analysis.
    // PutCommand would wipe analysisCount, latestPipelineId, and latestResumeId set by
    // previous pipeline runs. analysisCount uses if_not_exists to safely initialise on
    // first write and atomically increment on subsequent runs.
    // createdAt is also preserved via if_not_exists — it reflects when the application
    // record was first created, not when the latest analysis was triggered.
    log('INFO', 'Upserting METADATA', { handler: 'strategist-trigger', applicationSlug: slug });
    await ddbClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `APPLICATION#${slug}`,
            sk: 'METADATA',
        },
        UpdateExpression: `SET
            #status = :status,
            pipelineId = :pipelineId,
            executionArn = :arn,
            applicationSlug = :slug,
            targetCompany = :company,
            targetRole = :role,
            jobDescription = :jd,
            resumeId = :resumeId,
            interviewStage = :stage,
            startedAt = :started,
            updatedAt = :now,
            #env = :env,
            gsi1pk = :gsi1pk,
            gsi1sk = :gsi1sk,
            gsi2pk = :gsi2pk,
            gsi2sk = :gsi2sk,
            createdAt = if_not_exists(createdAt, :now),
            analysisCount = if_not_exists(analysisCount, :zero) + :one`,
        ExpressionAttributeNames: {
            '#status': 'status',
            '#env': 'environment',
        },
        ExpressionAttributeValues: {
            ':status': 'analysing',
            ':pipelineId': executionName,
            ':arn': result.executionArn ?? '',
            ':slug': slug,
            ':company': body.targetCompany,
            ':role': body.targetRole,
            ':jd': body.jobDescription,
            ':resumeId': body.resumeId ?? '',
            ':stage': 'applied',
            ':started': now,
            ':now': now,
            ':env': ENVIRONMENT,
            ':gsi1pk': 'APP_STATUS#analysing',
            ':gsi1sk': `${datePrefix}#${slug}`,
            ':gsi2pk': `COMPANY#${body.targetCompany.toLowerCase().replaceAll(/\s+/g, '-')}`,
            ':gsi2sk': `${datePrefix}#${slug}`,
            ':zero': 0,
            ':one': 1,
        },
    }));

    return buildResponse(200, {
        pipelineId: executionName,
        applicationSlug: slug,
        operation: 'analyse',
        status: 'analysing',
        executionArn: result.executionArn,
    });
}

// =============================================================================
// COACH OPERATION
// =============================================================================

/**
 * Handle the 'coach' operation — coaching pipeline.
 *
 * 1. Validates the existing application exists in DynamoDB
 * 2. Extracts application fields via Zod schema (no unsafe casts)
 * 3. Builds a minimal pipeline context
 * 4. Starts the Coaching State Machine (Load Analysis → Coach → Persist)
 *
 * @param body - Zod-validated coach request body
 * @returns API Gateway response with pipelineId
 */
async function handleCoach(body: CoachRequest): Promise<APIGatewayProxyResultV2> {
    const now = new Date().toISOString();
    // execution name limit is 80 chars. 
    // coach- (6) + stage (~10) + - (1) + timestamp (13) + - (1) = ~31 chars.
    // So slug can be max 49 chars.
    const maxSlugLen = 40;
    const safeSlug = body.applicationSlug.length > maxSlugLen ? body.applicationSlug.slice(0, maxSlugLen).replace(/-$/, '') : body.applicationSlug;
    const executionName = `coach-${safeSlug}-${body.interviewStage}-${Date.now()}`;

    log('INFO', 'Coach triggered', {
        handler: 'strategist-trigger',
        applicationSlug: body.applicationSlug,
        interviewStage: body.interviewStage,
    });

    // Verify the application exists
    const appResult = await ddbClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `APPLICATION#${body.applicationSlug}`,
            sk: 'METADATA',
        },
    }));

    if (!appResult.Item) {
        return buildResponse(404, {
            error: `Application not found: ${body.applicationSlug}. Run "analyse" first.`,
        });
    }

    // Zod-validate application metadata fields (replaces unsafe as string casts)
    const appFields = ApplicationMetadataRecordSchema.parse(appResult.Item);

    // Build minimal pipeline context for coaching
    const pipelineContext: StrategistPipelineContext = {
        pipelineId: executionName,
        operation: 'coach',
        applicationSlug: body.applicationSlug,
        jobDescription: appFields.jobDescription,
        targetCompany: appFields.targetCompany,
        targetRole: appFields.targetRole,
        resumeId: appFields.resumeId,
        resumeData: null, // Not needed for coaching — analysis has the context
        interviewStage: body.interviewStage,
        bucket: ASSETS_BUCKET,
        environment: ENVIRONMENT,
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt: now,
    };

    // Start Coaching State Machine
    log('INFO', 'Starting coaching execution', { handler: 'strategist-trigger', executionName });

    const sfnInput: StrategistCoachLoaderInput = {
        context: pipelineContext,
    };

    const result = await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: COACHING_STATE_MACHINE_ARN,
        name: executionName,
        input: JSON.stringify(sfnInput),
    }));

    log('INFO', 'Coaching execution started', { handler: 'strategist-trigger', executionArn: result.executionArn ?? 'unknown' });

    return buildResponse(200, {
        pipelineId: executionName,
        applicationSlug: body.applicationSlug,
        operation: 'coach',
        interviewStage: body.interviewStage,
        status: 'coaching',
        executionArn: result.executionArn,
    });
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Lambda handler for API Gateway → Step Functions trigger.
 *
 * Routes requests to the appropriate pipeline based on `operation`:
 * - 'analyse': Full analysis pipeline (Research → Strategist → Persist)
 * - 'coach': Coaching pipeline (Load Analysis → Coach → Persist)
 *
 * All request body validation is handled by Zod schemas — no manual
 * field checking or unsafe type assertions.
 *
 * @param event - API Gateway event
 * @returns API Gateway response with pipelineId
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    // Handle CORS preflight
    if (event.requestContext.http.method === 'OPTIONS') {
        return buildResponse(200, { message: 'OK' });
    }

    try {
        // Parse and validate body via Zod
        if (!event.body) {
            return buildResponse(400, { error: 'Request body is required' });
        }

        let rawBody: unknown;
        try {
            rawBody = JSON.parse(event.body);
        } catch {
            return buildResponse(400, { error: 'Invalid JSON in request body' });
        }

        // Zod discriminated union validates operation + operation-specific fields
        const body = TriggerRequestSchema.parse(rawBody);

        if (body.operation === 'analyse') {
            return handleAnalyse(body);
        }

        return handleCoach(body);

    } catch (error) {
        // Zod validation errors → 400 with field-level detail
        if (error instanceof ZodError) {
            log('WARN', 'Validation error', { handler: 'strategist-trigger', error: formatZodError(error) });
            return buildResponse(400, {
                error: 'Request validation failed',
                details: formatZodError(error),
            });
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        log('ERROR', 'Unhandled error', { handler: 'strategist-trigger', error: message });
        return buildResponse(500, { error: 'Internal server error', details: message });
    }
};
