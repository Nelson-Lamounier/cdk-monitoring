/**
 * @format
 * UserRepository — typed pg queries for the users table.
 *
 * Provisioning strategy:
 *   - cognito_sub is the stable identity anchor (Cognito's `sub` JWT claim).
 *   - users.id (UUID) is the FK anchor for all child tables — never changes.
 *   - On first sign-in the middleware calls upsertUser; on every subsequent
 *     sign-in it updates email/name/avatar if Cognito returned new values.
 *   - If the user row pre-dated Cognito (email existed, cognito_sub NULL),
 *     the UPDATE in step 1 links the sub before the INSERT runs — preserving
 *     the existing id and all FK children.
 */
import type { Pool } from 'pg';

export interface UserProfile {
  /** Cognito `sub` claim — stable UUID per identity, across all sign-in methods. */
  cognitoSub: string;
  email:      string;
  fullName?:  string;
  avatarUrl?: string;
}

export interface ProvisionedUser {
  /** RDS users.id — use this as user_id in all child-table queries. */
  id: string;
}

/**
 * Idempotent upsert keyed on cognito_sub.
 *
 * Step 1 — links an existing email-only row to the cognito_sub (migration path
 *   for users who existed before Cognito was wired).
 * Step 2 — inserts a new row, or updates profile fields on conflict with sub.
 *
 * Returns the stable users.id UUID for downstream query scoping.
 */
export async function upsertUser(pool: Pool, user: UserProfile): Promise<ProvisionedUser> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: claim any pre-existing email row that has no sub yet
    await client.query(
      `UPDATE users
          SET cognito_sub = $1,
              updated_at  = NOW()
        WHERE email       = $2
          AND cognito_sub IS NULL`,
      [user.cognitoSub, user.email],
    );

    // Step 2: upsert on cognito_sub — handles both new and returning users
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (id, cognito_sub, email, full_name, avatar_url, created_at, updated_at)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (cognito_sub) DO UPDATE
           SET email      = EXCLUDED.email,
               full_name  = COALESCE(EXCLUDED.full_name,  users.full_name),
               avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
               updated_at = NOW()
         RETURNING id`,
      [user.cognitoSub, user.email, user.fullName ?? null, user.avatarUrl ?? null],
    );

    await client.query('COMMIT');
    const row = result.rows[0];
    if (!row) throw new Error('upsertUser returned no row');
    return { id: row.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
