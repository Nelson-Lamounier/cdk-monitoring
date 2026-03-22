# @nelsonlamounier/cdk-governance-aspects

[![npm version](https://img.shields.io/npm/v/@nelsonlamounier/cdk-governance-aspects.svg)](https://www.npmjs.com/package/@nelsonlamounier/cdk-governance-aspects)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CDK Aspects for automated resource tagging and DynamoDB access governance. These aspects enforce consistent tagging and least-privilege data access policies at synthesis time — before any resources are deployed.

## Install

```bash
yarn add @nelsonlamounier/cdk-governance-aspects
```

> **Note:** `aws-cdk-lib` (≥ 2.170.0) and `constructs` (≥ 10.0.0) are peer dependencies.

## Aspects Included

### TaggingAspect

Applies a consistent 7-tag kebab-case schema to **every taggable resource** in a stack. Designed as the single source of truth for tags — eliminates scattered `.addTag()` calls across constructs.

**Tags applied:**

| Key | Source | Example |
|---|---|---|
| `project` | Config | `k8s-platform` |
| `environment` | Config | `development` |
| `owner` | Config | `nelson-l` |
| `component` | Config | `compute` |
| `managed-by` | Hardcoded | `cdk` |
| `version` | Config | `1.0.0` |
| `cost-centre` | Config (default: `platform`) | `infrastructure` |

**Usage:**

```typescript
import { TaggingAspect } from '@nelsonlamounier/cdk-governance-aspects';
import { Aspects, Stack } from 'aws-cdk-lib/core';

const stack = new Stack(app, 'MyStack');

Aspects.of(stack).add(new TaggingAspect({
    environment: 'production',
    project: 'k8s-platform',
    owner: 'nelson-l',
    component: 'compute',
    version: '2.1.0',
    costCentre: 'platform', // optional, defaults to 'platform'
}));
```

### EnforceReadOnlyDynamoDbAspect

Validates that ECS task roles only have **read-only** DynamoDB actions. Blocks `PutItem`, `DeleteItem`, `UpdateItem`, `BatchWriteItem`, and all admin actions (`CreateTable`, `DeleteTable`, etc.) at synthesis time.

This enforces the architectural boundary: reads happen directly from compute, writes go through API Gateway → Lambda.

**Usage:**

```typescript
import { EnforceReadOnlyDynamoDbAspect } from '@nelsonlamounier/cdk-governance-aspects';
import { Aspects, Stack } from 'aws-cdk-lib/core';

// Fail synthesis if task role has write access (default)
Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect());

// Warn only (useful during migration)
Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect({
    failOnViolation: false,
}));

// Custom role pattern
Aspects.of(computeStack).add(new EnforceReadOnlyDynamoDbAspect({
    roleNamePattern: 'nextjs-worker',
}));
```

**Forbidden actions:**

- **Write:** `PutItem`, `DeleteItem`, `UpdateItem`, `BatchWriteItem`
- **Admin:** `CreateTable`, `DeleteTable`, `UpdateTable`, `CreateGlobalTable`
- **Wildcard:** `dynamodb:*` (detected as including write actions)

## API Reference

### TagConfig

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `environment` | `string` | ✅ | — | Full environment name |
| `project` | `string` | ✅ | — | Project identifier |
| `owner` | `string` | ✅ | — | Owner shorthand |
| `component` | `string` | ✅ | — | Stack-level component |
| `version` | `string` | ✅ | — | Semantic version |
| `costCentre` | `CostCentre` | ❌ | `'platform'` | Cost-allocation centre |

### EnforceReadOnlyDynamoDbProps

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `failOnViolation` | `boolean` | ❌ | `true` | Fail synthesis or warn only |
| `roleNamePattern` | `string` | ❌ | `'taskrole'` | Role construct ID pattern to match |

## Licence

[MIT](./LICENSE)
