---
description: Stage, commit, push changes to develop, and trigger a GitHub Actions workflow dispatch
---

# Commit & Deploy Workflow

// turbo-all

Breaks session changes into logical, domain-scoped commits using
Conventional Commit format, pushes to `develop`, and optionally
triggers a GitHub Actions deployment workflow.

**Invoke with:** `/commit-and-deploy` after completing implementation work.

---

## Step 1 — Survey All Changes

```bash
# Show all modified, added, and untracked files
git status --short
```

If the output is empty, abort with:
> "✅ Working tree is clean — nothing to commit."

---

## Step 2 — Classify Changes by Domain

Group every changed file into one of these domains:

| Domain | Scope (for commit prefix) | File Patterns |
|:---|:---|:---|
| Infrastructure | `infra` | `infra/lib/**`, `infra/bin/**` |
| Bedrock AI/ML | `bedrock` | `bedrock-applications/**`, `infra/lib/stacks/bedrock/**`, `infra/lib/config/bedrock/**` |
| Kubernetes | `k8s` | `kubernetes-app/**`, `scripts/k8s-*` |
| Observability | `monitoring` | `kubernetes-app/platform/charts/monitoring/**` |
| Frontend | `frontend` | `frontend-ops/**` |
| CI/CD | `ci` | `.github/workflows/**` |
| Tests | `test` | `infra/tests/**`, `**/*.test.ts`, `**/*.spec.ts` |
| Documentation | `docs` | `docs/**`, `knowledge-base/**`, `.agents/**` |
| Config/Tooling | `chore` | `tsconfig.json`, `package.json`, `yarn.lock`, `.eslintrc.*` |

### Cross-Domain Files

Some files touch multiple domains. Assign them to the **primary** domain:

- `infra/lib/stacks/bedrock/*` → `bedrock` (not `infra`)
- `infra/tests/unit/stacks/bedrock/*` → `bedrock` (keep tests with the code they cover)
- `knowledge-base/**` → `docs`
- `.agents/workflows/*` → `docs`

---

## Step 3 — Design the Commit Plan

Create **2–6 commits** based on these rules:

### Commit Count Guidelines

| Changes | Commits | Rationale |
|:---|:---|:---|
| Single domain, small fix | 2 | Code + docs/tests |
| Single domain, new feature | 2–3 | Core impl + tests + docs |
| Multi-domain feature | 3–5 | One per domain touched |
| Major refactor | 4–6 | Logical layers of change |

### Commit Type Prefixes (Conventional Commits)

| Type | When to use |
|:---|:---|
| `feat` | New capability, feature, or stack |
| `fix` | Bug fix, configuration correction |
| `refactor` | Code restructuring without behaviour change |
| `docs` | Documentation only (KB, ADRs, workflows) |
| `test` | Adding or updating tests only |
| `chore` | Tooling, config, dependencies |
| `improve` | Enhancement to existing feature |
| `ci` | CI/CD pipeline changes |

### Commit Message Format

```
type(scope): concise imperative description

Optional body explaining WHY, not WHAT.
Max 72 chars for the subject line.
```

**Examples:**
```
feat(bedrock): add Job Strategist 3-agent pipeline and data stack
test(bedrock): add unit tests for strategist data and pipeline stacks
docs(ai-ml): add strategist pipeline KB document and update index
```

### Present the Plan

Before executing, present the commit plan as a table:

```
=== Commit Plan ===
#  | Type       | Scope    | Message                                          | Files
1  | feat       | bedrock  | add Job Strategist pipeline infrastructure        | 8 files
2  | test       | bedrock  | add strategist data and pipeline stack unit tests  | 2 files
3  | docs       | ai-ml    | add strategist KB doc and update index             | 6 files
```

**Ask the user for approval before proceeding.**

---

## Step 3.5 — Pre-Commit Quality Gate

Before creating any commits, run both lint checks to catch
issues early. **Both must pass** before proceeding to Step 4.

### 3.5a. Validate GitHub Actions workflows

```bash
actionlint
```

If `actionlint` reports errors, fix them before committing.
If `actionlint` is not installed, skip with a warning.

**Common actionlint failures:**

| Error Pattern | Root Cause | Fix |
|:---|:---|:---|
| `property "X" is not defined in object type` | Output used in `needs.*.outputs.X` but not declared in the job's `outputs:` map | Add `X: ${{ steps.<id>.outputs.X }}` to the job's `outputs:` |
| `shellcheck reported issue` (SC-level) | ShellCheck informational suggestions in `run:` scripts | Usually safe to ignore (CI runs with `-shellcheck=""`) |
| `expression type mismatch` | Incorrect expression syntax in `if:` or `run:` | Fix the expression to match the expected type |

### 3.5b. Run ESLint

```bash
just lint
```

If lint fails, fix the errors before committing.
Auto-fixable issues can be resolved with `just lint-fix`.

> **Important:** CI runs ESLint with `--max-warnings 0`.
> Both *errors* and *warnings* will fail the CI pipeline.
> Fix all warnings locally before committing.

**Common ESLint warnings that block CI:**

| Rule | Trigger | Fix |
|:---|:---|:---|
| `jest/no-conditional-in-test` | `??`, `&&`, `\|\|`, ternary, `.filter()` predicates inside `it()` | Move conditional logic to `beforeAll` or extract a module-level helper (see Rule 11) |
| `import/order` | Import groups not separated by blank lines | Run `just lint-fix` (auto-fixable) |
| `@typescript-eslint/no-unused-vars` | Unused imports or variables | Remove the unused declarations |

### Gate Decision

| actionlint | just lint | Action                          |
|:-----------|:----------|:--------------------------------|
| ✅ pass    | ✅ pass   | Proceed to Step 4               |
| ❌ fail    | ✅ pass   | Fix workflow YAML, then re-run  |
| ✅ pass    | ❌ fail   | Run `just lint-fix`, then retry |
| ❌ fail    | ❌ fail   | Fix both, then retry            |

---

## Step 4 — Execute Commits

For each commit in the plan:

### 4a. Stage Files

```bash
# Stage specific files for this commit
git add <file1> <file2> ...
```

**Rules:**
- Never use `git add .` or `git add -A` — always stage explicitly.
- Verify staged files match the plan: `git diff --cached --name-only`
- If `yarn.lock` changed, include it with the commit that changed
  `package.json`.

### 4b. Commit

```bash
git commit -m "type(scope): message"
```

### 4c. Verify

```bash
# Confirm the commit was created
git log -1 --oneline --stat
```

Repeat 4a–4c for each commit in the plan.

---

## Step 5 — Push to develop

```bash
# Verify we're on the correct branch
git branch --show-current

# Push all commits
git push origin develop
```

If the branch is not `develop`, ask the user before pushing.

If the push fails due to divergence:
```bash
git pull --rebase origin develop
git push origin develop
```

---

## Step 6 — Trigger Deployment (Optional)

Ask the user which workflow to trigger. Use this reference:

| Stack Changed | Workflow | Command |
|:---|:---|:---|
| CDK infra (K8s stacks) | `deploy-kubernetes.yml` | `gh workflow run deploy-kubernetes.yml --ref develop` |
| CDK infra (Bedrock) | `deploy-bedrock.yml` | `gh workflow run deploy-bedrock.yml --ref develop` |
| CDK infra (Shared) | `deploy-shared.yml` | `gh workflow run deploy-shared.yml --ref develop` |
| CDK infra (Self-healing) | `deploy-self-healing.yml` | `gh workflow run deploy-self-healing.yml --ref develop` |
| Helm / K8s manifests | `gitops-k8s.yml` | `gh workflow run gitops-k8s.yml --ref develop` |
| SSM Automation docs | `deploy-ssm-automation.yml` | `gh workflow run deploy-ssm-automation.yml --ref develop` |
| Frontend (Next.js) | `deploy-frontend.yml` | `gh workflow run deploy-frontend.yml --ref develop` |
| Organization / DNS | `deploy-org.yml` | `gh workflow run deploy-org.yml --ref develop -f confirm=DEPLOY-ORG -f stack=dns-role` |
| Docs / KB only | — | No deployment needed |

If the user specifies a workflow, trigger it:

```bash
gh workflow run <workflow>.yml --ref develop
```

Then watch the run:

```bash
# Wait a few seconds for the run to register
sleep 5
gh run list --workflow=<workflow>.yml --limit=1
```

If the user does not specify a workflow, suggest the most relevant
one based on the domains touched, or skip if docs-only.

---

## Step 7 — Summary Report

Output a structured summary:

```text
=== Commit & Deploy Summary ===
🔀 Branch:              develop
📦 Commits pushed:      <N>
📁 Total files changed: <N>
🚀 Workflow triggered:  <workflow-name or "none">
🔗 Run URL:             <gh run URL or "—">

Commits:
  1. <hash> type(scope): message
  2. <hash> type(scope): message
  ...
```
