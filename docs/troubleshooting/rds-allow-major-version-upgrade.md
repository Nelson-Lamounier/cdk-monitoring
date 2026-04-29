---
title: RDS allowMajorVersionUpgrade Required for PostgreSQL Major Version Upgrade
type: troubleshooting
tags: [aws-cdk, rds, postgresql, cloudformation]
sources:
  - infra/lib/stacks/kubernetes/platform-rds-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

## Symptom

A CDK stack update that changes the RDS PostgreSQL engine version across a
major version boundary (e.g. 16.x → 18.x) fails with a vague CloudFormation
error on the `AWS::RDS::DBInstance` resource. The error message does not
mention `AllowMajorVersionUpgrade` by name, and the stack rolls back to the
previous version.

## Root cause

`AWS::RDS::DBInstance` blocks a major version upgrade unless
`AllowMajorVersionUpgrade: true` is set on the resource. CloudFormation
enforces this constraint as a safety guard — major version upgrades are
irreversible and can break application compatibility.

The CDK L2 `DatabaseInstance` construct exposes this as the
`allowMajorVersionUpgrade` prop. When absent (the default is `false`), any
change to `engine.engineVersion` that crosses a major version boundary fails
at CloudFormation deploy time.

The `platform-rds-stack.ts` sets this prop explicitly because the stack
started on PostgreSQL 16 and may upgrade to PostgreSQL 18
([`platform-rds-stack.ts:96`](../../infra/lib/stacks/kubernetes/platform-rds-stack.ts)):

```typescript
this.instance = new rds.DatabaseInstance(this, 'Instance', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_18_2,
  }),
  allowMajorVersionUpgrade: true,
  // ...
});
```

## How to diagnose

```bash
# Check CloudFormation events for the failure reason
aws cloudformation describe-stack-events \
  --stack-name <rds-stack-name> \
  --query 'StackEvents[?ResourceStatus==`UPDATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table \
  --profile dev-account

# Verify the current engine version on the live instance
aws rds describe-db-instances \
  --db-instance-identifier <instance-id> \
  --query 'DBInstances[0].EngineVersion' \
  --profile dev-account
```

If the failure is `allowMajorVersionUpgrade`-related, the `ResourceStatusReason`
will mention version upgrade constraints but may not name the missing property.

```bash
# Check if the prop is set in CDK source
grep -n "allowMajorVersionUpgrade" infra/lib/stacks/kubernetes/platform-rds-stack.ts
```

## How to fix

Add `allowMajorVersionUpgrade: true` to the `DatabaseInstance` props in CDK:

```typescript
new rds.DatabaseInstance(this, 'Instance', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_18_2,
  }),
  allowMajorVersionUpgrade: true,
  // ... rest of props
});
```

Deploy the updated stack. CloudFormation will then allow the major version
upgrade. The upgrade itself may take 15–30 minutes for the instance to
become available.

Verify the upgrade completed:

```bash
aws rds describe-db-instances \
  --db-instance-identifier <instance-id> \
  --query 'DBInstances[0].{Status:DBInstanceStatus,Version:EngineVersion}' \
  --profile dev-account
```

## How to prevent

- **Set `allowMajorVersionUpgrade: true` whenever the engine version may
  increase across a major boundary.** This is a one-time prop that has no
  runtime cost. Setting it proactively prevents the CloudFormation failure
  from blocking a future upgrade.

- **Also export PostgreSQL upgrade logs.** The `platform-rds-stack.ts`
  includes `cloudwatchLogsExports: ['postgresql', 'upgrade']` — the
  `upgrade` log group captures major version upgrade progress and errors.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/kubernetes/platform-rds-stack.ts:81-105 (read on 2026-04-29)
- Commit: 6bcca0bf — "fix(rds): add allowMajorVersionUpgrade for PostgreSQL 16 → 18 upgrade" (read on 2026-04-29)
-->
