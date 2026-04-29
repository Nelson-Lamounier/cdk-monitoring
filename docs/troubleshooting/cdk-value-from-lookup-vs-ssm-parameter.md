---
title: CDK valueFromLookup() Bakes AMI at Synth Time — Breaks CI with --no-lookups
type: troubleshooting
tags: [aws-cdk, ssm, ami, ci-cd, cloudformation, launch-template]
sources:
  - infra/lib/stacks/kubernetes/control-plane-stack.ts
  - infra/lib/stacks/kubernetes/worker-asg-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

`cdk synth` fails in CI with an invalid AMI ID in the Launch Template:

```
[ERROR] The AMI ID 'ami-0placeholder00000001' is invalid.
```

Or alternatively, the CDK synthesis succeeds in CI (using `--no-lookups`)
but the CloudFormation template contains the stale placeholder AMI ID
`ami-0placeholder00000001` instead of the real AMI from SSM. The placeholder
propagates to production and the ASG attempts to launch instances from a
non-existent AMI.

## Root cause

`valueFromLookup()` resolves SSM parameter values at **CDK synth time**
by making a live AWS API call. This requires valid AWS credentials in every
environment that runs `cdk synth`.

CI pipelines use `--no-lookups` (the standard production-grade CDK CI
pattern) to prevent synth-time AWS API calls. When `--no-lookups` is active
and the value is not pre-seeded in `cdk.context.json`, CDK substitutes a
placeholder (`ami-0placeholder00000001`) so synthesis can complete. This
placeholder is not a valid EC2 image ID.

The preceding workaround commit (`286f0db8`) manually seeded this placeholder
into `cdk.context.json` to allow CI to pass. This created a second failure
mode: the baked-in placeholder diverged from the live SSM value as the Golden
AMI was refreshed by the AMI refresh Step Function. A subsequent stack update
would use the stale placeholder unless someone remembered to run a full synth
with credentials.

The root cause is using `valueFromLookup()` for a value (`golden-ami/latest`)
that the AMI refresh pipeline owns and updates at runtime. CDK does not need
to know the AMI ID at synth time — CloudFormation can resolve it at deploy
time.

## How to diagnose

```bash
# Check if valueFromLookup is in use
grep -rn "valueFromLookup\|ami-0placeholder" infra/lib/stacks/kubernetes/

# Check what's baked into cdk.context.json
cat infra/cdk.context.json | grep -A2 "golden-ami"

# Check the live SSM value
aws ssm get-parameter \
  --name /k8s/development/golden-ami/latest \
  --query Parameter.Value \
  --profile dev-account
```

If `cdk.context.json` contains `ami-0placeholder00000001` for the golden-AMI
key, the stale-context failure mode is present.

## How to fix

Replace `valueFromLookup()` with `ec2.MachineImage.fromSsmParameter()`.
This generates an `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` CloudFormation
parameter that CloudFormation resolves at deploy time — no synth-time lookup
required.

The fix in commit `4008c9b4` updates both affected stacks:

```typescript
// Before (broken): bakes AMI at synth time
// machineImage: ec2.MachineImage.genericLinux({
//   'eu-west-1': ssm.StringParameter.valueFromLookup(this, '/k8s/development/golden-ami/latest'),
// }),

// After (correct): CloudFormation resolves at deploy time
machineImage: ec2.MachineImage.fromSsmParameter(configs.image.amiSsmPath),
```

The current implementation is at
[`control-plane-stack.ts:196`](../../infra/lib/stacks/kubernetes/control-plane-stack.ts).

After applying the fix:
1. Remove the stale `ami-0placeholder00000001` entry from `cdk.context.json`.
2. Remove any CI workflow step that was manually clearing stale golden-AMI
   context — it is no longer needed.

## How to prevent

- **Use `fromSsmParameter()` for any SSM value that changes at runtime.**
  `valueFromLookup()` is appropriate only for values that are stable at
  synth time (VPC IDs, hosted zone IDs, cross-account role ARNs). AMI IDs
  managed by a separate refresh pipeline are runtime values — use
  `fromSsmParameter()`.

- **The distinction:**
  - `valueFromLookup()` → string baked into CloudFormation template at synth
  - `fromSsmParameter()` → `AWS::SSM::Parameter::Value<>` resolved by CloudFormation at deploy

- **Do not seed placeholder values in `cdk.context.json`.** If a value cannot
  be resolved without credentials, that is a signal to use `fromSsmParameter()`
  instead of working around the lookup requirement.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/control-plane-stack.ts:196 (read on 2026-04-29)
- Commit: 4008c9b4 — "fix(synth): replace valueFromLookup with fromSsmParameter for golden-ami" (read on 2026-04-29)
- Commit: 286f0db8 — "fix(synth): seed golden-ami/latest SSM context for CI no-lookups synth" (read on 2026-04-29)
-->
