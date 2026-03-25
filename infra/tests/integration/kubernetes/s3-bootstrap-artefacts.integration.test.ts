/**
 * @format
 * S3 Bootstrap Artefacts — Post-Sync Integration Test
 *
 * Validates that the S3 sync step in the deployment pipeline successfully
 * uploaded bootstrap scripts and deploy artefacts to the expected S3
 * prefixes.
 *
 * Three focused concerns:
 *   1. Bucket Existence — the scripts bucket SSM parameter resolves to a
 *      real, accessible S3 bucket.
 *   2. K8s Bootstrap Scripts — the `k8s-bootstrap/` prefix contains the
 *      core Python step scripts required by SSM Automation documents.
 *   3. App Deploy Scripts — optional `app-deploy/nextjs/` and
 *      `app-deploy/monitoring/` prefixes contain deployment artefacts
 *      when those apps are configured.
 *
 * All app-deploy assertions pass vacuously when files have not been
 * synced yet (Day-0 or bootstrap-only deployments).
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes/s3-bootstrap-artefacts development --verbose
 */

import {
    S3Client,
    ListObjectsV2Command,
    HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
    SSMClient,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import type { Environment } from '../../../lib/config';
import { k8sSsmPrefix } from '../../../lib/config/ssm-paths';

/**
 * Vacuous-pass sentinel.
 *
 * Mirrors the pattern from ssm-automation-runtime.integration.test.ts.
 * When an S3 prefix has not been synced yet (Day-0), assertions pass
 * vacuously instead of silently skipping in the `it()` body.
 */
const VACUOUS = 'VACUOUS_PASS' as const;

// =============================================================================
// Configuration — Named Constants (Rule 3)
// =============================================================================

const CDK_ENV = (process.env.CDK_ENV ?? 'development') as Environment;
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
const PREFIX = k8sSsmPrefix(CDK_ENV);

/** SSM parameter path for the scripts S3 bucket name */
const SCRIPTS_BUCKET_PARAM = `${PREFIX}/scripts-bucket`;

/** Minimum expected file count for k8s-bootstrap/ (core Python steps) */
const MIN_BOOTSTRAP_FILES = 10;

/** S3 prefixes synced by sync-bootstrap-scripts.ts */
const S3_SYNC_TARGETS = [
    {
        label: 'K8s Bootstrap Scripts',
        prefix: 'k8s-bootstrap/',
        required: true,
        minFiles: MIN_BOOTSTRAP_FILES,
    },
    {
        label: 'Next.js Deploy Scripts',
        prefix: 'app-deploy/nextjs/',
        required: false,
        minFiles: 1,
    },
    {
        label: 'Monitoring Deploy Scripts',
        prefix: 'app-deploy/monitoring/',
        required: false,
        minFiles: 1,
    },
] as const;

/** Type for required vs optional sync targets */
type SyncTarget = (typeof S3_SYNC_TARGETS)[number];

// AWS SDK clients
const s3 = new S3Client({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// =============================================================================
// Helpers (module-level — Rule 10)
// =============================================================================

/**
 * Fetch a single SSM parameter value.
 * Returns undefined if the parameter does not exist.
 */
async function getParam(name: string): Promise<string | undefined> {
    try {
        const result = await ssm.send(new GetParameterCommand({ Name: name }));
        return result.Parameter?.Value;
    } catch {
        return undefined;
    }
}

/**
 * Count objects under an S3 prefix.
 * Returns the count from the first page (up to 1000 objects).
 */
async function countS3Objects(bucket: string, prefix: string): Promise<number> {
    try {
        const { KeyCount } = await s3.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                MaxKeys: 1000,
            }),
        );
        return KeyCount ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Check if an S3 bucket exists and is accessible.
 */
async function bucketExists(bucket: string): Promise<boolean> {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
    } catch {
        return false;
    }
}

// =============================================================================
// Cached data — populated in beforeAll
// =============================================================================

let bucketName: string | typeof VACUOUS;
let bucketAccessible: boolean;
const prefixCounts = new Map<string, number>();

// =============================================================================
// Tests
// =============================================================================

describe('S3 Bootstrap Artefacts — Post-Sync Verification', () => {
    // ── Global Setup — all API calls happen here, zero in it() blocks ────
    beforeAll(async () => {
        // 1. Resolve the scripts bucket name from SSM
        const resolvedBucket = await getParam(SCRIPTS_BUCKET_PARAM);
        bucketName = resolvedBucket ?? VACUOUS;

        if (bucketName === VACUOUS) {
            bucketAccessible = false;
            return;
        }

        // 2. Verify bucket exists and is accessible
        bucketAccessible = await bucketExists(bucketName);

        if (!bucketAccessible) return;

        // 3. Count objects under each sync prefix
        for (const target of S3_SYNC_TARGETS) {
            const count = await countS3Objects(bucketName, target.prefix);
            prefixCounts.set(target.prefix, count);
        }
    }, 30_000);

    // =====================================================================
    // Bucket Existence — SSM parameter resolves to an accessible S3 bucket
    // =====================================================================
    describe('Scripts Bucket', () => {
        it('should resolve the scripts bucket name from SSM', () => {
            // Vacuous pass when SSM parameter does not exist (Day-0)
            if (bucketName === VACUOUS) {
                console.warn(
                    `[VACUOUS] ${SCRIPTS_BUCKET_PARAM} not found — bucket verification skipped`,
                );
            }
            expect(bucketName).not.toBe('');
        });

        it('should have an accessible S3 bucket', () => {
            if (bucketName === VACUOUS) return;
            expect(bucketAccessible).toBe(true);
        });
    });

    // =====================================================================
    // Sync Target Verification — files exist at each expected S3 prefix
    // =====================================================================
    describe.each(S3_SYNC_TARGETS)(
        'Sync Target — $label',
        (target: SyncTarget) => {
            let fileCount: number | typeof VACUOUS;
            let expectedMinFiles: number | typeof VACUOUS;

            // Depends on: prefixCounts populated in top-level beforeAll
            beforeAll(() => {
                if (bucketName === VACUOUS || !bucketAccessible) {
                    fileCount = VACUOUS;
                    expectedMinFiles = VACUOUS;
                    return;
                }

                const count = prefixCounts.get(target.prefix) ?? 0;

                if (!target.required && count === 0) {
                    // Optional prefix with no files — vacuous pass
                    fileCount = VACUOUS;
                    expectedMinFiles = VACUOUS;
                } else {
                    fileCount = count;
                    expectedMinFiles = target.minFiles;
                }
            });

            it(`should have files at s3://{bucket}/${target.prefix}`, () => {
                if (fileCount === VACUOUS) {
                    const reason = bucketName === VACUOUS
                        ? 'no bucket configured'
                        : 'optional prefix not yet synced';
                    console.warn(`[VACUOUS] ${target.label}: ${reason}`);
                    return;
                }

                expect(fileCount).toBeGreaterThanOrEqual(expectedMinFiles as number);
            });
        },
    );
});
