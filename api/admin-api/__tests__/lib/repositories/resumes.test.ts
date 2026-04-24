/**
 * @format
 * Unit tests for ResumeRepository.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockQuery = jest.fn<() => Promise<object>>();

jest.unstable_mockModule('pg', () => {
    class Pool {
        query = mockQuery;
    }
    return { Pool, default: { Pool } };
});

const {
    upsertResume,
    getResume,
    listResumes,
    deleteResume,
    setActiveResume,
} = await import('../../../src/lib/repositories/resumes.js');

describe('ResumeRepository', () => {
    beforeEach(() => { mockQuery.mockReset(); });

    const fakePool = { query: mockQuery } as unknown as import('pg').Pool;

    describe('upsertResume', () => {
        it('should execute INSERT ... ON CONFLICT (id) DO UPDATE', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await upsertResume(fakePool, {
                id: 'resume-uuid-1',
                userId: null,
                jobApplicationId: null,
                label: 'My CV',
                isActive: false,
                contentJson: { name: 'Nelson' },
                renderedHtml: null,
            });
            expect(mockQuery).toHaveBeenCalledTimes(1);
            const [sql] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO resumes/i);
            expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
        });

        it('should merge label and is_active into content_json param', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await upsertResume(fakePool, {
                id: 'resume-uuid-1',
                userId: null,
                jobApplicationId: null,
                label: 'Portfolio CV',
                isActive: true,
                contentJson: { name: 'Nelson' },
                renderedHtml: null,
            });
            const [, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            // params[3] is content_json (4th positional param after id, user_id, job_application_id)
            const contentJsonParam = params[3] as string;
            const parsed = JSON.parse(contentJsonParam) as Record<string, unknown>;
            expect(parsed['label']).toBe('Portfolio CV');
            expect(parsed['is_active']).toBe(true);
            expect(parsed['name']).toBe('Nelson');
        });
    });

    describe('getResume', () => {
        it('should return mapped resume with label and isActive extracted from content_json', async () => {
            mockQuery.mockResolvedValue({
                rows: [{
                    id: 'resume-uuid-1',
                    user_id: null,
                    job_application_id: null,
                    content_json: { label: 'My CV', is_active: true, name: 'Nelson' },
                    rendered_html: null,
                    generated_at: new Date('2026-01-01'),
                }],
            });
            const result = await getResume(fakePool, 'resume-uuid-1');
            expect(result).not.toBeNull();
            expect(result!.label).toBe('My CV');
            expect(result!.isActive).toBe(true);
            expect(result!.contentJson['name']).toBe('Nelson');
        });

        it('should return null when not found', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            expect(await getResume(fakePool, 'missing')).toBeNull();
        });
    });

    describe('listResumes', () => {
        it('should query all resumes ordered by generated_at DESC', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await listResumes(fakePool);
            const [sql] = mockQuery.mock.calls[0] as unknown as [string];
            expect(sql).toMatch(/SELECT/i);
            expect(sql).toMatch(/ORDER BY generated_at DESC/i);
        });
    });

    describe('deleteResume', () => {
        it('should execute DELETE WHERE id = $1', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await deleteResume(fakePool, 'resume-uuid-1');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/DELETE FROM resumes/i);
            expect(params).toContain('resume-uuid-1');
        });
    });

    describe('setActiveResume', () => {
        it('should call upsertResume twice when both old and new IDs exist', async () => {
            // getResume is called twice (once for old, once for new) → 2 SELECT calls
            // upsertResume is called twice → 2 INSERT calls
            // Total: 4 query calls
            mockQuery.mockResolvedValue({
                rows: [{
                    id: 'old-id',
                    user_id: null,
                    job_application_id: null,
                    content_json: { label: 'Old', is_active: true },
                    rendered_html: null,
                    generated_at: new Date(),
                }],
            });
            await setActiveResume(fakePool, 'old-id', 'new-id');
            // getResume(old-id) → SELECT, upsertResume(old deactivate) → INSERT
            // getResume(new-id) → SELECT, upsertResume(new activate) → INSERT
            expect(mockQuery).toHaveBeenCalledTimes(4);
        });

        it('should skip old resume deactivation when oldActiveId is null', async () => {
            mockQuery.mockResolvedValue({
                rows: [{
                    id: 'new-id',
                    user_id: null,
                    job_application_id: null,
                    content_json: { label: 'New', is_active: false },
                    rendered_html: null,
                    generated_at: new Date(),
                }],
            });
            await setActiveResume(fakePool, null, 'new-id');
            // Only getResume(new-id) → SELECT, upsertResume(activate) → INSERT
            expect(mockQuery).toHaveBeenCalledTimes(2);
        });
    });
});
