---
title: CloudFormation Rejects $Latest/$Default as ASG LaunchTemplate Version
type: troubleshooting
tags: [aws-cdk, cloudformation, auto-scaling, launch-template, ami-refresh]
sources:
  - infra/lib/constructs/compute/constructs/auto-scaling-group.ts
  - infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

A CloudFormation stack update rolls back with a cryptic error on the
`AWS::AutoScaling::AutoScalingGroup` resource after adding or modifying
a `LaunchTemplate` property. The update was intended to make the ASG
always use the latest or default Launch Template version. The specific
error does not mention `$Latest` or `$Default` by name.

The `ControlPlane-development` stack exhibited this rollback after a
`addPropertyOverride` escape hatch was added to set the LT version to
`$Latest` at the ASG resource level (commit `e411137d`).

## Root cause

CloudFormation hard-rejects `$Latest` and `$Default` as the `Version`
field in the `AWS::AutoScalingGroup::LaunchTemplateSpecification` at
the **resource definition level**. These strings are valid at the AWS
API level — `UpdateAutoScalingGroup` accepts `$Default` at runtime — but
CloudFormation's resource schema validation rejects them before any API
call is made, causing an immediate rollback.

The CDK L2 `AutoScalingGroup` writes a pinned numeric version at synth
time (e.g. `$Default` resolved to a CloudFormation `Ref`). An `addPropertyOverride`
escape hatch that overrides this to the literal string `$Latest` appears
valid in CDK but is rejected by CloudFormation at deploy time.

The comment at
[`auto-scaling-group.ts:322-324`](../../infra/lib/constructs/compute/constructs/auto-scaling-group.ts)
explains the invariant:

```typescript
// Note: CloudFormation rejects $Latest/$Default as LT version in ASG resources.
// The AMI refresh Lambda updates the ASG version via UpdateAutoScalingGroup API
// (which does allow $Default at runtime), so no override is needed here.
```

## How to diagnose

```bash
# Check CloudFormation events for the stack rollback reason
aws cloudformation describe-stack-events \
  --stack-name ControlPlane-development \
  --query 'StackEvents[?ResourceStatus==`UPDATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table \
  --profile dev-account

# Look for the ASG resource specifically
aws cloudformation describe-stack-events \
  --stack-name ControlPlane-development \
  --query 'StackEvents[?ResourceType==`AWS::AutoScaling::AutoScalingGroup`]' \
  --profile dev-account
```

Look for any `addPropertyOverride` in the ASG construct targeting the
`LaunchTemplate.Version` path:

```bash
grep -rn "addPropertyOverride\|LaunchTemplate.*Version\|\$Latest\|\$Default" \
  infra/lib/constructs/compute/
```

## How to fix

Remove the `addPropertyOverride` entirely. Do not set the LT version to
`$Latest` or `$Default` in the CloudFormation resource definition.

Instead, have the AMI refresh Lambda call `UpdateAutoScalingGroup` via the
AWS API after creating a new LT version and setting it as default. The API
accepts `$Default` at runtime:

```typescript
// In the AMI refresh Lambda handler
await autoScaling.updateAutoScalingGroup({
  AutoScalingGroupName: asgName,
  LaunchTemplate: {
    LaunchTemplateName: ltName,
    Version: '$Default',  // valid at API level, rejected by CloudFormation
  },
});
```

The Lambda requires `autoscaling:UpdateAutoScalingGroup` in its IAM role.
This is already present after commit `e411137d` which added the permission
to
[`update-launch-template.ts`](../../infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts).

## How to prevent

- **Never use `addPropertyOverride` to set LT version to `$Latest` or
  `$Default`.** This is a CloudFormation validation constraint, not a CDK
  bug. The CDK escape hatch bypasses CDK-level validation but cannot
  bypass CloudFormation's resource schema.

- **Use the API path for runtime version management.** ASG Launch Template
  version changes that need to track `$Default` belong in Lambda/SDK code,
  not in CloudFormation resource definitions.

- **Verify override values against the CloudFormation resource schema.**
  The `AWS::AutoScaling::AutoScalingGroup` `LaunchTemplateSpecification`
  requires a numeric version string or a CloudFormation token — not the
  AWS API convenience strings.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/constructs/compute/constructs/auto-scaling-group.ts (read on 2026-04-29)
- Source: infra/lib/constructs/events/ami-refresh/handlers/update-launch-template.ts (referenced via commit e411137d on 2026-04-29)
- Commit: e411137d — "fix(ami-refresh): replace $Latest ASG override with runtime UpdateAutoScalingGroup" (read on 2026-04-29)
-->
