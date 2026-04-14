/**
 * @format
 * admin-api — Shared DynamoDB client.
 *
 * Instantiated with zero explicit credentials — the AWS SDK v3 default
 * credential chain resolves credentials in this order:
 *   1. Environment variables (not set — enforced by design)
 *   2. ~/.aws/credentials (not present in container)
 *   3. EC2 Instance Metadata Service (IMDS) — the intended source
 *
 * The client is a singleton to reuse TCP connections across handlers.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Singleton raw DynamoDB client — resolves credentials from IMDS. */
export const ddbClient = new DynamoDBClient({
  // AWS_REGION takes priority; fall back to AWS_DEFAULT_REGION (ConfigMap key).
  // Explicit override prevents SDK v3 region-resolver from failing when only
  // AWS_DEFAULT_REGION is set (smithy resolves AWS_REGION but not always the default).
  region: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-west-1',
});

/**
 * DynamoDB Document client — provides automatic marshalling/unmarshalling
 * between JavaScript types and DynamoDB AttributeValue format.
 */
export const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    /** Remove undefined keys from marshalled objects. */
    removeUndefinedValues: true,
  },
});
