/**
 * @format
 * Unit tests for ApplicationRepository.
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
    upsertApplication,
    getApplication,
    listApplications,
    updateApplicationStatus,
    deleteApplication,
} = await import('../../../src/lib/repositories/applications.js');

describe('ApplicationRepository', () => {
    beforeEach(() => { mockQuery.mockReset(); });

    const fakePool = { query: mockQuery } as unknown as import('pg').Pool;

    describe('upsertApplication', () => {
        it('should execute INSERT ... ON CONFLICT (id) DO UPDATE', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await upsertApplication(fakePool, {
                id: 'app-uuid-1',
                userId: null,
                company: 'Acme',
                role: 'Engineer',
                jobUrl: null,
                jobDescription: 'Build stuff',
                kanbanStatus: 'saved',
                appliedAt: null,
            });
            expect(mockQuery).toHaveBeenCalledTimes(1);
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO job_applications/i);
            expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
            expect(params).toContain('app-uuid-1');
            expect(sql).not.toMatch(/job_description_tsv/i);
        });
    });

    describe('getApplication', () => {
        it('should return mapped application when found', async () => {
            mockQuery.mockResolvedValue({
                rows: [{
                    id: 'app-uuid-1',
                    user_id: null,
                    company: 'Acme',
                    role: 'Engineer',
                    job_url: null,
                    job_description: 'Build stuff',
                    kanban_status: 'saved',
                    applied_at: null,
                    created_at: new Date('2026-01-01'),
                    updated_at: new Date('2026-01-01'),
                }],
            });
            const result = await getApplication(fakePool, 'app-uuid-1');
            expect(result).not.toBeNull();
            expect(result!.id).toBe('app-uuid-1');
            expect(result!.jobDescription).toBe('Build stuff');
            expect(result!.kanbanStatus).toBe('saved');
        });

        it('should return null when not found', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            const result = await getApplication(fakePool, 'missing');
            expect(result).toBeNull();
        });
    });

    describe('listApplications', () => {
        it('should list all applications ordered by created_at DESC when no status filter', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await listApplications(fakePool);
            const [sql] = mockQuery.mock.calls[0] as unknown as [string];
            expect(sql).toMatch(/SELECT/i);
            expect(sql).toMatch(/ORDER BY created_at DESC/i);
            expect(sql).not.toMatch(/WHERE kanban_status/i);
        });

        it('should filter by kanban_status when provided', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await listApplications(fakePool, 'saved');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/WHERE kanban_status = \$1/i);
            expect(params).toContain('saved');
        });
    });

    describe('updateApplicationStatus', () => {
        it('should UPDATE kanban_status and updated_at', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await updateApplicationStatus(fakePool, 'app-uuid-1', 'applied');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/UPDATE job_applications/i);
            expect(sql).toMatch(/kanban_status/i);
            expect(params).toContain('applied');
            expect(params).toContain('app-uuid-1');
        });
    });

    describe('deleteApplication', () => {
        it('should execute DELETE WHERE id = $1', async () => {
            mockQuery.mockResolvedValue({ rows: [] });
            await deleteApplication(fakePool, 'app-uuid-1');
            const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
            expect(sql).toMatch(/DELETE FROM job_applications/i);
            expect(params).toContain('app-uuid-1');
        });
    });
});
