# Resume Import Failure Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate silent stuck imports by adding a K8s Job watcher that writes failure status to the DB in real-time, and give users a one-click retry that reuses the already-uploaded S3 file.

**Architecture:** A new `platform-job-watcher` Deployment (TypeScript, `platform` namespace) runs two concurrent loops — a K8s Watch API stream for real-time Job failure detection, and a 5-minute reconciliation sweep for missed events. The admin-api gains a `POST /:id/retry` endpoint that resets the import record and re-dispatches the Job. The frontend error phase gains a context-aware Retry button.

**Tech Stack:** TypeScript, `@kubernetes/client-node`, `pg`, `js-yaml`, Hono, TanStack Start, Jest, Helm, ArgoCD Image Updater.

**Spec:** `docs/superpowers/specs/2026-05-03-resume-import-observability-design.md`

---

## File Map

```
ai-applications/
  applications/platform-job-watcher/
    src/
      config.ts           NEW — parse env vars, load ConfigMap YAML
      db.ts               NEW — pg Pool singleton
      watcher.ts          NEW — K8s Watch stream loop
      reconciler.ts       NEW — staleness sweep loop
      run-watcher.ts      NEW — entrypoint; starts both loops
    __tests__/
      config.test.ts      NEW
      reconciler.test.ts  NEW
      watcher.test.ts     NEW
    Dockerfile            NEW
    package.json          NEW
    tsconfig.json         NEW
  .github/workflows/
    deploy-platform-job-watcher.yml   NEW

cdk-monitoring/
  infra/lib/shared/vpc-stack.ts       MODIFY — add ECR repo for watcher
  api/admin-api/src/routes/resume-imports.ts   MODIFY — import-id label + retry endpoint
  api/admin-api/src/lib/repositories/career-history.ts   MODIFY — resetImportForRetry fn
  api/admin-api/__tests__/routes/resume-imports.test.ts  NEW

tucaken-app/
  src/server/resume-imports.ts        MODIFY — add retryImportFn
  src/features/onboarding/components/steps/ImportCareerStep.tsx  MODIFY — retry button

kubernetes-bootstrap/
  charts/platform-job-watcher/
    chart/
      Chart.yaml          NEW
      values.yaml         NEW
      templates/
        deployment.yaml         NEW
        serviceaccount.yaml     NEW
        clusterrole.yaml        NEW
        clusterrolebinding.yaml NEW
        configmap.yaml          NEW
  argocd-apps/
    platform-job-watcher.yaml  NEW
```

---

## Task 1: Add `import-id` label to buildJobSpec

**Repo:** `cdk-monitoring`
**Files:** Modify `api/admin-api/src/routes/resume-imports.ts:86-95`

This label lets the watcher map a failed K8s Job back to its DB record without reading pod env vars.

- [ ] **Step 1: Open resume-imports.ts and locate the metadata block in buildJobSpec (~line 83)**

- [ ] **Step 2: Add `import-id` to metadata.labels and template.metadata.labels**

```typescript
// In buildJobSpec — metadata block (around line 83):
metadata: {
  name:      jobName,
  namespace: cfg.resumeImportNamespace,
  labels: {
    app:          'resume-import-processor',
    userId:       safeUserId,
    'import-id':  importId,          // ← ADD THIS LINE
  },
},
// ...
// In template.metadata.labels (around line 95):
metadata: { labels: {
  app:         'resume-import-processor',
  userId:      safeUserId,
  'import-id': importId,             // ← ADD THIS LINE
} },
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/api/admin-api
yarn typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add api/admin-api/src/routes/resume-imports.ts
git commit -m "fix(resume-imports): add import-id label to K8s Job spec for watcher mapping"
```

---

## Task 2: Add `resetImportForRetry` to career-history repository

**Repo:** `cdk-monitoring`
**Files:** Modify `api/admin-api/src/lib/repositories/career-history.ts`

- [ ] **Step 1: Find the end of the resume_imports section in career-history.ts (after `getResumeImport` and `listResumeImports` functions)**

- [ ] **Step 2: Add the resetImportForRetry function**

```typescript
/**
 * Resets a failed resume_import for retry. Clears error fields,
 * increments retry_count, transitions status back to 'queued'.
 * Returns the updated record, or null if the import is not found,
 * not owned by the user, or not in 'failed' status.
 */
export async function resetImportForRetry(
  pool: Pool,
  importId: string,
  userId: string,
): Promise<ResumeImportRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE resume_imports
        SET status        = 'queued',
            error_code    = NULL,
            error_details = NULL,
            started_at    = NOW(),
            completed_at  = NULL,
            retry_count   = retry_count + 1,
            updated_at    = NOW()
      WHERE id = $1::uuid
        AND user_id = $2::uuid
        AND status = 'failed'
  RETURNING ${IMPORT_COLS}`,
    [importId, userId],
  );
  if (result.rows.length === 0) return null;
  return mapImportRow(result.rows[0]);
}
```

> Note: `IMPORT_COLS` and `mapImportRow` are already defined earlier in the file. Check their names match — if the row mapper is named differently (e.g. `toImportRecord`), use that name.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/api/admin-api
yarn typecheck
```

- [ ] **Step 4: Commit**

```bash
git add api/admin-api/src/lib/repositories/career-history.ts
git commit -m "feat(resume-imports): add resetImportForRetry repository function"
```

---

## Task 3: Write failing tests for the retry endpoint

**Repo:** `cdk-monitoring`
**Files:** Create `api/admin-api/__tests__/routes/resume-imports.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
/**
 * @format
 * Tests for POST /api/admin/resume-imports/:id/retry
 *
 * Mocks k8s.js, pg.js, and career-history repository so the route
 * is exercised without real infrastructure.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const createNamespacedJobMock = jest.fn<() => Promise<object>>().mockResolvedValue({});

jest.unstable_mockModule('../../src/lib/k8s.js', () => ({
  getBatchApi:    () => ({ createNamespacedJob: createNamespacedJobMock }),
  _resetBatchApi: () => {},
}));

jest.unstable_mockModule('../../src/lib/pg.js', () => ({
  getPool:    () => ({}),
  _resetPool: () => {},
}));

const resetImportForRetryMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getJobImageMock         = jest.fn<() => string>();
const isImageConfiguredMock   = jest.fn<(s: string) => boolean>().mockReturnValue(true);

jest.unstable_mockModule('../../src/lib/repositories/career-history.js', () => ({
  resetImportForRetry: resetImportForRetryMock,
  // other exports the route may import — add as needed
  markUploadComplete:  jest.fn(),
  getResumeImport:     jest.fn(),
  listResumeImports:   jest.fn(),
  createResumeImport:  jest.fn(),
}));

jest.unstable_mockModule('../../src/lib/config.js', () => ({
  getJobImage:        getJobImageMock,
  isImageConfigured:  isImageConfiguredMock,
  UNSET_IMAGE_SENTINEL: 'image-uri-not-yet-set',
}));

// ─── Dynamic imports after mocks ──────────────────────────────────────────────

const { Hono } = await import('hono');
const { createResumeImportsRouter } = await import('../../src/routes/resume-imports.js');

// ─── Test config ──────────────────────────────────────────────────────────────

const testConfig = {
  assetsBucketName:             'test-assets-bucket',
  cognitoUserPoolId:            'eu-west-1_TestPool',
  cognitoClientId:              'test-client-id',
  cognitoIssuerUrl:             'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool',
  awsRegion:                    'eu-west-1',
  port:                         3002,
  pgHost:                       'pgbouncer.platform.svc.cluster.local',
  pgPort:                       5432,
  pgDatabase:                   'tucaken',
  pgUser:                       'postgres',
  pgPassword:                   'secret',
  resumeImportNamespace:        'resume-import',
  resumeImportServiceAccount:   'resume-import-sa',
} as const;

const VALID_IMPORT_ID = '00000000-0000-0000-0000-000000000001';
const TEST_USER_ID    = 'test-user';
const TEST_IMAGE      = '123456789.dkr.ecr.eu-west-1.amazonaws.com/resume-import-processor:abc123';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('jwtPayload', { sub: TEST_USER_ID });
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.route('/', createResumeImportsRouter(testConfig as any));
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /:id/retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getJobImageMock.mockReturnValue(TEST_IMAGE);
    isImageConfiguredMock.mockReturnValue(true);
  });

  it('returns 202 and re-dispatches the Job when import is in failed state', async () => {
    const failedRecord = {
      id: VALID_IMPORT_ID, userId: TEST_USER_ID, status: 'queued',
      s3Key: 'resume-imports/test-user/file.pdf', contentType: 'application/pdf',
      originalFilename: 'cv.pdf', errorCode: null, statusMessage: null,
      currentStep: null, totalSteps: null, careerEntriesCreated: [],
      embeddingsCreatedCount: 0, createdAt: new Date().toISOString(),
    };
    resetImportForRetryMock.mockResolvedValueOnce(failedRecord);

    const app = buildApp();
    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as { importId: string; status: string };
    expect(body.importId).toBe(VALID_IMPORT_ID);
    expect(body.status).toBe('queued');
    expect(createNamespacedJobMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when import not found or not in failed state', async () => {
    resetImportForRetryMock.mockResolvedValueOnce(null);

    const app = buildApp();
    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 502 when image is not yet configured', async () => {
    const failedRecord = {
      id: VALID_IMPORT_ID, userId: TEST_USER_ID, status: 'queued',
      s3Key: 'resume-imports/test-user/file.pdf', contentType: 'application/pdf',
      originalFilename: 'cv.pdf', errorCode: null, statusMessage: null,
      currentStep: null, totalSteps: null, careerEntriesCreated: [],
      embeddingsCreatedCount: 0, createdAt: new Date().toISOString(),
    };
    resetImportForRetryMock.mockResolvedValueOnce(failedRecord);
    isImageConfiguredMock.mockReturnValue(false);

    const app = buildApp();
    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect(createNamespacedJobMock).not.toHaveBeenCalled();
  });

  it('returns 401 when request is unauthenticated', async () => {
    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.route('/', createResumeImportsRouter(testConfig as any));

    const res = await app.request(`/${VALID_IMPORT_ID}/retry`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail with "route not found" or similar**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/api/admin-api
NODE_OPTIONS='--experimental-vm-modules' yarn jest __tests__/routes/resume-imports.test.ts --no-coverage
```
Expected: FAIL — the retry route does not exist yet.

---

## Task 4: Implement the retry endpoint

**Repo:** `cdk-monitoring`
**Files:** Modify `api/admin-api/src/routes/resume-imports.ts`

- [ ] **Step 1: Add the import for `resetImportForRetry` at the top of resume-imports.ts**

Find the existing import from `'../lib/repositories/career-history.js'` and add `resetImportForRetry` to the named imports list.

- [ ] **Step 2: Add the retry route after the `POST /:id/complete` handler (around line 245)**

```typescript
// ─── POST /:id/retry ──────────────────────────────────────────────────────
// Re-dispatch a failed import using the existing S3 file.
// Resets status → 'queued', clears error fields, increments retry_count.
// ──────────────────────────────────────────────────────────────────────────
router.post('/:id/retry', async (ctx) => {
  const userId = requireUserId(ctx);
  if (!userId) return ctx.json({ error: 'Authenticated user not provisioned' }, 401);

  const importId = ctx.req.param('id');

  const importRecord = await resetImportForRetry(pool, importId, userId);
  if (!importRecord) {
    return ctx.json({ error: 'Import not found or not in failed state' }, 404);
  }

  const image = getJobImage('resume-import-processor');
  if (!isImageConfigured(image)) {
    console.error('[resume-imports] retry: image URI unresolved — ESO not yet synced', { image });
    return ctx.json({ error: 'Resume import processor image not configured — wait ~60s for ESO/kubelet sync' }, 502);
  }

  const job = buildJobSpec(
    config,
    image,
    importRecord.id,
    userId,
    importRecord.s3Key,
    importRecord.contentType,
  );

  try {
    await getBatchApi().createNamespacedJob({ namespace: config.resumeImportNamespace, body: job });
  } catch (err) {
    console.error('[resume-imports] retry: failed to create K8s Job', err);
    return ctx.json({ error: 'Failed to schedule resume import job' }, 502);
  }

  return ctx.json({ importId: importRecord.id, status: 'queued' }, 202);
});
```

- [ ] **Step 3: Check that `s3Key` and `contentType` are available on `ResumeImportRecord`**

Open `api/admin-api/src/lib/repositories/career-history.ts` and verify `ResumeImportRecord` has `s3Key: string` and `contentType: string` fields. If not, add them to the interface and the `mapImportRow` function.

- [ ] **Step 4: Run the tests — all should pass**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn jest __tests__/routes/resume-imports.test.ts --no-coverage
```
Expected: 4 tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn jest --no-coverage
```
Expected: all existing tests still pass.

- [ ] **Step 6: Typecheck**

```bash
yarn typecheck
```

- [ ] **Step 7: Commit**

```bash
git add api/admin-api/src/routes/resume-imports.ts \
        api/admin-api/__tests__/routes/resume-imports.test.ts
git commit -m "feat(resume-imports): add POST /:id/retry endpoint to re-dispatch failed imports"
```

---

## Task 5: Add `retryImportFn` server function in tucaken-app

**Repo:** `tucaken-app`
**Files:** Modify `src/server/resume-imports.ts`

- [ ] **Step 1: Add the `retryImportFn` export at the end of resume-imports.ts**

```typescript
/**
 * Retry a failed import using the existing S3 file. No re-upload needed.
 * Returns the import ID and new status ('queued') on success.
 */
export const retryImportFn = createServerFn({ method: 'POST' })
  .inputValidator(importIdSchema)
  .handler(async ({ data: importId }) => {
    await requireAuth()
    const token = getSessionToken()
    return apiFetch<{ importId: string; status: string }>(
      `/api/admin/resume-imports/${importId}/retry`,
      token,
      { method: 'POST' },
    )
  })
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/tucaken-app
yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/server/resume-imports.ts
git commit -m "feat(resume-imports): add retryImportFn server function"
```

---

## Task 6: Update ImportCareerStep with context-aware retry button

**Repo:** `tucaken-app`
**Files:** Modify `src/features/onboarding/components/steps/ImportCareerStep.tsx`

- [ ] **Step 1: Add `retryImportFn` to the imports at the top of the file**

Find the existing import line:
```typescript
import {
  getUploadUrlFn,
  completeUploadFn,
  getImportStatusFn,
  listCareerEntriesFn,
} from '../../../../server/resume-imports'
```
Add `retryImportFn` to the list.

- [ ] **Step 2: Add a `retrying` state flag after the existing state declarations**

```typescript
const [retrying, setRetrying] = useState(false)
```

- [ ] **Step 3: Add the `handleRetry` function after `handleFile`**

```typescript
async function handleRetry() {
  if (!importId) return
  setRetrying(true)
  try {
    await retryImportFn({ data: importId })
    setErrorMsg('')
    setRetrying(false)
    setPhase('processing')
  } catch (err) {
    setRetrying(false)
    setErrorMsg(err instanceof Error ? err.message : 'Retry failed — please try again.')
  }
}
```

- [ ] **Step 4: Update the error phase render block**

Replace the current error phase return with the following. The key difference: when `importId` is set (job was dispatched before it failed), show a **Retry** button that calls `handleRetry`. When `importId` is null (error happened before job dispatch), keep the existing **Try again** button.

```typescript
if (phase === 'error') {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div>
          <p className="text-sm font-medium text-red-300">Import failed</p>
          <p className="mt-0.5 text-xs text-red-400/70">{errorMsg}</p>
        </div>
      </div>
      <div className="flex gap-2">
        {importId ? (
          <Button
            variant="secondary"
            onClick={() => void handleRetry()}
            disabled={retrying}
            className="flex items-center gap-1.5"
          >
            {retrying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => { setPhase('idle'); setFile(null); setImportId(null) }}
          >
            Try again
          </Button>
        )}
        <Button variant="ghost" onClick={onSkip}>Skip for now</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Typecheck**

```bash
yarn typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/features/onboarding/components/steps/ImportCareerStep.tsx
git commit -m "feat(resume-imports): add context-aware retry button to ImportCareerStep"
```

---

## Task 7: Scaffold platform-job-watcher package

**Repo:** `ai-applications`
**Files:** Create package.json, tsconfig.json, Dockerfile

- [ ] **Step 1: Create `applications/platform-job-watcher/package.json`**

```json
{
  "name": "@platform/job-watcher",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest --passWithNoTests",
    "start": "node dist/run-watcher.js"
  },
  "dependencies": {
    "@kubernetes/client-node": "^0.22.3",
    "js-yaml": "^4.1.0",
    "pg": "^8.20.0"
  },
  "devDependencies": {
    "@jest/globals": "^29.7.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.10",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.6",
    "typescript": "^5.7.3"
  },
  "jest": {
    "preset": "ts-jest/presets/default/jest-preset",
    "testEnvironment": "node",
    "extensionsToTreatAsEsm": [".ts"],
    "moduleNameMapper": {
      "^(\\.{1,2}/.*)\\.js$": "$1"
    },
    "transform": {
      "^.+\\.tsx?$": ["ts-jest", { "useESM": true }]
    }
  }
}
```

- [ ] **Step 2: Create `applications/platform-job-watcher/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `applications/platform-job-watcher/Dockerfile`**

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock tsconfig.base.json ./
COPY applications/platform-job-watcher/package.json applications/platform-job-watcher/
RUN yarn workspaces focus @platform/job-watcher
COPY applications/platform-job-watcher/src applications/platform-job-watcher/src
COPY applications/platform-job-watcher/tsconfig.json applications/platform-job-watcher/
RUN yarn workspace @platform/job-watcher build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/applications/platform-job-watcher/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/run-watcher.js"]
```

- [ ] **Step 4: Install dependencies**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn install
```

- [ ] **Step 5: Commit scaffold**

```bash
git add applications/platform-job-watcher/
git commit -m "chore(platform-job-watcher): scaffold package with tsconfig, Dockerfile"
```

---

## Task 8: Implement `config.ts`

**Repo:** `ai-applications`
**Files:** Create `applications/platform-job-watcher/src/config.ts`

- [ ] **Step 1: Create the file**

```typescript
import * as fs   from 'node:fs';
import * as path from 'node:path';
import yaml      from 'js-yaml';

export interface WatcherEntry {
  readonly namespace:         string;
  readonly dbTable:           string;
  readonly staleAfterMinutes: number;
}

export interface WatcherConfig {
  readonly watchers: readonly WatcherEntry[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): WatcherConfig {
  const configPath = process.env['WATCHER_CONFIG_PATH'] ?? '/etc/watcher/config.yaml';
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as { watchers: Array<{ namespace: string; dbTable: string; staleAfterMinutes?: number }> };

  if (!Array.isArray(parsed?.watchers) || parsed.watchers.length === 0) {
    throw new Error(`Invalid watcher config at ${configPath}: watchers array missing or empty`);
  }

  return {
    watchers: parsed.watchers.map((w) => ({
      namespace:         w.namespace,
      dbTable:           w.dbTable,
      staleAfterMinutes: w.staleAfterMinutes ?? 15,
    })),
  };
}

export interface DbConfig {
  readonly host:     string;
  readonly port:     number;
  readonly database: string;
  readonly user:     string;
  readonly password: string;
}

export function loadDbConfig(): DbConfig {
  return {
    host:     required('PG_HOST'),
    port:     parseInt(process.env['PG_PORT'] ?? '5432', 10),
    database: required('PG_DATABASE'),
    user:     required('PG_USER'),
    password: required('PG_PASSWORD'),
  };
}
```

- [ ] **Step 2: Write the failing config test**

Create `applications/platform-job-watcher/__tests__/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('loadConfig', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
    configFile = path.join(tmpDir, 'config.yaml');
    process.env['WATCHER_CONFIG_PATH'] = configFile;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    delete process.env['WATCHER_CONFIG_PATH'];
  });

  it('parses valid config with defaults', async () => {
    fs.writeFileSync(configFile, `
watchers:
  - namespace: resume-import
    dbTable: resume_imports
`);
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.watchers).toHaveLength(1);
    expect(cfg.watchers[0].namespace).toBe('resume-import');
    expect(cfg.watchers[0].dbTable).toBe('resume_imports');
    expect(cfg.watchers[0].staleAfterMinutes).toBe(15);
  });

  it('throws when config file is missing', async () => {
    process.env['WATCHER_CONFIG_PATH'] = '/nonexistent/config.yaml';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow();
  });

  it('throws when watchers array is empty', async () => {
    fs.writeFileSync(configFile, 'watchers: []\n');
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('Invalid watcher config');
  });
});
```

- [ ] **Step 3: Run test**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
NODE_OPTIONS='--experimental-vm-modules' yarn workspace @platform/job-watcher test -- --no-coverage
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add applications/platform-job-watcher/src/config.ts \
        applications/platform-job-watcher/__tests__/config.test.ts
git commit -m "feat(platform-job-watcher): add config loader with YAML + env var parsing"
```

---

## Task 9: Implement `db.ts`

**Repo:** `ai-applications`
**Files:** Create `applications/platform-job-watcher/src/db.ts`

- [ ] **Step 1: Create the file**

```typescript
import { Pool } from 'pg';
import type { DbConfig } from './config.js';

let pool: Pool | undefined;

export function getPool(cfg: DbConfig): Pool {
  if (!pool) {
    pool = new Pool({
      host:                    cfg.host,
      port:                    cfg.port,
      database:                cfg.database,
      user:                    cfg.user,
      password:                cfg.password,
      ssl:                     false,
      max:                     3,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Test helper — reset singleton so tests get a fresh pool. */
export function _resetPool(): void {
  pool = undefined;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn workspace @platform/job-watcher typecheck
```

- [ ] **Step 3: Commit**

```bash
git add applications/platform-job-watcher/src/db.ts
git commit -m "feat(platform-job-watcher): add pg Pool singleton (ssl:false for pgbouncer)"
```

---

## Task 10: Implement `reconciler.ts` with tests

**Repo:** `ai-applications`
**Files:** Create `applications/platform-job-watcher/src/reconciler.ts` and `__tests__/reconciler.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `applications/platform-job-watcher/__tests__/reconciler.test.ts`:

```typescript
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';

// Mock pg Pool
const queryMock = jest.fn<() => Promise<{ rowCount: number }>>()
  .mockResolvedValue({ rowCount: 0 });
const mockPool = { query: queryMock } as unknown as Pool;

describe('runReconciliation', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 0 });
  });

  it('runs one UPDATE per watcher entry and logs the row count', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const watchers = [
      { namespace: 'resume-import', dbTable: 'resume_imports', staleAfterMinutes: 15 },
    ];

    await runReconciliation(mockPool, watchers);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('resume_imports');
    expect(sql).toContain('WATCHER_TIMEOUT');
    expect(params[0]).toBe(15);

    consoleSpy.mockRestore();
  });

  it('runs one UPDATE per entry when multiple watchers configured', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const watchers = [
      { namespace: 'resume-import',  dbTable: 'resume_imports',  staleAfterMinutes: 15 },
      { namespace: 'ingestion',       dbTable: 'ingestion_jobs',  staleAfterMinutes: 30 },
    ];

    await runReconciliation(mockPool, watchers);

    expect(queryMock).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it('logs an error but does not throw when a query fails', async () => {
    const { runReconciliation } = await import('../src/reconciler.js');
    queryMock.mockRejectedValueOnce(new Error('db down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const watchers = [
      { namespace: 'resume-import', dbTable: 'resume_imports', staleAfterMinutes: 15 },
    ];

    await expect(runReconciliation(mockPool, watchers)).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn workspace @platform/job-watcher test -- --testPathPattern reconciler --no-coverage
```
Expected: FAIL — `reconciler.js` does not exist yet.

- [ ] **Step 3: Create `applications/platform-job-watcher/src/reconciler.ts`**

```typescript
import type { Pool } from 'pg';
import type { WatcherEntry } from './config.js';

/**
 * Sweeps all configured DB tables for imports stuck in a non-terminal state
 * longer than staleAfterMinutes. Marks them as failed with error_code='WATCHER_TIMEOUT'.
 *
 * Called on a setInterval in run-watcher.ts. Each query is independent —
 * a failure on one table is logged and skipped, the others still run.
 */
export async function runReconciliation(
  pool: Pool,
  watchers: readonly WatcherEntry[],
): Promise<void> {
  for (const entry of watchers) {
    try {
      const result = await pool.query<{ rowCount: number }>(
        `UPDATE ${entry.dbTable}
            SET status       = 'failed',
                error_code   = 'WATCHER_TIMEOUT',
                completed_at = NOW()
          WHERE status NOT IN ('completed', 'failed', 'awaiting_upload')
            AND started_at < NOW() - ($1 || ' minutes')::INTERVAL`,
        [entry.staleAfterMinutes],
      );
      const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
      if (affected > 0) {
        console.info('[reconciler] marked stale imports as failed', {
          table: entry.dbTable,
          count: affected,
        });
      }
    } catch (err) {
      console.error('[reconciler] sweep failed', { table: entry.dbTable, err });
    }
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn workspace @platform/job-watcher test -- --testPathPattern reconciler --no-coverage
```
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add applications/platform-job-watcher/src/reconciler.ts \
        applications/platform-job-watcher/__tests__/reconciler.test.ts
git commit -m "feat(platform-job-watcher): add reconciler sweep — marks stale imports as WATCHER_TIMEOUT"
```

---

## Task 11: Implement `watcher.ts` with tests

**Repo:** `ai-applications`
**Files:** Create `applications/platform-job-watcher/src/watcher.ts` and `__tests__/watcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `applications/platform-job-watcher/__tests__/watcher.test.ts`:

```typescript
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Pool } from 'pg';

const queryMock = jest.fn<() => Promise<{ rowCount: number }>>()
  .mockResolvedValue({ rowCount: 1 });
const mockPool = { query: queryMock } as unknown as Pool;

describe('markJobFailed', () => {
  beforeEach(() => {
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rowCount: 1 });
  });

  it('updates the correct table with JOB_FAILED and the import-id from labels', async () => {
    const { markJobFailed } = await import('../src/watcher.js');

    await markJobFailed(mockPool, 'resume_imports', 'abc-123-uuid');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('resume_imports');
    expect(sql).toContain('JOB_FAILED');
    expect(params[0]).toBe('abc-123-uuid');
  });

  it('logs a warning when no rows were updated (import already terminal)', async () => {
    const { markJobFailed } = await import('../src/watcher.js');
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await markJobFailed(mockPool, 'resume_imports', 'abc-123-uuid');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[watcher]'),
      expect.objectContaining({ importId: 'abc-123-uuid' }),
    );
    warnSpy.mockRestore();
  });

  it('does not throw when the importId is missing from job labels', async () => {
    const { markJobFailed } = await import('../src/watcher.js');

    await expect(markJobFailed(mockPool, 'resume_imports', undefined)).resolves.not.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn workspace @platform/job-watcher test -- --testPathPattern watcher --no-coverage
```

- [ ] **Step 3: Create `applications/platform-job-watcher/src/watcher.ts`**

```typescript
import * as k8s         from '@kubernetes/client-node';
import type { Pool }    from 'pg';
import type { WatcherEntry } from './config.js';

/**
 * Writes 'failed' status to the DB when a K8s Job fails.
 * Called by watchNamespace on every failed Job event.
 * No-ops silently if importId is absent (e.g. Job created outside this pipeline).
 */
export async function markJobFailed(
  pool:     Pool,
  dbTable:  string,
  importId: string | undefined,
): Promise<void> {
  if (!importId) return;

  const result = await pool.query(
    `UPDATE ${dbTable}
        SET status       = 'failed',
            error_code   = 'JOB_FAILED',
            completed_at = NOW()
      WHERE id = $1::uuid
        AND status NOT IN ('completed', 'failed')`,
    [importId],
  );
  const affected = (result as unknown as { rowCount: number | null }).rowCount ?? 0;
  if (affected === 0) {
    console.warn('[watcher] markJobFailed: no rows updated (already terminal?)', { importId });
  } else {
    console.info('[watcher] marked import as JOB_FAILED', { importId, table: dbTable });
  }
}

/**
 * Opens a K8s Watch stream on batch/v1/Jobs in the given namespace.
 * On any MODIFIED event where job.status.failed > 0, calls markJobFailed.
 * Reconnects automatically when the stream closes (Watch streams time out after ~5 min).
 *
 * Returns a cleanup function that stops the watch loop.
 */
export function watchNamespace(
  kc:    k8s.KubeConfig,
  pool:  Pool,
  entry: WatcherEntry,
): () => void {
  let stopped = false;
  const watch  = new k8s.Watch(kc);

  async function startWatch(): Promise<void> {
    if (stopped) return;

    try {
      await watch.watch(
        `/apis/batch/v1/namespaces/${entry.namespace}/jobs`,
        {},
        async (type, job: k8s.V1Job) => {
          if (type !== 'MODIFIED') return;
          const failed = job.status?.failed ?? 0;
          if (failed === 0) return;

          const importId = job.metadata?.labels?.['import-id'];
          await markJobFailed(pool, entry.dbTable, importId).catch((err) =>
            console.error('[watcher] markJobFailed threw', { err, importId }),
          );
        },
        (err) => {
          if (stopped) return;
          if (err) console.warn('[watcher] stream closed with error — reconnecting', { namespace: entry.namespace, err });
          else      console.info('[watcher] stream closed — reconnecting', { namespace: entry.namespace });
          // Reconnect after a short back-off
          setTimeout(() => void startWatch(), 5_000);
        },
      );
    } catch (err) {
      if (stopped) return;
      console.error('[watcher] failed to open watch stream — retrying in 10s', { namespace: entry.namespace, err });
      setTimeout(() => void startWatch(), 10_000);
    }
  }

  void startWatch();

  return () => { stopped = true; };
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn workspace @platform/job-watcher test -- --testPathPattern watcher --no-coverage
```
Expected: 3 tests PASS.

- [ ] **Step 5: Run all watcher tests**

```bash
NODE_OPTIONS='--experimental-vm-modules' yarn workspace @platform/job-watcher test -- --no-coverage
```
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add applications/platform-job-watcher/src/watcher.ts \
        applications/platform-job-watcher/__tests__/watcher.test.ts
git commit -m "feat(platform-job-watcher): add K8s watch loop and markJobFailed DB writer"
```

---

## Task 12: Implement `run-watcher.ts` entrypoint

**Repo:** `ai-applications`
**Files:** Create `applications/platform-job-watcher/src/run-watcher.ts`

- [ ] **Step 1: Create the entrypoint**

```typescript
import * as k8s from '@kubernetes/client-node';
import { loadConfig, loadDbConfig } from './config.js';
import { getPool, closePool }       from './db.js';
import { watchNamespace }           from './watcher.js';
import { runReconciliation }        from './reconciler.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

async function main(): Promise<void> {
  const config   = loadConfig();
  const dbConfig = loadDbConfig();
  const pool     = getPool(dbConfig);

  // Verify DB connectivity on startup — fail fast rather than silently.
  await pool.query('SELECT 1');
  console.info('[run-watcher] DB connection OK');

  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();

  const stopFns: Array<() => void> = [];

  for (const entry of config.watchers) {
    console.info('[run-watcher] starting watch', { namespace: entry.namespace, table: entry.dbTable });
    const stop = watchNamespace(kc, pool, entry);
    stopFns.push(stop);
  }

  // Reconciliation sweep — runs immediately on startup, then every 5 min.
  async function reconcile(): Promise<void> {
    await runReconciliation(pool, config.watchers);
  }
  await reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    console.info('[run-watcher] shutting down', { signal });
    clearInterval(reconcileTimer);
    stopFns.forEach((fn) => fn());
    await closePool();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  console.info('[run-watcher] running', {
    watchers: config.watchers.map((w) => w.namespace),
    reconcileIntervalMin: RECONCILE_INTERVAL_MS / 60_000,
  });
}

main().catch((err) => {
  console.error('[run-watcher] fatal startup error', err);
  process.exit(1);
});
```

- [ ] **Step 2: Build the package**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
yarn workspace @platform/job-watcher build
```
Expected: `dist/run-watcher.js` is created, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add applications/platform-job-watcher/src/run-watcher.ts
git commit -m "feat(platform-job-watcher): add entrypoint with watch + reconcile loops and graceful shutdown"
```

---

## Task 13: Add ECR repository for platform-job-watcher

**Repo:** `cdk-monitoring`
**Files:** Modify `infra/lib/shared/vpc-stack.ts`

- [ ] **Step 1: Find the resume-import-processor ECR block (around line 627) in vpc-stack.ts for reference**

- [ ] **Step 2: Add a parallel block for platform-job-watcher immediately after the resume-import-processor block**

Follow the exact same pattern. Add to `SharedVpcStackProps`:

```typescript
/** platform-job-watcher ECR repository name @default 'platform-job-watcher' */
readonly platformJobWatcherEcrRepositoryName?: string;
/** Enable platform-job-watcher ECR repository creation @default true */
readonly enablePlatformJobWatcherEcrRepository?: boolean;
```

Add to `SharedVpcStack` public properties:

```typescript
/** ECR Repository for the platform-job-watcher Deployment */
public readonly platformJobWatcherEcrRepository?: ecr.Repository;
```

Add the creation block in the constructor (after the resume-import-processor block):

```typescript
// ECR Repository (platform-job-watcher) — long-running Deployment that
// watches K8s Jobs and writes failure status back to the DB.
if (props.enablePlatformJobWatcherEcrRepository !== false) {
  const repoName = props.platformJobWatcherEcrRepositoryName ?? 'platform-job-watcher';
  this.platformJobWatcherEcrRepository = new ecr.Repository(this, 'PlatformJobWatcherEcrRepository', {
    repositoryName:    repoName,
    removalPolicy:     cdk.RemovalPolicy.RETAIN,
    imageScanOnPush:   true,
    imageTagMutability: ecr.TagMutability.MUTABLE,
  });

  const ssmPrefix = `/shared/ecr-platform-job-watcher/${props.targetEnvironment}`;
  new ssm.StringParameter(this, 'PlatformJobWatcherEcrRepoUri', {
    parameterName: `${ssmPrefix}/repository-uri`,
    stringValue:   this.platformJobWatcherEcrRepository.repositoryUri,
    description:   `platform-job-watcher ECR repository URI for ${props.targetEnvironment}`,
  });

  cdk.Tags.of(this.platformJobWatcherEcrRepository).add(
    'Description', 'platform-job-watcher K8s Deployment ECR Repository URI for docker push/pull',
  );
}
```

- [ ] **Step 3: Typecheck infra**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra
yarn typecheck
```

- [ ] **Step 4: Commit**

```bash
git add infra/lib/shared/vpc-stack.ts
git commit -m "feat(infra): add ECR repository for platform-job-watcher"
```

---

## Task 14: Create Helm chart for platform-job-watcher

**Repo:** `kubernetes-bootstrap`
**Files:** Create `charts/platform-job-watcher/chart/` directory tree

- [ ] **Step 1: Create `charts/platform-job-watcher/chart/Chart.yaml`**

```yaml
# @format
apiVersion: v2
name: platform-job-watcher
description: Watches K8s batch Jobs and writes failure status to the DB
type: application
version: 0.1.0
appVersion: "latest"
```

- [ ] **Step 2: Create `charts/platform-job-watcher/chart/values.yaml`**

```yaml
# @format
image:
  repository: ""   # Written by ArgoCD Image Updater
  tag: ""          # Written by ArgoCD Image Updater

namespace: platform

serviceAccount:
  name: platform-job-watcher

config:
  watchers:
    - namespace: resume-import
      dbTable: resume_imports
      staleAfterMinutes: 15

resources:
  requests:
    memory: 128Mi
    cpu: 50m
  limits:
    memory: 256Mi
    cpu: 200m
```

- [ ] **Step 3: Create `charts/platform-job-watcher/chart/templates/serviceaccount.yaml`**

```yaml
# @format
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Values.serviceAccount.name }}
  namespace: {{ .Values.namespace }}
  labels:
    app: platform-job-watcher
```

- [ ] **Step 4: Create `charts/platform-job-watcher/chart/templates/clusterrole.yaml`**

```yaml
# @format
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-job-watcher
  labels:
    app: platform-job-watcher
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch"]
```

- [ ] **Step 5: Create `charts/platform-job-watcher/chart/templates/clusterrolebinding.yaml`**

```yaml
# @format
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform-job-watcher
  labels:
    app: platform-job-watcher
subjects:
  - kind: ServiceAccount
    name: {{ .Values.serviceAccount.name }}
    namespace: {{ .Values.namespace }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: platform-job-watcher
```

- [ ] **Step 6: Create `charts/platform-job-watcher/chart/templates/configmap.yaml`**

```yaml
# @format
apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-job-watcher-config
  namespace: {{ .Values.namespace }}
  labels:
    app: platform-job-watcher
data:
  config.yaml: |
    watchers:
    {{- range .Values.config.watchers }}
      - namespace: {{ .namespace }}
        dbTable: {{ .dbTable }}
        staleAfterMinutes: {{ .staleAfterMinutes }}
    {{- end }}
```

- [ ] **Step 7: Create `charts/platform-job-watcher/chart/templates/deployment.yaml`**

```yaml
# @format
apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-job-watcher
  namespace: {{ .Values.namespace }}
  labels:
    app: platform-job-watcher
spec:
  replicas: 1
  selector:
    matchLabels:
      app: platform-job-watcher
  template:
    metadata:
      labels:
        app: platform-job-watcher
    spec:
      serviceAccountName: {{ .Values.serviceAccount.name }}
      containers:
        - name: watcher
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: Always
          command: ["node", "dist/run-watcher.js"]
          env:
            - name: WATCHER_CONFIG_PATH
              value: /etc/watcher/config.yaml
          envFrom:
            - secretRef:
                name: platform-rds-credentials
          volumeMounts:
            - name: watcher-config
              mountPath: /etc/watcher
              readOnly: true
          resources:
            requests:
              memory: {{ .Values.resources.requests.memory }}
              cpu: {{ .Values.resources.requests.cpu }}
            limits:
              memory: {{ .Values.resources.limits.memory }}
              cpu: {{ .Values.resources.limits.cpu }}
      volumes:
        - name: watcher-config
          configMap:
            name: platform-job-watcher-config
```

- [ ] **Step 8: Commit**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git add charts/platform-job-watcher/
git commit -m "feat(platform-job-watcher): add Helm chart with Deployment, SA, ClusterRole, ConfigMap"
```

---

## Task 15: Create ArgoCD ApplicationSet for platform-job-watcher

**Repo:** `kubernetes-bootstrap`
**Files:** Create `argocd-apps/platform-job-watcher.yaml`

- [ ] **Step 1: Read `argocd-apps/admin-api.yaml` to understand the ApplicationSet + Image Updater pattern (the `spec.generators[0].list.elements` and annotation template)**

- [ ] **Step 2: Create `argocd-apps/platform-job-watcher.yaml`**

```yaml
# @format
# ArgoCD ApplicationSet: platform-job-watcher
#
# ArgoCD Image Updater monitors the ECR repository and writes the new
# image tag to chart/.argocd-source-platform-job-watcher.yaml on each
# successful CI push — no pod restart required from the Helm side.
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-job-watcher
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  generators:
    - list:
        elements:
          - env:        development
            ecrAccount: "771826808455"
            ecrRegion:  eu-west-1
            gitBranch:  develop
            namespace:  platform
  template:
    metadata:
      name: platform-job-watcher
      annotations:
        argocd-image-updater.argoproj.io/image-list: >-
          watcher={{ecrAccount}}.dkr.ecr.{{ecrRegion}}.amazonaws.com/platform-job-watcher
        argocd-image-updater.argoproj.io/watcher.allow-tags: "regexp:^[0-9a-f]{7,40}(-r[0-9]+)?$"
        argocd-image-updater.argoproj.io/watcher.helm.image-name: image.repository
        argocd-image-updater.argoproj.io/watcher.helm.image-tag: image.tag
        argocd-image-updater.argoproj.io/watcher.update-strategy: newest-build
        argocd-image-updater.argoproj.io/git-branch: "{{gitBranch}}"
        argocd-image-updater.argoproj.io/write-back-method: "git:secret:argocd/argocd-image-updater-writeback-key"
        kubernetes.io/description: "platform-job-watcher — K8s Job failure detector"
    spec:
      project: default
      source:
        repoURL: https://github.com/Nelson-Lamounier/kubernetes-bootstrap.git
        targetRevision: "{{gitBranch}}"
        path: charts/platform-job-watcher/chart
        helm:
          valueFiles:
            - ../platform-job-watcher-values.yaml
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

- [ ] **Step 3: Create `charts/platform-job-watcher/platform-job-watcher-values.yaml`**

```yaml
# @format
# platform-job-watcher — Development environment overrides
image:
  repository: 771826808455.dkr.ecr.eu-west-1.amazonaws.com/platform-job-watcher
  # tag: written by ArgoCD Image Updater

namespace: platform

config:
  watchers:
    - namespace: resume-import
      dbTable: resume_imports
      staleAfterMinutes: 15
```

- [ ] **Step 4: Commit**

```bash
git add argocd-apps/platform-job-watcher.yaml \
        charts/platform-job-watcher/platform-job-watcher-values.yaml
git commit -m "feat(platform-job-watcher): add ArgoCD ApplicationSet with Image Updater"
```

---

## Task 16: Create CI workflow for platform-job-watcher

**Repo:** `ai-applications`
**Files:** Create `.github/workflows/deploy-platform-job-watcher.yml`

- [ ] **Step 1: Create the workflow**

```yaml
# =============================================================================
# Deploy Platform-Job-Watcher Image (Development)
# =============================================================================
#
# Builds the platform-job-watcher container, pushes to ECR.
# ArgoCD Image Updater monitors the ECR repo and automatically rolls
# out the new image to the Deployment — no SSM/ESO step needed.
#
# Triggers:
#   - Push to develop touching applications/platform-job-watcher/**
#   - Manual workflow_dispatch
#
# Prerequisite: ECR repo must exist with its URI at
#   /shared/ecr-platform-job-watcher/{env}/repository-uri
# =============================================================================

name: "Deploy Platform-Job-Watcher (Dev)"

on:
  push:
    branches: [develop]
    paths:
      - "applications/platform-job-watcher/**"
      - ".github/workflows/deploy-platform-job-watcher.yml"
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  ENVIRONMENT: development
  AWS_REGION: "eu-west-1"
  IMAGE_TAG: "${{ github.sha }}-r${{ github.run_attempt }}"

concurrency:
  group: deploy-platform-job-watcher-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: "[Platform-Job-Watcher] Build Docker Image"
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: ${{ vars.ENVIRONMENT || 'development' }}
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build Docker Image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: applications/platform-job-watcher/Dockerfile
          push: false
          load: false
          tags: platform-job-watcher:${{ env.IMAGE_TAG }}
          cache-from: type=gha,scope=platform-job-watcher
          cache-to: type=gha,mode=max,scope=platform-job-watcher
          provenance: false
          outputs: type=docker,dest=/tmp/platform-job-watcher-image.tar

      - name: Cache Image
        uses: actions/cache/save@cdf6c1fa76f9f475f3d7449005a359c84ca0f306
        with:
          path: /tmp/platform-job-watcher-image.tar
          key: platform-job-watcher-image-${{ env.ENVIRONMENT }}-${{ github.run_id }}-${{ github.run_attempt }}

  push:
    name: "[Platform-Job-Watcher] Push to ECR"
    needs: [build]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: ${{ vars.ENVIRONMENT || 'development' }}
    permissions:
      id-token: write
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd

      - name: Configure AWS Credentials
        uses: ./.github/actions/configure-aws
        with:
          role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Restore Image from Cache
        uses: actions/cache/restore@cdf6c1fa76f9f475f3d7449005a359c84ca0f306
        with:
          path: /tmp/platform-job-watcher-image.tar
          key: platform-job-watcher-image-${{ env.ENVIRONMENT }}-${{ github.run_id }}-${{ github.run_attempt }}
          fail-on-cache-miss: true

      - name: Load Docker Image
        run: docker load -i /tmp/platform-job-watcher-image.tar

      - name: Resolve ECR URL
        id: resolve-ecr
        run: |
          ECR_URL=$(aws ssm get-parameter \
            --name "/shared/ecr-platform-job-watcher/$ENVIRONMENT/repository-uri" \
            --query 'Parameter.Value' \
            --output text)
          echo "::add-mask::$ECR_URL"
          echo "ecr-url=$ECR_URL" >> $GITHUB_OUTPUT

      - name: Push to ECR
        env:
          ECR_URL: ${{ steps.resolve-ecr.outputs.ecr-url }}
        run: |
          aws ecr get-login-password --region "$AWS_REGION" \
            | docker login --username AWS --password-stdin "$ECR_URL"
          docker tag "platform-job-watcher:$IMAGE_TAG" "$ECR_URL:$IMAGE_TAG"
          docker push "$ECR_URL:$IMAGE_TAG"

      - name: Push Summary
        run: |
          echo "## [Platform-Job-Watcher] ECR Push" >> $GITHUB_STEP_SUMMARY
          echo "- **Tag**: $IMAGE_TAG" >> $GITHUB_STEP_SUMMARY
          echo "- **Next**: ArgoCD Image Updater picks up new tag → rolls out Deployment" >> $GITHUB_STEP_SUMMARY
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy-platform-job-watcher.yml
git commit -m "ci: add deploy-platform-job-watcher workflow"
```

---

## Task 17: Push all branches

- [ ] **Step 1: Push cdk-monitoring**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring
git push origin develop
```

- [ ] **Step 2: Push ai-applications**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications
git push origin develop
```

- [ ] **Step 3: Push tucaken-app**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/tucaken-app
git push origin develop
```

- [ ] **Step 4: Push kubernetes-bootstrap**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
git push origin develop
```

Expected: GitHub Actions workflows trigger for `ai-applications` (build + push `platform-job-watcher` to ECR). ArgoCD Image Updater picks up the new tag and rolls out the Deployment within ~2 min of ECR push.

---

## Verification Checklist

After all tasks are complete:

- [ ] `kubectl get deployment platform-job-watcher -n platform` — Running, 1/1
- [ ] `kubectl logs -n platform -l app=platform-job-watcher` — shows `[run-watcher] running` with namespace `resume-import` listed
- [ ] Trigger a resume import that fails (e.g. temporarily break the processor) — within 30s the import record in the DB should have `status='failed', error_code='JOB_FAILED'`
- [ ] Trigger a retry from the UI — button should appear on the error phase, call `/retry`, resume polling
- [ ] Retry re-dispatches the Job without re-uploading the file
- [ ] Reconciliation sweep runs every 5 min — check logs for `[reconciler]` output
