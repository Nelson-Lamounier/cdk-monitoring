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
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import type {
    InterviewStage,
    PipelineOperation,
    StrategistPipelineContext,
    StrategistResearchHandlerInput,
    StrategistCoachLoaderInput,
    StructuredResumeData,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Step Functions — Analysis state machine ARN */
const ANALYSIS_STATE_MACHINE_ARN = process.env.ANALYSIS_STATE_MACHINE_ARN ?? '';

/** Step Functions — Coaching state machine ARN */
const COACHING_STATE_MACHINE_ARN = process.env.COACHING_STATE_MACHINE_ARN ?? '';

/** DynamoDB table for job application tracking */
const TABLE_NAME = process.env.TABLE_NAME ?? '';

/** S3 bucket for pipeline artefacts */
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';

/** Runtime environment */
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

/** Allowed CORS origins */
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? '*';

// =============================================================================
// CLIENTS
// =============================================================================

const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// =============================================================================
// TYPES
// =============================================================================

/**
 * Request body for the 'analyse' operation.
 *
 * Triggers the full analysis pipeline: Research → Strategist → Persist.
 */
interface AnalyseRequestBody {
    /** Operation type */
    readonly operation: 'analyse';
    /** Raw job description text */
    readonly jobDescription: string;
    /** Target company name */
    readonly targetCompany: string;
    /** Target role title */
    readonly targetRole: string;
    /** Resume ID selected by the user in the admin UI */
    readonly resumeId: string;
}

/**
 * Request body for the 'coach' operation.
 *
 * Triggers the coaching pipeline: Load Analysis → Coach → Persist.
 */
interface CoachRequestBody {
    /** Operation type */
    readonly operation: 'coach';
    /** Existing application slug to load analysis from */
    readonly applicationSlug: string;
    /** Interview stage to prepare coaching for */
    readonly interviewStage: InterviewStage;
}

/**
 * Discriminated union of all valid trigger request bodies.
 */
type TriggerRequestBody = AnalyseRequestBody | CoachRequestBody;

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

// =============================================================================
// ANALYSE OPERATION
// =============================================================================

/**
 * Handle the 'analyse' operation — full analysis pipeline.
 *
 * 1. Generates an application slug from company + role
 * 2. Fetches structured resume data from DynamoDB
 * 3. Writes an initial 'analysing' record to DynamoDB
 * 4. Starts the Analysis State Machine
 *
 * @param body - Validated analyse request body
 * @returns API Gateway response with pipelineId
 */
async function handleAnalyse(body: AnalyseRequestBody): Promise<APIGatewayProxyResultV2> {
    // Generate slug and execution name
    const slug = `${body.targetCompany}-${body.targetRole}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);

    const now = new Date().toISOString();
    const datePrefix = now.slice(0, 10);
    const executionName = `${slug}-${Date.now()}`;

    console.log(`[strategist-trigger] Analyse — slug="${slug}", role="${body.targetRole}", resumeId="${body.resumeId}"`);

    // Fetch structured resume from DynamoDB
    let resumeData: StructuredResumeData | null = null;

    if (TABLE_NAME) {
        console.log(`[strategist-trigger] Fetching resume: RESUME#${body.resumeId}`);
        const resumeResult = await ddbClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `RESUME#${body.resumeId}`,
                sk: 'METADATA',
            },
        }));

        if (resumeResult.Item) {
            resumeData = (resumeResult.Item['data'] ?? resumeResult.Item) as StructuredResumeData;
            console.log(`[strategist-trigger] Resume loaded: ${resumeData.profile?.name ?? 'unknown'}`);
        } else {
            console.warn(`[strategist-trigger] Resume not found: RESUME#${body.resumeId} — pipeline will run without resume baseline`);
        }
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
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt: now,
    };

    // Write initial 'analysing' record to DynamoDB
    if (TABLE_NAME) {
        console.log(`[strategist-trigger] Writing analysing record: APPLICATION#${slug}`);
        await ddbClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `APPLICATION#${slug}`,
                sk: 'METADATA',
                status: 'analysing',
                pipelineId: executionName,
                applicationSlug: slug,
                targetCompany: body.targetCompany,
                targetRole: body.targetRole,
                interviewStage: 'applied',
                startedAt: now,
                updatedAt: now,
                environment: ENVIRONMENT,
                // GSI1 — status index
                gsi1pk: 'APP_STATUS#analysing',
                gsi1sk: `${datePrefix}#${slug}`,
                // GSI2 — company index
                gsi2pk: `COMPANY#${body.targetCompany.toLowerCase().replace(/\s+/g, '-')}`,
                gsi2sk: `${datePrefix}#${slug}`,
            },
        }));
    }

    // Start Analysis State Machine
    console.log(`[strategist-trigger] Starting analysis execution: ${executionName}`);

    const sfnInput: StrategistResearchHandlerInput = {
        context: pipelineContext,
    };

    const result = await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: ANALYSIS_STATE_MACHINE_ARN,
        name: executionName,
        input: JSON.stringify(sfnInput),
    }));

    console.log(`[strategist-trigger] Analysis execution started — arn=${result.executionArn ?? 'unknown'}`);

    return buildResponse(200, {
        pipelineId: executionName,
        applicationSlug: slug,
        operation: 'analyse' as PipelineOperation,
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
 * 2. Builds a minimal pipeline context
 * 3. Starts the Coaching State Machine (Load Analysis → Coach → Persist)
 *
 * @param body - Validated coach request body
 * @returns API Gateway response with pipelineId
 */
async function handleCoach(body: CoachRequestBody): Promise<APIGatewayProxyResultV2> {
    const now = new Date().toISOString();
    const executionName = `coach-${body.applicationSlug}-${body.interviewStage}-${Date.now()}`;

    console.log(
        `[strategist-trigger] Coach — slug="${body.applicationSlug}", ` +
        `stage="${body.interviewStage}"`,
    );

    // Verify the application exists
    if (TABLE_NAME) {
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

        // Read saved application data for the pipeline context
        const appData = appResult.Item;

        // Build minimal pipeline context for coaching
        const pipelineContext: StrategistPipelineContext = {
            pipelineId: executionName,
            operation: 'coach',
            applicationSlug: body.applicationSlug,
            jobDescription: (appData['jobDescription'] as string) ?? '',
            targetCompany: (appData['targetCompany'] as string) ?? '',
            targetRole: (appData['targetRole'] as string) ?? '',
            resumeId: (appData['resumeId'] as string) ?? '',
            resumeData: null, // Not needed for coaching — analysis has the context
            interviewStage: body.interviewStage,
            bucket: ASSETS_BUCKET,
            environment: ENVIRONMENT,
            cumulativeTokens: { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
            startedAt: now,
        };

        // Start Coaching State Machine
        console.log(`[strategist-trigger] Starting coaching execution: ${executionName}`);

        const sfnInput: StrategistCoachLoaderInput = {
            context: pipelineContext,
        };

        const result = await sfnClient.send(new StartExecutionCommand({
            stateMachineArn: COACHING_STATE_MACHINE_ARN,
            name: executionName,
            input: JSON.stringify(sfnInput),
        }));

        console.log(`[strategist-trigger] Coaching execution started — arn=${result.executionArn ?? 'unknown'}`);

        return buildResponse(200, {
            pipelineId: executionName,
            applicationSlug: body.applicationSlug,
            operation: 'coach' as PipelineOperation,
            interviewStage: body.interviewStage,
            status: 'coaching',
            executionArn: result.executionArn,
        });
    }

    return buildResponse(500, { error: 'TABLE_NAME is not configured' });
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
 * @param event - API Gateway event
 * @returns API Gateway response with pipelineId
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    // Handle CORS preflight
    if (event.requestContext.http.method === 'OPTIONS') {
        return buildResponse(200, { message: 'OK' });
    }

    try {
        // Parse and validate body
        if (!event.body) {
            return buildResponse(400, { error: 'Request body is required' });
        }

        const body = JSON.parse(event.body) as TriggerRequestBody;

        // Route based on operation
        if (!body.operation || (body.operation !== 'analyse' && body.operation !== 'coach')) {
            return buildResponse(400, {
                error: 'Invalid operation. Must be "analyse" or "coach".',
            });
        }

        if (body.operation === 'analyse') {
            const analyseBody = body as AnalyseRequestBody;
            if (!analyseBody.jobDescription || !analyseBody.targetCompany || !analyseBody.targetRole || !analyseBody.resumeId) {
                return buildResponse(400, {
                    error: 'Missing required fields for analyse: jobDescription, targetCompany, targetRole, resumeId',
                });
            }
            return handleAnalyse(analyseBody);
        }

        // operation === 'coach'
        const coachBody = body as CoachRequestBody;
        if (!coachBody.applicationSlug || !coachBody.interviewStage) {
            return buildResponse(400, {
                error: 'Missing required fields for coach: applicationSlug, interviewStage',
            });
        }
        return handleCoach(coachBody);

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[strategist-trigger] Error: ${message}`);
        return buildResponse(500, { error: 'Internal server error', details: message });
    }
};
