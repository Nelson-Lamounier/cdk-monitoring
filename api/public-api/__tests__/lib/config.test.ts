/**
 * @format
 * Tests for public-api lib/config.ts
 *
 * Verifies fail-fast startup validation and correct mapping of
 * environment variables to the typed Config interface.
 */

import { loadConfig } from '../../src/lib/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ENV: Record<string, string> = {
  AWS_DEFAULT_REGION: 'eu-west-1',
  DYNAMODB_TABLE_NAME: 'test-content-table',
  DYNAMODB_GSI1_NAME: 'gsi1-status-date',
  DYNAMODB_GSI2_NAME: 'gsi2-tag-date',
};

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
  afterEach(() => unsetEnv([...Object.keys(VALID_ENV), 'PORT', 'STRATEGIST_TABLE_NAME']));

  describe('happy path', () => {
    it('returns typed config when all required vars are present', () => {
      const cfg = loadConfig();

      expect(cfg.awsRegion).toBe('eu-west-1');
      expect(cfg.dynamoTableName).toBe('test-content-table');
      expect(cfg.dynamoGsi1Name).toBe('gsi1-status-date');
      expect(cfg.dynamoGsi2Name).toBe('gsi2-tag-date');
    });

    it('defaults port to 3001 when PORT is not set', () => {
      const cfg = loadConfig();
      expect(cfg.port).toBe(3001);
    });

    it('reads port from PORT env var', () => {
      process.env['PORT'] = '9000';
      const cfg = loadConfig();
      expect(cfg.port).toBe(9000);
    });

    it('sets resumesTableName to undefined when STRATEGIST_TABLE_NAME is absent', () => {
      const cfg = loadConfig();
      expect(cfg.resumesTableName).toBeUndefined();
    });

    it('sets resumesTableName from STRATEGIST_TABLE_NAME when present', () => {
      process.env['STRATEGIST_TABLE_NAME'] = 'strategist-table';
      const cfg = loadConfig();
      expect(cfg.resumesTableName).toBe('strategist-table');
    });

    it('returns a frozen config object', () => {
      const cfg = loadConfig();
      expect(Object.isFrozen(cfg)).toBe(true);
    });
  });

  describe('fail-fast validation', () => {
    it('throws when AWS_DEFAULT_REGION is missing', () => {
      delete process.env['AWS_DEFAULT_REGION'];
      expect(() => loadConfig()).toThrow('AWS_DEFAULT_REGION');
    });

    it('throws when DYNAMODB_TABLE_NAME is missing', () => {
      delete process.env['DYNAMODB_TABLE_NAME'];
      expect(() => loadConfig()).toThrow('DYNAMODB_TABLE_NAME');
    });

    it('lists all missing variables in a single error', () => {
      unsetEnv(['DYNAMODB_GSI1_NAME', 'DYNAMODB_GSI2_NAME']);
      const err = (): void => { loadConfig(); };
      expect(err).toThrow(/DYNAMODB_GSI1_NAME/);
      setEnv(VALID_ENV); // reset for second check
      expect(() => loadConfig()).not.toThrow();
    });

    it('includes the ConfigMap name in the error message', () => {
      delete process.env['AWS_DEFAULT_REGION'];
      expect(() => loadConfig()).toThrow(/nextjs-config/);
    });
  });
});
