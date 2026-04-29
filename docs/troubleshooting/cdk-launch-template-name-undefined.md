---
title: CDK L2 LaunchTemplate.launchTemplateName Always Undefined
type: troubleshooting
tags: [aws-cdk, launch-template, auto-scaling, typescript]
sources:
  - infra/lib/constructs/compute/constructs/launch-template.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

TypeScript build fails with `TS2551` — property does not exist — when code
accesses `launchTemplateName` on a CDK `LaunchTemplate` construct instance
(commit `a13c5821`). Or, the build succeeds but the downstream code passes
`undefined` (as the literal string `'undefined'`) to AWS API calls, causing
cryptic validation errors like:

```
InvalidLaunchTemplateId: The launchTemplateId 'undefined' does not exist.
```

The property appears to exist (`launchTemplateName` is in the CDK L2 type
definition) but evaluates to `undefined` at runtime even when
`launchTemplateName` was passed as a prop at construction time.

## Root cause

The CDK L2 `LaunchTemplate` construct exposes a `launchTemplateName`
property on its interface, but the L2 implementation stores the name as an
`IResolvable` token rather than materialising it as a plain string on the
construct object. Reading `lt.launchTemplateName` at runtime returns
`undefined` even when `props.launchTemplateName` was set.

The same behaviour affects `AutoScalingGroup.autoScalingGroupName` — it
resolves as `this.physicalName`, which becomes a CloudFormation `Ref`
token at synth time, not the human-readable name string.

Any code that reads these properties directly and passes the result to
another AWS API call or to `addPropertyOverride()` will silently pass
`undefined` or a CloudFormation token string rather than the intended
concrete name.

The comment at
[`launch-template.ts:315-318`](../../infra/lib/constructs/compute/constructs/launch-template.ts)
documents the workaround:

```typescript
// Expose the concrete LT name (synth-time string, not a CloudFormation token).
// CDK's LaunchTemplate L2 does not populate `.launchTemplateName` even when the
// prop is set — using it would give `undefined`. Build the string directly here.
this.concreteTemplateName = `${namePrefix}-lt`;
```

## How to diagnose

```bash
# Check if launchTemplateName is read anywhere in the codebase
grep -rn "\.launchTemplateName\|\.autoScalingGroupName" infra/lib/

# Check if concreteTemplateName / concreteAsgName are used consistently
grep -rn "concreteTemplateName\|concreteAsgName" infra/lib/
```

In TypeScript, add a runtime check to catch this at development time:

```typescript
const name = lt.launchTemplateName;
console.log(typeof name, name); // likely: "undefined" undefined
```

## How to fix

Build the concrete name directly as a TypeScript string rather than reading
it from the CDK construct property. The pattern used in this codebase:

```typescript
// In LaunchTemplateConstruct constructor
this.concreteTemplateName = `${namePrefix}-lt`;

// In AutoScalingGroupConstruct constructor
this.concreteAsgName = `${namePrefix}-asg`;
```

Use `concreteTemplateName` and `concreteAsgName` everywhere a string name
is needed for API calls, SSM parameters, or cross-stack references. Never
read `lt.launchTemplateName` or `asg.autoScalingGroupName` for string
operations.

The pattern was committed in `a13c5821` which added `concreteTemplateName`
to `LaunchTemplateConstruct` and `concreteAsgName` to
`AutoScalingGroupConstruct`, and updated all consumers in `factory.ts` to
use the concrete properties.

## How to prevent

- **Treat CDK L2 name properties as opaque tokens.** Unless a CDK property
  is documented as returning a concrete string (not a token), assume it may
  be a CloudFormation `Ref` or an `IResolvable`. Build concrete name strings
  independently using the same naming convention as the CDK prop.

- **Add TypeScript custom types for concrete names.** Declaring
  `concreteTemplateName: string` (not `launchTemplateName: string`) on
  construct interfaces makes the distinction explicit at compile time.

- **Do not pass CDK construct name properties to `addPropertyOverride()`.**
  Override values must be plain strings. CloudFormation tokens in override
  values cause silent or cryptic failures.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/constructs/compute/constructs/launch-template.ts:315-318 (read on 2026-04-29)
- Commit: a13c5821 — "fix(ami-refresh): commit concrete name properties — resolve TS2551 build failure" (read on 2026-04-29)
-->
