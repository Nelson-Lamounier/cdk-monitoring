/**
 * @format
 * End-to-end tests for admin-api routes/github.ts
 *
 * Coverage:
 *   GET    /installation              — connected / not connected
 *   POST   /installation              — store installation, 400 on missing body
 *   DELETE /installation              — cascade delete + 404 when not connected
 *   GET    /repos                     — list via installation token
 *   GET    /connected-repos           — list with sync status join
 *   POST   /connected-repos           — insert + mark pending + dispatch Job
 *   DELETE /connected-repos/:fullName — delete repo + cascade embeddings
 *
 * Mocks: pg pool, github-app helpers, k8s BatchApi, config image resolver.
 * No real network calls or DB connections are made.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// github-app mock — replace all exported functions
// ---------------------------------------------------------------------------

const mockGenerateInstallationToken = jest.fn<() => Promise<string>>().mockResolvedValue('ghs_test_token');
const mockGetInstallationInfo       = jest.fn<() => Promise<{ accountLogin: string; accountAvatarUrl: string }>>()
    .mockResolvedValue({ accountLogin: 'nelson-lamounier', accountAvatarUrl: 'https://avatars.github.com/u/1' });
const mockListInstallationRepos     = jest.fn<() => Promise<object[]>>().mockResolvedValue([
    { id: 1, full_name: 'Nelson-Lamounier/cdk-monitoring',        owner: { login: 'Nelson-Lamounier' }, name: 'cdk-monitoring',        default_branch: 'develop', private: false, updated_at: '2026-04-29T00:00:00Z' },
    { id: 2, full_name: 'Nelson-Lamounier/kubernetes-bootstrap',   owner: { login: 'Nelson-Lamounier' }, name: 'kubernetes-bootstrap',  default_branch: 'develop', private: false, updated_at: '2026-04-29T00:00:00Z' },
]);

jest.unstable_mockModule('../../src/lib/github-app.js', () => ({
    generateInstallationToken: mockGenerateInstallationToken,
    getInstallationInfo:       mockGetInstallationInfo,
    listInstallationRepos:     mockListInstallationRepos,
}));

// ---------------------------------------------------------------------------
// pg pool mock
// ---------------------------------------------------------------------------

const poolQueryMock = jest.fn() as jest.Mock<() => Promise<{ rows: object[] }>>;
poolQueryMock.mockResolvedValue({ rows: [] });

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
    getPool:    () => ({ query: poolQueryMock }),
    _resetPool: () => {},
}));

// ---------------------------------------------------------------------------
// K8s BatchApi mock
// ---------------------------------------------------------------------------

const createNamespacedJobMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
    getBatchApi:    () => ({ createNamespacedJob: createNamespacedJobMock }),
    _resetBatchApi: () => {},
}));

// ---------------------------------------------------------------------------
// config image resolver mock
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../../src/lib/config.js', () => ({
    loadConfig:           jest.fn(),
    getJobImage:          jest.fn().mockReturnValue('771826808455.dkr.ecr.eu-west-1.amazonaws.com/ingestion:latest'),
    isImageConfigured:    jest.fn().mockReturnValue(true),
    isAssetsBucketConfigured: jest.fn().mockReturnValue(false),
    UNSET_IMAGE_SENTINEL: 'image-uri-not-yet-set',
    _resetJobImageCache:  jest.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { Hono }               = await import('hono');
const { createGitHubRouter } = await import('../../src/routes/github.js');

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig = {
    cognitoUserPoolId:              'eu-west-1_Test',
    cognitoClientId:                'client',
    cognitoIssuerUrl:               'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Test',
    awsRegion:                      'eu-west-1',
    port:                           3002,
    assetsBucketName:               undefined,
    githubAppId:                    '999999',
    githubPrivateKey:               '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----',
    pgHost:                         'pg',
    pgPort:                         5432,
    pgDatabase:                     'tucaken',
    pgUser:                         'postgres',
    pgPassword:                     'secret',
    ingestionNamespace:             'ingestion',
    ingestionServiceAccount:        'ingestion-sa',
    articlePipelineNamespace:       'article-pipeline',
    articlePipelineServiceAccount:  'article-pipeline-sa',
    strategistPipelineNamespace:    'job-strategist',
    strategistPipelineServiceAccount: 'job-strategist-sa',
} as const;

// Stable users.id UUID used across all test assertions.
const TEST_USER_UUID = 'a1b2c3d4-0000-0000-0000-000000000001';

function buildApp() {
    const app = new Hono();
    app.use('*', async (ctx, next) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ctx as any).set('jwtPayload', { sub: 'user-cognito-sub-123' });
        // userProvisionMiddleware sets users.id UUID on every authenticated request.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ctx as any).set('userId', TEST_USER_UUID);
        await next();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.route('/', createGitHubRouter(testConfig as any));
    return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Seed poolQueryMock to return rows for specific SQL patterns. */
function seedQuery(rows: Row[]) {
    poolQueryMock.mockResolvedValueOnce({ rows });
}

/** Connected oauth_connections row */
const connectedRow: Row = {
    installation_id: '12345',
    username:        'nelson-lamounier',
    avatar_url:      'https://avatars.github.com/u/1',
    connected_at:    new Date('2026-04-29T10:00:00Z'),
};

/** Connected repo row (joins repositories + repo_sync_state) */
const connectedRepoRow: Row = {
    full_name:      'Nelson-Lamounier/cdk-monitoring',
    default_branch: 'develop',
    index_status:   'pending',
    added_at:       new Date('2026-04-29T10:00:00Z'),
    sync_status:    'complete',
    last_synced_at: new Date('2026-04-29T11:00:00Z'),
    file_count:     393,
    chunk_count:    1420,
    error_message:  null,
};

beforeEach(() => {
    jest.clearAllMocks();
    poolQueryMock.mockResolvedValue({ rows: [] });
    mockGenerateInstallationToken.mockResolvedValue('ghs_test_token');
    mockGetInstallationInfo.mockResolvedValue({ accountLogin: 'nelson-lamounier', accountAvatarUrl: 'https://avatars.github.com/u/1' });
    mockListInstallationRepos.mockResolvedValue([
        { id: 1, full_name: 'Nelson-Lamounier/cdk-monitoring',       owner: { login: 'Nelson-Lamounier' }, name: 'cdk-monitoring',       default_branch: 'develop', private: false, updated_at: '2026-04-29T00:00:00Z' },
        { id: 2, full_name: 'Nelson-Lamounier/kubernetes-bootstrap',  owner: { login: 'Nelson-Lamounier' }, name: 'kubernetes-bootstrap', default_branch: 'develop', private: false, updated_at: '2026-04-29T00:00:00Z' },
    ]);
    createNamespacedJobMock.mockResolvedValue({});
});

// ===========================================================================
// GET /installation
// ===========================================================================

describe('GET /installation', () => {
    it('returns 404 when user has no GitHub connection', async () => {
        seedQuery([]);   // getConnection → empty

        const res  = await buildApp().request('/installation');
        const body = await res.json() as { error: string };

        expect(res.status).toBe(404);
        expect(body.error).toMatch(/Not connected/);
        expect(mockGenerateInstallationToken).not.toHaveBeenCalled();
    });

    it('returns installation details with live repo count', async () => {
        seedQuery([connectedRow]);   // getConnection

        const res  = await buildApp().request('/installation');
        const body = await res.json() as { installation: Record<string, unknown> };

        expect(res.status).toBe(200);
        expect(mockGenerateInstallationToken).toHaveBeenCalledWith(
            testConfig.githubAppId,
            testConfig.githubPrivateKey,
            '12345',
        );
        expect(mockListInstallationRepos).toHaveBeenCalledWith('ghs_test_token');
        expect(body.installation.installationId).toBe('12345');
        expect(body.installation.accountLogin).toBe('nelson-lamounier');
        expect(body.installation.repositoryCount).toBe(2);
    });
});

// ===========================================================================
// POST /installation
// ===========================================================================

describe('POST /installation', () => {
    it('returns 400 when body is missing installationId', async () => {
        const res  = await buildApp().request('/installation', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/installationId/);
        expect(mockGetInstallationInfo).not.toHaveBeenCalled();
    });

    it('fetches account info and upserts connection (fresh install — no auto-dispatch)', async () => {
        // Fresh install: getConnection → null, then upsertConnection.
        // No auto-dispatch on fresh install (user picks repos via UI picker).
        const res = await buildApp().request('/installation', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ installationId: '12345' }),
        });

        expect(res.status).toBe(200);
        expect(mockGetInstallationInfo).toHaveBeenCalledWith(
            testConfig.githubAppId,
            testConfig.githubPrivateKey,
            '12345',
        );
        // getConnection (1) + upsertConnection (1)
        expect(poolQueryMock).toHaveBeenCalledTimes(2);
        const body = await res.json() as { success: boolean; queued: string[] };
        expect(body.success).toBe(true);
        expect(body.queued).toEqual([]);
        // No jobs dispatched on fresh install
        expect(createNamespacedJobMock).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// DELETE /installation
// ===========================================================================

describe('DELETE /installation', () => {
    it('returns 404 when user is not connected', async () => {
        seedQuery([]);   // getConnection → empty

        const res = await buildApp().request('/installation', { method: 'DELETE' });
        expect(res.status).toBe(404);
        expect(poolQueryMock).toHaveBeenCalledTimes(1);
    });

    it('cascade-deletes embeddings → sync_state → repos → oauth in order', async () => {
        seedQuery([connectedRow]);   // getConnection

        const res  = await buildApp().request('/installation', { method: 'DELETE' });
        const body = await res.json() as { success: boolean };

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);

        // 1 (getConnection) + 4 (cascade deletes)
        expect(poolQueryMock).toHaveBeenCalledTimes(5);

        const calls = poolQueryMock.mock.calls.map(c => (c[0] as string).trim());
        expect(calls[1]).toMatch(/DELETE FROM document_embeddings/);
        expect(calls[2]).toMatch(/DELETE FROM repo_sync_state/);
        expect(calls[3]).toMatch(/DELETE FROM repositories/);
        expect(calls[4]).toMatch(/DELETE FROM oauth_connections/);

        // All deletes must be scoped to the authenticated user
        calls.slice(1).forEach(sql => {
            expect((sql as string)).toMatch(/user_id/);
        });
    });
});

// ===========================================================================
// GET /repos
// ===========================================================================

describe('GET /repos', () => {
    it('returns 404 when not connected', async () => {
        seedQuery([]);
        const res = await buildApp().request('/repos');
        expect(res.status).toBe(404);
    });

    it('generates installation token and returns accessible repos', async () => {
        seedQuery([connectedRow]);

        const res  = await buildApp().request('/repos');
        const body = await res.json() as { repos: object[] };

        expect(res.status).toBe(200);
        expect(mockGenerateInstallationToken).toHaveBeenCalledWith('999999', testConfig.githubPrivateKey, '12345');
        expect(body.repos).toHaveLength(2);
        expect((body.repos[0] as Record<string, unknown>)['fullName']).toBe('Nelson-Lamounier/cdk-monitoring');
        expect((body.repos[0] as Record<string, unknown>)['defaultBranch']).toBe('develop');
    });
});

// ===========================================================================
// GET /connected-repos
// ===========================================================================

describe('GET /connected-repos', () => {
    it('returns empty list when no repos connected', async () => {
        seedQuery([]);
        const res  = await buildApp().request('/connected-repos');
        const body = await res.json() as { repos: object[] };
        expect(res.status).toBe(200);
        expect(body.repos).toHaveLength(0);
    });

    it('returns repos with sync status from join', async () => {
        seedQuery([connectedRepoRow]);

        const res  = await buildApp().request('/connected-repos');
        const body = await res.json() as { repos: Array<Record<string, unknown>> };

        expect(res.status).toBe(200);
        expect(body.repos).toHaveLength(1);
        const repo = body.repos[0]!;
        expect(repo['repoFullName']).toBe('Nelson-Lamounier/cdk-monitoring');
        expect(repo['syncStatus']).toBe('complete');
        expect(repo['fileCount']).toBe(393);
        expect(repo['chunkCount']).toBe(1420);
        expect(repo['defaultBranch']).toBe('develop');
    });
});

// ===========================================================================
// POST /connected-repos
// ===========================================================================

describe('POST /connected-repos', () => {
    it('returns 400 when GitHub is not connected', async () => {
        seedQuery([]);   // getConnection → empty

        const res = await buildApp().request('/connected-repos', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ repoFullName: 'Nelson-Lamounier/cdk-monitoring' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/not connected/i);
    });

    it('returns 400 for invalid repoFullName format', async () => {
        seedQuery([connectedRow]);

        const res = await buildApp().request('/connected-repos', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ repoFullName: 'not-valid' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/owner\/repo/);
    });

    it('inserts repo, marks pending, generates token, dispatches Job', async () => {
        seedQuery([connectedRow]);       // 1. getConnection
        seedQuery([]);                   // 2. plan SELECT (empty rows → defaults to 'free')
        seedQuery([{ count: 1 }]);       // 3. quota INSERT…RETURNING: count=1 → allowed
        // 4. insertRepository, 5. markRepoPending, 6. markSyncTriggered → default { rows: [] }

        const res  = await buildApp().request('/connected-repos', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ repoFullName: 'Nelson-Lamounier/cdk-monitoring', defaultBranch: 'develop' }),
        });
        const body = await res.json() as { status: string; repoFullName: string; jobName: string };

        expect(res.status).toBe(202);
        expect(body.status).toBe('queued');
        expect(body.repoFullName).toBe('Nelson-Lamounier/cdk-monitoring');
        expect(body.jobName).toMatch(/^ingestion-/);
        expect(body.jobName.length).toBeLessThanOrEqual(63);

        // getConnection (1) + plan SELECT (1) + quota INSERT…RETURNING (1, atomic)
        // + insertRepository (1) + markRepoPending (1) + markSyncTriggered (1)
        expect(poolQueryMock).toHaveBeenCalledTimes(6);

        // Installation token generated for this user's installation
        expect(mockGenerateInstallationToken).toHaveBeenCalledWith('999999', testConfig.githubPrivateKey, '12345');

        // K8s Job created
        expect(createNamespacedJobMock).toHaveBeenCalledTimes(1);

        // Job spec must inject per-user GITHUB_TOKEN (not rely on ingestion-secrets static token)
        const jobArg = (createNamespacedJobMock.mock.calls[0] as unknown as [{ body: { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } } }])[0];
        const envMap = Object.fromEntries(
            jobArg.body.spec.template.spec.containers[0]!.env.map(e => [e.name, e.value]),
        );
        expect(envMap['GITHUB_TOKEN']).toBe('ghs_test_token');
        // USER_ID is now the resolved users.id UUID (set by userProvisionMiddleware),
        // not the Cognito sub. All DB FK constraints use users.id.
        expect(envMap['USER_ID']).toBe(TEST_USER_UUID);
        expect(envMap['REPO_FULL_NAME']).toBe('Nelson-Lamounier/cdk-monitoring');
    });
});

// ===========================================================================
// DELETE /connected-repos/:fullName
// ===========================================================================

describe('DELETE /connected-repos/:fullName', () => {
    it('cascade-deletes embeddings, sync_state, and repo row', async () => {
        const res = await buildApp().request(
            `/connected-repos/${encodeURIComponent('Nelson-Lamounier/cdk-monitoring')}`,
            { method: 'DELETE' },
        );
        const body = await res.json() as { success: boolean };

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);

        // 3 deletes: document_embeddings, repo_sync_state, repositories
        expect(poolQueryMock).toHaveBeenCalledTimes(3);
        const calls = poolQueryMock.mock.calls.map(c => (c[0] as string).trim());
        expect(calls[0]).toMatch(/DELETE FROM document_embeddings/);
        expect(calls[1]).toMatch(/DELETE FROM repo_sync_state/);
        expect(calls[2]).toMatch(/DELETE FROM repositories/);

        // All deletes scoped to authenticated user
        calls.forEach(sql => expect(sql).toMatch(/user_id/));
    });

    it('returns 400 for an invalid encoded repo name', async () => {
        const res = await buildApp().request('/connected-repos/not-valid', { method: 'DELETE' });
        expect(res.status).toBe(400);
    });
});
