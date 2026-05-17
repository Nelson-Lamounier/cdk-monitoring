/**
 * @format
 * GitHub App authentication helpers.
 *
 * Generates short-lived installation tokens used by the ingestion K8s Job.
 * The App's private key never leaves this process — only the derived token
 * (valid 1 hour) is injected into the Job spec as GITHUB_TOKEN.
 *
 * JWT flow (RFC 7519 + GitHub App spec):
 *   1. Sign a 10-minute JWT with the App private key (RS256)
 *   2. POST /app/installations/{id}/access_tokens with the JWT as Bearer
 *   3. Use the returned token as GITHUB_TOKEN for API or ingestion calls
 *
 * All GitHub API calls use the same raw HTTPS helper as GitHubAdapter to keep
 * the network layer consistent.
 */

import { createPrivateKey } from 'node:crypto';
import https from 'node:https';

import { SignJWT, importPKCS8 } from 'jose';

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface GitHubInstallationResponse {
    id:          number;
    account:     { id: number; login: string; avatar_url: string };
    app_slug:    string;
    target_type: string;
}

interface GitHubAccessTokenResponse {
    token:      string;
    expires_at: string;
}

interface GitHubRepoListResponse {
    total_count:  number;
    repositories: GitHubRawRepo[];
}

export interface GitHubRawRepo {
    id:             number;
    full_name:      string;
    owner:          { login: string };
    name:           string;
    default_branch: string;
    private:        boolean;
    updated_at:     string;
}

// =============================================================================
// JWT GENERATION
// =============================================================================

/**
 * Generate a GitHub App JWT valid for up to 10 minutes.
 * Issued 60 seconds in the past to absorb clock skew between this server
 * and GitHub's auth endpoint.
 */
export async function generateAppJwt(appId: string, privateKeyPem: string): Promise<string> {
    // GitHub App keys are PKCS#1; jose requires PKCS#8 — normalise via Node crypto
    const pkcs8Pem = createPrivateKey(privateKeyPem)
        .export({ type: 'pkcs8', format: 'pem' }) as string;
    const privateKey = await importPKCS8(pkcs8Pem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(appId)
        .setIssuedAt(now - 60)
        .setExpirationTime(now + 600)
        .sign(privateKey);
}

// =============================================================================
// INSTALLATION TOKEN
// =============================================================================

/**
 * Exchange a GitHub App JWT for a short-lived installation access token.
 * The token is scoped to repos the App is installed on for this installation.
 * Lifespan: 1 hour. Never stored — generated per Job dispatch.
 */
export async function generateInstallationToken(
    appId: string,
    privateKeyPem: string,
    installationId: string,
): Promise<string> {
    const jwt  = await generateAppJwt(appId, privateKeyPem);
    const data = await githubRequest<GitHubAccessTokenResponse>(
        'POST',
        `/app/installations/${installationId}/access_tokens`,
        jwt,
    );
    return data.token;
}

// =============================================================================
// INSTALLATION INFO
// =============================================================================

/**
 * Fetch installation metadata (account login, avatar) using the App JWT.
 * Called when a user first connects their GitHub account.
 */
export async function getInstallationInfo(
    appId: string,
    privateKeyPem: string,
    installationId: string,
): Promise<{ accountId: string; accountLogin: string; accountAvatarUrl: string }> {
    const jwt  = await generateAppJwt(appId, privateKeyPem);
    const data = await githubRequest<GitHubInstallationResponse>(
        'GET',
        `/app/installations/${installationId}`,
        jwt,
    );
    return {
        accountId:         String(data.account.id),
        accountLogin:      data.account.login,
        accountAvatarUrl:  data.account.avatar_url,
    };
}

// =============================================================================
// REPO LISTING
// =============================================================================

/**
 * List all repositories accessible to an installation.
 * Uses the installation token (not the App JWT) — called after
 * generateInstallationToken().
 *
 * GitHub caps the response at 100 repos per page. For portfolio scale
 * (< 50 repos) a single page is always sufficient.
 */
export async function listInstallationRepos(installationToken: string): Promise<GitHubRawRepo[]> {
    const data = await githubRequest<GitHubRepoListResponse>(
        'GET',
        '/installation/repositories?per_page=100',
        installationToken,
    );
    return data.repositories;
}

// =============================================================================
// HTTPS HELPER — consistent with GitHubAdapter
// =============================================================================

function githubRequest<T>(method: string, path: string, token: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'api.github.com',
                path,
                method,
                headers: {
                    Authorization:          `Bearer ${token}`,
                    'User-Agent':           'portfolio-admin-api/1.0',
                    Accept:                 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    if (!res.statusCode || res.statusCode >= 400) {
                        reject(new Error(`GitHub API ${method} ${path} → ${res.statusCode}: ${body}`));
                        return;
                    }
                    try { resolve(JSON.parse(body) as T); }
                    catch { reject(new Error(`GitHub API ${path}: invalid JSON`)); }
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}
