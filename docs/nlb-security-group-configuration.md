# NLB Security Group Configuration

> Comprehensive reference for the Network Load Balancer
> implementation in the `cdk-monitoring` infrastructure.

## Why Is the NLB Needed?

The NLB replaced the previous **EIP-to-instance + Lambda
failover** model. Previously, the cluster EIP was directly
attached to an EC2 instance, and a Lambda function monitored
the instance health to reassign the EIP on failure.

The NLB provides:

- **Automatic health-check-based failover** — no Lambda needed
- **Multiple active targets** — both workers can serve
  traffic simultaneously
- **Same EIP** — the EIP is attached to the NLB via
  SubnetMapping, so no DNS or CloudFront changes were needed
- **TCP passthrough (Layer 4)** — preserves client source IPs

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      INTERNET                               │
├──────────────────────┬──────────────────────────────────────┤
│  CloudFront          │  Admin Browser / ops domain          │
│  (*.nelsonlamounier  │  (ops.nelsonlamounier.com)           │
│   .com)              │                                      │
│       │              │         │                             │
│       ▼              │         ▼                             │
│  NLB:80 (HTTP)       │    NLB:443 (HTTPS)                  │
│       │              │         │                             │
│       ▼              │         ▼                             │
│  Target Group        │    Target Group                      │
│  k8s-dev-http        │    k8s-dev-https                     │
│  (port 80)           │    (port 443)                        │
│       │              │         │                             │
│       ▼              │         ▼                             │
│  Traefik :80         │    Traefik :443                      │
│  (HTTP entrypoint)   │    (HTTPS entrypoint)                │
│       │              │         │                             │
│       ▼              │         ▼                             │
│  K8s IngressRoutes   │    ArgoCD / Grafana / etc.           │
└─────────────────────────────────────────────────────────────┘
```

### Traffic Paths

1. **Public site** (e.g. `nelsonlamounier.com`):
   `CloudFront → NLB:80 → Traefik → Next.js app`
2. **Ops/Admin** (e.g. `ops.nelsonlamounier.com/argocd`):
   `Browser → EIP → NLB:443 → Traefik → ArgoCD`

---

## Security Groups

The NLB setup involves **two** security groups:

### 1. NLB Security Group

**Name:** `Base-development-NlbNLBSecurityGroup-*`
**Purpose:** Controls what traffic can reach and leave the NLB.

| Direction | Port | Source/Destination | Description |
| --------- | ---- | ------------------ | ----------- |
| Inbound   | 80   | `0.0.0.0/0`, `::/0` | HTTP from CloudFront + Let's Encrypt |
| Inbound   | 443  | `0.0.0.0/0`, `::/0` | HTTPS from admin browsers |
| Outbound  | 80   | `10.0.0.0/16` (VPC) | Forward to targets + health checks |
| Outbound  | 443  | `10.0.0.0/16` (VPC) | Forward HTTPS to targets |

### 2. Instance Ingress Security Group

**Name:** `k8s-dev-k8s-ingress`
**Purpose:** Controls what traffic reaches Traefik on the
EC2 instances. This is where **IP filtering** happens.

| Direction | Port | Source | Description |
| --------- | ---- | ------ | ----------- |
| Inbound   | 80   | `10.0.0.0/16` (VPC) | NLB health checks |
| Inbound   | 80   | CloudFront PL | HTTP from CloudFront |
| Inbound   | 443  | Admin IPs (SSM) | HTTPS from allowed admins |

---

## Why Does the NLB SG Use `0.0.0.0/0`?

This is a common concern. The answer is **defence-in-depth**:

1. **NLB is Layer 4 (TCP passthrough)** — it does NOT
   terminate TLS, inspect headers, or serve content.
   It simply forwards TCP packets.

2. **IP filtering is NOT the NLB SG's job** — the NLB
   SG's role is to allow traffic _into_ the NLB. The
   **instance-level Ingress SG** is the actual security
   boundary that enforces admin IP restrictions.

3. **Restricting NLB inbound breaks CloudFront** —
   CloudFront uses a dynamic, rotating pool of IPs.
   AWS provides a managed prefix list for port 80,
   but there is no prefix list for port 443.

4. **The security layers are:**

   ```
   Layer 1: NLB SG (0.0.0.0/0) — wide open, TCP passthrough
   Layer 2: Instance Ingress SG — admin IPs on :443, VPC on :80
   Layer 3: Traefik middleware — admin-ip-allowlist on :443
   ```

---

## Health Checks

| Setting | Value |
| ------- | ----- |
| Protocol | TCP |
| Port | 80 (Traefik HTTP entrypoint) |
| Interval | 30 seconds |
| Healthy threshold | 3 consecutive successes |
| Unhealthy threshold | 3 consecutive failures |

The HTTPS target group (`k8s-dev-https`) uses port 80 for
health checks because:

- Traefik always responds on port 80 (even for 503 — it's
  a valid TCP connection)
- Port 443 requires TLS negotiation, adding complexity
- TCP health checks only need a successful TCP handshake

### Health Check Traffic Flow

```
NLB node IP (10.0.0.x) ──TCP:80──▶ Instance (Traefik)
      │                                    │
      │  Goes through:                     │
      │  1. NLB SG outbound (port 80 →     │
      │     VPC CIDR)                      │
      │  2. Instance Ingress SG inbound    │
      │     (port 80 from VPC CIDR)        │
      │                                    │
      ◀──── TCP ACK (healthy) ─────────────┘
```

---

## Current Configuration (CDK)

### NLB Construct (`network-load-balancer.ts`)

```typescript
// Explicit SG with restricted outbound
this.securityGroup = new ec2.SecurityGroup(
    this, 'NlbSecurityGroup', {
        vpc, allowAllOutbound: false,
    }
);

// NLB with explicit SG
this.loadBalancer = new elbv2.NetworkLoadBalancer(
    this, 'NLB', {
        securityGroups: [this.securityGroup],
    }
);
```

### Base Stack (`base-stack.ts`)

```typescript
// Target groups
nlb.createTargetGroup('HttpTg', {
    port: 80 });
nlb.createTargetGroup('HttpsTg', {
    port: 443, healthCheckPort: 80 });

// Listeners
nlb.addTcpListener('HttpListener', 80, httpTg);
nlb.addTcpListener('HttpsListener', 443, httpsTg);

// Open NLB SG for ports 80 + 443
nlb.configureSecurityGroup([80, 443]);
```

### Ingress SG Config (`configurations.ts`)

```typescript
ingress: {
    allowAllOutbound: false,
    rules: [
        {
            port: 80,
            source: 'vpcCidr',
            description: 'HTTP health checks from NLB',
        },
    ],
}
```

---

## CloudWatch Logs for Troubleshooting

**NLB access logs are currently suppressed** via cdk-nag
(`AwsSolutions-ELB2`). This is intentional for the
solo-developer environment to avoid S3 storage costs.

### What Is Available

| Log Source | Location | What It Shows |
| ---------- | -------- | ------------- |
| NLB access logs | Disabled (suppressed) | Per-request NLB data |
| Target health | `aws elbv2 describe-target-health` | Current health state |
| CloudWatch metrics | `AWS/NetworkELB` namespace | Connection counts, health |
| Traefik access logs | Pod stdout (Loki) | Request routing and errors |
| VPC Flow Logs | If enabled | Network-level packet data |

### Useful Troubleshooting Commands

```bash
# Check target health
aws elbv2 describe-target-health \
  --target-group-arn <TG_ARN> \
  --query 'TargetHealthDescriptions[*].
    {Id:Target.Id,State:TargetHealth.State}' \
  --output table

# Check NLB security group rules
aws ec2 describe-security-groups \
  --group-ids <NLB_SG_ID> \
  --query 'SecurityGroups[*].
    {Inbound:IpPermissions,Outbound:IpPermissionsEgress}'

# Check which SGs are on target instances
aws ec2 describe-instances \
  --instance-ids <INSTANCE_ID> \
  --query 'Reservations[*].Instances[*].
    {Id:InstanceId,SGs:SecurityGroups[*].GroupName}'
```

### Enabling NLB Access Logs

To enable access logs for deeper troubleshooting, set
`suppressAccessLogNag: false` in the NLB construct props
and configure an S3 bucket:

```typescript
new NetworkLoadBalancerConstruct(this, 'Nlb', {
    suppressAccessLogNag: false,
    // Then configure access logs on the NLB:
});
nlb.loadBalancer.logAccessLogs(accessLogBucket);
```

---

## Common Issues

### Targets Are Unhealthy

1. Check the **NLB SG** has outbound on port 80 to VPC CIDR
2. Check the **Ingress SG** has inbound on port 80 from VPC CIDR
3. Verify Traefik is listening: `curl -v http://localhost:80`
4. Verify cross-node connectivity: `curl http://<vpc-ip>:80`

### ERR_CONNECTION_TIMED_OUT

1. Check the **NLB SG** has inbound on port 443 from 0.0.0.0/0
2. Check the **Ingress SG** has inbound on port 443 from your IP
3. Verify DNS resolves to the EIP: `dig ops.nelsonlamounier.com`
4. Check NLB target health (above)
