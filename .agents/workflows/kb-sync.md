---
description: Synchronise the Knowledge Base after code changes, debugging, or implementation sessions
---

# Knowledge Base Sync Workflow

// turbo-all

This workflow ensures the Knowledge Base stays in sync with the codebase after any session that modifies infrastructure, Kubernetes resources, observability, CI/CD, or application code.

**Invoke with**: `/kb-sync` or when the agent detects significant code changes at end of a session.

---

## Step 1 — Identify What Changed

Determine what code was modified in this session:

```bash
# Show files changed since the last commit (unstaged + staged)
git diff --name-only HEAD
# If already committed, show last commit
git diff --name-only HEAD~1..HEAD
```

If working from conversation context rather than git, review the session summary to identify affected code areas.

---

## Step 2 — Consult the Code-to-KB Mapping

Read the mapping file to find which KB documents are affected:

```
knowledge-base/.kb-map.yml
```

Cross-reference the changed files against the `code_paths` globs. For each match, note the corresponding `kb_docs`.

**If no mapping exists for the changed code area**, flag it:
> "⚠️ Unmapped code area: `<path>`. Consider adding a mapping to `.kb-map.yml`."

---

## Step 3 — Review Each Affected KB Document

For each affected KB document, read it and determine:

1. **Is the content still accurate?** Does the document describe the current state of the code?
2. **Are there new capabilities/changes not documented?** (new endpoints, new stacks, changed configs)
3. **Are there removed capabilities still documented?** (deleted services, deprecated patterns)

### Quality Gates — Ask the User If Needed

If you are uncertain about any of the following, **ask the user before updating**:

- [ ] Is this a temporary experimental change or a permanent architectural decision?
- [ ] Should this change be documented as a new ADR (architecture decision)?
- [ ] Does this change affect the cost breakdown or security posture?
- [ ] Are there runbooks that need updating for new failure modes?

---

## Step 4 — Update Existing KB Documents

For each affected document that needs changes:

### 4a. Update Frontmatter
```yaml
last_updated: "YYYY-MM-DD"  # Set to today's date
```

Update `tags:` if new technologies or services were introduced.

### 4b. Update Content Sections
- Refresh prose to reflect current implementation
- Update code snippets if they reference changed files
- Ensure `## Summary` accurately describes the current state
- Update `## Keywords` if new terms are relevant
- Update `## Transferable Skills Demonstrated` if applicable

### 4c. Regenerate Sidecar File
After updating any KB document, regenerate its `.metadata.json` sidecar:

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

### 4d. Update Cross-References
If the document references other KB docs via `related_docs:` in frontmatter, verify those paths still exist. Update if necessary.

---

## Step 5 — Create New KB Documents (If Needed)

If the code changes introduce an **entirely new service, stack, or capability** that no existing KB document covers:

### 5a. Ask the User
> "I've identified a new code area (`<path>`) that isn't covered by any KB document. What type of document should I create?"

Offer options:
- **Implementation doc** — describes how it works
- **ADR** — records why a decision was made
- **Runbook** — troubleshooting steps
- **Architecture doc** — high-level design

### 5b. Use the Document Template

Every new KB document MUST include:

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

<Introduction paragraph>

## <Main Sections>

<Content>

## Transferable Skills Demonstrated

- **<Skill>** — <how it's demonstrated in this document>

## Summary

<2-3 sentence summary of what this document covers>

## Keywords

<comma-separated list of searchable terms>
```

### 5c. Create the Sidecar
Generate the `.metadata.json` file alongside the new document.

### 5d. Update the Mapping
Add the new document to `knowledge-base/.kb-map.yml` under the appropriate code paths.

### 5e. Update index.md
Add the new document to `knowledge-base/index.md` in the correct domain section.

---

## Step 6 — Validate

Run the validation checks to ensure all documents pass:

```bash
cd knowledge-base
# Check: every .md has frontmatter
find . -name '*.md' -not -path './scripts/*' -not -name 'README.md' -not -name 'index.md' | while read f; do
  head -1 "$f" | grep -q '^---$' || echo "MISSING FRONTMATTER: $f"
done

# Check: every .md has a sidecar
find . -name '*.md' -not -path './scripts/*' -not -name 'README.md' | while read f; do
  [ -f "${f}.metadata.json" ] || echo "MISSING SIDECAR: $f"
done

# Check: required sections
for f in $(find . -name '*.md' -not -path './scripts/*' -not -name 'README.md' -not -name 'index.md'); do
  grep -q '## Summary' "$f" || echo "MISSING SUMMARY: $f"
  grep -q '## Keywords' "$f" || echo "MISSING KEYWORDS: $f"
done
```

---

## Step 7 — Update Knowledge Base(At repository Root Directory) Items (Major Changes Only)

If this session involved **significant architectural changes** (new stacks, major refactoring, deleted services), update the Antigravity knowledge items:

1. Check if the relevant KI exists in `~/.gemini/antigravity/knowledge/`
2. Update the `metadata.json` summary and timestamps
3. Update the relevant artifact files

**Skip this step for minor content updates** (typo fixes, small config changes).

---

## Summary Checklist

At the end of a `/kb-sync` run, report:

```
=== KB Sync Summary ===
📝 Documents updated:    <N>
📄 Documents created:    <N>
🗺️ Mappings added:       <N>
📎 Sidecars regenerated: <N>
🧠 Knowledge items updated: <N>
⚠️  Unmapped code areas:  <list>
```