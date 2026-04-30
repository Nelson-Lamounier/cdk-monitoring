/**
 * @format
 * admin-api — Resume management routes.
 *
 * After migration 004, any AI-generated tailored resume can be promoted to the
 * active portfolio CV. Portfolio CVs are no longer a separate concept — the
 * "active" resume is whichever one is flagged is_active = true. Deleting the
 * associated job application sets job_application_id = NULL (ON DELETE SET NULL)
 * so the resume survives.
 *
 * Routes (all protected by Cognito JWT middleware):
 *
 *   GET    /api/admin/resumes              — List all resumes (tailored + manual)
 *   GET    /api/admin/resumes/active       — Get the currently active resume
 *   GET    /api/admin/resumes/:id          — Get a single resume by ID
 *   POST   /api/admin/resumes              — Create a manual resume (label + data required)
 *   PUT    /api/admin/resumes/:id          — Update label and/or data
 *   DELETE /api/admin/resumes/:id          — Delete (guards against deleting the active one)
 *   POST   /api/admin/resumes/:id/activate — Promote any resume as the active portfolio CV
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AdminApiConfig } from '../lib/config.js';
import { getPool, withUser } from '../lib/pg.js';
import type { AdminApiBindings } from '../lib/types.js';
import {
    upsertResume,
    getResume as pgGetResume,
    listResumes,
    getActiveResume,
    deleteResume as pgDeleteResume,
    setActiveResume,
} from '../lib/repositories/resumes.js';

export function createResumesRouter(config: AdminApiConfig): Hono<AdminApiBindings> {
  const router = new Hono<AdminApiBindings>();

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes — list all resumes (tailored + manual)
  // -------------------------------------------------------------------------
  router.get('/', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    return withUser(getPool(config), userId, async (db) => {
      const resumes = await listResumes(db);
      return ctx.json({ resumes, count: resumes.length });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes/active — active portfolio resume
  // Must be defined BEFORE /:id to take route precedence.
  // -------------------------------------------------------------------------
  router.get('/active', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    return withUser(getPool(config), userId, async (db) => {
      const resume = await getActiveResume(db);
      if (!resume) return ctx.json({ error: 'No active resume configured' }, 404);
      return ctx.json({ resume });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/resumes/:id — fetch one
  // -------------------------------------------------------------------------
  router.get('/:id', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const id = ctx.req.param('id');

    return withUser(getPool(config), userId, async (db) => {
      const resume = await pgGetResume(db, id);
      if (!resume) return ctx.json({ error: `Resume not found: ${id}` }, 404);
      return ctx.json({ resume });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/resumes — create a manual resume
  // -------------------------------------------------------------------------
  router.post('/', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const body = await ctx.req.json<{ label?: string; data?: Record<string, unknown> }>();

    if (!body.label || typeof body.label !== 'string' || body.label.trim().length === 0) {
      return ctx.json({ error: '"label" is required and must be a non-empty string' }, 400);
    }
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return ctx.json({ error: '"data" is required and must be an object' }, 400);
    }

    const resumeId = randomUUID();

    return withUser(getPool(config), userId, async (db) => {
      await upsertResume(db, {
        id:               resumeId,
        userId,
        jobApplicationId: null,
        label:            body.label!.trim(),
        isActive:         false,
        contentJson:      body.data!,
        renderedHtml:     null,
      });
      const created = await pgGetResume(db, resumeId);
      return ctx.json({ resume: created }, 201);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/admin/resumes/:id — update label and/or data
  // -------------------------------------------------------------------------
  router.put('/:id', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const id = ctx.req.param('id');
    const body = await ctx.req.json<{ label?: string; data?: Record<string, unknown> }>();

    if (!body.label && !body.data) {
      return ctx.json({ error: 'At least one of "label" or "data" must be provided' }, 400);
    }

    return withUser(getPool(config), userId, async (db) => {
      const existing = await pgGetResume(db, id);
      if (!existing) return ctx.json({ error: `Resume not found: ${id}` }, 404);

      await upsertResume(db, {
        ...existing,
        label:       body.label?.trim() ?? existing.label,
        contentJson: body.data          ?? existing.contentJson,
      });
      const updated = await pgGetResume(db, id);
      return ctx.json({ resume: updated });
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/admin/resumes/:id — delete (guards active)
  // -------------------------------------------------------------------------
  router.delete('/:id', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const id = ctx.req.param('id');

    return withUser(getPool(config), userId, async (db) => {
      const existing = await pgGetResume(db, id);
      if (!existing) return ctx.json({ error: `Resume not found: ${id}` }, 404);
      if (existing.isActive) {
        return ctx.json(
          { error: 'Cannot delete the active resume. Activate another resume first.' },
          409,
        );
      }
      await pgDeleteResume(db, id);
      return ctx.json({ deleted: true, resumeId: id });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/resumes/:id/activate
  //
  // Promotes any resume — tailored (AI-generated) or manual — as the active
  // portfolio CV. The previous active resume is deactivated atomically.
  // -------------------------------------------------------------------------
  router.post('/:id/activate', async (ctx) => {
    const userId = ctx.get('userId');
    if (!userId) return ctx.json({ error: 'User not provisioned — retry in a moment' }, 503);

    const id = ctx.req.param('id');

    return withUser(getPool(config), userId, async (db) => {
      const target = await pgGetResume(db, id);
      if (!target) return ctx.json({ error: `Resume not found: ${id}` }, 404);

      await setActiveResume(db, userId, id);
      const activated = await pgGetResume(db, id);
      return ctx.json({ resume: activated });
    });
  });

  return router;
}
