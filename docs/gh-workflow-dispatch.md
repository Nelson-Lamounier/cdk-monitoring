# GitHub CLI — Workflow Dispatch Reference

## Syntax

```bash
gh workflow run <workflow-file> --ref <branch> [-f key=value]
```

## Project Workflows

```bash
# --- Kubernetes (full pipeline) ---
gh workflow run deploy-kubernetes.yml --ref develop

# --- GitOps (Helm + ArgoCD sync only) ---
gh workflow run gitops-k8s.yml --ref develop

# --- SSM Automation ---
gh workflow run deploy-ssm-automation.yml --ref develop

# --- Shared Infrastructure ---
gh workflow run deploy-shared.yml --ref develop

# --- Frontend (Next.js) ---
gh workflow run deploy-frontend.yml --ref develop

# --- Bedrock ---
gh workflow run deploy-bedrock.yml --ref develop

# --- Organization ---
gh workflow run deploy-org.yml --ref develop -f confirm=DEPLOY-ORG -f stack=dns-role

# --- Day-1 Orchestration ---
gh workflow run day-1-orchestration.yml --ref develop
```

## Useful Commands

```bash
# List all workflows
gh workflow list

# Watch latest run in real-time
gh run watch

# List recent runs for a workflow
gh run list --workflow=deploy-kubernetes-dev.yml

# View logs of specific run
gh run view <run-id> --log

# Re-run a failed workflow
gh run rerun <run-id>

# Cancel a running workflow
gh run cancel <run-id>
```

## Git Log Reference

```bash
# Last commit (compact)
git log -1 --oneline

# Last commit (full details: author, date, files changed)
git log -1 --stat

# Last 5 commits
git log -5 --oneline

# Commits not yet pushed to remote
git log origin/develop..HEAD --oneline

# Last commit that touched a specific file
git log -1 --oneline -- path/to/file.yaml

# Show what changed in the last commit (diff)
git show --stat

# Show diff of uncommitted changes
git diff --stat
```
