# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-19

### Added

- `TaggingAspect` — applies a consistent 7-tag kebab-case schema to all taggable resources
- `EnforceReadOnlyDynamoDbAspect` — validates ECS task roles have read-only DynamoDB access
- Configurable `failOnViolation` mode (error or warning)
- Configurable `roleNamePattern` for targeting specific IAM roles
- Wildcard action detection (`dynamodb:*`, prefix wildcards)
- Full TypeScript type exports (`TagConfig`, `CostCentre`, `EnforceReadOnlyDynamoDbProps`)
- Exported constants: `DYNAMODB_WRITE_ACTIONS`, `DYNAMODB_ADMIN_ACTIONS`, `FORBIDDEN_DYNAMODB_ACTIONS`
