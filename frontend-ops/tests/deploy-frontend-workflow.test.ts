/**
 * @format
 * Workflow Validation Tests — deploy-frontend.yml
 *
 * Parses the deploy-frontend.yml GitHub Actions workflow and validates
 * that job dependencies are correctly configured to prevent race conditions
 * between S3 sync and Kubernetes deployment.
 *
 * These are structural YAML validation tests — they do NOT execute the workflow.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { load } from 'js-yaml'

// ============================================================================
// Constants
// ============================================================================

const WORKFLOW_PATH = join(__dirname, '..', '..', '.github', 'workflows', 'deploy-frontend.yml')

/** Jobs that must exist in the workflow */
const REQUIRED_JOBS = ['build-and-push', 'sync-assets', 'deploy-to-cluster', 'summary'] as const

/** Build-and-push is the root dependency for all other jobs */
const ROOT_JOB = 'build-and-push'

/** sync-assets must complete before deploy-to-cluster starts */
const SYNC_JOB = 'sync-assets'
const DEPLOY_JOB = 'deploy-to-cluster'

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
  // Job Dependencies — Race Condition Prevention
  // ==========================================================================
  describe('Job dependency ordering', () => {
    it('deploy-to-cluster should depend on sync-assets (no race condition)', () => {
      const deployNeeds = normaliseNeeds(workflow.jobs[DEPLOY_JOB].needs)
      expect(deployNeeds).toContain(SYNC_JOB)
    })

    it('deploy-to-cluster should also depend on build-and-push', () => {
      const deployNeeds = normaliseNeeds(workflow.jobs[DEPLOY_JOB].needs)
      expect(deployNeeds).toContain(ROOT_JOB)
    })

    it('sync-assets should depend on build-and-push', () => {
      const syncNeeds = normaliseNeeds(workflow.jobs[SYNC_JOB].needs)
      expect(syncNeeds).toContain(ROOT_JOB)
    })

    it('summary should depend on sync-assets, deploy-to-cluster, and build-and-push', () => {
      const summaryNeeds = normaliseNeeds(workflow.jobs.summary.needs)
      expect(summaryNeeds).toContain(ROOT_JOB)
      expect(summaryNeeds).toContain(SYNC_JOB)
      expect(summaryNeeds).toContain(DEPLOY_JOB)
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
