/**
 * @format
 * Kubernetes Edge Stack — Post-Deployment Integration Test
 *
 * Runs AFTER the KubernetesEdgeStack is deployed via CI (_deploy-kubernetes.yml).
 * Calls real AWS APIs to verify:
 *   1. CloudFront behaviour ordering (S3 static vs EIP dynamic)
 *   2. Container ↔ ECR image linkage (SSM tag = latest ECR image)
 *   3. S3 ↔ Container build coherence (build ID hash match)
 *
 * SSM-Anchored Strategy:
 *   - Reads SSM parameters published by the Edge, Data, and Shared stacks
 *   - Uses those values to call CloudFront, ECR, and S3 APIs
 *   - Guarantees we're testing the SAME resources the stacks created
 *
 * Environment Variables:
 *   CDK_ENV      — Target environment (default: development)
 *   AWS_REGION   — AWS region (default: eu-west-1)
 *
 * @example CI invocation:
 *   just ci-integration-test kubernetes development --testPathPattern="edge-stack"
 *
 * @example Local invocation (with SSH tunnel for kubectl):
 *   just test-integration kubernetes development --testPathPattern="edge-stack"
 */

import { execSync } from 'child_process';

import {
    CloudFrontClient,
    GetDistributionConfigCommand,
    GetCachePolicyCommand,
    GetOriginRequestPolicyCommand,
} from '@aws-sdk/client-cloudfront';
import type {
    DistributionConfig,
    CacheBehavior,
    CachePolicyConfig,
    OriginRequestPolicyConfig,
} from '@aws-sdk/client-cloudfront';
import {
    ECRClient,
    DescribeImagesCommand,
} from '@aws-sdk/client-ecr';
import type { ImageDetail } from '@aws-sdk/client-ecr';
import {
    S3Client,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
    SSMClient,
    GetParametersByPathCommand,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import type { DeployableEnvironment } from '../../../lib/config';
import { Environment } from '../../../lib/config';
import { CLOUDFRONT_PATH_PATTERNS } from '../../../lib/config/nextjs';
import {
    nextjsSsmPaths,
    nextjsSsmPrefix,
    sharedEcrPaths,
} from '../../../lib/config/ssm-paths';

// =============================================================================
// Rule 4: Environment Variable Parsing — No Silent `as` Casts
// =============================================================================

/**
 * Parse and validate CDK_ENV environment variable.
 * Throws with a descriptive error for invalid values.
 *
 * @param raw - The raw string from process.env
 * @returns A validated DeployableEnvironment value
 * @throws Error if the value is not a valid deployable environment
 */
function parseEnvironment(raw: string): DeployableEnvironment {
    const valid = [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION] as const satisfies readonly DeployableEnvironment[];
    if (!valid.includes(raw as DeployableEnvironment)) {
        throw new Error(`Invalid CDK_ENV: "${raw}". Expected one of: ${valid.join(', ')}`);
    }
    return raw as DeployableEnvironment;
}

// =============================================================================
// Configuration
// =============================================================================

const CDK_ENV = parseEnvironment(process.env.CDK_ENV ?? 'development');
const REGION = process.env.AWS_REGION ?? 'eu-west-1';
/** CloudFront SSM parameters are stored in us-east-1 (global service) */
const CLOUDFRONT_REGION = 'us-east-1';

const SSM_PATHS = nextjsSsmPaths(CDK_ENV);
const NEXTJS_PREFIX = nextjsSsmPrefix(CDK_ENV);
const ECR_PATHS = sharedEcrPaths(CDK_ENV);

// =============================================================================
// Rule 3: Magic Values — Named Constants Only
// =============================================================================

/** Expected CloudFront behaviour count (excluding the default behaviour) */
const EXPECTED_BEHAVIOUR_COUNT = 8;

/**
 * Expected ordered path patterns matching the `additionalBehaviors` array
 * in edge-stack.ts. Order matters: CloudFront evaluates first match wins.
 *
 * CRITICAL: Auth-sensitive patterns (/api/auth/*, /admin/*, /api/admin/*)
 * MUST appear BEFORE the /api/* catch-all. CloudFront evaluates behaviours
 * in listed order (first match wins), NOT by path specificity.
 */
const EXPECTED_BEHAVIOUR_ORDER = [
    CLOUDFRONT_PATH_PATTERNS.nextjs.static,   // /_next/static/*
    CLOUDFRONT_PATH_PATTERNS.nextjs.data,      // /_next/data/*
    CLOUDFRONT_PATH_PATTERNS.assets.images,    // /images/*
    CLOUDFRONT_PATH_PATTERNS.assets.videos,    // /videos/*
    CLOUDFRONT_PATH_PATTERNS.authCallback,     // /api/auth/*
    CLOUDFRONT_PATH_PATTERNS.admin,            // /admin/*
    CLOUDFRONT_PATH_PATTERNS.adminApi,         // /api/admin/*
    CLOUDFRONT_PATH_PATTERNS.api,              // /api/*
] satisfies readonly string[];

/** Indices for critical ordering assertions */
const AUTH_CALLBACK_INDEX = 4;
const API_CATCHALL_INDEX = 7;

/**
 * Path patterns that require auth cookie forwarding.
 * These behaviours MUST use the AuthNoCachePolicy (CookieBehavior: all)
 * to allow Set-Cookie headers to pass through to the viewer.
 */
const AUTH_SENSITIVE_PATTERNS: Set<string> = new Set([
    CLOUDFRONT_PATH_PATTERNS.authCallback,
    CLOUDFRONT_PATH_PATTERNS.admin,
    CLOUDFRONT_PATH_PATTERNS.adminApi,
]);

/**
 * Expected CookieBehavior for auth-sensitive behaviours.
 * Must be 'all' to allow Set-Cookie forwarding for CSRF double-submit.
 */
const EXPECTED_AUTH_COOKIE_BEHAVIOR = 'all';

/**
 * Expected CookieBehavior for the API catch-all.
 * 'none' is correct here — public API routes don't need cookies.
 */
const EXPECTED_API_COOKIE_BEHAVIOR = 'none';

/** S3-origin path patterns (should be routed to S3 OAC, not EIP) */
const S3_ORIGIN_PATTERNS = new Set([
    CLOUDFRONT_PATH_PATTERNS.nextjs.static,
    CLOUDFRONT_PATH_PATTERNS.nextjs.data,
    CLOUDFRONT_PATH_PATTERNS.assets.images,
    CLOUDFRONT_PATH_PATTERNS.assets.videos,
]);

/** S3 prefix for Next.js static assets */
const S3_STATIC_PREFIX = '_next/static/';

/** Viewer protocol policy — all behaviours must enforce HTTPS */
const EXPECTED_VIEWER_PROTOCOL = 'redirect-to-https';

// =============================================================================
// AWS SDK Clients (shared across tests — Rule 1)
// =============================================================================

const ssm = new SSMClient({ region: REGION });
const ssmUsEast1 = new SSMClient({ region: CLOUDFRONT_REGION });
const cloudfront = new CloudFrontClient({ region: CLOUDFRONT_REGION });
const ecr = new ECRClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

// =============================================================================
// Rule 2: Non-Null Assertions — Use a `requireParam` Helper
// =============================================================================

/**
 * Retrieve a required SSM parameter from the cached map.
 * Throws a descriptive error if the parameter is missing or empty.
 *
 * @param params - The SSM parameter Map<path, value>
 * @param path - The full SSM path to look up
 * @returns The parameter value (guaranteed non-empty)
 * @throws Error if the parameter is missing or empty
 */
function requireParam(params: Map<string, string>, path: string): string {
    const value = params.get(path);
    if (!value) throw new Error(`Missing required SSM parameter: ${path}`);
    return value;
}

// =============================================================================
// SSM Parameter Cache (loaded once at module level — Rule 1)
// =============================================================================

/**
 * Load all SSM parameters under a prefix in one paginated call.
 * Returns a Map<path, value> for fast lookup.
 *
 * @param client - The SSM client to use
 * @param prefix - The SSM path prefix to load
 * @returns A Map of parameter paths to values
 */
async function loadSsmParameters(
    client: SSMClient,
    prefix: string,
): Promise<Map<string, string>> {
    const params = new Map<string, string>();
    let nextToken: string | undefined;

    do {
        const response = await client.send(
            new GetParametersByPathCommand({
                Path: prefix,
                Recursive: true,
                WithDecryption: true,
                NextToken: nextToken,
            }),
        );

        for (const param of response.Parameters ?? []) {
            if (param.Name && param.Value) {
                params.set(param.Name, param.Value);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return params;
}

/**
 * Load a single SSM parameter by name.
 *
 * @param client - The SSM client to use
 * @param name - The SSM parameter name
 * @returns The parameter value, or undefined if not found
 */
async function loadSingleParam(
    client: SSMClient,
    name: string,
): Promise<string | undefined> {
    try {
        const response = await client.send(
            new GetParameterCommand({
                Name: name,
                WithDecryption: true,
            }),
        );
        return response.Parameter?.Value;
    } catch {
        return undefined;
    }
}

// =============================================================================
// Module-Level Predicate Helpers (Rule 10/11)
// =============================================================================

/**
 * Find a CloudFront behaviour by its path pattern.
 *
 * @param behaviours - The array of CloudFront CacheBehavior objects
 * @param pattern - The path pattern to search for
 * @returns The matching CacheBehavior, or undefined
 */
function findBehaviourByPattern(
    behaviours: CacheBehavior[],
    pattern: string,
): CacheBehavior | undefined {
    return behaviours.find((b) => b.PathPattern === pattern);
}

/**
 * Check if a cookie name contains wildcard characters.
 * Extracted to module level to avoid conditionals inside it() blocks.
 *
 * @param cookie - The cookie name string
 * @returns true if the cookie contains '*' or '?'
 */
function isWildcardCookie(cookie: string): boolean {
    return cookie.includes('*') || cookie.includes('?');
}

/**
 * Check if kubectl is available and connected to a cluster.
 *
 * @returns true if kubectl can reach a cluster, false otherwise
 */
function isKubectlAvailable(): boolean {
    try {
        execSync('kubectl cluster-info', { timeout: 5000, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Extract the Next.js build ID from the running pod via kubectl.
 * Requires an open SSH tunnel to the control plane.
 *
 * Uses a label selector (`app=nextjs`) instead of `deploy/` shorthand
 * because the pod is managed by an Argo Rollout, not a standard Deployment.
 *
 * @returns The build ID string, or undefined if unavailable
 */
function getPodBuildId(): string | undefined {
    try {
        // Discover the pod name via label selector (Argo Rollout pods
        // don't have a Deployment resource to shorthand with `deploy/`)
        const podName = execSync(
            'kubectl get pods -n nextjs-app -l app=nextjs -o jsonpath=\'{.items[0].metadata.name}\'',
            { timeout: 10000, stdio: 'pipe' },
        ).toString().trim();

        if (!podName) return undefined;

        const result = execSync(
            `kubectl exec ${podName} -n nextjs-app -- cat /app/.next/BUILD_ID`,
            { timeout: 10000, stdio: 'pipe' },
        );
        return result.toString().trim();
    } catch {
        return undefined;
    }
}

/**
 * Filter image tags to only include SHA-format tags.
 * Accepts pure SHA tags (7-40 hex chars) and composite tags with
 * run-attempt suffix (e.g. `abc123-r1`).
 *
 * @param tags - Array of ECR image tags
 * @returns Filtered array of SHA-format tags
 */
function filterShaTags(tags: string[]): string[] {
    return tags.filter((tag) => /^[0-9a-f]{7,40}(-r[0-9]+)?$/.test(tag));
}

/**
 * Extract the image tag from a full ECR image URI.
 * URI format: `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`
 *
 * @param uri - The full ECR image URI
 * @returns The extracted tag portion
 */
function extractTagFromUri(uri: string): string {
    const parts = uri.split(':');
    return parts[parts.length - 1];
}

/**
 * Extract unique build ID directories from S3 object keys.
 * Build IDs are the first path segment after `_next/static/`.
 *
 * @param keys - Array of S3 object keys under the `_next/static/` prefix
 * @returns A Set of unique build ID strings
 */
function extractBuildIdsFromKeys(keys: string[]): Set<string> {
    const buildIds = new Set<string>();
    for (const key of keys) {
        const afterPrefix = key.slice(S3_STATIC_PREFIX.length);
        const segment = afterPrefix.split('/')[0];
        // Build IDs are alphanumeric hashes (not 'chunks', 'css', 'media', etc.)
        if (segment && /^[a-zA-Z0-9_-]{8,}$/.test(segment)) {
            buildIds.add(segment);
        }
    }
    return buildIds;
}

// =============================================================================
// Shared State (loaded once in top-level beforeAll — Rule 1)
// =============================================================================

/** SSM parameters for the Next.js/Edge stack (eu-west-1) */
let nextjsParams: Map<string, string>;

/** SSM parameters for the Next.js/Edge stack (us-east-1 — CloudFront) */
let nextjsParamsUsEast1: Map<string, string>;

/** SSM parameters for shared ECR */
let ecrParams: Map<string, string>;

/** CloudFront distribution config (live from AWS) */
let distributionConfig: DistributionConfig;

/** CloudFront additional behaviours (ordered) */
let behaviours: CacheBehavior[];

/** Latest ECR image details */
let latestEcrImage: ImageDetail;

/** S3 assets bucket name */
let assetsBucketName: string;

/** S3 object keys under _next/static/ */
let s3StaticKeys: string[];

/** Current SSM image URI (set by deploy-frontend.yml) */
let ssmImageUri: string | undefined;

// =============================================================================
// Top-Level beforeAll — Load All Shared Data Once
// =============================================================================

beforeAll(async () => {
    // Load SSM parameters from both regions
    const [nParams, nParamsUs, eParams] = await Promise.all([
        loadSsmParameters(ssm, NEXTJS_PREFIX),
        loadSsmParameters(ssmUsEast1, NEXTJS_PREFIX),
        loadSsmParameters(ssm, ECR_PATHS.prefix),
    ]);
    nextjsParams = nParams;
    nextjsParamsUsEast1 = nParamsUs;
    ecrParams = eParams;

    // Resolve CloudFront distribution config
    const distributionId = requireParam(nextjsParamsUsEast1, SSM_PATHS.cloudfront.distributionId);
    const distResponse = await cloudfront.send(
        new GetDistributionConfigCommand({ Id: distributionId }),
    );
    expect(distResponse.DistributionConfig).toBeDefined();
    distributionConfig = distResponse.DistributionConfig!;
    behaviours = distributionConfig.CacheBehaviors?.Items ?? [];

    // Resolve ECR latest image
    const repoName = requireParam(ecrParams, ECR_PATHS.repositoryName);
    const imagesResponse = await ecr.send(
        new DescribeImagesCommand({
            repositoryName: repoName,
            filter: { tagStatus: 'TAGGED' },
        }),
    );
    const sortedImages = (imagesResponse.imageDetails ?? [])
        .filter((img) => img.imagePushedAt)
        .sort((a, b) => (b.imagePushedAt!.getTime()) - (a.imagePushedAt!.getTime()));
    expect(sortedImages.length).toBeGreaterThan(0);
    latestEcrImage = sortedImages[0];

    // Resolve S3 assets bucket
    assetsBucketName = requireParam(nextjsParams, SSM_PATHS.assetsBucketName);

    // List S3 static asset keys
    const s3Keys: string[] = [];
    let continuationToken: string | undefined;
    do {
        const listResult = await s3.send(
            new ListObjectsV2Command({
                Bucket: assetsBucketName,
                Prefix: S3_STATIC_PREFIX,
                ContinuationToken: continuationToken,
            }),
        );
        for (const obj of listResult.Contents ?? []) {
            if (obj.Key) s3Keys.push(obj.Key);
        }
        continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
    s3StaticKeys = s3Keys;

    // Load current SSM image URI (may not exist in all environments)
    ssmImageUri = await loadSingleParam(ssm, `${NEXTJS_PREFIX}/image-uri`);
}, 60_000);

// =============================================================================
// SUITE 1: CloudFront Behaviour Order
// =============================================================================

describe('CloudFront — Behaviour Ordering', () => {
    it('should have the expected number of additional behaviours', () => {
        expect(behaviours).toHaveLength(EXPECTED_BEHAVIOUR_COUNT);
    });

    it('should have behaviours in the correct path-pattern order', () => {
        const actualPatterns = behaviours.map((b) => b.PathPattern);
        expect(actualPatterns).toStrictEqual(EXPECTED_BEHAVIOUR_ORDER);
    });

    it('should place /api/auth/* before /api/* for correct cookie forwarding', () => {
        const authIndex = behaviours.findIndex(
            (b) => b.PathPattern === CLOUDFRONT_PATH_PATTERNS.authCallback,
        );
        const apiIndex = behaviours.findIndex(
            (b) => b.PathPattern === CLOUDFRONT_PATH_PATTERNS.api,
        );
        expect(authIndex).toBe(AUTH_CALLBACK_INDEX);
        expect(apiIndex).toBe(API_CATCHALL_INDEX);
        expect(authIndex).toBeLessThan(apiIndex);
    });

    it.each(
        EXPECTED_BEHAVIOUR_ORDER.map((pattern, index) => ({ pattern, index })),
    )('should enforce redirect-to-https for "$pattern"', ({ pattern }) => {
        const behaviour = findBehaviourByPattern(behaviours, pattern);
        expect(behaviour).toBeDefined();
        expect(behaviour!.ViewerProtocolPolicy).toBe(EXPECTED_VIEWER_PROTOCOL);
    });

    it('should enforce redirect-to-https on the default behaviour', () => {
        expect(distributionConfig.DefaultCacheBehavior?.ViewerProtocolPolicy).toBe(
            EXPECTED_VIEWER_PROTOCOL,
        );
    });

    it.each(
        Array.from(S3_ORIGIN_PATTERNS).map((pattern) => ({ pattern })),
    )('should enable compression for S3-origin "$pattern"', ({ pattern }) => {
        const behaviour = findBehaviourByPattern(behaviours, pattern);
        expect(behaviour).toBeDefined();
        expect(behaviour!.Compress).toBe(true);
    });
});

// =============================================================================
// SUITE 1b: CloudFront Auth Cookie Forwarding
//
// Post-deployment validation of the three CSRF root causes:
//   1. Auth/admin behaviours must use CookieBehavior: all (not none)
//   2. OriginRequestPolicy cookie names must contain no wildcards
//   3. Auth behaviours must appear before /api/* catch-all
//
// These tests run against the LIVE distribution and will FAIL the CI
// pipeline if any of the three root causes recur.
// =============================================================================

describe('CloudFront — Auth Cookie Forwarding', () => {
    // Depends on: behaviours, distributionConfig populated in top-level beforeAll
    // Cache/OriginRequest policies are loaded per-behaviour in this suite's beforeAll

    /** Map of auth-sensitive pattern → resolved CachePolicyConfig */
    let authCachePolicies: Map<string, CachePolicyConfig>;

    /** Map of auth-sensitive pattern → resolved OriginRequestPolicyConfig */
    let authOriginRequestPolicies: Map<string, OriginRequestPolicyConfig>;

    /** Map of auth-sensitive pattern → wildcard cookies found (pre-computed) */
    let authOriginRequestWildcards: Map<string, string[]>;

    /** CachePolicyConfig for the /api/* catch-all */
    let apiCatchallCachePolicy: CachePolicyConfig | undefined;

    beforeAll(async () => {
        authCachePolicies = new Map();
        authOriginRequestPolicies = new Map();
        authOriginRequestWildcards = new Map();

        // Resolve CachePolicy and OriginRequestPolicy for each auth-sensitive behaviour
        for (const behaviour of behaviours) {
            const pattern = behaviour.PathPattern ?? '';

            if (AUTH_SENSITIVE_PATTERNS.has(pattern)) {
                // Resolve CachePolicy
                const cpId = behaviour.CachePolicyId;
                if (cpId) {
                    const cpResponse = await cloudfront.send(
                        new GetCachePolicyCommand({ Id: cpId }),
                    );
                    const config = cpResponse.CachePolicy?.CachePolicyConfig;
                    if (config) authCachePolicies.set(pattern, config);
                }

                // Resolve OriginRequestPolicy
                const orpId = behaviour.OriginRequestPolicyId;
                if (orpId) {
                    const orpResponse = await cloudfront.send(
                        new GetOriginRequestPolicyCommand({ Id: orpId }),
                    );
                    const config = orpResponse.OriginRequestPolicy?.OriginRequestPolicyConfig;
                    if (config) authOriginRequestPolicies.set(pattern, config);
                }
            }

            // Resolve API catch-all CachePolicy
            if (pattern === CLOUDFRONT_PATH_PATTERNS.api) {
                const cpId = behaviour.CachePolicyId;
                if (cpId) {
                    const cpResponse = await cloudfront.send(
                        new GetCachePolicyCommand({ Id: cpId }),
                    );
                    apiCatchallCachePolicy = cpResponse.CachePolicy?.CachePolicyConfig;
                }
            }
        }

        // Pre-compute wildcard cookies for each auth-sensitive pattern (Rule 11)
        for (const pattern of AUTH_SENSITIVE_PATTERNS) {
            const policy = authOriginRequestPolicies.get(pattern);
            const cookies = policy?.CookiesConfig?.Cookies?.Items ?? [];
            authOriginRequestWildcards.set(pattern, cookies.filter(isWildcardCookie));
        }
    }, 30_000);

    it.each(
        Array.from(AUTH_SENSITIVE_PATTERNS).map((pattern) => ({ pattern })),
    )('should use CookieBehavior "all" for auth-sensitive "$pattern"', ({ pattern }) => {
        const policy = authCachePolicies.get(pattern);
        expect(policy).toBeDefined();
        const cookieBehavior = policy!.ParametersInCacheKeyAndForwardedToOrigin?.CookiesConfig?.CookieBehavior;
        expect(cookieBehavior).toBe(EXPECTED_AUTH_COOKIE_BEHAVIOR);
    });

    it('should use CookieBehavior "none" for the /api/* catch-all', () => {
        expect(apiCatchallCachePolicy).toBeDefined();
        const cookieBehavior = apiCatchallCachePolicy!.ParametersInCacheKeyAndForwardedToOrigin?.CookiesConfig?.CookieBehavior;
        expect(cookieBehavior).toBe(EXPECTED_API_COOKIE_BEHAVIOR);
    });

    it.each(
        Array.from(AUTH_SENSITIVE_PATTERNS).map((pattern) => ({ pattern })),
    )('should have no wildcard cookies in OriginRequestPolicy for "$pattern"', ({ pattern }) => {
        const wildcards = authOriginRequestWildcards.get(pattern);
        expect(wildcards).toBeDefined();
        expect(wildcards!).toHaveLength(0);
    });

    it('should list all auth-sensitive patterns BEFORE the /api/* catch-all', () => {
        const apiIndex = behaviours.findIndex(
            (b) => b.PathPattern === CLOUDFRONT_PATH_PATTERNS.api,
        );
        expect(apiIndex).toBeGreaterThan(-1);

        for (const pattern of AUTH_SENSITIVE_PATTERNS) {
            const authIndex = behaviours.findIndex((b) => b.PathPattern === pattern);
            expect(authIndex).toBeGreaterThan(-1);
            expect(authIndex).toBeLessThan(apiIndex);
        }
    });
});

// =============================================================================
// SUITE 2: Container ↔ ECR Image Linkage
// =============================================================================

describe('Container ↔ ECR — Image Linkage', () => {
    // Depends on: latestEcrImage, ssmImageUri populated in top-level beforeAll
    let ecrShaTags: string[];
    let latestShaTag: string;
    let ssmTag: string;
    let sevenDaysAgo: Date;

    beforeAll(() => {
        ecrShaTags = filterShaTags(latestEcrImage.imageTags ?? []);
        latestShaTag = ecrShaTags[0] ?? '';

        // Extract the tag from the SSM image URI (format: <repo-uri>:<tag>)
        ssmTag = ssmImageUri ? extractTagFromUri(ssmImageUri) : '';

        sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    });

    it('should have a latest ECR image with SHA-format tags', () => {
        expect(ecrShaTags.length).toBeGreaterThan(0);
    });

    it('should have the SSM image URI referencing a valid ECR tag', () => {
        // deploy-frontend.yml sets /nextjs/{env}/image-uri after every push
        // If ssmImageUri is empty, the parameter was not found — expected before first pipeline run
        expect(ssmTag).toBeTruthy();
        expect(ssmTag).toBe(latestShaTag);
    });

    it('should have the latest ECR image pushed within the last 7 days', () => {
        expect(latestEcrImage.imagePushedAt).toBeDefined();
        expect(latestEcrImage.imagePushedAt!.getTime()).toBeGreaterThan(sevenDaysAgo.getTime());
    });
});

// =============================================================================
// SUITE 3: S3 ↔ Container Build Coherence
// =============================================================================

describe('S3 ↔ Container — Build Coherence', () => {
    // Depends on: s3StaticKeys populated in top-level beforeAll
    let s3BuildIds: Set<string>;

    beforeAll(() => {
        s3BuildIds = extractBuildIdsFromKeys(s3StaticKeys);
    });

    it('should have static assets in S3', () => {
        expect(s3StaticKeys.length).toBeGreaterThan(0);
    });

    it('should have at least one build ID directory in S3', () => {
        expect(s3BuildIds.size).toBeGreaterThan(0);
    });
});

/**
 * Conditional suite: only runs when kubectl is available.
 * Uses `describe.skip` to avoid lint warnings for conditionals inside `it()`.
 */
const kubectlSuite = isKubectlAvailable() ? describe : describe.skip;

kubectlSuite('S3 ↔ Container — Pod Build ID Match (kubectl)', () => {
    describe('Pod BUILD_ID vs S3 build hashes', () => {
        let localPodBuildId: string;
        let kubectlS3BuildIds: Set<string>;

        beforeAll(() => {
            const result = getPodBuildId();
            expect(result).toBeDefined();
            localPodBuildId = result!;
            kubectlS3BuildIds = extractBuildIdsFromKeys(s3StaticKeys);
        });

        it('should have the pod build ID present in S3 static assets', () => {
            expect(kubectlS3BuildIds.has(localPodBuildId)).toBe(true);
        });
    });
});
