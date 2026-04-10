/**
 * @format
 * Tests for admin-api lib/config.ts
 *
 * Verifies that loadConfig() correctly reads environment variables,
 * fails fast with a descriptive error listing all missing vars, and
 * returns a fully-typed AdminApiConfig object when all vars are present.
 */

import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete set of valid environment variables for the admin-api. */
const VALID_ENV: Record<string, string> = {
  DYNAMODB_TABLE_NAME: 'test-articles-table',
  DYNAMODB_GSI1_NAME: 'gsi1-status-date',
  DYNAMODB_GSI2_NAME: 'gsi2-tag-date',
  ASSETS_BUCKET_NAME: 'test-assets-bucket',
  PUBLISH_LAMBDA_ARN: 'arn:aws:lambda:eu-west-1:123456789012:function:publish',
  ARTICLE_TRIGGER_ARN: 'arn:aws:lambda:eu-west-1:123456789012:function:trigger',
  STRATEGIST_TRIGGER_ARN: 'arn:aws:lambda:eu-west-1:123456789012:function:strategist',
  STRATEGIST_TABLE_NAME: 'test-strategist-table',
  COGNITO_USER_POOL_ID: 'eu-west-1_TestPool',
  COGNITO_CLIENT_ID: 'testClientId',
  COGNITO_ISSUER_URL: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  AWS_DEFAULT_REGION: 'eu-west-1',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
}

function unsetEnv(keys: string[]): void {
  for (const k of keys) {
    delete process.env[k];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadConfig()', () => {
  beforeEach(() => setEnv(VALID_ENV));
  afterEach(() => unsetEnv(Object.keys(VALID_ENV)));

  describe('happy path', () => {
    it('returns typed config when all env vars are present', () => {
      const config = loadConfig();

      expect(config.dynamoTableName).toBe('test-articles-table');
      expect(config.dynamoGsi1Name).toBe('gsi1-status-date');
      expect(config.dynamoGsi2Name).toBe('gsi2-tag-date');
      expect(config.assetsBucketName).toBe('test-assets-bucket');
      expect(config.publishLambdaArn).toContain('publish');
      expect(config.articleTriggerArn).toContain('trigger');
      expect(config.strategistTriggerArn).toContain('strategist');
      expect(config.strategistTableName).toBe('test-strategist-table');
      expect(config.resumesTableName).toBe('test-strategist-table');
      expect(config.cognitoUserPoolId).toBe('eu-west-1_TestPool');
      expect(config.cognitoClientId).toBe('testClientId');
      expect(config.awsRegion).toBe('eu-west-1');
    });

    it('defaults port to 3002 when PORT is not set', () => {
      const config = loadConfig();
      expect(config.port).toBe(3002);
    });

    it('reads port from PORT env var', () => {
      process.env['PORT'] = '8080';
      const config = loadConfig();
      expect(config.port).toBe(8080);
      delete process.env['PORT'];
    });

    it('maps resumesTableName to STRATEGIST_TABLE_NAME (co-location of resumes)', () => {
      const config = loadConfig();
      expect(config.resumesTableName).toBe(config.strategistTableName);
    });
  });

  describe('fail-fast validation', () => {
    it('throws when a single required var is missing', () => {
      delete process.env['DYNAMODB_TABLE_NAME'];
      expect(() => loadConfig()).toThrow('DYNAMODB_TABLE_NAME');
    });

    it('lists all missing variables in a single thrown error', () => {
      unsetEnv(['DYNAMODB_TABLE_NAME', 'COGNITO_USER_POOL_ID', 'ASSETS_BUCKET_NAME']);
      expect(() => loadConfig()).toThrow(/DYNAMODB_TABLE_NAME/);
    });

    it('throws the admin-api service prefix in the error message', () => {
      unsetEnv(Object.keys(VALID_ENV));
      expect(() => loadConfig()).toThrow('[admin-api] Missing required environment variables');
    });
  });
});
