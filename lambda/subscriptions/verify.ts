/**
 * @format
 * Email Verification Lambda Handler
 *
 * Handles GET /subscriptions/verify?token={token}&email={email}
 *
 * Flow:
 * 1. Validate token and email query parameters
 * 2. Recompute HMAC-SHA256 token and compare
 * 3. Fetch subscription from DynamoDB
 * 4. Check status is 'pending'
 * 5. Update status to 'verified', set verifiedAt, remove TTL
 *
 * Environment Variables:
 * - TABLE_NAME: DynamoDB table name
 * - VERIFICATION_SECRET: HMAC secret for token validation
 */

import { createHmac } from 'crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    GetCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.TABLE_NAME!;
const VERIFICATION_SECRET = process.env.VERIFICATION_SECRET!;

/**
 * Build CORS headers for response
 */
function buildHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
}

/**
 * Generate HMAC-SHA256 verification token (must match subscribe.ts)
 */
function generateVerificationToken(email: string): string {
    return createHmac('sha256', VERIFICATION_SECRET)
        .update(email.toLowerCase())
        .digest('hex');
}

/**
 * Validate that the provided token matches the expected token for the email
 */
function isValidToken(email: string, token: string): boolean {
    const expectedToken = generateVerificationToken(email);
    // Constant-time comparison to prevent timing attacks
    if (token.length !== expectedToken.length) return false;
    let result = 0;
    for (let i = 0; i < token.length; i++) {
        result |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Lambda handler
 */
export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    console.log('Verification request:', JSON.stringify({
        path: event.path,
        queryStringParameters: event.queryStringParameters,
    }));

    try {
        // Extract query parameters
        const token = event.queryStringParameters?.token;
        const email = event.queryStringParameters?.email;

        if (!token || !email) {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Missing token or email parameter',
                }),
            };
        }

        const decodedEmail = decodeURIComponent(email).toLowerCase();

        // Validate token
        if (!isValidToken(decodedEmail, token)) {
            console.warn(`Invalid token for email: ${decodedEmail}`);
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Invalid or expired verification link',
                }),
            };
        }

        // Fetch subscription
        const result = await docClient.send(
            new GetCommand({
                TableName: TABLE_NAME,
                Key: {
                    pk: `EMAIL#${decodedEmail}`,
                    sk: 'SUBSCRIPTION',
                },
            }),
        );

        if (!result.Item) {
            return {
                statusCode: 404,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Not Found',
                    message: 'Subscription not found. It may have expired — please subscribe again.',
                }),
            };
        }

        const currentStatus = result.Item.status as string;

        // Already verified
        if (currentStatus === 'verified') {
            return {
                statusCode: 200,
                headers: buildHeaders(),
                body: JSON.stringify({
                    message: 'Your email is already verified. Thank you!',
                }),
            };
        }

        // Not in pending state
        if (currentStatus !== 'pending') {
            return {
                statusCode: 400,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: `Cannot verify subscription with status: ${currentStatus}`,
                }),
            };
        }

        // Update status to verified, remove TTL
        const now = new Date().toISOString();
        await docClient.send(
            new UpdateCommand({
                TableName: TABLE_NAME,
                Key: {
                    pk: `EMAIL#${decodedEmail}`,
                    sk: 'SUBSCRIPTION',
                },
                UpdateExpression: 'SET #status = :verified, verifiedAt = :now REMOVE #ttl',
                ConditionExpression: '#status = :pending',
                ExpressionAttributeNames: {
                    '#status': 'status',
                    '#ttl': 'ttl',
                },
                ExpressionAttributeValues: {
                    ':verified': 'verified',
                    ':now': now,
                    ':pending': 'pending',
                },
            }),
        );

        console.log(`Email verified: ${decodedEmail}`);

        return {
            statusCode: 200,
            headers: buildHeaders(),
            body: JSON.stringify({
                message: 'Your subscription has been confirmed. Welcome!',
            }),
        };
    } catch (error) {
        console.error('Error verifying subscription:', error);

        // Handle conditional check failure (race condition)
        if ((error as Record<string, string>).name === 'ConditionalCheckFailedException') {
            return {
                statusCode: 409,
                headers: buildHeaders(),
                body: JSON.stringify({
                    error: 'Conflict',
                    message: 'This subscription has already been processed',
                }),
            };
        }

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
