/**
 * @format
 * Tests for admin-api routes/resumes.ts
 *
 * Strategy: mock `../../src/lib/dynamo.js` using `jest.unstable_mockModule()`
 * — the correct ESM-compatible API in Jest 29. All module imports are via
 * top-level `await import()` so the mock registry is populated before the
 * route module is evaluated.
 *
 * Coverage:
 *   GET  /                 — list all resume summaries (summary strips DynamoDB keys)
 *   GET  /active           — 200 with active resume including data
 *   GET  /active           — 404 when no active resume configured
 *   GET  /:id              — 200 with full resume
 *   GET  /:id              — 404 when not found
 *   POST /                 — 201 creates resume with isActive: false
 *   POST /                 — 400 when label is missing or empty string
 *   POST /                 — 400 when data is missing or is an array
 *   PUT  /:id              — 200 updates label and/or data
 *   PUT  /:id              — 400 when neither label nor data provided
 *   DELETE /:id            — 200 for inactive resume
 *   DELETE /:id            — 404 when not found
 *   DELETE /:id            — 409 when resume is active
 *   POST /:id/activate     — deactivates previous, activates target
 *   POST /:id/activate     — skips deactivation when target already active
 *   POST /:id/activate     — skips deactivation when no active resume exists
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared send mock
// ---------------------------------------------------------------------------

/** Shared docClient.send mock — reset in beforeEach. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendMock = jest.fn() as jest.Mock<any>;

// ---------------------------------------------------------------------------
// ESM module mock — MUST be called before any import() of the mocked module
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../src/lib/dynamo.js', () => ({
  docClient: { send: sendMock },
}));

// ---------------------------------------------------------------------------
// Dynamic imports — resolved AFTER mocks are registered
// ---------------------------------------------------------------------------

const { Hono } = await import('hono');
const { createResumesRouter } = await import('../../src/routes/resumes.js');

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const testConfig = {
  dynamoTableName: 'test-articles',
  dynamoGsi1Name: 'gsi1-status-date',
  dynamoGsi2Name: 'gsi2-tag-date',
  assetsBucketName: 'test-bucket',
  publishLambdaArn: 'arn:aws:lambda:eu-west-1:123:function:publish',
  articleTriggerArn: 'arn:aws:lambda:eu-west-1:123:function:trigger',
  strategistTriggerArn: 'arn:aws:lambda:eu-west-1:123:function:strategist',
  strategistTableName: 'test-strategist',
  resumesTableName: 'test-strategist',
  cognitoUserPoolId: 'eu-west-1_TestPool',
  cognitoClientId: 'testClient',
  cognitoIssuerUrl: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  awsRegion: 'eu-west-1',
  port: 3002,
} as const;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Builds the Hono test app with a stub JWT middleware.
 *
 * @returns Configured Hono app with resumes router mounted at /.
 */
function buildApp() {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).set('jwtPayload', { sub: 'test-user-sub' });
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createResumesRouter(testConfig as any));
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const RESUME_ENTITY = {
  pk: 'RESUME#resume-uuid-1',
  sk: 'METADATA',
  gsi1pk: 'RESUME',
  gsi1sk: 'RESUME#2026-01-01T00:00:00.000Z',
  entityType: 'RESUME',
  resumeId: 'resume-uuid-1',
  label: 'Senior Engineer 2026',
  isActive: false,
  data: { basics: { name: 'Nelson Lamounier' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ACTIVE_RESUME_ENTITY = {
  ...RESUME_ENTITY,
  resumeId: 'active-uuid',
  pk: 'RESUME#active-uuid',
  isActive: true,
  label: 'Active CV',
};

// ---------------------------------------------------------------------------
// GET / — list resumes
// ---------------------------------------------------------------------------

describe('GET / — list all resume summaries', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns 200 with a list of summaries', async () => {
    sendMock.mockResolvedValue({ Items: [RESUME_ENTITY] });
    const res = await buildApp().request('/');
    const body = (await res.json()) as { resumes: unknown[]; count: number };
    expect(res.status).toBe(200);
    expect(body.resumes).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  it('summary strips DynamoDB-internal keys (pk, sk, gsi1pk, data)', async () => {
    sendMock.mockResolvedValue({ Items: [RESUME_ENTITY] });
    const res = await buildApp().request('/');
    const body = (await res.json()) as { resumes: Record<string, unknown>[] };
    const summary = body.resumes[0] as Record<string, unknown>;
    expect(summary['pk']).toBeUndefined();
    expect(summary['sk']).toBeUndefined();
    expect(summary['data']).toBeUndefined();
    expect(summary['resumeId']).toBe('resume-uuid-1');
    expect(summary['label']).toBe('Senior Engineer 2026');
  });

  it('returns empty list when DynamoDB returns no items', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const res = await buildApp().request('/');
    const body = (await res.json()) as { resumes: unknown[]; count: number };
    expect(body.resumes).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /active
// ---------------------------------------------------------------------------

describe('GET /active — get active resume', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns 200 with the active resume when one exists', async () => {
    sendMock.mockResolvedValue({ Items: [ACTIVE_RESUME_ENTITY] });
    const res = await buildApp().request('/active');
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.resume['resumeId']).toBe('active-uuid');
    expect(body.resume['isActive']).toBe(true);
  });

  it('includes the full data payload in the active resume response', async () => {
    sendMock.mockResolvedValue({ Items: [ACTIVE_RESUME_ENTITY] });
    const res = await buildApp().request('/active');
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(body.resume['data']).toEqual({ basics: { name: 'Nelson Lamounier' } });
  });

  it('returns 404 when no active resume exists', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const res = await buildApp().request('/active');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No active resume/);
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe('GET /:id — get resume by ID', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns 200 with full resume including data', async () => {
    sendMock.mockResolvedValue({ Item: RESUME_ENTITY });
    const res = await buildApp().request('/resume-uuid-1');
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.resume['resumeId']).toBe('resume-uuid-1');
    expect(body.resume['data']).toEqual({ basics: { name: 'Nelson Lamounier' } });
  });

  it('queries with the correct RESUME# composite key', async () => {
    sendMock.mockResolvedValue({ Item: RESUME_ENTITY });
    await buildApp().request('/resume-uuid-1');
    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { Key: Record<string, string> };
    };
    expect(callArg.input.Key['pk']).toBe('RESUME#resume-uuid-1');
    expect(callArg.input.Key['sk']).toBe('METADATA');
  });

  it('returns 404 when resume does not exist', async () => {
    sendMock.mockResolvedValue({ Item: undefined });
    const res = await buildApp().request('/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST / — create resume
// ---------------------------------------------------------------------------

describe('POST / — create resume', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('returns 201 with the created resume', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New CV 2026', data: { basics: { name: 'Nelson' } } }),
    });
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(res.status).toBe(201);
    expect(body.resume['label']).toBe('New CV 2026');
    expect(body.resume['isActive']).toBe(false);
    expect(typeof body.resume['resumeId']).toBe('string');
  });

  it('PUTs entity with correct DynamoDB key structure', async () => {
    await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Test', data: { version: 1 } }),
    });
    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { Item: Record<string, unknown> };
    };
    expect(callArg.input.Item['sk']).toBe('METADATA');
    expect(callArg.input.Item['gsi1pk']).toBe('RESUME');
    expect(callArg.input.Item['entityType']).toBe('RESUME');
    expect(callArg.input.Item['isActive']).toBe(false);
  });

  it('returns 400 when label is missing', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { basics: {} } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/label/);
  });

  it('returns 400 when label is an empty string', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '   ', data: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when data is missing', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'CV' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/data/);
  });

  it('returns 400 when data is an array instead of an object', async () => {
    const res = await buildApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'CV', data: ['not', 'an', 'object'] }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id — update resume
// ---------------------------------------------------------------------------

describe('PUT /:id — update resume', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ Attributes: RESUME_ENTITY });
  });

  it('returns 200 with updated resume on success', async () => {
    const res = await buildApp().request('/resume-uuid-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Updated Label' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resume: unknown };
    expect(body.resume).toBeDefined();
  });

  it('returns 400 when neither label nor data is provided', async () => {
    const res = await buildApp().request('/resume-uuid-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/label.*data|data.*label/i);
  });

  it('always stamps updatedAt in the UpdateExpression', async () => {
    await buildApp().request('/resume-uuid-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New Label' }),
    });
    const callArg = sendMock.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(callArg.input.ExpressionAttributeValues[':updatedAt']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete resume
// ---------------------------------------------------------------------------

describe('DELETE /:id — delete resume', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns 200 when resume exists and is not active', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: RESUME_ENTITY }) // GetCommand — isActive: false
      .mockResolvedValueOnce({});                     // DeleteCommand

    const res = await buildApp().request('/resume-uuid-1', { method: 'DELETE' });
    const body = (await res.json()) as { deleted: boolean; resumeId: string };
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.resumeId).toBe('resume-uuid-1');
  });

  it('returns 404 when resume does not exist', async () => {
    sendMock.mockResolvedValue({ Item: undefined });
    const res = await buildApp().request('/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when trying to delete the active resume', async () => {
    sendMock.mockResolvedValue({ Item: ACTIVE_RESUME_ENTITY });
    const res = await buildApp().request('/active-uuid', { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cannot delete the active resume/i);
  });

  it('does not issue a DeleteCommand when the resume is active', async () => {
    sendMock.mockResolvedValue({ Item: ACTIVE_RESUME_ENTITY });
    await buildApp().request('/active-uuid', { method: 'DELETE' });
    expect(sendMock).toHaveBeenCalledTimes(1); // only the GetCommand
  });
});

// ---------------------------------------------------------------------------
// POST /:id/activate
// ---------------------------------------------------------------------------

describe('POST /:id/activate — activate resume', () => {
  beforeEach(() => { sendMock.mockReset(); });

  it('returns 200 with the activated resume', async () => {
    const activatedAttributes = {
      ...RESUME_ENTITY,
      resumeId: 'target-uuid',
      pk: 'RESUME#target-uuid',
      isActive: true,
    };
    sendMock
      .mockResolvedValueOnce({ Items: [ACTIVE_RESUME_ENTITY] }) // findActive scan
      .mockResolvedValueOnce({})                                 // deactivate old
      .mockResolvedValueOnce({ Attributes: activatedAttributes }); // activate target

    const res = await buildApp().request('/target-uuid/activate', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resume: Record<string, unknown> };
    expect(body.resume['isActive']).toBe(true);
  });

  it('skips deactivation when the target is already the active resume', async () => {
    const sameActive = { ...ACTIVE_RESUME_ENTITY, resumeId: 'same-uuid', pk: 'RESUME#same-uuid' };
    sendMock
      .mockResolvedValueOnce({ Items: [sameActive] }) // findActive — same ID
      .mockResolvedValueOnce({ Attributes: sameActive }); // activate

    await buildApp().request('/same-uuid/activate', { method: 'POST' });
    // Scan + activate only — no deactivate call
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('skips deactivation when no active resume exists', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [] })                   // findActive → none
      .mockResolvedValueOnce({ Attributes: RESUME_ENTITY });  // activate

    await buildApp().request('/resume-uuid-1/activate', { method: 'POST' });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
