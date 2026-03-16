# Networking Observability Strategy

> Solo-developer, cost-optimised logging with 3-day retention across the full
> traffic path.

## Traffic Path Overview

```
Internet
  │
  ▼
CloudFront (L7 CDN)          ← CloudFront access logs → S3 (3-day)
  │
  ▼
NLB (L4 TCP passthrough)     ← NLB access logs → S3 (3-day)
  │
  ▼
EC2 Instance (Ingress SG)
  │
  ▼
Traefik (L7 reverse proxy)   ← Access logs → stdout → Loki
  │
  ▼
ArgoCD / Application Pods
```

Each layer logs to a different destination with a consistent 3-day retention
policy. VPC Flow Logs provide the cross-cutting packet-level view.

---

## Logging Layers

### 1. CloudFront Access Logs → S3

| Property | Value |
|----------|-------|
| **Destination** | S3 bucket (`{env}-{project}-cloudfront-logs-{account}`) |
| **Retention** | 3-day lifecycle (auto-delete) |
| **Environments** | All (development, staging, production) |
| **What it captures** | Request URI, viewer IP, edge location, status code, cache hit/miss |
| **CDK construct** | `CloudFrontConstruct` (`cloudfront.ts`) |

**When to use:** Diagnosing cache misses, checking viewer IPs, confirming
requests are reaching the edge.

```bash
# List recent CloudFront logs
aws s3 ls s3://{bucket}/cloudfront-development/ --recursive \
  --region eu-west-1 --profile dev-account
```

---

### 2. NLB Access Logs → S3

| Property | Value |
|----------|-------|
| **Destination** | S3 bucket (`{prefix}-nlb-access-logs-{account}-{region}`) |
| **Retention** | 3-day lifecycle (auto-delete) |
| **What it captures** | Source IP, destination IP, port, bytes, TLS handshake, connection time |
| **CDK construct** | `NetworkLoadBalancerConstruct` (`network-load-balancer.ts`) |

**When to use:** Diagnosing NLB health check failures, target connectivity
issues, TLS negotiation errors — exactly what was missing during the
`ERR_CONNECTION_TIMED_OUT` incident.

```bash
# List NLB access logs
aws s3 ls s3://{bucket}/nlb-access-logs/ --recursive \
  --region eu-west-1 --profile dev-account

# Download and inspect a specific log file
aws s3 cp s3://{bucket}/nlb-access-logs/AWSLogs/{account}/... . \
  --region eu-west-1 --profile dev-account
zcat net_log_*.gz | head -20
```

**NLB log fields (space-delimited):**

```
type timestamp elb listener client:port destination:port connection_time
tls_handshake_time received_bytes sent_bytes incoming_tls_alert
chosen_cert_arn chosen_cert_serial tls_cipher tls_protocol_version
tls_named_group domain_name alpn_fe_protocol alpn_be_protocol
alpn_client_preference_list tls_connection_creation_time
```

---

### 3. VPC Flow Logs → CloudWatch Logs

| Property | Value |
|----------|-------|
| **Destination** | CloudWatch Logs (`/vpc/{namespace}/{env}/flow-logs`) |
| **Retention** | 3 days |
| **What it captures** | Source/destination IP, port, protocol, action (ACCEPT/REJECT), bytes |
| **CDK construct** | `SharedVpcStack` (`vpc-stack.ts`) |

**When to use:** Confirming whether traffic was accepted or rejected at the
VPC level. Essential for SG rule troubleshooting.

```bash
# Query rejected traffic in the last hour
aws logs filter-log-events \
  --log-group-name "/vpc/shared/development/flow-logs" \
  --filter-pattern "REJECT" \
  --start-time $(( $(date +%s) - 3600 ))000 \
  --region eu-west-1 --profile dev-account \
  --query 'events[*].message' --output text | head -20
```

---

### 4. Traefik Access Logs → Loki

| Property | Value |
|----------|-------|
| **Destination** | Pod stdout → Promtail → Loki |
| **Retention** | Loki default retention |
| **What it captures** | HTTP method, path, status, latency, X-Forwarded-For, User-Agent |
| **Configuration** | Traefik Helm values (`traefik.accessLogs.enabled: true`) |

**When to use:** Diagnosing application-level routing (middleware rejections,
path matching, IP allowlist blocks like the ArgoCD 403 incident).

```bash
# Query via Grafana LogQL
{namespace="kube-system", container="traefik"}
  |= "/argocd"
  | json
```

---

## Troubleshooting Decision Tree

```
Problem: Connection timeout / unreachable
│
├── Check CloudFront logs
│   └── If no request logged → DNS or client-side issue
│
├── Check NLB access logs
│   ├── If no log entry → CloudFront not reaching NLB (SG or NLB config)
│   ├── If log shows TLS error → Certificate or listener mismatch
│   └── If log shows 0 bytes sent → Target health check failing
│
├── Check VPC Flow Logs
│   ├── If REJECT → Security group blocking traffic
│   └── If ACCEPT → Traffic reaches instance, check Traefik
│
└── Check Traefik logs (Grafana/Loki)
    ├── If 403 → IP allowlist middleware blocking
    ├── If 503 → Backend service unavailable
    └── If no log → Traefik not receiving the request (port/SG issue)
```

---

## Cost Summary

| Source | Destination | Volume (~dev) | Retention | Monthly Cost |
|--------|------------|--------------|-----------|-------------|
| CloudFront | S3 | ~5 MB/day | 3 days | < £0.01 |
| NLB | S3 | ~10 MB/day | 3 days | < £0.01 |
| VPC Flow | CloudWatch | ~50 MB/day | 3 days | ~£0.15 |
| Traefik | Loki | Pod stdout | Loki default | £0.00 |
| **Total** | | | | **~£0.20/month** |

---

## CDK Implementation

### NLB Access Logs (base-stack.ts)

```typescript
const nlbLogBucket = new S3BucketConstruct(this, 'NlbAccessLogsBucket', {
    environment: targetEnvironment,
    config: {
        bucketName: `${namePrefix}-nlb-access-logs-${this.account}-${this.region}`,
        purpose: 'nlb-access-logs',
        encryption: s3.BucketEncryption.S3_MANAGED,
        lifecycleRules: [{
            id: 'DeleteAfter3Days',
            expiration: cdk.Duration.days(3),
        }],
    },
});

this.nlbConstruct.enableAccessLogs(nlbLogBucket.bucket, 'nlb-access-logs');
```

### CloudFront Logging (nextjs.ts)

```typescript
// Development environment config
cloudfront: {
    loggingEnabled: true,  // ← was false, now enabled across all envs
    // ...
}
```

Log bucket lifecycle in `cloudfront.ts`:

```typescript
lifecycleRules: [{
    id: 'DeleteOldLogs',
    expiration: cdk.Duration.days(3),  // ← was 90 days
}],
```

### VPC Flow Logs (defaults.ts)

```typescript
flowLogRetention: logs.RetentionDays.THREE_DAYS,  // ← was ONE_MONTH
```

---

## L3/L2 Construct Usage

| Resource | Stack level | Inside construct |
|----------|-----------|-----------------|
| S3 Buckets | `S3BucketConstruct` (L3) | Raw `s3.Bucket` (L2) |
| Security Groups | `SecurityGroupConstruct` (L3) | Raw `ec2.SecurityGroup` (L2) |

**Pattern:** Stacks always use L3 constructs for visibility and consistency.
Constructs encapsulate L2 as internal implementation details.
