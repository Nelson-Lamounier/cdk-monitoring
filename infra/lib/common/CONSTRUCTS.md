# Common Constructs Library

> Reusable L3 CDK constructs with opinionated defaults, security hardening, and consistent patterns.

## Design Principles

1. **Inline Defaults** — Constructs provide dev-safe fallbacks via `?? literal`. No shared default objects.
2. **Config Layer Overrides** — Environment-specific values come from `configurations.ts` / `allocations.ts`, passed as props.
3. **Blueprint Pattern** — Constructs are pure blueprints. Stacks compose them and wire dependencies.
4. **Security by Default** — IMDSv2, EBS encryption, least-privilege IAM, enforceSSL.
5. **Tag Delegation** — Only component-specific tags here. Org tags applied by `TaggingAspect` at app level.

## Module Inventory

### Compute (`compute/`)

| Construct                    | File                         | Purpose                                                          |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `EcsClusterConstruct`        | `ecs/ecs-cluster.ts`         | ECS cluster with Fargate/EC2/Hybrid capacity, Container Insights |
| `EcsServiceConstruct`        | `ecs/ecs-service.ts`         | ECS service with deployment config, auto-scaling, Cloud Map      |
| `EcsTaskDefinitionConstruct` | `ecs/ecs-task-definition.ts` | Task definition with health checks, security hardening, logging  |
| `AutoScalingGroupConstruct`  | `auto-scaling-group.ts`      | ASG with rolling updates, signals, lifecycle hooks               |
| `LaunchTemplateConstruct`    | `launch-template.ts`         | Launch template with IMDSv2, GP3 EBS, IAM role                   |
| `Ec2InstanceConstruct`       | `ec2-instance.ts`            | Standalone EC2 with SSM access, CloudWatch logs                  |
| `LambdaFunctionConstruct`    | `lambda-function.ts`         | NodejsFunction with TypeScript bundling, DLQ, tracing            |

### Networking (`networking/`)

| Construct                          | File                               | Purpose                                            |
| ---------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `ApplicationLoadBalancerConstruct` | `elb/application-load-balancer.ts` | ALB with access logs, target groups, listeners     |
| `CloudFrontConstruct`              | `cloudfront.ts`                    | CloudFront with multi-origin, cache behaviors, WAF |
| `StandardVpcConstruct`             | `vpc-flow-logs.ts`                 | VPC with flow logs and KMS encryption              |
| `ApiGatewayConstruct`              | `api/api-gateway.ts`               | REST API with CORS, throttling, Lambda integration |
| `GatewayEndpointsConstruct`        | `api/gateway-endpoints.ts`         | VPC gateway endpoints for S3, DynamoDB             |

### Storage (`storage/`)

| Construct                     | File                | Purpose                                         |
| ----------------------------- | ------------------- | ----------------------------------------------- |
| `S3BucketConstruct`           | `s3-bucket.ts`      | S3 with encryption, versioning, lifecycle, CORS |
| `DynamoDbTableConstruct`      | `dynamodb-table.ts` | DynamoDB with GSI/LSI, TTL, PITR                |
| `EncryptedEbsVolumeConstruct` | `ebs-volume.ts`     | EBS volume with KMS encryption, GP3             |
| `EcrRepositoryConstruct`      | `ecr-repository.ts` | ECR with image scanning, lifecycle policies     |

### Security (`security/`)

| Construct                              | File                 | Purpose                                           |
| -------------------------------------- | -------------------- | ------------------------------------------------- |
| `BaseSecurityGroupConstruct`           | `security-group.ts`  | Bare SG with no default rules                     |
| `EcsSecurityGroupConstruct`            | `security-group.ts`  | Pre-configured SG for ECS (monitoring ports)      |
| `NextJsTaskSecurityGroupConstruct`     | `security-group.ts`  | SG for Next.js ECS tasks (ALB ingress only)       |
| `AcmCertificateDnsValidationConstruct` | `acm-certificate.ts` | Cross-account ACM certificate with DNS validation |

### Events (`events/`)

| Construct                  | File                  | Purpose                                       |
| -------------------------- | --------------------- | --------------------------------------------- |
| `EventBridgeRuleConstruct` | `eventbridge-rule.ts` | EventBridge rules with Lambda targets and DLQ |

### SSM (`ssm/`)

| Construct               | File                          | Purpose                                         |
| ----------------------- | ----------------------------- | ----------------------------------------------- |
| `SsmRunCommandDocument` | `ssm-run-command-document.ts` | Parameterized shell scripts via SSM Run Command |

## Default Value Strategy

```
┌─────────────────────────────────────────────────────┐
│  Stack (e.g. NextJsComputeStack)                    │
│                                                     │
│  configs = getNextJsConfigs(env)                    │
│         ↓                                           │
│  new AutoScalingGroupConstruct(this, 'ASG', {       │
│      minCapacity: configs.asg.minCapacity, // 2     │
│  })                                                 │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Construct (auto-scaling-group.ts)                  │
│                                                     │
│  const minCapacity = props.minCapacity ?? 1;        │
│  // ↑ inline fallback for dev safety                │
└─────────────────────────────────────────────────────┘
```

- **Layer 1** — `configurations.ts` / `allocations.ts`: environment-specific values (prod: 2, dev: 1)
- **Layer 2** — Construct inline `?? literal`: dev-safe fallback when config doesn't specify a value

### What Remains in `defaults.ts`

| Export                                                              | Type      | Purpose                         |
| ------------------------------------------------------------------- | --------- | ------------------------------- |
| `DEFAULT_REGION`, `DEFAULT_VPC_CIDR`, `MAX_AZS`                     | Constants | Global infrastructure constants |
| `DEFAULT_VOLUME_SIZE_GB`, `GP3_BASELINE_IOPS/THROUGHPUT`            | Constants | EBS baseline specs              |
| `SSH_PORT`, `GRAFANA_PORT`, `PROMETHEUS_PORT`, `NODE_EXPORTER_PORT` | Constants | Well-known service ports        |
| `VPC_DEFAULTS`, `EBS_DEFAULTS`                                      | Objects   | VPC/EBS configuration bundles   |
| `MONITORING_PORTS`, `MONITORING_APP_TAG`, `DEFAULT_TAGS`            | Objects   | Monitoring-specific constants   |
| `DOCKER_VERSIONS`                                                   | Object    | Pinned container image versions |
| `LOG_RETENTION`                                                     | Object    | Environment-keyed log retention |
| `ComputeMode`, `EcsCapacityType`, `EcsLaunchType`                   | Enums     | Type-safe mode selectors        |
| `S3_*`, `PORTFOLIO_GSI*`                                            | Constants | S3/DynamoDB global defaults     |

## Consuming Stacks

| Stack                  | Constructs Used                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NextJS Compute**     | `AutoScalingGroupConstruct`, `LaunchTemplateConstruct`                                                                                                                  |
| **NextJS Application** | `EcsServiceConstruct`, `EcsTaskDefinitionConstruct`                                                                                                                     |
| **NextJS Networking**  | `ApplicationLoadBalancerConstruct`, `BaseSecurityGroupConstruct`, `NextJsTaskSecurityGroupConstruct`, `AcmCertificateDnsValidationConstruct`, `LambdaFunctionConstruct` |
| **NextJS Edge**        | `CloudFrontConstruct`, `LambdaFunctionConstruct`                                                                                                                        |
| **NextJS Data**        | `S3BucketConstruct`, `DynamoDbTableConstruct`                                                                                                                           |
| **NextJS API**         | `ApiGatewayConstruct`, `LambdaFunctionConstruct`                                                                                                                        |
| **Monitoring Compute** | `AutoScalingGroupConstruct`, `LaunchTemplateConstruct`, `Ec2InstanceConstruct`, `BaseSecurityGroupConstruct`                                                            |
| **Monitoring Storage** | `S3BucketConstruct`, `EncryptedEbsVolumeConstruct`                                                                                                                      |
| **Monitoring SSM**     | `SsmRunCommandDocument`, `LambdaFunctionConstruct`                                                                                                                      |
