# Next.js Application Platform — Subsystem Deep-Dive

> **Companion document** to
> [NEXTJS-INFRASTRUCTURE-REFERENCE.md](../../../docs/NEXTJS-INFRASTRUCTURE-REFERENCE.md)
> (CDK architecture) and
> [monitoring-observability-platform.md](../monitoring/monitoring-observability-platform.md)
> (monitoring subsystems).
>
> This document explains the _how_ and _why_ at the networking, security,
> runtime, and pipeline level — the subsystem knowledge that sits beneath the
> CDK constructs.

---

## Table of Contents

| #   | Section                                                                              | Subsystem     |
| --- | ------------------------------------------------------------------------------------ | ------------- |
| 1   | [ECS Networking — `awsvpc` Mode Deep-Dive](#1-ecs-networking--awsvpc-mode-deep-dive) | Networking    |
| 2   | [IAM Policy Anatomy](#2-iam-policy-anatomy)                                          | Security      |
| 3   | [Container Security Hardening](#3-container-security-hardening)                      | Security      |
| 4   | [Sidecar Container Architecture](#4-sidecar-container-architecture)                  | Observability |
| 5   | [DynamoDB Single-Table Design](#5-dynamodb-single-table-design)                      | Data          |
| 6   | [CloudFront Multi-Origin Routing](#6-cloudfront-multi-origin-routing)                | Edge          |
| 7   | [WAF Rules — Layer-by-Layer Analysis](#7-waf-rules--layer-by-layer-analysis)         | Security      |
| 8   | [Lambda Handler Architecture](#8-lambda-handler-architecture)                        | Compute       |
| 9   | [Pipeline YAML — Step-by-Step Analysis](#9-pipeline-yaml--step-by-step-analysis)     | CI/CD         |
| 10  | [SSM Parameter Discovery Model](#10-ssm-parameter-discovery-model)                   | Configuration |
| 11  | [Deployment Scripts — TypeScript CLI](#11-deployment-scripts--typescript-cli)        | Tooling       |
| 12  | [Cross-Region Patterns](#12-cross-region-patterns)                                   | Architecture  |

---

## 1. ECS Networking — `awsvpc` Mode Deep-Dive

> Source: [`compute-stack.ts`](compute/compute-stack.ts),
> [`application-stack.ts`](application/application-stack.ts),
> [`ecs-service.ts`](../../common/compute/constructs/ecs/ecs-service.ts)

### 1.1 ENI Lifecycle

Every ECS task running in `awsvpc` mode gets its own **Elastic Network Interface (ENI)**.
This fundamentally changes how networking works compared to `bridge` or `host` modes:

```
┌─────────────────────────────── EC2 Instance ─────────────────────────────────┐
│                                                                              │
│  ┌─── Primary ENI (eth0) ───┐   ┌─── Task ENI (eni-xxx) ──┐                │
│  │  IP: 10.0.1.100          │   │  IP: 10.0.1.201         │                │
│  │  SG: ecs-instance-sg     │   │  SG: nextjs-task-sg     │                │
│  │                          │   │                         │                │
│  │  Used by:                │   │  Used by:               │                │
│  │  • ECS Agent             │   │  • Next.js container    │                │
│  │  • SSM Agent             │   │  • Promtail sidecar     │                │
│  │  • CloudWatch Agent      │   │  • Alloy sidecar        │                │
│  └──────────────────────────┘   └─────────────────────────┘                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key properties:**

| Property              | Value                       | Why                                                                        |
| --------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Network mode          | `awsvpc`                    | Each task gets a unique IP from the VPC subnet                             |
| Security group        | Per-task (`nextjs-task-sg`) | Traffic filtering at task level, not instance level                        |
| Subnet placement      | `PUBLIC`                    | Avoids NAT Gateway cost (~$30-90/mo) for this portfolio project            |
| `assignPublicIp`      | `false` (EC2 launch type)   | EC2 instances have their own public IP; task ENIs inherit NAT via instance |
| `ECS_ENABLE_TASK_ENI` | `true`                      | Required for `awsvpc` on EC2 launch type                                   |

### 1.2 User Data — ECS Agent Configuration

The EC2 user data in [`compute-stack.ts`](compute/compute-stack.ts) configures the ECS agent:

```bash
set -euo pipefail
trap 'echo "UserData FAILED"; /opt/aws/bin/cfn-signal -e 1 ...' ERR

echo "ECS_CLUSTER=nextjs-cluster-development" >> /etc/ecs/ecs.config
echo "ECS_ENABLE_TASK_IAM_ROLE=true"          >> /etc/ecs/ecs.config
echo "ECS_ENABLE_TASK_ENI=true"               >> /etc/ecs/ecs.config
echo "ECS_AWSVPC_BLOCK_IMDS=true"             >> /etc/ecs/ecs.config
```

| Setting                    | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `ECS_CLUSTER`              | Tells agent which cluster to join                                           |
| `ECS_ENABLE_TASK_IAM_ROLE` | Enables per-task IAM roles via credential proxy                             |
| `ECS_ENABLE_TASK_ENI`      | Enables `awsvpc` networking — creates trunk ENI for task ENI allocation     |
| `ECS_AWSVPC_BLOCK_IMDS`    | **Security**: Blocks tasks from reaching instance metadata service (IMDSv2) |

### 1.3 Security Group Rules

Two distinct security groups operate at different layers:

**ECS Instance Security Group** (from `EcsSecurityGroupConstruct`):

| Direction | Protocol | Port | Source/Dest   | Purpose                          |
| --------- | -------- | ---- | ------------- | -------------------------------- |
| Ingress   | TCP      | 9100 | Monitoring SG | Prometheus scrapes Node Exporter |
| Egress    | TCP      | 443  | 0.0.0.0/0     | ECS Agent → AWS APIs, ECR pulls  |

**Next.js Task Security Group** (from `NextJsTaskSecurityGroupConstruct`):

| Direction | Protocol | Port | Source/Dest   | Purpose                           |
| --------- | -------- | ---- | ------------- | --------------------------------- |
| Ingress   | TCP      | 3000 | ALB SG        | ALB health checks and traffic     |
| Ingress   | TCP      | 3000 | Monitoring SG | Prometheus scrapes `/api/metrics` |
| Egress    | TCP      | 443  | 0.0.0.0/0     | AWS APIs (DynamoDB, S3, SSM, SES) |

### 1.4 Cloud Map Service Discovery

```
ECS Task Start → Register IP in Cloud Map → DNS: nextjs-app.nextjs.local → A record: 10.0.1.201
ECS Task Stop  → Deregister IP from Cloud Map → DNS record removed
```

Configuration from [`application-stack.ts`](application/application-stack.ts):

```typescript
cloudMapOptions: {
    cloudMapNamespace: mon.cloudMapNamespace,
    name: 'nextjs-app',              // → nextjs-app.nextjs.local
    dnsRecordType: cloudmap.DnsRecordType.A,
    dnsTtl: cdk.Duration.seconds(10), // Fast deregistration
}
```

The monitoring stack's Prometheus instance uses `DiscoverInstances` API to find
task IPs without hard-coding addresses.

---

## 2. IAM Policy Anatomy

> Source: [`compute-stack.ts`](compute/compute-stack.ts),
> [`application-stack.ts`](application/application-stack.ts)

The platform uses **three distinct IAM roles** following the principle of least privilege:

### 2.1 EC2 Instance Role (`nextjs-ec2-instance-{env}`)

**Trust Policy:**

```json
{
  "Principal": { "Service": "ec2.amazonaws.com" },
  "Action": "sts:AssumeRole"
}
```

**Managed Policies:**

| Policy                                | Purpose                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| `AmazonEC2ContainerServiceforEC2Role` | ECS Agent: register instance, pull images, report status |
| `AmazonSSMManagedInstanceCore`        | SSM Agent: Session Manager, Run Command                  |
| `CloudWatchAgentServerPolicy`         | CloudWatch Agent: metrics and logs                       |

**Why these three?** The EC2 instance is the _host_ — it runs infrastructure services (ECS Agent,
SSM Agent) that need broad access, but it never touches application data.

### 2.2 Task Execution Role (`nextjs-task-exec-{env}`)

**Trust Policy:**

```json
{
  "Principal": { "Service": "ecs-tasks.amazonaws.com" },
  "Action": "sts:AssumeRole"
}
```

This role is used by the **ECS Agent** (not the application) to set up the container environment:

| Sid                    | Actions                                                                                                           | Resource                                                    | Purpose                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| — (managed)            | `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` | `*`                                                         | Pull images from ECR                  |
| `CloudWatchLogsAccess` | `logs:CreateLogStream`, `logs:PutLogEvents`                                                                       | `arn:aws:logs:{region}:{account}:log-group:/ecs/nextjs/*:*` | Send container logs                   |
| `SsmSecretsAccess`     | `ssm:GetParameters`, `ssm:GetParameter`                                                                           | `arn:aws:ssm:{region}:{account}:parameter/nextjs/{env}/*`   | Inject SSM secrets into container env |
| `SecretsManagerAccess` | `secretsmanager:GetSecretValue`                                                                                   | Pattern-matched ARN                                         | Inject Secrets Manager values         |
| `KmsDecryptSecrets`    | `kms:Decrypt`                                                                                                     | Specific KMS key ARN                                        | Decrypt encrypted secrets             |

**Key design decision:** SSM and Secrets Manager access is scoped to the exact parameter path prefix,
not `*`. This prevents a compromised task from reading secrets belonging to other environments.

### 2.3 Task Role (`nextjs-task-role-{env}`)

**Trust Policy:**

```json
{
  "Principal": { "Service": "ecs-tasks.amazonaws.com" },
  "Action": "sts:AssumeRole"
}
```

This role is used by the **running application** code:

| Sid                  | Actions                                               | Resource                             | Purpose                       |
| -------------------- | ----------------------------------------------------- | ------------------------------------ | ----------------------------- |
| `S3ReadAccess`       | `s3:GetObject`, `s3:GetObjectVersion`                 | `arn:aws:s3:::nextjs-assets-{env}/*` | Read article images for SSR   |
| `DynamoDbReadAccess` | `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan` | Table ARN + `/index/*`               | SSR data fetching (read-only) |

**Why read-only?** Writes to DynamoDB go through API Gateway → Lambda (a separate execution path).
The ECS task only performs server-side rendering, which requires read access only.

### 2.4 Permissions Boundary

All three roles accept an optional `permissionsBoundaryArn`:

```typescript
const permissionsBoundary = props.permissionsBoundaryArn
  ? iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      "PermissionsBoundary",
      props.permissionsBoundaryArn,
    )
  : undefined;
```

This allows organization-level IAM controls to cap what these roles can do, even if the
CDK-generated policies are broader than intended.

---

## 3. Container Security Hardening

> Source: [`application-stack.ts`](application/application-stack.ts),
> [`ecs-task-definition.ts`](../../common/compute/constructs/ecs/ecs-task-definition.ts)

### 3.1 Security Features Matrix

| Feature                  | Value                                       | Linux Mechanism              | Why                                                                       |
| ------------------------ | ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `user`                   | `1001`                                      | `--user 1001:1001`           | Non-root execution — limits blast radius of container escape              |
| `readonlyRootFilesystem` | `false`                                     | `ReadonlyRootfs` in OCI spec | Next.js ISR writes to `/app/.next/server/` at runtime (revalidated pages) |
| `tmpfsVolumes`           | `[{ path: '/app/.next/cache', size: 256 }]` | `tmpfs` mount (RAM-backed)   | Fast build cache without persistent disk writes                           |
| `initProcessEnabled`     | `true`                                      | `--init` (tini)              | Reaps zombie processes from Next.js child workers                         |
| `dropAllCapabilities`    | `true`                                      | `--cap-drop=ALL`             | Removes all Linux capabilities (NET_RAW, SYS_ADMIN, etc.)                 |
| `privileged`             | `false`                                     | —                            | Never run in privileged mode                                              |
| `stopTimeoutSeconds`     | `30`                                        | SIGTERM → wait → SIGKILL     | Graceful shutdown for in-flight SSR requests                              |
| `nofileLimit`            | `65536`                                     | `RLIMIT_NOFILE`              | Prevents "too many open files" under load                                 |

### 3.2 Why `readonlyRootFilesystem: false` for Next.js

Unlike the monitoring containers, the Next.js container **cannot** use a read-only root filesystem.
Here's why:

```
ISR lifecycle:
1. User requests /articles/my-slug
2. Next.js checks if cached page exists in /app/.next/server/pages/
3. If stale (beyond revalidate period), regenerates page
4. Writes new HTML to /app/.next/server/pages/articles/my-slug.html  ← WRITE to root FS
5. Subsequent requests served from this cached file
```

If `readonlyRootFilesystem: true`, step 4 would fail with `EROFS: read-only file system`.
The `tmpfs` mount at `/app/.next/cache` handles the _build cache_ (webpack artifacts),
but ISR pages are written to `/app/.next/server/` which is part of the root filesystem.

**Security is maintained through other layers:**

- Non-root user (`1001`) — cannot modify system files
- `awsvpc` isolation — task has its own network namespace
- Security group — only ALB and monitoring can reach port 3000
- Dropped capabilities — cannot escalate privileges

### 3.3 Health Check Deep-Dive

```typescript
healthCheck: {
    command: [
        'CMD', 'node', '-e',
        "require('http').get('http://localhost:3000/api/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
    ],
    interval: 30,    // Check every 30 seconds
    timeout: 5,      // Fail if no response in 5 seconds
    retries: 3,      // 3 consecutive failures = unhealthy
    startPeriod: 60,  // Ignore failures for first 60s (cold start)
}
```

**Why `CMD` not `CMD-SHELL`?** `CMD` executes the command directly without `/bin/sh -c`,
removing the shell overhead and avoiding issues if the container is a distroless image.

**Why `node -e` not `curl`?** The Next.js container uses a minimal Node.js base image
(`node:20-alpine`). `curl` may not be installed. `node -e` is always available and
avoids adding a dependency.

---

## 4. Sidecar Container Architecture

> Source: [`application-stack.ts`](application/application-stack.ts) — methods
> `addPromtailSidecar`, `addAlloySidecar`, `addNodeExporterDaemon`

### 4.1 Architecture Overview

```
┌─────────────────────── ECS Task (awsvpc, port 3000) ──────────────────────────┐
│                                                                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐             │
│  │   nextjs-app     │  │    promtail      │  │     alloy        │             │
│  │   (essential)    │  │  (non-essential)  │  │  (non-essential) │             │
│  │                  │  │                  │  │                  │             │
│  │  Port: 3000      │  │  Port: 9080      │  │  Port: 4317      │             │
│  │  CPU: 512        │  │  CPU: 64         │  │  CPU: 64         │             │
│  │  Mem: 896 MiB    │  │  Mem: 128 MiB    │  │  Mem: 128 MiB    │             │
│  │                  │  │                  │  │                  │             │
│  │  Writes logs to  │──│  Reads logs from │  │  OTLP receiver   │             │
│  │  /var/log/app/   │  │  /var/log/app/   │  │  localhost:4317  │             │
│  │                  │  │                  │  │                  │             │
│  │  Sends traces to │──│──────────────────│──│  ← gRPC traces   │             │
│  │  localhost:4317  │  │                  │  │  → Tempo          │             │
│  └──────────────────┘  └──────┬───────────┘  └──────┬───────────┘             │
│                               │                      │                         │
│                        Loki push API           Tempo OTLP                      │
│                               ↓                      ↓                         │
│                    http://monitoring:3100    http://monitoring:4317             │
└────────────────────────────────────────────────────────────────────────────────┘

┌──────────────── Separate ECS Daemon Service (HOST networking) ────────────────┐
│  ┌──────────────────┐                                                         │
│  │  node-exporter   │  Bind mounts: /proc, /sys, /                            │
│  │  Port: 9100      │  Network: HOST (uses instance SG, not task SG)          │
│  │  read-only FS    │  Prometheus scrapes: http://<instance-ip>:9100/metrics  │
│  └──────────────────┘                                                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Promtail — Config Injection Pattern

Promtail cannot mount config files from the host in ECS (no Kubernetes ConfigMaps).
The solution: inject the entire YAML config as an **environment variable** and pipe it to stdin:

```typescript
entryPoint: ['/bin/sh', '-c'],
command: ['echo "$PROMTAIL_CONFIG" | /usr/bin/promtail -config.expand-env=true -config.file=/dev/stdin'],
```

**How it works:**

1. CDK builds the YAML config as a TypeScript string
2. The string is set as the `PROMTAIL_CONFIG` environment variable
3. At runtime, the shell echoes the variable and pipes it to Promtail's stdin
4. `-config.file=/dev/stdin` tells Promtail to read config from standard input
5. `-config.expand-env=true` resolves `${LOKI_ENDPOINT}` from the environment

**The config itself:**

```yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0 # Disabled — not needed in sidecar mode
positions:
  filename: /tmp/positions.yaml # tmpfs mount — tracks which log lines are sent
clients:
  - url: ${LOKI_ENDPOINT} # Resolved at runtime from env var
scrape_configs:
  - job_name: nextjs-app
    static_configs:
      - targets: [localhost]
        labels:
          job: nextjs
          environment: development
          __path__: /var/log/app/*.log
```

### 4.3 Alloy — OTLP Trace Collection

The Alloy sidecar receives OpenTelemetry traces from the Next.js app via gRPC:

```
Next.js App                    Alloy Sidecar                  Tempo
  │                              │                              │
  │  OTEL_EXPORTER_OTLP_ENDPOINT │                              │
  │  = http://localhost:4317     │                              │
  │  ──── gRPC traces ──────────►│                              │
  │                              │  TEMPO_ENDPOINT              │
  │                              │  = http://10.0.x.x:4317     │
  │                              │  ──── gRPC forward ─────────►│
```

**Why localhost?** Within an `awsvpc` task, all containers share the same network namespace.
`localhost:4317` in the Next.js container reaches Alloy's port 4317 directly — no DNS
resolution, no network hop.

### 4.4 Node Exporter — HOST Networking

Node Exporter is a **separate daemon service** (not a sidecar) because:

1. **HOST networking** — it needs access to `/proc`, `/sys`, and the root filesystem
2. **Daemon scheduling** — one per EC2 instance, not one per task
3. **No task security group** — HOST mode inherits the EC2 instance's security group

```typescript
nodeExporterTaskDef.addVolume({ name: 'proc', host: { sourcePath: '/proc' } });
nodeExporterTaskDef.addVolume({ name: 'sys',  host: { sourcePath: '/sys' }  });
nodeExporterTaskDef.addVolume({ name: 'rootfs', host: { sourcePath: '/' }   });

// Mount as read-only inside container
{ sourceVolume: 'proc',   containerPath: '/host/proc',   readOnly: true }
{ sourceVolume: 'sys',    containerPath: '/host/sys',    readOnly: true }
{ sourceVolume: 'rootfs', containerPath: '/host/rootfs', readOnly: true }
```

The `--path.procfs=/host/proc` flag tells Node Exporter to read host metrics from
the bind-mounted paths instead of the container's own `/proc`.

---

## 5. DynamoDB Single-Table Design

> Source: [`data-stack.ts`](data/data-stack.ts)

### 5.1 Table Schema

```
Table: nextjs-personal-portfolio-{env}
─────────────────────────────────────
PK (pk)          │ SK (sk)                  │ Entity
─────────────────┼──────────────────────────┼──────────
ARTICLE#my-slug  │ METADATA                 │ Article metadata
ARTICLE#my-slug  │ CONTENT#v1               │ Article content (versioned)
EMAIL#user@x.com │ SUBSCRIPTION             │ Email subscription
```

### 5.2 Global Secondary Indexes

**GSI1 (`gsi1-status-date`)** — Query patterns:

- Articles: `gsi1pk = STATUS#published`, `gsi1sk = 2024-01-15#my-slug` → List published articles sorted by date
- Subscriptions: `gsi1pk = ENTITY#EMAIL`, `gsi1sk = 1705012800` → List all subscriptions by timestamp

**GSI2 (`gsi2-tag-date`)** — Query pattern:

- Articles: `gsi2pk = TAG#aws`, `gsi2sk = 2024-01-15#my-slug` → Filter articles by tag

### 5.3 Design Decisions

| Decision            | Value                      | Why                                                                       |
| ------------------- | -------------------------- | ------------------------------------------------------------------------- |
| Billing mode        | `PAY_PER_REQUEST`          | Unpredictable traffic for a portfolio site                                |
| TTL                 | Enabled on `ttl` attribute | Pending (unverified) subscriptions expire after 48 hours                  |
| PITR                | `true`                     | Point-in-time recovery for data protection (AwsSolutions-DDB3 compliance) |
| Encryption (dev)    | `AWS_MANAGED`              | AWS-owned keys — no KMS cost                                              |
| Encryption (prod)   | `CUSTOMER_MANAGED`         | Dedicated KMS key with automatic rotation                                 |
| Deletion protection | `true` (prod only)         | Prevent accidental table deletion                                         |

### 5.4 S3 Assets Bucket

The assets bucket stores article images and media:

| Feature             | Configuration                              | Why                                               |
| ------------------- | ------------------------------------------ | ------------------------------------------------- |
| Public access       | `BLOCK_ALL`                                | Serve through CloudFront OAC only                 |
| Versioning          | Enabled                                    | Content recovery for article images               |
| Lifecycle           | Noncurrent versions expire in 30-90 days   | Cost optimization                                 |
| Intelligent Tiering | Production only                            | Automatic cost optimization for infrequent access |
| CORS                | Origins from `nextjsConfig.s3.corsOrigins` | Allow frontend uploads                            |
| Encryption          | `S3_MANAGED` (SSE-S3)                      | Required for CloudFront OAC compatibility         |

**CloudFront OAC Access Policy:**

```typescript
// Grants CloudFront service principal read access
this.assetsBucket.addToResourcePolicy(
  new iam.PolicyStatement({
    sid: "AllowCloudFrontOACAccess",
    principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
    actions: ["s3:GetObject"],
    resources: [this.assetsBucket.arnForObjects("*")],
    conditions: {
      StringEquals: {
        "AWS:SourceAccount": cdk.Stack.of(this).account,
      },
    },
  }),
);
```

---

## 6. CloudFront Multi-Origin Routing

> Source: [`edge-stack.ts`](edge/edge-stack.ts),
> [`configurations.ts`](../../config/nextjs/configurations.ts)

### 6.1 Traffic Flow

```
Browser ──HTTPS──► CloudFront (us-east-1)
                      │
              ┌───────┴───────┐
              │ PATH MATCHING │
              └───────┬───────┘
                      │
    ┌─────────────────┼─────────────────────┐
    │                 │                     │
    ▼                 ▼                     ▼
 S3 Origin        ALB Origin            ALB Origin
 (eu-west-1)      (eu-west-1)           (eu-west-1)

 /_next/static/*   /api/*              /* (default)
 /_next/data/*     (no cache)          (ISR cache)
 /images/*
 (immutable cache)
```

### 6.2 Cache Behaviours

| Path Pattern      | Origin | Cache Policy       | TTL                | Compression   | Allowed Methods                    |
| ----------------- | ------ | ------------------ | ------------------ | ------------- | ---------------------------------- |
| `/_next/static/*` | S3     | Static Assets      | 1 year (immutable) | Brotli + Gzip | GET, HEAD                          |
| `/_next/data/*`   | S3     | Dynamic Content    | ISR revalidation   | Brotli + Gzip | GET, HEAD                          |
| `/images/*`       | S3     | Static Assets      | 1 year             | Brotli + Gzip | GET, HEAD                          |
| `/api/*`          | ALB    | `CACHING_DISABLED` | 0                  | No            | ALL (GET, POST, PUT, DELETE, etc.) |
| `/*` (default)    | ALB    | Dynamic Content    | ISR revalidation   | Brotli + Gzip | GET, HEAD, OPTIONS                 |

### 6.3 Cache Policy Details

**Static Assets Policy:**

```typescript
defaultTtl: Duration.days(365),     // 1 year
maxTtl:     Duration.days(365),
minTtl:     Duration.days(365),
headerBehavior:      CacheHeaderBehavior.none(),       // No headers in cache key
queryStringBehavior: CacheQueryStringBehavior.none(),  // No query strings
cookieBehavior:      CacheCookieBehavior.none(),       // No cookies
```

**Why 1 year?** Next.js static assets (`/_next/static/`) are content-hashed. A change in
code produces a new hash, so the URL changes. The old URL is never requested again — making
indefinite caching safe.

**Dynamic Content Policy:**

```typescript
headerBehavior: CacheHeaderBehavior.allowList(
    'Accept', 'Accept-Language', 'RSC', 'Next-Router-Prefetch', 'Next-Router-State-Tree'
),
queryStringBehavior: CacheQueryStringBehavior.all(),
cookieBehavior:      CacheCookieBehavior.none(),
```

**Why these headers?** The `RSC`, `Next-Router-Prefetch`, and `Next-Router-State-Tree` headers
are React Server Component headers. They differentiate between full page loads and client-side
navigations, which return different response formats (HTML vs RSC payload).

### 6.4 ALB Origin Configuration

```typescript
const albOrigin = new origins.HttpOrigin(albDnsName, {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY, // ← Not HTTPS!
  connectionAttempts: 3,
  connectionTimeout: Duration.seconds(10),
  readTimeout: Duration.seconds(30),
  keepaliveTimeout: Duration.seconds(5),
  customHeaders: { "X-CloudFront-Origin": envName },
});
```

**Why HTTP_ONLY?** CloudFront → ALB uses HTTP because:

1. The ALB's certificate is for `*.elb.amazonaws.com` — doesn't match `dev.nelsonlamounier.com`
2. Traffic is within AWS infrastructure (CloudFront POP to ALB)
3. HTTPS termination happens at the CloudFront edge (user → CloudFront is encrypted)
4. Using `HTTPS` would cause an SSL hostname mismatch error

---

## 7. WAF Rules — Layer-by-Layer Analysis

> Source: [`waf-rules.ts`](../../common/security/waf-rules.ts),
> [`edge-stack.ts`](edge/edge-stack.ts),
> [`api-stack.ts`](networking/api-stack.ts)

### 7.1 Two-Tier WAF Architecture

```
                     ┌─────────────────────────────────────────┐
User Request ──────► │  CloudFront WAF (CLOUDFRONT scope)       │
                     │  Region: us-east-1                       │
                     │  Rules: Common + BadInputs + IPRep + Rate│
                     │  SizeRestrictions_BODY: EXCLUDED         │
                     └─────────────────┬───────────────────────┘
                                       │
                                       ▼
                     ┌─────────────────────────────────────────┐
                     │  API Gateway WAF (REGIONAL scope)        │
                     │  Region: eu-west-1                       │
                     │  Rules: Common + BadInputs + IPRep + Rate│
                     │  SizeRestrictions_BODY: NOT excluded     │
                     └─────────────────────────────────────────┘
```

**Why two WAFs?** Defense in depth. CloudFront WAF catches most attacks at the edge.
The regional API Gateway WAF provides a second layer for API-specific traffic, especially
useful if the API is accessed directly (not through CloudFront).

### 7.2 Rule-by-Rule Breakdown

Both WAFs use the shared `buildWafRules()` function:

| Priority | Rule Name                               | Type       | Action                 | Purpose                                                         |
| -------- | --------------------------------------- | ---------- | ---------------------- | --------------------------------------------------------------- |
| 1        | `AWSManagedRulesCommonRuleSet`          | Managed    | `overrideAction: none` | SQLi, XSS, directory traversal, protocol violations             |
| 2        | `AWSManagedRulesKnownBadInputsRuleSet`  | Managed    | `overrideAction: none` | Log4j (CVE-2021-44228), Spring4Shell, known exploit patterns    |
| 3        | `AWSManagedRulesAmazonIpReputationList` | Managed    | `overrideAction: none` | Blocks IPs known to AWS Threat Intelligence (botnets, scanners) |
| 4        | `RateLimitRule`                         | Rate-based | `action: block`        | Blocks IP after 5,000 requests per 5-minute window              |

### 7.3 `overrideAction` vs `action`

```typescript
// Rules 1-3: Managed rule groups
overrideAction: {
  none: {
  }
} // Let AWS decide per-rule actions (block/count)

// Rule 4: Custom rate-based rule
action: {
  block: {
  }
} // Our explicit action — block when threshold hit
```

**Why `overrideAction: { none: {} }`?** For managed rule groups, `none` means "use the
rule group's default actions". Each rule within the group has its own action (some block,
some count). Using `{ count: {} }` would override ALL rules to count-only mode — useful
for testing but not for protection.

### 7.4 `SizeRestrictions_BODY` Exclusion

The CloudFront WAF excludes this rule:

```typescript
commonRuleExclusions = ["SizeRestrictions_BODY"]; // CloudFront default
```

The API Gateway WAF does NOT:

```typescript
commonRuleExclusions = []; // API: no exclusions
```

**Why?** CloudFront forwards ISR revalidation requests and React Server Component payloads
that can exceed the default 8KB body size restriction. The API Gateway only receives
small JSON payloads (subscription requests), so the size restriction adds security value.

---

## 8. Lambda Handler Architecture

> Source: [`api-stack.ts`](networking/api-stack.ts)

### 8.1 API Gateway → Lambda Integration

```
Client ──► CloudFront ──► API Gateway ──► Lambda ──► DynamoDB / SES
               │                │              │
               │         ┌─────┴──────┐       │
               │         │ Throttling │       │
               │         │ WAF        │       │
               │         │ CORS       │       │
               │         │ Logging    │       │
               │         └────────────┘       │
               │                              │
               │         Request Validation   │
               │         (JSON Schema)        │
               │                              │
```

### 8.2 Lambda Functions

| Function        | Route                       | Purpose                   | DynamoDB Access    | Other AWS     |
| --------------- | --------------------------- | ------------------------- | ------------------ | ------------- |
| `list-articles` | `GET /articles`             | List published articles   | Read (+ GSI Query) | —             |
| `get-article`   | `GET /articles/{slug}`      | Get article by slug       | Read (+ GSI Query) | —             |
| `subscribe`     | `POST /subscriptions`       | Create email subscription | Read/Write         | SES SendEmail |
| `verify`        | `GET /subscriptions/verify` | Verify subscription token | Read/Write         | —             |

### 8.3 Per-Function Dead Letter Queues

Each Lambda has its own SQS DLQ for failure isolation:

```typescript
this.lambdaDlqs = {
    listArticles: new sqs.Queue(this, 'ListArticlesDlq', { ... }),
    getArticle:   new sqs.Queue(this, 'GetArticleDlq', { ... }),
    subscribe:    new sqs.Queue(this, 'SubscribeDlq', { ... }),
    verify:       new sqs.Queue(this, 'VerifyDlq', { ... }),
};
```

**Why per-function DLQs?** When a message appears in the `subscribe` DLQ, you immediately
know which function failed and what payload caused it. A shared DLQ would require
parsing the message to determine the failing function.

### 8.4 Request Body Validation (JSON Schema)

API Gateway validates subscription requests before Lambda invocation:

```typescript
const subscriptionModel = this.api.api.addModel("SubscriptionModel", {
  schema: {
    type: JsonSchemaType.OBJECT,
    required: ["email"],
    properties: {
      email: { type: JsonSchemaType.STRING },
      name: { type: JsonSchemaType.STRING, minLength: 1, maxLength: 100 },
    },
    additionalProperties: false, // ← Rejects unknown fields
  },
});
```

**Why validate at API Gateway?** Malformed requests are rejected with a 400 before
Lambda is invoked — reducing invocation costs and attack surface.

### 8.5 SES Permission Scoping

```typescript
subscribeLambda.function.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["ses:SendEmail", "ses:SendRawEmail"],
    resources: [
      `arn:aws:ses:${this.region}:${this.account}:identity/${sesFromEmail}`,
    ],
  }),
);
```

**Why identity-scoped?** The policy only allows sending FROM the verified sender address
(`noreply@nelsonlamounier.com`), not from any SES identity. This prevents the Lambda from
being abused to send spam from other verified domains in the account.

### 8.6 HMAC Verification Secret

```typescript
if (configs.isProduction && !props.verificationSecret) {
  throw new Error(
    "verificationSecret is required in production — " +
      "HMAC tokens would be signed with a known default",
  );
}
const verificationSecret = props.verificationSecret ?? "default-dev-secret";
```

The verification token in the email link is an HMAC-SHA256 hash of the email address.
In development, a default secret is acceptable. In production, the secret must be
explicitly provided to prevent token forgery.

---

## 9. Pipeline YAML — Step-by-Step Analysis

> Source: [`.github/workflows/_deploy-nextjs.yml`](../../../.github/workflows/_deploy-nextjs.yml)

### 9.1 Job Dependency Graph

```
                    ┌─────────┐
                    │  setup  │  OIDC auth, CDK synth, output stack names
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         ┌────▼────┐ ┌──▼───┐ ┌───▼──────────┐
         │security │ │drift │ │  validate     │
         │  scan   │ │detect│ │  templates    │
         └────┬────┘ └──┬───┘ └───┬──────────┘
              │          │         │
              └──────────┼─────────┘
                         │
                    ┌────▼────┐
                    │  data   │  DynamoDB, S3, SSM parameters
                    └────┬────┘
                  ┌──────┤
                  │      │
            ┌─────▼──┐ ┌─▼────────┐
            │compute │ │   api    │  API Gateway + Lambda
            └────┬───┘ └──────────┘
                 │
            ┌────▼──────┐
            │networking │  ALB, Security Groups
            └────┬──────┘
                 │
            ┌────▼────────┐
            │application  │  ECS Task Def, Service, Auto-Deploy
            └────┬────────┘
                 │
            ┌────▼──┐
            │ edge  │  CloudFront, WAF, ACM (us-east-1)
            └────┬──┘
                 │
         ┌───────┼───────┐
         │       │       │
    ┌────▼──┐ ┌──▼───┐ ┌─▼──────┐
    │verify │ │sync  │ │smoke   │
    │       │ │static│ │tests   │
    └───┬───┘ └──┬───┘ └───┬────┘
         │       │         │
         └───────┼─────────┘
                 │
            ┌────▼────┐
            │summary  │  Aggregate results, post PR comment
            └─────────┘
```

### 9.2 Setup Job — OIDC Authentication

```yaml
- name: Configure AWS Credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
    role-session-name: nextjs-${{ inputs.environment }}-deploy
    aws-region: ${{ env.AWS_REGION }}
```

**OIDC flow:**

1. GitHub Actions requests a JWT from GitHub's OIDC provider
2. The JWT is sent to AWS STS `AssumeRoleWithWebIdentity`
3. STS validates the JWT against the IAM role's trust policy
4. Temporary credentials (15-60 min) are returned
5. **No long-lived secrets stored in GitHub!**

### 9.3 CDK Synthesis

```yaml
- name: CDK Synth
  run: |
    npx cdk synth --context environment=${{ inputs.environment }} \
                   --context domainName=${{ env.DOMAIN_NAME }} \
                   --context hostedZoneId=${{ env.HOSTED_ZONE_ID }} \
                   --context crossAccountRoleArn=${{ env.DNS_VALIDATION_ROLE }} \
                   ...
```

All context values are resolved from `vars.*` (GitHub environment variables) with
input fallbacks. The synth output is uploaded as a **golden artifact** — a single
`cdk.out` that all downstream jobs consume.

### 9.4 Template Validation

```yaml
- name: Validate CloudFormation Templates
  run: |
    python3 -c "import sys; sys.setrecursionlimit(10000)" && \
    cfn-lint cdk.out/**/*.template.json --region ${{ env.AWS_REGION }}
```

**Why the Python recursion limit?** `cfn-lint` uses deep recursion for large CDK-generated
templates. The default Python recursion limit (1,000) is insufficient for templates with
deeply nested constructs, causing `RecursionError`. Setting it to 10,000 prevents this.

### 9.5 Stack Deployment Order

Each stack deploys with `--exclusively`:

```yaml
- name: Deploy Data Stack
  run: |
    npx cdk deploy ${{ needs.setup.outputs.data-stack-name }} \
      --exclusively \
      --require-approval never \
      --outputs-file outputs.json
```

**Why `--exclusively`?** Without it, CDK would deploy the target stack AND all its
dependencies. Since each job deploys one stack, and dependency ordering is handled
by GitHub Actions `needs:`, `--exclusively` prevents redundant deployments.

### 9.6 Static Asset Sync

After the application stack deploys, static assets are synced to S3:

```yaml
- name: Sync Static Assets
  run: npx ts-node scripts/deployment/sync-assets-ci.ts
```

This script:

1. Extracts `.next/static/` from the Docker image (the golden artifact)
2. Clears stale local files to prevent hash mismatches
3. Syncs to S3 with appropriate cache headers

---

## 10. SSM Parameter Discovery Model

> Source: [`ssm-paths.ts`](../../config/ssm-paths.ts),
> [`data-stack.ts`](data/data-stack.ts),
> [`edge-stack.ts`](edge/edge-stack.ts)

### 10.1 Path Convention

```
/{project}/{environment}/{resource}

Examples:
/nextjs/development/dynamodb-table-name
/nextjs/development/assets-bucket-name
/nextjs/development/ecs/cluster-name
/nextjs/development/ecs/service-name
/nextjs/development/cloudfront/waf-arn
/shared/ecr/development/repository-arn
/monitoring-development/security-group/id
```

### 10.2 Publishing — `AwsCustomResource` Pattern

Stacks publish their outputs to SSM using `AwsCustomResource` instead of `ssm.StringParameter`:

```typescript
private createSsmParameter(id: string, parameterName: string, value: string,
    description: string, policy: cr.AwsCustomResourcePolicy): void {
    new cr.AwsCustomResource(this, id, {
        onUpdate: {
            service: 'SSM',
            action: 'putParameter',
            parameters: {
                Name: parameterName,
                Value: value,
                Type: 'String',
                Description: description,
                Overwrite: true,         // ← Idempotent redeployment
            },
            physicalResourceId: cr.PhysicalResourceId.of(parameterName),
        },
        onDelete: {
            service: 'SSM',
            action: 'deleteParameter',
            parameters: { Name: parameterName },
        },
        policy,
    });
}
```

**Why `AwsCustomResource` not `ssm.StringParameter`?**

| Feature                       | `ssm.StringParameter`                      | `AwsCustomResource`                          |
| ----------------------------- | ------------------------------------------ | -------------------------------------------- |
| CloudFormation export lock-in | Yes — creates `Fn::ImportValue` dependency | No — consumers use `valueForStringParameter` |
| Idempotent redeploy           | `ParameterAlreadyExists` on recreation     | `Overwrite: true` handles it                 |
| Cross-stack coupling          | Tight — cannot delete producer stack       | Loose — SSM is just a key-value store        |
| Cleanup on stack delete       | Orphaned parameter remains                 | `onDelete` deletes parameter                 |

**Exception:** The Application and Networking stacks use `ssm.StringParameter` directly
for outputs that don't need the `AwsCustomResource` lifecycle (e.g., service name, SG ID).
These are consumed via `valueForStringParameter` which reads at deploy time, not via
CloudFormation exports.

### 10.3 Reading — Same Region vs Cross-Region

**Same region** (consumer stack in `eu-west-1` reads `eu-west-1` parameter):

```typescript
const tableName = ssm.StringParameter.valueForStringParameter(
  this,
  props.tableSsmPath,
);
```

This resolves at **deploy time** via CloudFormation's `{{resolve:ssm:...}}` dynamic reference.

**Cross-region** (Edge stack in `us-east-1` reads `eu-west-1` parameter):

```typescript
private readSsmParameter(id: string, parameterPath: string, region: string,
    policy: cr.AwsCustomResourcePolicy): string {
    const reader = new cr.AwsCustomResource(this, id, {
        onCreate: {
            service: 'SSM',
            action: 'getParameter',
            parameters: { Name: parameterPath },
            region,  // ← Specifies eu-west-1
            physicalResourceId: cr.PhysicalResourceId.of(`read-${parameterPath}`),
        },
        onUpdate: { ... },  // Re-reads on every deploy (values can change)
        policy,
    });
    return reader.getResponseField('Parameter.Value');
}
```

**Why no `onDelete`?** These are read-only resources. The `AwsCustomResource` doesn't own
the SSM parameter, so it shouldn't delete it.

---

## 11. Deployment Scripts — TypeScript CLI

> Source: [`scripts/deployment/stacks.ts`](../../../scripts/deployment/stacks.ts),
> [`scripts/deployment/deploy.ts`](../../../scripts/deployment/deploy.ts)

### 11.1 Architecture

```
┌─────────────────────────────────────────────────────┐
│                    cli.ts                            │
│  Commander.js program with commands:                 │
│  deploy, synth, rollback, drift-detection,           │
│  verify, reconfigure-monitoring                      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│                  deploy.ts                            │
│  Interactive project/stack/environment selection      │
│  Builds context, confirms production deploys,        │
│  deploys individually or --all                       │
└──────────────────────┬──────────────────────────────┘
                       │
           ┌───────────┼──────────┐
           │           │          │
           ▼           ▼          ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ stacks.ts│ │  exec.ts │ │prompts.ts│
    │          │ │          │ │          │
    │ Stack    │ │buildCdk  │ │Interactive│
    │ registry │ │  Args()  │ │ menus     │
    │ project  │ │runCdk()  │ │           │
    │ configs  │ │          │ │           │
    └──────────┘ └──────────┘ └──────────┘
```

### 11.2 Stack Registry (`stacks.ts`)

Each project defines its stacks with dependencies:

```typescript
const nextjsStacks: StackConfig[] = [
  {
    id: "data",
    getStackName: (env) => `NextJS-DataStack-${env}`,
    dependsOn: [],
  },
  {
    id: "compute",
    getStackName: (env) => `NextJS-ComputeStack-${env}`,
    dependsOn: ["data"],
  },
  {
    id: "networking",
    getStackName: (env) => `NextJS-NetworkingStack-${env}`,
    dependsOn: ["compute"],
  },
  {
    id: "application",
    getStackName: (env) => `NextJS-ApplicationStack-${env}`,
    dependsOn: ["networking", "compute"],
  },
  {
    id: "api",
    getStackName: (env) => `NextJS-ApiStack-${env}`,
    dependsOn: ["data"],
  },
  {
    id: "edge",
    getStackName: (env) => `NextJS-EdgeStack-${env}`,
    dependsOn: ["networking", "application"],
    region: "us-east-1",
    requiredContext: ["domainName", "hostedZoneId", "crossAccountRoleArn"],
  },
];
```

### 11.3 `buildCdkArgs` Pattern

```typescript
const args = buildCdkArgs({
  command: "deploy",
  stackNames: [stackName],
  exclusively: true, // --exclusively flag
  context, // CDK context key-value pairs
  profile: actualProfile, // AWS CLI profile
  region: stackRegion, // Override region for edge stack
  accountId: options.accountId,
  requireApproval: "never", // --require-approval never
});
```

This function constructs the `npx cdk deploy` command array with all flags properly formatted.
The `--exclusively` flag is critical — it prevents CDK from deploying dependencies that
have already been deployed by a previous job in the pipeline.

### 11.4 Profile Mapping

```typescript
const profileMap: Record<Environment, string> = {
  development: "dev",
  staging: "staging",
  production: "prod",
};
```

Maps environment names to AWS CLI profile names for local development.
In CI, OIDC credentials are used instead of profiles.

---

## 12. Cross-Region Patterns

> Source: [`edge-stack.ts`](edge/edge-stack.ts)

### 12.1 Why Cross-Region?

```
┌────────────────┐          ┌────────────────┐
│   us-east-1    │          │   eu-west-1    │
│                │          │                │
│  Edge Stack:   │          │  All other     │
│  • CloudFront  │◄─────────│  stacks:       │
│  • WAF (CF)    │  SSM     │  • Data        │
│  • ACM (edge)  │  reads   │  • Compute     │
│  • DNS Alias   │          │  • Networking  │
│                │          │  • Application │
│                │          │  • API         │
└────────────────┘          └────────────────┘
```

CloudFront requires:

- **ACM certificates** in `us-east-1` (global edge requirement)
- **WAF WebACL** with `CLOUDFRONT` scope (only valid in `us-east-1`)

Everything else runs in `eu-west-1` (Ireland) — closest region to the target audience.

### 12.2 Region Guard

```typescript
// Guard 1: Hard throw for explicitly wrong region
if (props.env?.region && props.env.region !== "us-east-1") {
  throw new Error(
    `Edge stack MUST be deployed in us-east-1. Got: ${props.env.region}`,
  );
}

// Guard 2: Synth-time annotation for unresolved region tokens
if (this.region !== "us-east-1") {
  cdk.Annotations.of(this).addError(
    "Edge stack MUST be deployed in us-east-1 region.",
  );
}
```

**Why two guards?** Guard 1 catches explicit misconfiguration (`env: { region: 'eu-west-1' }`).
Guard 2 catches the case where `env.region` is not set at all — `this.region` would be a
CloudFormation token that doesn't equal `us-east-1`.

### 12.3 ACM Cross-Account DNS Validation

```
┌─────────────────────────────────────────────────────────────┐
│                   Certificate Flow                          │
│                                                             │
│  Edge Stack (us-east-1)     Root Account (Route 53)         │
│  ┌─────────────────┐       ┌─────────────────────────┐     │
│  │ 1. Request cert │──────►│ 3. Lambda assumes        │     │
│  │    from ACM     │       │    crossAccountRoleArn   │     │
│  │                 │       │                          │     │
│  │ 2. ACM provides │       │ 4. Lambda creates CNAME  │     │
│  │    CNAME record │       │    in Route 53 zone      │     │
│  │    for validation│      │                          │     │
│  │                 │       │ 5. ACM validates domain  │     │
│  │ 6. Certificate  │◄─────│    ownership              │     │
│  │    issued       │       └─────────────────────────┘     │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

The `AcmCertificateDnsValidationConstruct` creates a custom resource backed by a Lambda
function that:

1. Calls ACM to get the CNAME validation records
2. Assumes the `crossAccountRoleArn` via STS
3. Creates the CNAME records in the root account's Route 53 hosted zone
4. Waits for ACM to validate ownership
5. Returns the certificate ARN

### 12.4 DNS Alias Record (Reusing the Validation Lambda)

The same Lambda function is reused to create the Route 53 A record (alias) pointing
to the CloudFront distribution:

```typescript
const dnsAliasRecord = new cdk.CustomResource(this, "DnsAliasRecord", {
  serviceToken: dnsAliasProvider.serviceToken,
  properties: {
    DomainName: props.domainName,
    HostedZoneId: props.hostedZoneId,
    CrossAccountRoleArn: props.crossAccountRoleArn,
    CloudFrontDomainName: this.distribution.distribution.distributionDomainName,
    SkipCertificateCreation: "true", // ← Only create DNS alias
  },
});
```

**Why reuse?** Both operations need the same permission to assume the cross-account
Route 53 role. The Lambda checks `SkipCertificateCreation` to determine which code
path to execute.

**Trade-off:** This creates coupling — changes to certificate logic could break DNS alias
creation. Acceptable for a portfolio project; in production, split into two Lambdas with
shared Route 53 utility code.

---

## Quick Reference Card

### SSM Paths

| Parameter           | Path                                           | Published By      |
| ------------------- | ---------------------------------------------- | ----------------- |
| DynamoDB table name | `/nextjs/{env}/dynamodb-table-name`            | Data Stack        |
| S3 bucket name      | `/nextjs/{env}/assets-bucket-name`             | Data Stack        |
| AWS region          | `/nextjs/{env}/aws-region`                     | Data Stack        |
| ALB DNS name        | `/nextjs/{env}/alb-dns-name`                   | Networking Stack  |
| Task SG ID          | `/nextjs/{env}/task-security-group-id`         | Networking Stack  |
| ECS cluster name    | `/nextjs/{env}/ecs/cluster-name`               | Compute Stack     |
| ECS service name    | `/nextjs/{env}/ecs/service-name`               | Application Stack |
| API Gateway URL     | `/nextjs/{env}/api-gateway-url`                | API Stack         |
| ACM cert ARN        | `/nextjs/{env}/acm-certificate-arn`            | Edge Stack        |
| WAF ARN             | `/nextjs/{env}/cloudfront/waf-arn`             | Edge Stack        |
| CloudFront domain   | `/nextjs/{env}/cloudfront/distribution-domain` | Edge Stack        |
| Cloud Map namespace | `/nextjs/{env}/cloudmap/namespace-name`        | Compute Stack     |
| ECR repository URI  | `/shared/ecr/{env}/repository-uri`             | Shared VPC Stack  |
| Monitoring SG ID    | `/monitoring-{env}/security-group/id`          | Monitoring Stack  |

### Stack Deployment Order

```
1. Data        → DynamoDB, S3, SSM params
2. Compute     → ECS Cluster, IAM, ASG, Cloud Map         (depends on: Data)
3. Networking  → ALB, Target Group, Security Groups         (depends on: Compute)
4. Application → Task Definition, ECS Service, Auto-Deploy  (depends on: Networking, Compute)
5. API         → API Gateway, Lambda, DLQ                   (depends on: Data)
6. Edge        → CloudFront, WAF, ACM, DNS                  (depends on: Networking, Application)
```

### Container Security Checklist

- [x] Non-root user (`1001`)
- [x] Dropped all Linux capabilities
- [x] Init process enabled (tini)
- [x] tmpfs for build cache (`/app/.next/cache`)
- [x] NOFILE ulimit set (65536)
- [x] Health check configured (node HTTP probe)
- [x] `awsvpc` network isolation
- [x] IMDS blocked (`ECS_AWSVPC_BLOCK_IMDS=true`)
- [x] SSM secrets injection (not env vars)
- [ ] Read-only root filesystem (disabled for ISR — see §3.2)
