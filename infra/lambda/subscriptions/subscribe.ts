/**
 * @format
 * Email Subscription Lambda Handler
 *
 * Handles POST /subscriptions to create email subscriptions.
 *
 * Flow:
 * 1. Validate email input
 * 2. Check for existing subscription (prevent duplicates)
 * 3. Generate verification token (HMAC-SHA256)
 * 4. Write to DynamoDB with status: pending, ttl: +48h
 * 5. Send verification email to subscriber via SES
 * 6. Send notification email to owner via SES
 *
 * Environment Variables:
 * - TABLE_NAME: DynamoDB table name
 * - NOTIFICATION_EMAIL: Owner email for notifications
 * - SES_FROM_EMAIL: Sender email address
 * - VERIFICATION_BASE_URL: (Optional) Base URL for verification links.
 *   If not set, derived at runtime from the API Gateway event context.
 * - VERIFICATION_SECRET: HMAC secret for token generation
 * - ENVIRONMENT: Current environment (development, staging, production)
 */

import { createHmac } from 'crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sesClient = new SESClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL!;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL!;
const VERIFICATION_BASE_URL = process.env.VERIFICATION_BASE_URL; // Optional: derived from event if not set
const VERIFICATION_SECRET = process.env.VERIFICATION_SECRET!;
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';

// TTL: 48 hours from now (in seconds)
const TTL_HOURS = 48;

interface SubscriptionRequest {
    email: string;
    name?: string;
    source?: string;
}

/**
 * Build CORS headers for response
 */
function buildHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
    };
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) && email.length <= 254;
}

/**
 * Generate HMAC-SHA256 verification token
 */
function generateVerificationToken(email: string): string {
    return createHmac('sha256', VERIFICATION_SECRET)
        .update(email.toLowerCase())
        .digest('hex');
}

/**
 * Check if email already has an active subscription
 */
async function getExistingSubscription(
    email: string,
): Promise<Record<string, unknown> | null> {
    const result = await docClient.send(
        new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                pk: `EMAIL#${email.toLowerCase()}`,
                sk: 'SUBSCRIPTION',
            },
        }),
    );
    return (result.Item as Record<string, unknown>) ?? null;
}

/**
 * Write subscription to DynamoDB
 */
async function createSubscription(
    email: string,
    name?: string,
    source?: string,
): Promise<void> {
    const now = new Date().toISOString();
    const ttlEpoch = Math.floor(Date.now() / 1000) + TTL_HOURS * 3600;

    await docClient.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: `EMAIL#${email.toLowerCase()}`,
                sk: 'SUBSCRIPTION',
                gsi1pk: 'ENTITY#EMAIL',
                gsi1sk: now,
                email: email.toLowerCase(),
                name: name ?? '',
                source: source ?? 'website',
                status: 'pending',
                subscribedAt: now,
                consentRecord: {
                    consentedAt: now,
                    consentType: 'email_subscription',
                    source: source ?? 'website',
                },
                ttl: ttlEpoch,
            },
        }),
    );
}

/**
 * Derive the verification base URL from the API Gateway event context.
 * Falls back to VERIFICATION_BASE_URL env var if set.
 */
function getVerificationBaseUrl(event: APIGatewayProxyEvent): string {
    if (VERIFICATION_BASE_URL) {
        return VERIFICATION_BASE_URL;
    }
    // Build from API Gateway event context (domain + stage + path)
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    return `https://${domain}/${stage}/subscriptions/verify`;
}

/**
 * Send verification email to subscriber
 */
async function sendVerificationEmail(
    email: string,
    name: string,
    event: APIGatewayProxyEvent,
): Promise<void> {
    const token = generateVerificationToken(email);
    const baseUrl = getVerificationBaseUrl(event);
    const verifyUrl = `${baseUrl}?token=${token}&email=${encodeURIComponent(email.toLowerCase())}`;

    await sesClient.send(
        new SendEmailCommand({
            Source: SES_FROM_EMAIL,
            Destination: { ToAddresses: [email] },
            Message: {
                Subject: {
                    Data: 'Verify your email subscription - Nelson Lamounier Portfolio',
                },
                Body: {
                    Html: {
                        Data: `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2>Hi ${name || 'there'}! 👋</h2>
    <p>Thanks for subscribing to updates from Nelson Lamounier's portfolio.</p>
    <p>Please click the button below to verify your email address:</p>
    <p style="text-align: center; margin: 30px 0;">
        <a href="${verifyUrl}" 
           style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
            Verify Email Address
        </a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">
        This link expires in 48 hours. If you didn't request this, you can safely ignore this email.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
    <p style="color: #9ca3af; font-size: 12px;">Nelson Lamounier Portfolio</p>
</body>
</html>`,
                    },
                    Text: {
                        Data: `Hi ${name || 'there'}!\n\nThanks for subscribing. Please verify your email by visiting:\n${verifyUrl}\n\nThis link expires in 48 hours.`,
                    },
                },
            },
        }),
    );
}

/**
 * Send notification email to portfolio owner
 */
async function sendOwnerNotification(
    email: string,
    name: string,
    source: string,
): Promise<void> {
    await sesClient.send(
        new SendEmailCommand({
            Source: SES_FROM_EMAIL,
            Destination: { ToAddresses: [NOTIFICATION_EMAIL] },
            Message: {
                Subject: {
                    Data: `[Portfolio] New email subscription: ${email}`,
                },
                Body: {
                    Text: {
                        Data: `New email subscription (pending verification):\n\nEmail: ${email}\nName: ${name || 'Not provided'}\nSource: ${source || 'website'}\nEnvironment: ${ENVIRONMENT}\nTime: ${new Date().toISOString()}`,
                    },
                },
            },
        }),
    );
}

/**
 * Lambda handler
 */
export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    console.log('Subscription request:', JSON.stringify({
        path: event.path,
        httpMethod: event.httpMethod,
    }));

    try {
        // Parse request body
        if (!event.body) {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Request body is required',
                }),
            };
        }

        let request: SubscriptionRequest;
        try {
            request = JSON.parse(event.body);
        } catch {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Invalid JSON in request body',
                }),
            };
        }

        // Validate email
        if (!request.email || !isValidEmail(request.email)) {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'A valid email address is required',
                }),
            };
        }

        // Check for existing subscription
        const existing = await getExistingSubscription(request.email);
        if (existing) {
            const status = existing.status as string;

            if (status === 'verified') {
                return {
                    statusCode: 409,
                    headers: buildHeaders(),
                    body: JSON.stringify({
                        error: 'Conflict',
                        message: 'This email is already subscribed',
                    }),
                };
            }

            // If pending, allow re-subscription (overwrites and resets TTL)
            console.log(`Re-subscribing pending email: ${request.email}`);
        }

        // Create subscription
        await createSubscription(
            request.email,
            request.name,
            request.source,
        );
        console.log(`Subscription created: ${request.email}`);

        // Send emails (non-blocking: don't fail subscription if email fails)
        try {
            await sendVerificationEmail(
                request.email,
                request.name ?? '',
                event,
            );
            console.log(`Verification email sent to: ${request.email}`);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
            // Subscription is still created — user can retry verification
        }

        try {
            await sendOwnerNotification(
                request.email,
                request.name ?? '',
                request.source ?? 'website',
            );
            console.log(`Owner notification sent to: ${NOTIFICATION_EMAIL}`);
        } catch (notifyError) {
            console.error('Failed to send owner notification:', notifyError);
            // Non-critical: don't affect user experience
        }

        return {
            statusCode: 200,
            headers: buildHeaders(),
            body: JSON.stringify({
                message: 'Please check your email to verify your subscription',
            }),
        };
    } catch (error) {
        console.error('Error processing subscription:', error);

        return {
            statusCode: 500,
            headers: buildHeaders(),
            body: JSON.stringify({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : 'Unknown error',
            }),
        };
    }
};
