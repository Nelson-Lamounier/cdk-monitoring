/**
 * @format
 * admin-api — GitHub App integration routes.
 *
 * All routes require a valid Cognito JWT. User isolation is enforced at two
 * layers: the DB schema (UNIQUE(user_id, provider) / UNIQUE(user_id, provider,
 * full_name) constraints) and every SQL query (user_id = $userId from JWT sub).
 *
 * Routes:
 *   GET    /github/installation              — check if GitHub App is installed
 *   POST   /github/installation              — store installation_id after redirect
 *   DELETE /github/installation              — disconnect + cascade-delete repos
 *   GET    /github/repos                     — list repos accessible via installation
 *   GET    /github/connected-repos           — list repos added to KB + sync status
 *   POST   /github/connected-repos           — add repo + write pending + trigger Job
 *   DELETE /github/connected-repos/:fullName — remove repo + embeddings
 *
 * Token model:
 *   Only installation_id is stored in oauth_connections (TEXT column).
 *   Installation tokens (1-hour, read-only) are generated on the fly from the
 *   App private key for repo listing and ingestion Job dispatch.
 *   No long-lived PAT is ever persisted.
 */

import { Hono } from 'hono';
import type { JWTPayload } from 'jose';
import type { Pool } from 'pg';
import type { AdminApiConfig } from '../lib/config.js';
import { getPool } from '../lib/pg.js';
import { getBatchApi } from '../lib/k8s.js';
import { getJobImage, isImageConfigured } from '../lib/config.js';
import {
    generateInstallationToken,
    getInstallationInfo,
    listInstallationRepos,
} from '../lib/github-app.js';

type AdminApiBindings = { Variables: { jwtPayload: JWTPayload } };

// =============================================================================
// DB HELPERS — all queries are scoped to userId from JWT
// =============================================================================

interface OAuthRow {
    installation_id: string | null;
    username:        string;
    avatar_url:      string | null;
    connected_at:    Date;
}

async function getConnection(pool: Pool, userId: string): Promise<OAuthRow | null> {
    const { rows } = await pool.query<OAuthRow>(
        `SELECT installation_id, username, avatar_url, connected_at
         FROM oauth_connections
         WHERE user_id = $1 AND provider = 'github'`,
        [userId],
    );
    return rows[0] ?? null;
}

async function upsertConnection(
    pool: Pool,
    userId: string,
    installationId: string,
    username: string,
    avatarUrl: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO oauth_connections
           (user_id, provider, provider_user_id, username, access_token_enc, installation_id, avatar_url)
         VALUES ($1, 'github', $2, $3, '', $4, $5)
         ON CONFLICT (user_id, provider)
         DO UPDATE SET
           installation_id = EXCLUDED.installation_id,
           username        = EXCLUDED.username,
           avatar_url      = EXCLUDED.avatar_url,
           connected_at    = NOW()`,
        [userId, installationId, username, installationId, avatarUrl],
    );
}

async function deleteConnection(pool: Pool, userId: string): Promise<void> {
    // Cascade: delete connected repos + their sync state + embeddings.
    // Ordering matters — FK-free tables first, then oauth_connections.
    await pool.query(
        `DELETE FROM document_embeddings
         WHERE user_id = $1
           AND repo_full_name IN (
             SELECT full_name FROM repositories WHERE user_id = $1 AND provider = 'github'
           )`,
        [userId],
    );
    await pool.query(
        `DELETE FROM repo_sync_state
         WHERE user_id = $1
           AND repo_full_name IN (
             SELECT full_name FROM repositories WHERE user_id = $1 AND provider = 'github'
           )`,
        [userId],
    );
    await pool.query(
        `DELETE FROM repositories WHERE user_id = $1 AND provider = 'github'`,
        [userId],
    );
    await pool.query(
        `DELETE FROM oauth_connections WHERE user_id = $1 AND provider = 'github'`,
        [userId],
    );
}

interface ConnectedRepoRow {
    full_name:      string;
    default_branch: string;
    index_status:   string;
    added_at:       Date;
    sync_status:    string | null;
    last_synced_at: Date | null;
    file_count:     number | null;
    chunk_count:    number | null;
    error_message:  string | null;
}

async function listConnectedRepos(pool: Pool, userId: string): Promise<ConnectedRepoRow[]> {
    const { rows } = await pool.query<ConnectedRepoRow>(
        `SELECT r.full_name, r.default_branch, r.index_status, r.added_at,
                s.sync_status, s.last_synced_at, s.file_count, s.chunk_count, s.error_message
         FROM repositories r
         LEFT JOIN repo_sync_state s
           ON s.user_id = r.user_id AND s.repo_full_name = r.full_name
         WHERE r.user_id = $1 AND r.provider = 'github'
         ORDER BY r.added_at DESC`,
        [userId],
    );
    return rows;
}

async function insertRepository(
    pool: Pool,
    userId: string,
    fullName: string,
    defaultBranch: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO repositories (user_id, provider, full_name, default_branch, index_status)
         VALUES ($1, 'github', $2, $3, 'pending')
         ON CONFLICT (user_id, provider, full_name) DO NOTHING`,
        [userId, fullName, defaultBranch],
    );
}

async function markRepoPending(pool: Pool, userId: string, fullName: string): Promise<void> {
    await pool.query(
        `INSERT INTO repo_sync_state (user_id, repo_full_name, sync_status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (user_id, repo_full_name)
         DO UPDATE SET sync_status = 'pending', error_message = NULL`,
        [userId, fullName],
    );
}

async function deleteRepository(pool: Pool, userId: string, fullName: string): Promise<void> {
    await pool.query(
        `DELETE FROM document_embeddings WHERE user_id = $1 AND repo_full_name = $2`,
        [userId, fullName],
    );
    await pool.query(
        `DELETE FROM repo_sync_state WHERE user_id = $1 AND repo_full_name = $2`,
        [userId, fullName],
    );
    await pool.query(
        `DELETE FROM repositories
         WHERE user_id = $1 AND provider = 'github' AND full_name = $2`,
        [userId, fullName],
    );
}

// =============================================================================
// JOB DISPATCH HELPER
// =============================================================================

const MAX_NAME_LEN = 63;
function sanitizeLabel(v: string): string {
    return v.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LEN);
}

async function dispatchIngestionJob(
    config: AdminApiConfig,
    userId: string,
    repoFullName: string,
    githubToken: string,
    forceReindex = false,
): Promise<{ jobName: string }> {
    const { createHash } = await import('node:crypto');
    const image = getJobImage('ingestion');
    if (!isImageConfigured(image)) {
        throw Object.assign(new Error('Ingestion image not yet configured'), { status: 502 });
    }

    const timestamp = Date.now();
    const safeUser  = sanitizeLabel(userId);
    const repoSlug  = sanitizeLabel(repoFullName.replace('/', '-'));
    const suffix    = createHash('sha1').update(`${userId}:${repoFullName}:${timestamp}`).digest('hex').slice(0, 8);
    const slugPart  = sanitizeLabel(`${safeUser}-${repoSlug}`).slice(0, 43);
    const jobName   = `ingestion-${slugPart}-${suffix}`.slice(0, MAX_NAME_LEN);

    const job = {
        apiVersion: 'batch/v1',
        kind:       'Job',
        metadata: {
            name:      jobName,
            namespace: config.ingestionNamespace,
            labels: { app: 'ingestion-worker', userId: safeUser, repoSlug },
        },
        spec: {
            ttlSecondsAfterFinished: 3600,
            backoffLimit:            2,
            activeDeadlineSeconds:   900,
            template: {
                metadata: { labels: { app: 'ingestion-worker', userId: safeUser, repoSlug } },
                spec: {
                    restartPolicy:      'Never',
                    serviceAccountName: config.ingestionServiceAccount,
                    containers: [{
                        name:    'worker',
                        image,
                        command: ['node', 'dist/run-ingestion.js'],
                        // Explicit env vars take precedence over envFrom in K8s.
                        // GITHUB_TOKEN here overrides any static token in ingestion-secrets,
                        // ensuring each Job uses the per-user installation token.
                        env: [
                            { name: 'USER_ID',        value: userId },
                            { name: 'REPO_FULL_NAME', value: repoFullName },
                            { name: 'FORCE_REINDEX',  value: String(forceReindex) },
                            { name: 'GITHUB_TOKEN',   value: githubToken },
                        ],
                        envFrom: [{ secretRef: { name: 'platform-rds-credentials' } }],
                        resources: {
                            requests: { memory: '512Mi', cpu: '250m' },
                            limits:   { memory: '1Gi',   cpu: '500m' },
                        },
                    }],
                },
            },
        },
    };

    await getBatchApi().createNamespacedJob({ namespace: config.ingestionNamespace, body: job });
    return { jobName };
}

// =============================================================================
// ROUTER
// =============================================================================

/** Extract userId from JWT sub or return empty string (caller must guard). */
function extractUserId(payload: JWTPayload | undefined): string {
    return typeof payload?.sub === 'string' ? payload.sub : '';
}

/** Return [appId, privateKey] or throw 503. */
function requireGitHubConfig(config: AdminApiConfig): [string, string] {
    const { githubAppId, githubPrivateKey } = config;
    if (!githubAppId || !githubPrivateKey) {
        throw Object.assign(
            new Error('GitHub App not configured — GITHUB_APP_ID / GITHUB_PRIVATE_KEY missing'),
            { status: 503 },
        );
    }
    return [githubAppId, githubPrivateKey];
}

export function createGitHubRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
    const router = new Hono<AdminApiBindings>();

    // -------------------------------------------------------------------------
    // Error boundary — consistent JSON error shape
    // -------------------------------------------------------------------------
    router.onError((err, ctx) => {
        const status = (err as { status?: number }).status ?? 500;
        console.error(`[github] ${ctx.req.method} ${ctx.req.path}`, err.message);
        return ctx.json({ error: err.message }, status as 400 | 401 | 403 | 404 | 500 | 502 | 503);
    });

    // -------------------------------------------------------------------------
    // GET /installation — check connection status
    // -------------------------------------------------------------------------
    router.get('/installation', async (ctx) => {
        const pool = getPool(config);
        const uid  = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn?.installation_id) return ctx.json({ error: 'Not connected' }, 404);

        // Fetch live repo count using a fresh installation token.
        const [appId, key] = requireGitHubConfig(config);
        const token = await generateInstallationToken(appId, key, conn.installation_id);
        const repos  = await listInstallationRepos(token);

        return ctx.json({
            installation: {
                installationId:     conn.installation_id,
                accountLogin:       conn.username,
                accountAvatarUrl:   conn.avatar_url ?? '',
                repositoryCount:    repos.length,
                connectedAt:        conn.connected_at.toISOString(),
            },
        });
    });

    // -------------------------------------------------------------------------
    // POST /installation — store installation_id from GitHub redirect
    // Body: { installationId: string }
    // -------------------------------------------------------------------------
    router.post('/installation', async (ctx) => {
        const pool = getPool(config);
        const uid  = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const [appId, key] = requireGitHubConfig(config);

        let body: { installationId?: string };
        try { body = await ctx.req.json(); }
        catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

        const installationId = body.installationId?.trim();
        if (!installationId) return ctx.json({ error: '"installationId" is required' }, 400);

        const info = await getInstallationInfo(appId, key, installationId);
        await upsertConnection(pool, uid, installationId, info.accountLogin, info.accountAvatarUrl);

        return ctx.json({ success: true });
    });

    // -------------------------------------------------------------------------
    // DELETE /installation — disconnect GitHub + cascade-delete all repo data
    // -------------------------------------------------------------------------
    router.delete('/installation', async (ctx) => {
        const pool = getPool(config);
        const uid  = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn) return ctx.json({ error: 'Not connected' }, 404);

        await deleteConnection(pool, uid);
        return ctx.json({ success: true });
    });

    // -------------------------------------------------------------------------
    // GET /repos — list repos accessible via the App installation
    // -------------------------------------------------------------------------
    router.get('/repos', async (ctx) => {
        const pool = getPool(config);
        const uid  = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn?.installation_id) return ctx.json({ error: 'GitHub not connected' }, 404);

        const [appId, key] = requireGitHubConfig(config);
        const token = await generateInstallationToken(appId, key, conn.installation_id);
        const raw   = await listInstallationRepos(token);

        const repos = raw.map(r => ({
            id:            r.id,
            fullName:      r.full_name,
            owner:         r.owner.login,
            name:          r.name,
            defaultBranch: r.default_branch,
            private:       r.private,
            updatedAt:     r.updated_at,
        }));

        return ctx.json({ repos });
    });

    // -------------------------------------------------------------------------
    // GET /connected-repos — list repos added to KB with sync status
    // -------------------------------------------------------------------------
    router.get('/connected-repos', async (ctx) => {
        const pool = getPool(config);
        const uid  = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const rows = await listConnectedRepos(pool, uid);

        const repos = rows.map(r => {
            const [owner, name] = r.full_name.split('/');
            return {
                repoFullName:   r.full_name,
                owner:          owner ?? '',
                name:           name  ?? '',
                defaultBranch:  r.default_branch,
                syncStatus:     r.sync_status ?? r.index_status,
                lastSyncedAt:   r.last_synced_at?.toISOString(),
                fileCount:      r.file_count ?? 0,
                chunkCount:     r.chunk_count ?? 0,
                errorMessage:   r.error_message,
                addedAt:        r.added_at.toISOString(),
            };
        });

        return ctx.json({ repos });
    });

    // -------------------------------------------------------------------------
    // POST /connected-repos — add repo to KB + write pending + dispatch Job
    // Body: { repoFullName: string, defaultBranch?: string }
    // -------------------------------------------------------------------------
    router.post('/connected-repos', async (ctx) => {
        const pool = getPool(config);
        const uid  = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const conn = await getConnection(pool, uid);
        if (!conn?.installation_id) return ctx.json({ error: 'GitHub not connected' }, 400);

        let body: { repoFullName?: string; defaultBranch?: string };
        try { body = await ctx.req.json(); }
        catch { return ctx.json({ error: 'Body must be valid JSON' }, 400); }

        const repoFullName = body.repoFullName?.trim();
        if (!repoFullName || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
            return ctx.json({ error: '"repoFullName" must match owner/repo' }, 400);
        }
        const defaultBranch = body.defaultBranch?.trim() || 'main';

        const [appId, key] = requireGitHubConfig(config);

        // Insert repo row + mark pending before Job dispatch so the UI
        // shows "Queued" immediately even if pod startup takes a few seconds.
        await insertRepository(pool, uid, repoFullName, defaultBranch);
        await markRepoPending(pool, uid, repoFullName);

        // Generate a fresh installation token scoped to this user's repos.
        const githubToken = await generateInstallationToken(appId, key, conn.installation_id);
        const { jobName } = await dispatchIngestionJob(config, uid, repoFullName, githubToken);

        return ctx.json({ status: 'queued', repoFullName, jobName }, 202);
    });

    // -------------------------------------------------------------------------
    // DELETE /connected-repos/:fullName — remove repo + all KB data
    // :fullName is URL-encoded "owner%2Frepo"
    // -------------------------------------------------------------------------
    router.delete('/connected-repos/:fullName', async (ctx) => {
        const pool        = getPool(config);
        const uid         = extractUserId(ctx.get('jwtPayload'));
        if (!uid) return ctx.json({ error: 'Authenticated subject missing' }, 401);
        const repoFullName = decodeURIComponent(ctx.req.param('fullName'));

        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
            return ctx.json({ error: 'Invalid repo name' }, 400);
        }

        await deleteRepository(pool, uid, repoFullName);
        return ctx.json({ success: true });
    });

    return router;
}
