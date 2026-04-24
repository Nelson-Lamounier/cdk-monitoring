/**
 * @format
 * Tests for admin-api routes/pipelines.ts
 *
 * Strategy: mock `@aws-sdk/client-lambda` using `jest.unstable_mockModule()`
 * — the correct ESM-compatible API in Jest 29. All module imports happen
 * through top-level `await import()` so that the mock registry is populated
 * before the route module is evaluated.
 *
 * Note on casting: `noUncheckedIndexedAccess` makes `mock.calls[0]?.[0]`
 * return `T | undefined`. TypeScript strict mode disallows casting
 * `undefined` directly to a concrete type. All payload extractions therefore
 * use the double-cast pattern `as unknown as T` to satisfy the compiler
 * without disabling the safety rule.
 *
 * Coverage:
 *   POST /article     — 400 when slug is missing from body
 *   POST /article     — 400 when slug is an empty string
 *   POST /article     — 202 with correct synthetic S3 event payload
 *   POST /article     — Lambda InvocationType must be 'Event' (fire-and-forget)
 *   POST /article     — S3 event Records[] shape matches S3Handler contract
 *   POST /strategist  — 202 with queued: true and pipeline: 'strategist'
 *   POST /strategist  — Lambda ARN and InvocationType Event
 *   POST /strategist  — Payload wrapped in APIGatewayProxyEventV2 envelope (requestContext + body)
 *   POST /strategist  — Admin UI body forwarded verbatim inside event.body (analyse)
 *   POST /strategist  — Admin UI body forwarded verbatim inside event.body (coach)
 *   POST /strategist  — Malformed body falls back to empty object (202, Lambda rejects internally)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock — captured by unstable_mockModule closure
// ---------------------------------------------------------------------------

/** Shared LambdaClient.send mock — resolves by default (async fire-and-forget). */
const lambdaSendMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

// ---------------------------------------------------------------------------
// ESM module mock — MUST be declared before any `await import()`
// ---------------------------------------------------------------------------

jest.unstable_mockModule('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    /** @param _input - constructor input (unused in tests). */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_input: unknown) {}
    send = lambdaSendMock;
  }

  class InvokeCommand {
    /** @param input - Lambda invocation input. */
    constructor(public readonly input: unknown) {}
  }

  return { LambdaClient, InvokeCommand };
});

// ---------------------------------------------------------------------------
// Module imports — after mocks
// ---------------------------------------------------------------------------

/** Resolved application configuration stub for tests. */
const testConfig = {
  assetsBucketName: 'test-assets-bucket',
  articleTriggerArn: 'arn:aws:lambda:eu-west-1:123456789012:function:trigger',
  versionHistoryLambdaArn: 'arn:aws:lambda:eu-west-1:123456789012:function:version-history',
  publishLambdaArn: 'arn:aws:lambda:eu-west-1:123456789012:function:publish',
  strategistTriggerArn: 'arn:aws:lambda:eu-west-1:123456789012:function:strategist',
  dynamoTableName: 'test-table',
  dynamoGsi1Name: 'gsi1-status-date',
  dynamoGsi2Name: 'gsi2-tag-date',
  strategistTableName: 'test-strategist-table',
  resumesTableName: 'test-strategist-table',
  cognitoUserPoolId: 'eu-west-1_TestPool',
  cognitoClientId: 'test-client-id',
  cognitoIssuerUrl: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  ssmBedrockPrefix: '/bedrock/dev',
  awsRegion: 'eu-west-1',
  port: 3002,
  pgHost: 'pgbouncer.platform.svc.cluster.local',
  pgPort: 5432,
  pgDatabase: 'tucaken',
  pgUser: 'postgres',
  pgPassword: 'secret',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a POST request to the pipelines router.
 *
 * @param path - Route path, e.g. '/article' or '/strategist'
 * @param body - JSON request body
 * @returns Hono Response
 */
async function buildRequest(path: string, body: unknown) {
  const { createPipelinesRouter } = await import('../../src/routes/pipelines.js');
  const router = createPipelinesRouter(testConfig as Parameters<typeof createPipelinesRouter>[0]);

  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return router.request(req);
}

/**
 * Extract and parse the Lambda Payload from the first mock call.
 *
 * Uses `as unknown as T` because `noUncheckedIndexedAccess` makes
 * `mock.calls[0]?.[0]` return `T | undefined`, which TypeScript strict
 * mode disallows casting directly to a concrete type.
 *
 * @returns Parsed JSON payload object
 */
function getLastCallPayload<T>(): T {
  const calls = lambdaSendMock.mock.calls as unknown[][];
  const command = calls[0]![0] as unknown as { input: { Payload: Buffer } };
  return JSON.parse(Buffer.from(command.input.Payload).toString('utf-8')) as T;
}

/**
 * Extract the InvokeCommand input from the first mock call.
 *
 * @returns Parsed input object
 */
function getLastCallInput<T>(): T {
  const calls = lambdaSendMock.mock.calls as unknown[][];
  return calls[0]![0] as unknown as T;
}

// ---------------------------------------------------------------------------
// Tests — article pipeline trigger
// ---------------------------------------------------------------------------

describe('POST /article', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lambdaSendMock.mockResolvedValue({});
  });

  it('returns 400 when slug is absent from the body', async () => {
    const res = await buildRequest('/article', {});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('slug is required');
  });

  it('returns 400 when slug is an empty string', async () => {
    const res = await buildRequest('/article', { slug: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 202 with queued: true on success', async () => {
    const res = await buildRequest('/article', { slug: 'my-test-slug' });
    expect(res.status).toBe(202);
    const body = await res.json() as { queued: boolean; pipeline: string; slug: string; key: string };
    expect(body.queued).toBe(true);
    expect(body.pipeline).toBe('article');
    expect(body.slug).toBe('my-test-slug');
    expect(body.key).toBe('drafts/my-test-slug.md');
  });

  it('invokes Lambda with InvocationType Event (fire-and-forget)', async () => {
    await buildRequest('/article', { slug: 'async-test' });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const command = getLastCallInput<{ input: { InvocationType: string } }>();
    expect(command.input.InvocationType).toBe('Event');
  });

  it('invokes the correct Lambda ARN', async () => {
    await buildRequest('/article', { slug: 'arn-test' });
    const command = getLastCallInput<{ input: { FunctionName: string } }>();
    expect(command.input.FunctionName).toBe(testConfig.articleTriggerArn);
  });

  it('sends a synthetic S3 event with a Records[] array (S3Handler contract)', async () => {
    await buildRequest('/article', { slug: 's3-contract-test' });
    const payload = getLastCallPayload<{
      Records: Array<{ s3: { bucket: { name: string }; object: { key: string } } }>;
    }>();

    // The Lambda iterates Records[] — a missing or empty array causes silent no-op
    expect(Array.isArray(payload.Records)).toBe(true);
    expect(payload.Records).toHaveLength(1);
    expect(payload.Records[0]?.s3.bucket.name).toBe('test-assets-bucket');
    expect(payload.Records[0]?.s3.object.key).toBe('drafts/s3-contract-test.md');
  });

  it('trims leading/trailing whitespace from slug', async () => {
    const res = await buildRequest('/article', { slug: '  trimmed-slug  ' });
    expect(res.status).toBe(202);
    const body = await res.json() as { slug: string; key: string };
    expect(body.slug).toBe('trimmed-slug');
    expect(body.key).toBe('drafts/trimmed-slug.md');
  });
});

// ---------------------------------------------------------------------------
// Tests — strategist pipeline trigger
// ---------------------------------------------------------------------------

describe('POST /strategist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lambdaSendMock.mockResolvedValue({});
  });

  it('returns 202 with queued: true and pipeline: strategist', async () => {
    const res = await buildRequest('/strategist', { operation: 'analyse' });
    expect(res.status).toBe(202);
    const body = await res.json() as { queued: boolean; pipeline: string };
    expect(body.queued).toBe(true);
    expect(body.pipeline).toBe('strategist');
  });

  it('invokes the strategist Lambda ARN with InvocationType Event', async () => {
    await buildRequest('/strategist', { operation: 'analyse' });
    const command = getLastCallInput<{ input: { FunctionName: string; InvocationType: string } }>();
    expect(command.input.FunctionName).toBe(testConfig.strategistTriggerArn);
    expect(command.input.InvocationType).toBe('Event');
  });

  it('wraps body in APIGatewayProxyEventV2 envelope with requestContext', async () => {
    await buildRequest('/strategist', { operation: 'analyse' });
    const payload = getLastCallPayload<{
      requestContext: { http: { method: string } };
      body: string;
    }>();

    // Lambda reads event.requestContext.http.method to reject OPTIONS preflight
    expect(payload.requestContext?.http?.method).toBe('POST');
    // Lambda parses event.body as JSON — must be a serialised string
    expect(typeof payload.body).toBe('string');
  });

  it('forwards the admin UI request body verbatim inside event.body', async () => {
    const analysePayload = {
      operation: 'analyse',
      targetCompany: 'Acme Corp',
      targetRole: 'Senior Engineer',
      jobDescription: 'Build great things',
      resumeId: 'resume-123',
      includeCoverLetter: true,
    };
    await buildRequest('/strategist', analysePayload);
    const envelope = getLastCallPayload<{ body: string }>();
    const forwarded = JSON.parse(envelope.body) as typeof analysePayload;

    // All admin UI fields must reach event.body for Zod validation inside the Lambda
    expect(forwarded.operation).toBe('analyse');
    expect(forwarded.targetCompany).toBe('Acme Corp');
    expect(forwarded.targetRole).toBe('Senior Engineer');
    expect(forwarded.resumeId).toBe('resume-123');
    expect(forwarded.includeCoverLetter).toBe(true);
  });

  it('forwards coach operation fields correctly', async () => {
    const coachPayload = {
      operation: 'coach',
      applicationSlug: 'acme-corp-senior-engineer',
      interviewStage: 'technical',
    };
    await buildRequest('/strategist', coachPayload);
    const envelope = getLastCallPayload<{ body: string }>();
    const forwarded = JSON.parse(envelope.body) as typeof coachPayload;

    expect(forwarded.operation).toBe('coach');
    expect(forwarded.applicationSlug).toBe('acme-corp-senior-engineer');
    expect(forwarded.interviewStage).toBe('technical');
  });

  it('handles malformed body gracefully — falls back to empty envelope', async () => {
    const { createPipelinesRouter } = await import('../../src/routes/pipelines.js');
    const router = createPipelinesRouter(testConfig as Parameters<typeof createPipelinesRouter>[0]);

    const req = new Request('http://localhost/strategist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json',
    });

    // BFF returns 202 — Lambda surfaces the error internally (async invocation)
    const res = await router.request(req);
    expect(res.status).toBe(202);

    const envelope = getLastCallPayload<{ body: string }>();
    // Fallback body is empty object — Lambda's Zod will reject it with 400
    expect(JSON.parse(envelope.body)).toEqual({});
  });
});
