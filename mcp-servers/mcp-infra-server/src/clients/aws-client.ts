/**
 * @fileoverview AWS client factory for the Next.js Diagnostics MCP server.
 *
 * Creates typed AWS SDK v3 clients for DynamoDB, SES, and SSM.
 * All clients share the same region, defaulting to `eu-west-1` or
 * the `AWS_REGION` environment variable.
 *
 * @module aws-client
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESClient } from '@aws-sdk/client-ses';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Container for all AWS service clients used by the MCP server.
 */
export interface AwsClients {
  /** DynamoDB document client (high-level marshalling) */
  readonly docClient: DynamoDBDocumentClient;
  /** Raw DynamoDB client (for DescribeTable etc.) */
  readonly dynamoClient: DynamoDBClient;
  /** SES client for email identity verification */
  readonly sesClient: SESClient;
  /** SSM client for parameter discovery */
  readonly ssmClient: SSMClient;
  /** The resolved AWS region */
  readonly region: string;
}

/**
 * Creates a set of AWS service clients configured from environment variables.
 *
 * @param region - Optional explicit AWS region. Falls back to `AWS_REGION`
 *   environment variable, then `eu-west-1`.
 * @returns A readonly object containing all AWS clients.
 *
 * @example
 * ```typescript
 * const clients = createAwsClients();
 * const result = await clients.docClient.send(new ScanCommand({ ... }));
 * ```
 */
export function createAwsClients(region?: string): AwsClients {
  const resolvedRegion = region ?? process.env.AWS_REGION ?? 'eu-west-1';

  const dynamoClient = new DynamoDBClient({ region: resolvedRegion });
  const docClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sesClient = new SESClient({ region: resolvedRegion });
  const ssmClient = new SSMClient({ region: resolvedRegion });

  return {
    docClient,
    dynamoClient,
    sesClient,
    ssmClient,
    region: resolvedRegion,
  };
}
