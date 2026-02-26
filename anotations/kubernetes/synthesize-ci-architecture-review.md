# Synthesize CI — Architecture Review

> Does a dedicated TypeScript file for `cdk synth` follow 2026 DevOps best practices?

## TL;DR

**Yes — this is the recommended approach for CDK projects with multiple stacks.**

The TypeScript synth wrapper is not just acceptable — it follows the pattern used by AWS's own CDK Pipelines construct and aligns with the broader industry shift toward **programmatic CI orchestration**. That said, there are trade-offs to understand.

---

## What You Built

A **typed deployment toolkit** — 20 TypeScript files in `scripts/deployment/` — where `synthesize-ci.ts` is one entry point:

```
scripts/deployment/
├── synthesize-ci.ts    ← CI synth + stack name discovery
├── deploy.ts           ← CDK deploy orchestration
├── rollback.ts         ← Stack rollback
├── drift-detection.ts  ← Drift checks
├── stacks.ts           ← Project registry (single source of truth)
├── exec.ts             ← CDK command builder + runner
├── logger.ts           ← Structured logging
└── ... (13 more files)
```

The critical insight: **all these scripts share `stacks.ts`** — the project registry that defines stack names, dependencies, and CDK context. This is the primary justification for TypeScript over inline CLI.

---

## Pros

### 1. Single Source of Truth for Stack Names
```typescript
// stacks.ts — used by synth, deploy, rollback, drift detection
const k8sStacks: StackConfig[] = [
  { id: 'compute', getStackName: (env) => `K8s-Compute-${env}` },
  { id: 'edge',    getStackName: (env) => `K8s-Edge-${env}` },
];
```
If you used inline CLI, every workflow job would hardcode stack names separately — a maintenance risk as stacks are added/removed.

### 2. Type Safety at CI Time
- TypeScript catches misspelled stack IDs, missing context keys, and invalid enum values **before** `cdk synth` runs
- `CdkArgsOptions` interface ensures valid CDK command construction
- `Environment` enum prevents typos like `developement`

### 3. Testability
Your deployment scripts can be unit-tested like any TypeScript module. Inline bash or YAML `run:` blocks cannot be tested independently.

### 4. Local/CI Parity
Developers can run `npx tsx scripts/deployment/synthesize-ci.ts k8s development` locally — identical behavior to CI. Inline YAML `run:` blocks with `${{ vars.X }}` can't be tested locally without act or similar tools.

### 5. Structured Output
The script writes `$GITHUB_OUTPUT` and `synthesis-metadata.json` in a controlled way — no fragile `echo "key=value" >> $GITHUB_OUTPUT` bash one-liners spread across the workflow.

### 6. Reuse Across Projects
The same `synthesize-ci.ts` handles `monitoring`, `nextjs`, `k8s`, and `org` projects — just by changing the first argument. With bash, you'd either duplicate the synth logic or write a shell script that reimplements the project registry.

---

## Cons

### 1. Runtime Dependency on `tsx`
```yaml
run: npx tsx scripts/deployment/synthesize-ci.ts k8s development
```
This requires Node.js + `tsx` on the runner. If `npx tsx` fails or the version changes, synth breaks for a reason unrelated to your infrastructure code. A shell script would only need `bash` — universally available.

### 2. Slower Cold Start
`tsx` compiles TypeScript on-the-fly. This adds ~2-3 seconds vs. running `cdk synth` directly. For a script that runs once per pipeline, this is negligible — but it's not zero.

### 3. Higher Cognitive Barrier
A new team member reading the workflow sees:
```yaml
run: npx tsx scripts/deployment/synthesize-ci.ts k8s ${{ inputs.cdk-environment }}
```
vs. inline:
```yaml
run: npx cdk synth --all -c project=k8s -c environment=${{ inputs.cdk-environment }}
```
The second is immediately understandable. The first requires reading the TypeScript file to understand what it does.

### 4. Indirection
Debugging a failed synth requires tracing from YAML → TypeScript → `exec.ts` → `cdk` subprocess. With inline CLI, the failing command is visible directly in the workflow log.

### 5. Over-Engineering Risk for Simple Projects
If you had a single stack, a one-line `npx cdk synth` in the workflow would be sufficient. The TypeScript wrapper pays off only because you have **4 projects × 2-7 stacks each**.

---

## Industry Comparison (2026)

| Approach | When It's Used | Examples |
|----------|---------------|----------|
| **Inline CLI** (`run: npx cdk synth`) | Simple CDK apps, 1-3 stacks, solo developers | Most CDK Getting Started guides, AWS samples |
| **Shell scripts** (`deploy.sh`) | Non-CDK pipelines, Docker builds, kubectl, AWS CLI workflows | Kubernetes deploy scripts, Terraform wrappers |
| **Python scripts** | Data/ML pipelines, Terraform CDK, multi-tool orchestration | Airflow DAGs, Pulumi Automation API |
| **TypeScript scripts** (your approach) | CDK projects sharing config with infra code, multi-stack orchestration | CDK Pipelines, Projen, large enterprise CDK repos |
| **Dedicated CI tools** (Taskfile, Makefile, Just) | Cross-language monorepos, standardized task runners | Google, Stripe, large OSS projects |

### Where Your Approach Sits

Your implementation mirrors **CDK Pipelines** — AWS's own opinionated construct for CDK-based CI/CD. CDK Pipelines also uses TypeScript to orchestrate synth, deploy, and post-deploy actions, and it generates the pipeline from code rather than writing YAML manually.

The key principle in 2026 DevOps:

> **Workflows should declare _what_ to do; scripts should implement _how_ to do it.**

Your YAML says **what**: "synthesize and determine stack names." Your TypeScript says **how**: "run `cdk synth --all` with the right context, parse the project registry, write stack names to `$GITHUB_OUTPUT`." This separation is widely considered a best practice.

---

## Would Shell or Python Be More Appropriate?

### Shell Script
**Use when:** The script just runs CLI commands in sequence with no shared state.

```bash
#!/bin/bash
npx cdk synth --all -c project=k8s -c environment=$1
echo "compute=K8s-Compute-$1" >> "$GITHUB_OUTPUT"
echo "edge=K8s-Edge-$1" >> "$GITHUB_OUTPUT"
```

- ✅ No compile step, no `tsx` dependency
- ✅ Easier to read for ops engineers
- ❌ No type safety — typo in stack name = runtime failure
- ❌ Can't share the project registry with CDK code
- ❌ String manipulation for JSON, error handling is fragile

**Verdict:** Appropriate if synth were the _only_ deployment script. Since you have 20 scripts sharing `stacks.ts`, shell would fragment the source of truth.

### Python Script
**Use when:** The pipeline orchestration involves non-CDK tools (Terraform, Docker, K8s) or complex data transformation.

- ✅ Better for multi-tool pipelines (AWS CLI + kubectl + Terraform)
- ✅ Rich ecosystem for AWS SDK (boto3)
- ❌ Can't import your TypeScript CDK config — you'd duplicate stack definitions
- ❌ Adds a second runtime (Python + Node.js) to the CI environment

**Verdict:** Wrong language for a CDK TypeScript project. The whole point is sharing types with the infrastructure code.

### TypeScript (Your Approach)
**Use when:** CDK project with multiple stacks, shared config, and multiple deployment scripts.

- ✅ Same language as infrastructure code — one mental model
- ✅ Shared project registry (`stacks.ts`) across synth, deploy, rollback, drift
- ✅ Type safety catches errors before CDK runs
- ❌ Requires `tsx` runtime dependency
- ❌ Higher initial complexity

**Verdict:** Correct choice for your project size and complexity. The 20-script deployment toolkit justifies the TypeScript investment.

---

## Recommendations

### Keep
- TypeScript for deployment scripts — the shared `stacks.ts` registry is the strongest argument
- `$GITHUB_OUTPUT` integration for dynamic stack names
- `synthesis-metadata.json` for traceability

### Consider
1. **Pin `tsx` version** in `package.json` devDependencies to avoid silent breakage:
   ```json
   "devDependencies": {
     "tsx": "^4.x"
   }
   ```
   Then use `npx tsx` (resolves from local `node_modules`) instead of relying on global resolution.

2. **Add a `// Purpose:` comment** to the workflow step:
   ```yaml
   - name: Synthesize & Determine Stack Names
     # Runs CDK synth and outputs stack names from scripts/deployment/stacks.ts
     run: npx tsx scripts/deployment/synthesize-ci.ts k8s ${{ inputs.cdk-environment }}
   ```
   This helps the "inline readability" concern without needing to open the TS file.

3. **Consider Taskfile or Just** as a future evolution — these task runners provide a thin CLI layer that delegates to your TypeScript scripts, giving you `task synth k8s development` instead of `npx tsx scripts/deployment/synthesize-ci.ts k8s development`.

---

## Final Assessment

| Criterion | Rating | Notes |
|-----------|--------|-------|
| Follows 2026 best practices | ✅ Yes | "Code over config," shared project registry, typed orchestration |
| Modern DevOps pipeline | ✅ Yes | Mirrors CDK Pipelines and Projen patterns |
| Appropriate language choice | ✅ Yes | Same language as CDK code, shared types |
| Appropriate complexity | ✅ Yes | Justified by 20-script toolkit and 4 projects |
| Alternative would be better | ❌ No | Shell/Python would fragment the source of truth |

> **Bottom line:** Inline CLI is simpler for a 1-stack project. Your project has 4 projects with 2-7 stacks each, a shared config registry, and 20 deployment scripts. TypeScript is the right tool here, and the approach follows modern DevOps patterns.
