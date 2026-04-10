/**
 * @file dynamo.ts
 * @description DynamoDB DocumentClient factory for the public-api service.
 *
 * Creates a singleton DynamoDB DocumentClient using AWS SDK v3.
 * No credentials are explicitly configured — the SDK resolves credentials
 * automatically via the default credential provider chain:
 *   1. Environment variables (not present in production)
 *   2. EC2 Instance Profile / IMDS (active path for pods on the cluster)
 *
 * The region is supplied by `AWS_DEFAULT_REGION` from the `nextjs-config`
 * ConfigMap, which is the standard way SDK v3 picks up the region from env.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let _client: DynamoDBDocumentClient | undefined;

/**
 * Returns the singleton DynamoDB DocumentClient.
 *
 * Initialised on first call. The client uses:
 * - Region from `AWS_DEFAULT_REGION` environment variable (ConfigMap).
 * - Credentials from the EC2 Instance Profile via IMDS (automatic).
 *
 * @returns A configured {@link DynamoDBDocumentClient} instance.
 */
export function getDynamoClient(): DynamoDBDocumentClient {
  if (_client === undefined) {
    // No `credentials` key — resolved automatically by the SDK default chain.
    // No explicit `region` key — resolved from AWS_DEFAULT_REGION env var.
    const base = new DynamoDBClient({});
    _client = DynamoDBDocumentClient.from(base, {
      marshallOptions: {
        // Omit undefined values from marshalled objects
        removeUndefinedValues: true,
        // Preserve empty strings (article content may have them)
        convertEmptyValues: false,
      },
    });
  }
  return _client;
}
