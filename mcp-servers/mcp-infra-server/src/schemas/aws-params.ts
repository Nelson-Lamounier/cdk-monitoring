/**
 * @fileoverview Zod schemas for all MCP tool input parameters.
 *
 * Each schema is exported with a descriptive name matching the tool it validates.
 * The `.describe()` calls generate tool parameter documentation in MCP clients.
 *
 * @module schemas/tool-params
 */

import { z } from 'zod';

/** Parameters for the `query-dynamo` tool */
export const QueryDynamoSchema = {
  tableName: z.string().describe('DynamoDB table name to query'),
  partitionKey: z.string().optional().describe('Partition key name (e.g. "pk")'),
  partitionValue: z.string().optional().describe('Partition key value (e.g. "EMAIL#test@example.com")'),
  sortKey: z.string().optional().describe('Sort key name (e.g. "sk")'),
  sortValue: z.string().optional().describe('Sort key value (e.g. "SUBSCRIPTION")'),
  indexName: z.string().optional().describe('GSI name to query (e.g. "gsi1")'),
  limit: z.number().optional().default(20).describe('Maximum items to return (default: 20)'),
  scanAll: z.boolean().optional().default(false).describe('If true, performs a full table scan instead of a query'),
};

/** Parameters for the `describe-dynamo` tool */
export const DescribeDynamoSchema = {
  tableName: z.string().describe('DynamoDB table name to describe'),
};

/** Parameters for the `test-api-endpoint` tool */
export const TestApiEndpointSchema = {
  url: z.string().url().describe('Full URL to send the request to'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET').describe('HTTP method'),
  body: z.string().optional().describe('Request body (JSON string) for POST/PUT/PATCH'),
  headers: z.record(z.string()).optional().describe('Additional headers as key-value pairs'),
  timeoutMs: z.number().optional().default(10000).describe('Request timeout in milliseconds (default: 10000)'),
};

/** Parameters for the `list-subscriptions` tool */
export const ListSubscriptionsSchema = {
  tableName: z.string().describe('DynamoDB table name containing subscriptions'),
  status: z.enum(['pending', 'verified', 'all']).default('all').describe('Filter by subscription status'),
  limit: z.number().optional().default(50).describe('Maximum items to return (default: 50)'),
};

/** Parameters for the `test-subscription` tool */
export const TestSubscriptionSchema = {
  apiUrl: z.string().url().describe('API Gateway base URL (e.g. https://xxx.execute-api.eu-west-1.amazonaws.com/api)'),
  email: z.string().email().describe('Email address to test subscription with'),
  tableName: z.string().describe('DynamoDB table name to verify the record in'),
  name: z.string().optional().describe('Optional subscriber name'),
};

/** Parameters for the `check-ses-identity` tool */
export const CheckSesIdentitySchema = {
  identity: z.string().describe('Email address or domain to check SES identity for'),
};

/** Parameters for the `get-ssm-parameters` tool */
export const GetSsmParametersSchema = {
  pathPrefix: z.string().describe('SSM parameter path prefix (e.g. "/nextjs/development" or "/bedrock/development")'),
  recursive: z.boolean().optional().default(true).describe('Search recursively under the prefix (default: true)'),
};
