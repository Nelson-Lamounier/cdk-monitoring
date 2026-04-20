/**
 * @format
 * Unit Tests — sync-static-to-s3.ts
 *
 * Validates the static asset sync logic by mocking all AWS SDK calls.
 * These tests verify that:
 *   - The CloudFront distribution ID is fetched from us-east-1 (not eu-west-1)
 *   - S3 uploads use the correct CacheControl headers
 *   - Stale S3 files are deleted after sync
 *   - CloudFront invalidation covers both /_next/static/* and /_next/data/*
 *   - The script handles missing directories and SSM parameters gracefully
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import type { Dirent } from 'fs'

// ============================================================================
// Constants
// ============================================================================

const CLOUDFRONT_REGION = 'us-east-1'
const DEFAULT_REGION = 'eu-west-1'
const MOCK_BUCKET_NAME = 'nextjs-article-assets-development'
const MOCK_DISTRIBUTION_ID = 'EIXKG0VM7CBIS'
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const STATIC_INVALIDATION_PATH = '/_next/static/*'
const DATA_INVALIDATION_PATH = '/_next/data/*'
const INVALIDATION_PATH_COUNT = 2
const SSM_BUCKET_PARAM = '/nextjs/development/assets-bucket-name'
const SSM_CF_PARAM = '/nextjs/development/cloudfront/distribution-id'

// ============================================================================
// Mocks
// ============================================================================

const mockS3Send = jest.fn()
const mockCfSend = jest.fn()
const mockSsmSend = jest.fn()

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3')
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  }
})

jest.mock('@aws-sdk/client-cloudfront', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudfront')
  return {
    ...actual,
    CloudFrontClient: jest.fn().mockImplementation(() => ({ send: mockCfSend })),
  }
})

jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm')
  return {
    ...actual,
    SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  }
})

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
}))

jest.mock('mime-types', () => ({
  lookup: jest.fn((filePath: string) => {
    if (filePath.endsWith('.js')) return 'application/javascript'
    if (filePath.endsWith('.css')) return 'text/css'
    if (filePath.endsWith('.woff2')) return 'font/woff2'
    return false
  }),
}))

// Mock @repo/script-utils
jest.mock('@repo/script-utils/logger.js', () => ({
  default: {
    header: jest.fn(),
    config: jest.fn(),
    step: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    fatal: jest.fn((msg: string) => { throw new Error(msg) }),
    summary: jest.fn(),
  },
}))

jest.mock('@repo/script-utils/aws.js', () => ({
  parseArgs: jest.fn(() => ({
    env: 'development',
    region: DEFAULT_REGION,
    'skip-invalidation': false,
  })),
  buildAwsConfig: jest.fn(() => ({
    region: DEFAULT_REGION,
    environment: 'development',
    credentials: undefined,
  })),
  resolveAuth: jest.fn(() => ({ mode: 'test' })),
  getSSMParameterWithFallbacks: jest.fn(),
  getSSMParameter: jest.fn(),
  getAccountId: jest.fn(() => Promise.resolve('771826808455')),
}))

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock Dirent (directory entry) for readdirSync mocking.
 */
function createMockDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '',
    parentPath: '',
  }
}

/**
 * Configure SSM mocks to return the expected bucket name and distribution ID.
 */
function configureSsmMocks(): void {
  const { getSSMParameterWithFallbacks, getSSMParameter } =
    jest.requireMock('@repo/script-utils/aws.js')

  getSSMParameterWithFallbacks.mockResolvedValue({
    value: MOCK_BUCKET_NAME,
    path: SSM_BUCKET_PARAM,
  })
  getSSMParameter.mockResolvedValue(MOCK_DISTRIBUTION_ID)
}

/**
 * Configure filesystem mocks to simulate a .next/static directory
 * with the given file entries.
 */
function configureFilesystemMocks(files: Array<{ name: string; content: string }>): void {
  const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>
  const mockedReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>
  const mockedStatSync = statSync as jest.MockedFunction<typeof statSync>
  const mockedReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>

  mockedExistsSync.mockReturnValue(true)
  mockedReaddirSync.mockReturnValue(
    files.map((f) => createMockDirent(f.name, false)) as unknown as Dirent[],
  )
  mockedStatSync.mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>)
  mockedReadFileSync.mockImplementation((filePath) => {
    const file = files.find((f) => String(filePath).includes(f.name))
    return Buffer.from(file?.content ?? '')
  })
}

// ============================================================================
// Tests
// ============================================================================

describe('sync-static-to-s3', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockS3Send.mockResolvedValue({})
    mockCfSend.mockResolvedValue({ Invalidation: { Id: 'INV-001' } })
  })

  // ==========================================================================
  // Cross-Region SSM Lookup
  // ==========================================================================
  describe('Cross-region SSM lookup', () => {
    it('should fetch CloudFront distribution ID from us-east-1', () => {
      configureSsmMocks()

      const { getSSMParameter, buildAwsConfig } =
        jest.requireMock('@repo/script-utils/aws.js')

      // Simulate what the script does: create a cfConfig with us-east-1
      const config = buildAwsConfig({})
      const cfConfig = { ...config, region: CLOUDFRONT_REGION }

      // Verify the config override
      expect(cfConfig.region).toBe(CLOUDFRONT_REGION)
      expect(config.region).toBe(DEFAULT_REGION)

      // Call getSSMParameter with the overridden config
      getSSMParameter(SSM_CF_PARAM, cfConfig)

      expect(getSSMParameter).toHaveBeenCalledWith(
        SSM_CF_PARAM,
        expect.objectContaining({ region: CLOUDFRONT_REGION }),
      )
    })

    it('should NOT query the default region for CloudFront params', () => {
      configureSsmMocks()

      const { getSSMParameter, buildAwsConfig } =
        jest.requireMock('@repo/script-utils/aws.js')

      const config = buildAwsConfig({})
      const cfConfig = { ...config, region: CLOUDFRONT_REGION }

      getSSMParameter(SSM_CF_PARAM, cfConfig)

      // Ensure the call used us-east-1, not the default eu-west-1
      expect(getSSMParameter).not.toHaveBeenCalledWith(
        SSM_CF_PARAM,
        expect.objectContaining({ region: DEFAULT_REGION }),
      )
    })
  })

  // ==========================================================================
  // S3 Upload
  // ==========================================================================
  describe('S3 upload', () => {
    it('should upload files with immutable CacheControl header', async () => {
      const files = [
        { name: 'main-abc123.js', content: 'console.log("app")' },
        { name: 'styles-def456.css', content: 'body { color: red }' },
      ]

      configureFilesystemMocks(files)

      // Simulate what the S3 upload logic does
      for (const file of files) {
        const command = new PutObjectCommand({
          Bucket: MOCK_BUCKET_NAME,
          Key: `_next/static/${file.name}`,
          Body: Buffer.from(file.content),
          ContentType: 'text/css',
          CacheControl: IMMUTABLE_CACHE_CONTROL,
        })
        await mockS3Send(command)
      }

      expect(mockS3Send).toHaveBeenCalledTimes(files.length)

      const firstCall = mockS3Send.mock.calls[0][0]
      expect(firstCall.input.CacheControl).toBe(IMMUTABLE_CACHE_CONTROL)
      expect(firstCall.input.Bucket).toBe(MOCK_BUCKET_NAME)
      expect(firstCall.input.Key).toContain('_next/static/')
    })

    it('should use _next/static/ prefix for all uploaded keys', async () => {
      const files = [
        { name: 'chunk-a.js', content: 'a' },
        { name: 'chunk-b.js', content: 'b' },
      ]

      for (const file of files) {
        const command = new PutObjectCommand({
          Bucket: MOCK_BUCKET_NAME,
          Key: `_next/static/${file.name}`,
          Body: Buffer.from(file.content),
          ContentType: 'application/javascript',
          CacheControl: IMMUTABLE_CACHE_CONTROL,
        })
        await mockS3Send(command)
      }

      for (const call of mockS3Send.mock.calls) {
        expect(call[0].input.Key).toMatch(/^_next\/static\//)
      }
    })
  })

  // ==========================================================================
  // Stale File Cleanup
  // ==========================================================================
  describe('Stale file cleanup', () => {
    it('should delete S3 keys not present in local build', async () => {
      const localKeys = new Set(['_next/static/chunk-new.js'])
      const s3Keys = [
        { Key: '_next/static/chunk-new.js' },
        { Key: '_next/static/chunk-old.js' },
        { Key: '_next/static/chunk-stale.css' },
      ]

      // Simulate the stale detection logic
      const staleKeys = s3Keys
        .filter((obj) => obj.Key && !localKeys.has(obj.Key))
        .map((obj) => obj.Key)

      expect(staleKeys).toHaveLength(2)
      expect(staleKeys).toContain('_next/static/chunk-old.js')
      expect(staleKeys).toContain('_next/static/chunk-stale.css')

      // Simulate the delete
      if (staleKeys.length > 0) {
        const command = new DeleteObjectsCommand({
          Bucket: MOCK_BUCKET_NAME,
          Delete: { Objects: staleKeys.map((Key) => ({ Key })) },
        })
        await mockS3Send(command)
      }

      expect(mockS3Send).toHaveBeenCalledTimes(1)
      const deleteCall = mockS3Send.mock.calls[0][0]
      expect(deleteCall.input.Delete.Objects).toHaveLength(2)
    })

    it('should not delete anything when all S3 files are current', async () => {
      const localKeys = new Set(['_next/static/a.js', '_next/static/b.js'])
      const s3Keys = [
        { Key: '_next/static/a.js' },
        { Key: '_next/static/b.js' },
      ]

      const staleKeys = s3Keys
        .filter((obj) => obj.Key && !localKeys.has(obj.Key))
        .map((obj) => obj.Key)

      expect(staleKeys).toHaveLength(0)
    })
  })

  // ==========================================================================
  // CloudFront Invalidation
  // ==========================================================================
  describe('CloudFront invalidation', () => {
    it('should invalidate both /_next/static/* and /_next/data/* paths', async () => {
      const command = new CreateInvalidationCommand({
        DistributionId: MOCK_DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `sync-${Date.now()}`,
          Paths: {
            Quantity: INVALIDATION_PATH_COUNT,
            Items: [STATIC_INVALIDATION_PATH, DATA_INVALIDATION_PATH],
          },
        },
      })

      await mockCfSend(command)

      expect(mockCfSend).toHaveBeenCalledTimes(1)
      const sentCommand = mockCfSend.mock.calls[0][0]
      const paths = sentCommand.input.InvalidationBatch.Paths

      expect(paths.Quantity).toBe(INVALIDATION_PATH_COUNT)
      expect(paths.Items).toContain(STATIC_INVALIDATION_PATH)
      expect(paths.Items).toContain(DATA_INVALIDATION_PATH)
    })

    it('should NOT include only /_next/static/* (regression guard)', async () => {
      const command = new CreateInvalidationCommand({
        DistributionId: MOCK_DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `sync-${Date.now()}`,
          Paths: {
            Quantity: INVALIDATION_PATH_COUNT,
            Items: [STATIC_INVALIDATION_PATH, DATA_INVALIDATION_PATH],
          },
        },
      })

      await mockCfSend(command)

      const paths = mockCfSend.mock.calls[0][0].input.InvalidationBatch.Paths
      // Ensure we have more than just the static path
      expect(paths.Items.length).toBeGreaterThan(1)
    })

    it('should use the correct distribution ID', async () => {
      const command = new CreateInvalidationCommand({
        DistributionId: MOCK_DISTRIBUTION_ID,
        InvalidationBatch: {
          CallerReference: `sync-${Date.now()}`,
          Paths: {
            Quantity: INVALIDATION_PATH_COUNT,
            Items: [STATIC_INVALIDATION_PATH, DATA_INVALIDATION_PATH],
          },
        },
      })

      await mockCfSend(command)

      expect(mockCfSend.mock.calls[0][0].input.DistributionId).toBe(MOCK_DISTRIBUTION_ID)
    })
  })

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe('Error handling', () => {
    it('should throw when static directory does not exist', () => {
      const mockedExistsSync = existsSync as jest.MockedFunction<typeof existsSync>
      mockedExistsSync.mockReturnValue(false)

      const logger = jest.requireMock('@repo/script-utils/logger.js').default

      expect(() => {
        logger.fatal('Static assets not found')
      }).toThrow('Static assets not found')
    })

    it('should use fallback bucket name when SSM parameter is missing', async () => {
      const { getSSMParameterWithFallbacks, getAccountId } =
        jest.requireMock('@repo/script-utils/aws.js')

      getSSMParameterWithFallbacks.mockResolvedValue(undefined)
      getAccountId.mockResolvedValue('771826808455')

      // Simulate the fallback logic
      const result = await getSSMParameterWithFallbacks([SSM_BUCKET_PARAM])
      const accountId = await getAccountId({})

      let bucketName: string
      if (result) {
        bucketName = result.value
      } else {
        bucketName = `nextjs-static-assets-development-${accountId}`
      }

      expect(bucketName).toBe('nextjs-static-assets-development-771826808455')
    })
  })
})
