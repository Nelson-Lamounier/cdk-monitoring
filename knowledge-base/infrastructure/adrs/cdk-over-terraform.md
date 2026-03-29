---
title: "AWS CDK over Terraform"
doc_type: adr
domain: infrastructure
tags:
  - cdk
  - terraform
  - iac
  - typescript
  - cloudformation
related_docs:
  - infrastructure/stack-overview.md
  - infrastructure/security-implementation.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
---

# ADR: AWS CDK over Terraform

**Date:** 2026-03-22
**Status:** Accepted

## Context

The project requires infrastructure-as-code to provision ~30 CloudFormation stacks across 3 projects (Kubernetes, Bedrock AI, Shared). The two primary IaC options evaluated were AWS CDK (TypeScript) and Terraform (HCL).

## Decision

I chose AWS CDK with TypeScript for the following reasons:

1. **Type safety** — TypeScript with `strict: true` catches misconfigurations at compile time. The entire config layer (`infra/lib/config/kubernetes/configurations.ts`) uses typed interfaces like `K8sPortRule`, `K8sSecurityGroupConfig`, and `K8sConfigs`. Changing a port number from `number` to `string` breaks the build immediately, not at deploy time.

2. **L2/L3 constructs** — CDK's higher-level constructs reduce boilerplate. For example, `SecurityGroupConstruct` iterates over a config array to create all 18 intra-cluster SG rules from a typed `K8sPortRule[]` — this would require 18 separate `aws_security_group_rule` resources in Terraform.

3. **CDK-nag compliance** — `AwsSolutions` pack checks are applied via a custom aspect (`infra/lib/aspects/cdk-nag-aspect.ts`) that runs at synth time on every stack. Suppressions must include explicit justifications. This is equivalent to running a policy-as-code tool but integrated directly into the synthesis step.

4. **Factory pattern** — CDK's OOP model supports the project factory pattern (`infra/lib/factories/project-interfaces.ts`) where each project (Kubernetes, Bedrock, Shared) implements `IProjectFactory`. The CLI selects the factory via `-c project=k8s`, and the factory creates all stacks with correct dependency ordering.

5. **Shared language** — Lambda handlers, CDK stacks, integration tests, and MCP servers are all TypeScript. One `tsconfig.json` setup, one linting config, one CI pipeline.

## Evidence

Key implementation files:

- `infra/lib/config/kubernetes/configurations.ts` — 655 lines of typed config (SG rules, instance types, versions, edge config)
- `infra/lib/aspects/cdk-nag-aspect.ts` — AwsSolutions pack enforcement
- `infra/lib/factories/project-interfaces.ts` — IProjectFactory interface
- `infra/lib/projects/kubernetes/factory.ts` — Kubernetes factory (12 stacks)
- `infra/lib/projects/bedrock/factory.ts` — Bedrock AI factory (5 stacks)
- `infra/lib/constructs/` — Reusable constructs: SecurityGroup, SsmParameterStore, AutoScalingGroup, LaunchTemplate, S3Bucket, NetworkLoadBalancer

## Consequences

### Benefits

- **Compile-time safety** across 30+ stacks — typos in resource names or misconfigured props are caught by `tsc`
- **Reusable construct library** — `SecurityGroupConstruct`, `SsmParameterStoreConstruct`, `LaunchTemplateConstruct` used across multiple stacks
- **Single-language stack** — CDK, Lambda handlers, tests, and MCP servers all share TypeScript, reducing cognitive overhead
- **CDK-nag integration** — policy compliance checked at synth time, not as a separate CI step

### Trade-offs

- **AWS lock-in** — CDK generates CloudFormation, which is AWS-specific. Terraform's multi-cloud support is sacrificed
- **CloudFormation limits** — CDK inherits CFn's 500-resource limit per stack, requiring the 12-stack split
- **Steeper learning curve** — CDK's construct model and jsii type system add complexity beyond raw CFn templates
- **Synth time** — Full synthesis of 12 K8s stacks takes ~15 seconds; Terraform plan is typically faster

## Transferable Skills Demonstrated

- **Type-safe Infrastructure as Code** — using TypeScript with `strict: true` across 30+ CloudFormation stacks catches misconfigurations at compile time, not deploy time. This discipline transfers directly to any CDK, Pulumi, or CDKTF environment.
- **Reusable construct library** — building shared constructs (`SecurityGroupConstruct`, `LaunchTemplateConstruct`, `SsmParameterStoreConstruct`) demonstrates software engineering practices applied to infrastructure code. The same pattern is used by platform teams to standardise resource creation across development squads.
- **Policy-as-code compliance** — integrating CDK-nag AwsSolutions checks into the synthesis step makes security compliance automatic, not afterthought. Applicable to any team needing continuous compliance without a separate policy pipeline.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*
## Summary

This ADR documents the decision to use AWS CDK (TypeScript) over Terraform for infrastructure as code, highlighting type safety, single-language stack benefits, and native AWS CloudFormation integration as key factors.

## Keywords

cdk, terraform, infrastructure-as-code, typescript, cloudformation, aws, iac, constructs
