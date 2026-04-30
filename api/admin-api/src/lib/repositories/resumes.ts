/**
 * @format
 * ResumeRepository — typed pg queries for the resumes table.
 *
 * After migration 004, is_active and label are first-class columns —
 * not keys inside content_json. The partial unique index
 * idx_resumes_one_active_per_user enforces one active resume per user at the
 * database level, so setActiveResume just needs two UPDATE statements.
 */
import type { Queryable } from '../pg.js';

export interface Resume {
    id:               string;
    userId:           string | null;
    jobApplicationId: string | null;
    label:            string;
    isActive:         boolean;
    contentJson:      Record<string, unknown>;
    renderedHtml:     string | null;
    generatedAt?:     Date;
}

function rowToResume(row: Record<string, unknown>): Resume {
    const resume: Resume = {
        id:               row['id']                 as string,
        userId:           row['user_id']            as string | null,
        jobApplicationId: row['job_application_id'] as string | null,
        label:            (row['label']             as string) ?? '',
        isActive:         (row['is_active']         as boolean) ?? false,
        contentJson:      (row['content_json']      as Record<string, unknown>) ?? {},
        renderedHtml:     row['rendered_html']      as string | null,
    };
    if (row['generated_at']) {
        resume.generatedAt = new Date(row['generated_at'] as string);
    }
    return resume;
}

const SELECT_COLS = `
  id, user_id, job_application_id, label, is_active,
  content_json, rendered_html, generated_at
`;

export async function upsertResume(pool: Queryable, resume: Resume): Promise<void> {
    await pool.query(
        `INSERT INTO resumes
             (id, user_id, job_application_id, label, is_active, content_json, rendered_html)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
             user_id           = EXCLUDED.user_id,
             job_application_id = EXCLUDED.job_application_id,
             label             = EXCLUDED.label,
             is_active         = EXCLUDED.is_active,
             content_json      = EXCLUDED.content_json,
             rendered_html     = EXCLUDED.rendered_html`,
        [
            resume.id,
            resume.userId ?? null,
            resume.jobApplicationId ?? null,
            resume.label,
            resume.isActive,
            JSON.stringify(resume.contentJson),
            resume.renderedHtml ?? null,
        ],
    );
}

export async function getResume(pool: Queryable, id: string): Promise<Resume | null> {
    const result = await pool.query(
        `SELECT ${SELECT_COLS} FROM resumes WHERE id = $1`,
        [id],
    );
    if (result.rows.length === 0) return null;
    return rowToResume(result.rows[0] as Record<string, unknown>);
}

export async function listResumes(pool: Queryable): Promise<Resume[]> {
    const result = await pool.query(
        `SELECT ${SELECT_COLS} FROM resumes ORDER BY generated_at DESC`,
    );
    return (result.rows as Record<string, unknown>[]).map(rowToResume);
}

export async function getActiveResume(pool: Queryable): Promise<Resume | null> {
    const result = await pool.query(
        `SELECT ${SELECT_COLS} FROM resumes WHERE is_active = TRUE LIMIT 1`,
    );
    if (result.rows.length === 0) return null;
    return rowToResume(result.rows[0] as Record<string, unknown>);
}

export async function deleteResume(pool: Queryable, id: string): Promise<void> {
    await pool.query(`DELETE FROM resumes WHERE id = $1`, [id]);
}

/**
 * Atomically deactivate the current active resume and activate a new one.
 *
 * The partial unique index (user_id) WHERE is_active = TRUE ensures the DB
 * enforces the one-active-per-user invariant — these two UPDATEs are enough.
 * No round-trip through upsertResume needed.
 */
export async function setActiveResume(
    pool: Queryable,
    userId: string,
    newActiveId: string,
): Promise<void> {
    await pool.query(
        `UPDATE resumes SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE`,
        [userId],
    );
    await pool.query(
        `UPDATE resumes SET is_active = TRUE WHERE id = $1`,
        [newActiveId],
    );
}
