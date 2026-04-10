/**
 * @format
 * Tests for public-api routes/resumes.ts
 *
 * Strategy: mock `../../src/lib/dynamo.js` and `../../src/lib/config.js`
 * so the handler runs offline with no real AWS calls.
 *
 * Coverage:
 *   GET /api/resumes/active — 200 with stripped public payload
 *   GET /api/resumes/active — 204 when no active resume exists
 *   GET /api/resumes/active — 204 when STRATEGIST_TABLE_NAME is not configured
 *   GET /api/resumes/active — sets Cache-Control header
 *   GET /api/resumes/active — strips internal DynamoDB keys from response
 *   GET /api/resumes/active — correct DynamoDB scan filter applied
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Module mocks — before subject imports
// ---------------------------------------------------------------------------

jest.mock('../../src/lib/dynamo.js', () => ({
  getDynamoClient: jest.fn(),
}));

jest.mock('../../src/lib/config.js', () => ({
  loadConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import resumes from '../../src/routes/resumes.js';
import { getDynamoClient } from '../../src/lib/dynamo.js';
import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockedGetDynamoClient = jest.mocked(getDynamoClient);
const mockedLoadConfig = jest.mocked(loadConfig);

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const RESUME_ENTITY = {
  pk: 'RESUME#some-uuid',
  sk: 'METADATA',
  gsi1pk: 'RESUME',
  gsi1sk: 'RESUME#2026-01-01T00:00:00.000Z',
  entityType: 'RESUME',
  resumeId: 'some-uuid',
  label: 'Senior Engineer CV',
  isActive: true,
  data: { basics: { name: 'Nelson Lamounier', title: 'Senior Engineer' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const PUBLIC_KEYS = ['resumeId', 'label', 'isActive', 'data', 'createdAt', 'updatedAt'];
const INTERNAL_KEYS = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'entityType'];

const BASE_CONFIG = {
  awsRegion: 'eu-west-1',
  dynamoTableName: 'test-content',
  dynamoGsi1Name: 'gsi1',
  dynamoGsi2Name: 'gsi2',
  resumesTableName: 'test-strategist',
  port: 3001,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/resumes/active', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockedSend: jest.Mock<any>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedSend = jest.fn();
    mockedGetDynamoClient.mockReturnValue({ send: mockedSend } as never);
    mockedLoadConfig.mockReturnValue(BASE_CONFIG as never);
  });

  it('returns 200 with resume data when an active resume exists', async () => {
    mockedSend.mockResolvedValue({ Items: [RESUME_ENTITY] });
    const res = await resumes.request('/api/resumes/active');
    expect(res.status).toBe(200);
  });

  it('includes all public fields in the response', async () => {
    mockedSend.mockResolvedValue({ Items: [RESUME_ENTITY] });
    const res = await resumes.request('/api/resumes/active');
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of PUBLIC_KEYS) {
      expect(body[key]).toBeDefined();
    }
  });

  it('strips internal DynamoDB keys from the public response', async () => {
    mockedSend.mockResolvedValue({ Items: [RESUME_ENTITY] });
    const res = await resumes.request('/api/resumes/active');
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of INTERNAL_KEYS) {
      expect(body[key]).toBeUndefined();
    }
  });

  it('sets Cache-Control with s-maxage and stale-while-revalidate', async () => {
    mockedSend.mockResolvedValue({ Items: [RESUME_ENTITY] });
    const res = await resumes.request('/api/resumes/active');
    const cacheControl = res.headers.get('Cache-Control') ?? '';
    expect(cacheControl).toContain('s-maxage');
    expect(cacheControl).toContain('stale-while-revalidate');
  });

  it('returns 204 when no active resume exists in DynamoDB', async () => {
    mockedSend.mockResolvedValue({ Items: [] });
    const res = await resumes.request('/api/resumes/active');
    expect(res.status).toBe(204);
  });

  it('returns 204 when STRATEGIST_TABLE_NAME is not configured', async () => {
    mockedLoadConfig.mockReturnValue({ ...BASE_CONFIG, resumesTableName: undefined } as never);
    const res = await resumes.request('/api/resumes/active');
    expect(res.status).toBe(204);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('scans with entityType=RESUME AND isActive=true filter', async () => {
    mockedSend.mockResolvedValue({ Items: [RESUME_ENTITY] });
    await resumes.request('/api/resumes/active');
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const callArg = mockedSend.mock.calls[0]?.[0] as {
      input: { ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(callArg.input.ExpressionAttributeValues[':type']).toBe('RESUME');
    expect(callArg.input.ExpressionAttributeValues[':active']).toBe(true);
  });
});
