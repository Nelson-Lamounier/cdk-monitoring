---
description: Synchronise the Knowledge Base after code changes, debugging, or implementation sessions
---

# Knowledge Base Sync Workflow

// turbo-all

Keeps the Knowledge Base accurate after sessions that modify
infrastructure, Kubernetes, observability, CI/CD, or application code.

**Invoke with:** `/kb-sync` after code changes or at end of session.

---

## Step 1 — Identify What Changed

```bash
# Unstaged + staged changes
git diff --name-only HEAD
# Or last commit
git diff --name-only HEAD~1..HEAD
```

If working from conversation context, review the session summary.

---

## Step 2 — Map Changes to KB Documents

Read `knowledge-base/.kb-map.yml` and cross-reference changed files
against `code_paths` globs. Note the corresponding `kb_docs`.

**If no mapping exists:**
> "⚠️ Unmapped code area: `<path>`. Adding to `.kb-map.yml`."

### Domain Boundaries

Use these boundaries when deciding where content belongs:

| Domain | Scope |
|:---|:---|
| `infrastructure` | CDK stacks, VPC, CloudFront, WAF, NLB, SGs, IAM, KMS |
| `kubernetes` | Self-managed K8s, bootstrap, GitOps, Crossplane |
| `observability` | Prometheus, Grafana, Loki, Tempo, Faro RUM |
| `ai-ml` | Bedrock, Pinecone, self-healing agent |
| `frontend` | Next.js deployment, Argo Rollouts, API Gateway |
| `operations` | CI/CD, MCP servers, workflows |
| `finops` | Cost breakdown, optimisation |
| `career` | Professional development, certifications |

---

## Step 3 — Review Affected KB Documents

For each affected document, check:

1. **Accuracy** — does it describe the current code state?
2. **Completeness** — are new capabilities documented?
3. **Staleness** — are removed features still described?
4. **Troubleshooting** — does a new resolved issue warrant a
   troubleshooting entry (What? Why? Fix)?

### Decision Gates (ask user if uncertain)

- Temporary experiment or permanent architectural decision?
- Should a new ADR be created?
- Does this affect cost or security posture?
- Are runbooks affected by new failure modes?

---

## Step 4 — Update Documents

### 4a. Frontmatter

```yaml
last_updated: "YYYY-MM-DD"  # Today's date
```

Add/update `tags:` if new services were introduced.

### 4b. Content

- Refresh prose to match current implementation
- Update code snippets referencing changed files
- Ensure `## Summary` is accurate
- Update `## Keywords` if new terms apply
- Update `## Transferable Skills Demonstrated` if applicable

### 4c. Troubleshooting Entries

If a resolved production issue was part of this session, add a
structured troubleshooting entry under `## Troubleshooting` in the
relevant domain document. Use this format:

```markdown
### <Short Title>

**What happened:** <Observable symptom — what the user saw>

**Why:** <Root cause — why the system behaved that way>

**Fix:** <What was changed to resolve it permanently>
```

Each entry should be self-contained — a developer hitting the same
issue should be able to understand and resolve it from this entry alone.

### 4d. Sidecar Metadata

Regenerate the `.metadata.json` sidecar for each updated document:

```json
{
  "metadataAttributes": {
    "doc_type": "<from frontmatter>",
    "domain": "<from frontmatter>",
    "title": "<from frontmatter>",
    "tags": "<comma-separated from frontmatter tags>"
  }
}
```

Save as `<filename>.md.metadata.json` alongside the document.

### 4e. Cross-References

Verify `related_docs:` paths in frontmatter still exist. Update if
files were moved or renamed.

---

## Step 5 — Create New Documents (If Needed)

Only when code changes introduce an entirely new service, stack, or
capability not covered by any existing KB document.

### 5a. Ask the User

> "New code area `<path>` has no KB doc. What type?"

Options: Implementation, ADR, Runbook, Architecture.

### 5b. Document Template

```markdown
---
title: "<Descriptive Title>"
doc_type: <implementation|adr|runbook|architecture|review>
domain: <infrastructure|kubernetes|observability|ai-ml|frontend|operations|finops|career>
tags:
  - <tag1>
  - <tag2>
related_docs:
  - "<domain>/<related-doc>.md"
last_updated: "YYYY-MM-DD"
author: "Nelson Lamounier"
status: active
---

# <Title>

<Introduction>

## <Sections>

## Troubleshooting

### <Issue Title>

**What happened:** <symptom>

**Why:** <root cause>

**Fix:** <resolution>

## Transferable Skills Demonstrated

- **<Skill>** — <demonstration>

## Summary

<2-3 sentences>

## Keywords

<comma-separated searchable terms>
```

### 5c. Post-Creation

1. Create `.metadata.json` sidecar
2. Add mapping to `knowledge-base/.kb-map.yml`
3. Add entry to `knowledge-base/index.md`

---

## Step 6 — Validate

```bash
cd knowledge-base
# Check: every .md has frontmatter
find . -name '*.md' -not -path './scripts/*' \
  -not -name 'README.md' -not -name 'index.md' | while read f; do
  head -1 "$f" | grep -q '^---$' || echo "MISSING FRONTMATTER: $f"
done

# Check: every .md has a sidecar
find . -name '*.md' -not -path './scripts/*' \
  -not -name 'README.md' | while read f; do
  [ -f "${f}.metadata.json" ] || echo "MISSING SIDECAR: $f"
done

# Check: required sections
for f in $(find . -name '*.md' -not -path './scripts/*' \
  -not -name 'README.md' -not -name 'index.md'); do
  grep -q '## Summary' "$f" || echo "MISSING SUMMARY: $f"
  grep -q '## Keywords' "$f" || echo "MISSING KEYWORDS: $f"
done
```

---

## Step 7 — Update Antigravity Knowledge Items (Major Only)

Only for significant architectural changes (new stacks, major
refactoring, deleted services). Skip for minor updates.

1. Check `~/.gemini/antigravity/knowledge/` for relevant KI
2. Update `metadata.json` summary and timestamps
3. Update relevant artifact files

---

## Summary Report

At the end of every `/kb-sync`, output:

```text
=== KB Sync Summary ===
📝 Documents updated:       <N>
📄 Documents created:       <N>
🗺️  Mappings added:          <N>
📎 Sidecars regenerated:    <N>
🔧 Troubleshooting entries: <N>
🧠 Knowledge items updated: <N>
⚠️  Unmapped code areas:     <list>
```