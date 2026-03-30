/**
 * @format
 * Strategist Trigger Handler — API Gateway → Step Functions
 *
 * Lambda handler triggered by the Admin Dashboard API when the user
 * submits a job description for analysis. Creates a StrategistPipelineContext,
 * writes an initial "analysing" record to DynamoDB, and starts
 * the Step Functions execution.
 *
 * Input: API Gateway event with JSON body { jobDescription, targetCompany, targetRole, interviewStage? }
 * Output: API Gateway response with pipelineId and status
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import type {
    InterviewStage,
    StrategistPipelineContext,
    StrategistResearchHandlerInput,
} from '../../../shared/src/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Step Functions state machine ARN */
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

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
 * Expected request body from the admin dashboard.
 */
interface TriggerRequestBody {
    /** Raw job description text */
    readonly jobDescription: string;
    /** Target company name */
    readonly targetCompany: string;
    /** Target role title */
    readonly targetRole: string;
    /** Current interview stage (defaults to 'applied') */
    readonly interviewStage?: InterviewStage;
}

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
// HANDLER
// =============================================================================

/**
 * Lambda handler for API Gateway → Step Functions trigger.
 *
 * Validates the request body, creates a slug from company + role,
 * writes an initial "analysing" record to DynamoDB, and starts
 * the Step Functions execution.
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

        const body: TriggerRequestBody = JSON.parse(event.body);

        if (!body.jobDescription || !body.targetCompany || !body.targetRole) {
            return buildResponse(400, {
                error: 'Missing required fields: jobDescription, targetCompany, targetRole',
            });
        }

        // Generate slug and execution name
        const slug = `${body.targetCompany}-${body.targetRole}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 60);

        const now = new Date().toISOString();
        const datePrefix = now.slice(0, 10);
        const executionName = `${slug}-${Date.now()}`;

        console.log(`[strategist-trigger] New analysis — slug="${slug}", role="${body.targetRole}"`);

        // Build pipeline context
        const pipelineContext: StrategistPipelineContext = {
            pipelineId: executionName,
            applicationSlug: slug,
            jobDescription: body.jobDescription,
            targetCompany: body.targetCompany,
            targetRole: body.targetRole,
            interviewStage: body.interviewStage ?? 'applied',
            bucket: ASSETS_BUCKET,
            environment: ENVIRONMENT,
            cumulativeTokens: { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
            startedAt: now,
        };

        // Write initial "analysing" record to DynamoDB
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
                    interviewStage: body.interviewStage ?? 'applied',
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

        // Start Step Functions execution
        console.log(`[strategist-trigger] Starting execution: ${executionName}`);

        const sfnInput: StrategistResearchHandlerInput = {
            context: pipelineContext,
        };

        const result = await sfnClient.send(new StartExecutionCommand({
            stateMachineArn: STATE_MACHINE_ARN,
            name: executionName,
            input: JSON.stringify(sfnInput),
        }));

        console.log(
            `[strategist-trigger] Execution started — arn=${result.executionArn ?? 'unknown'}, slug="${slug}"`,
        );

        return buildResponse(200, {
            pipelineId: executionName,
            applicationSlug: slug,
            status: 'analysing',
            executionArn: result.executionArn,
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[strategist-trigger] Error: ${message}`);
        return buildResponse(500, { error: 'Internal server error', details: message });
    }
};
