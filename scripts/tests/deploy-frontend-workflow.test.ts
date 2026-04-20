/**
 * @format
 * Workflow Validation Tests — deploy-frontend.yml
 *
 * Parses the deploy-frontend.yml GitHub Actions workflow and validates
 * that job dependencies are correctly configured to prevent race conditions
 * between S3 sync and Kubernetes deployment.
 *
 * The workflow uses a dual-app (site + admin) model where each app has its
 * own build → push → deploy chain. The site path also includes an S3 asset
 * sync that must complete after the image is pushed.
 *
 * These are structural YAML validation tests — they do NOT execute the workflow.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

// ============================================================================
// Constants
// ============================================================================

const WORKFLOW_PATH = join(__dirname, '..', '..', '.github', 'workflows', 'deploy-frontend.yml')

/** Jobs that must exist in the workflow */
const REQUIRED_JOBS = [
    'build-site',
    'push-site',
    'sync-assets',
    'deploy-site',
    'build-admin',
    'push-admin',
    'deploy-admin',
    'summary',
] as const

/** Site pipeline: build → push → (sync-assets | deploy-site in parallel) */
const SITE_BUILD_JOB = 'build-site'
const SITE_PUSH_JOB = 'push-site'
const SYNC_JOB = 'sync-assets'
const SITE_DEPLOY_JOB = 'deploy-site'

/** Admin pipeline: build → push → deploy */
const ADMIN_BUILD_JOB = 'build-admin'
const ADMIN_PUSH_JOB = 'push-admin'
const ADMIN_DEPLOY_JOB = 'deploy-admin'

// ============================================================================
// Types
// ============================================================================

interface WorkflowJob {
    name: string
    needs?: string[] | string
    uses?: string
    'runs-on'?: string
    environment?: string
    if?: string
    steps?: unknown[]
}

interface Workflow {
    name: string
    on: Record<string, unknown>
    jobs: Record<string, WorkflowJob>
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalise the `needs` field to a string array.
 * GitHub Actions allows `needs` as a single string or an array.
 *
 * @param needs - The raw `needs` value from the workflow YAML
 * @returns A normalised string array of job dependencies
 */
function normaliseNeeds(needs: string[] | string | undefined): string[] {
    if (!needs) return []
    return Array.isArray(needs) ? needs : [needs]
}

// ============================================================================
// Tests
// ============================================================================

describe('deploy-frontend.yml — Workflow Structure', () => {
    let workflow: Workflow

    beforeAll(() => {
        const raw = readFileSync(WORKFLOW_PATH, 'utf-8')
        workflow = load(raw) as Workflow
    })

    // ==========================================================================
    // Job Existence
    // ==========================================================================
    describe('Required jobs', () => {
        it.each(REQUIRED_JOBS.map((job) => ({ job })))(
            'should contain the "$job" job',
            ({ job }) => {
                expect(workflow.jobs).toHaveProperty(job)
            },
        )
    })

    // ==========================================================================
    // Site Pipeline — Race Condition Prevention
    // ==========================================================================
    describe('Site pipeline dependency ordering', () => {
        it('push-site should depend on build-site', () => {
            const needs = normaliseNeeds(workflow.jobs[SITE_PUSH_JOB].needs)
            expect(needs).toContain(SITE_BUILD_JOB)
        })

        it('sync-assets should depend on push-site (image built before assets sync)', () => {
            const needs = normaliseNeeds(workflow.jobs[SYNC_JOB].needs)
            expect(needs).toContain(SITE_PUSH_JOB)
        })

        it('deploy-site should depend on push-site', () => {
            const needs = normaliseNeeds(workflow.jobs[SITE_DEPLOY_JOB].needs)
            expect(needs).toContain(SITE_PUSH_JOB)
        })
    })

    // ==========================================================================
    // Admin Pipeline
    // ==========================================================================
    describe('Admin pipeline dependency ordering', () => {
        it('push-admin should depend on build-admin', () => {
            const needs = normaliseNeeds(workflow.jobs[ADMIN_PUSH_JOB].needs)
            expect(needs).toContain(ADMIN_BUILD_JOB)
        })

        it('deploy-admin should depend on push-admin', () => {
            const needs = normaliseNeeds(workflow.jobs[ADMIN_DEPLOY_JOB].needs)
            expect(needs).toContain(ADMIN_PUSH_JOB)
        })
    })

    // ==========================================================================
    // Summary
    // ==========================================================================
    describe('Summary job', () => {
        it('summary should depend on all pipeline terminal jobs', () => {
            const summaryNeeds = normaliseNeeds(workflow.jobs.summary.needs)
            expect(summaryNeeds).toContain(SYNC_JOB)
            expect(summaryNeeds).toContain(SITE_DEPLOY_JOB)
            expect(summaryNeeds).toContain(ADMIN_DEPLOY_JOB)
        })
    })

    // ==========================================================================
    // Sync-Assets Job Configuration
    // ==========================================================================
    describe('sync-assets job', () => {
        it('should use the _sync-assets.yml reusable workflow', () => {
            const syncJob = workflow.jobs[SYNC_JOB]
            expect(syncJob.uses).toContain('_sync-assets.yml')
        })
    })

    // ==========================================================================
    // Workflow Metadata
    // ==========================================================================
    describe('Workflow metadata', () => {
        it('should have a descriptive name', () => {
            expect(workflow.name).toBeTruthy()
        })

        it('should support workflow_dispatch for manual triggers', () => {
            expect(workflow.on).toHaveProperty('workflow_dispatch')
        })

        it('should support repository_dispatch for cross-repo triggers', () => {
            expect(workflow.on).toHaveProperty('repository_dispatch')
        })
    })
})
