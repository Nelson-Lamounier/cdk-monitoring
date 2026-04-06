---
title: "Networking Implementation — CloudFront, WAF, VPC, NLB, Traefik"
doc_type: code-analysis
domain: infrastructure
tags:
  - cloudfront
  - waf
  - vpc
  - security-groups
  - nlb
  - traefik
  - route53
  - calico
  - networking
related_docs:
  - kubernetes/adrs/traefik-over-nginx-alb.md
  - infrastructure/stack-overview.md
  - infrastructure/infrastructure-topology.md
  - frontend/frontend-integration.md
last_updated: "2026-03-30"
author: Nelson Lamounier
status: accepted
---

# Networking Implementation

**Project:** cdk-monitoring
**Last Updated:** 2026-03-30

## CloudFront Distribution

The CloudFront distribution is the public entry point for all traffic.
Deployed in us-east-1 (required by AWS) via the Edge stack.

**Construct:** `infra/lib/constructs/networking/cloudfront.ts`

### Behaviour Ordering

CloudFront evaluates behaviours in **listed order** (first match wins,
NOT by path specificity). The order must be:

1. `/_next/static/*` — immutable assets (S3 OAC, 1-year TTL)
2. `/_next/data/*` — ISR data files (S3 OAC)
3. `/images/*` — article images (S3 OAC)
4. `/videos/*` — video assets (S3 OAC)
5. `/api/auth/*` — auth callbacks (`AuthNoCachePolicy`)
6. `/api/admin/*` — admin API (`AuthNoCachePolicy`)
7. `/api/*` — general API catch-all (`CachingDisabled`)
8. `/admin/*` — admin pages (`AuthNoCachePolicy`)
9. Default `*` — Next.js SSR (EIP origin)

> **Critical rule:** More-specific patterns must appear **before**
> catch-all patterns. `/api/auth/*` must precede `/api/*`.

### Cache Policies

| Policy | CookieBehaviour | Use Case |
|:---|:---|:---|
| `AuthNoCachePolicy` | `all` | Auth/admin routes — preserves `Set-Cookie` |
| `CachingDisabled` (managed) | `none` | Public API — strips `Set-Cookie` |
| `CachingOptimized` (managed) | `none` | Static assets (S3 OAC) |

**Why `AuthNoCachePolicy` exists:** The managed `CachingDisabled` policy
sets `CookieBehavior: none`, which strips `Set-Cookie` headers from
origin responses. Auth routes require `Set-Cookie` forwarding for CSRF
tokens. `AuthNoCachePolicy` uses `CookieBehavior: all` with `MaxTTL: 1`
(not 0 — CloudFront rejects `all` with `MaxTTL: 0`).

### Origin Configuration

- **EIP origin:** `HTTP_ONLY` to Traefik (self-signed cert does not
  match domain). Origin bypass mitigated by `X-CloudFront-Origin` header.
- **S3 OAC origin:** Origin Access Control for static asset buckets.
- **EIP DNS conversion:** CloudFront rejects raw IPs — the stack
  converts `1.2.3.4` to
  `ec2-1-2-3-4.eu-west-1.compute.amazonaws.com`.

### Compile-Time Guardrails

Two validation functions prevent misconfigurations at `cdk synth`:

- **`validateAuthCookies()`** (`nextjs.ts`) — no wildcards,
  max 10 cookies, no duplicates
- **`validateBehaviourOrdering()`** (`cloudfront.ts`) — catch-all
  patterns cannot precede specific sub-paths

## WAF WebACL

Attached to the CloudFront distribution (CLOUDFRONT scope, us-east-1):

- **Rate limiting:** 2000 requests per 5 minutes per IP
- **IP reputation:** AWS managed `AWSManagedRulesAmazonIpReputationList`
- **Common exploits:** AWS managed `AWSManagedRulesCommonRuleSet`
- **Known bad inputs:** AWS managed `AWSManagedRulesKnownBadInputsRuleSet`

## VPC Architecture

The Kubernetes cluster uses a shared VPC from the `deploy-shared`
pipeline, looked up via VPC ID in the base stack:

```typescript
// base-stack.ts — VPC lookup (not created, discovered)
const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
  vpcId: props.configs.networking.vpcId,
});
```

The shared VPC provides public and private subnets across multiple AZs
in eu-west-1. VPC Flow Logs are enabled via `VpcFlowLogsConstruct`.

**Key networking values:**

- VPC CIDR: `10.0.0.0/16` (shared VPC)
- Pod network CIDR: `192.168.0.0/16` (Calico CNI)
- Service subnet: `10.96.0.0/12` (kubeadm default)
- K8s API port: 6443
- Traefik HTTP: 80, HTTPS: 443

## Security Groups — 4 Config-Driven SGs

All rules are defined as typed data in
`infra/lib/config/kubernetes/configurations.ts` using `K8sPortRule[]`.
The `SecurityGroupConstruct` iterates the config array and calls
`addIngressRule()` per entry — adding a port rule is a config change,
not a stack code change.

### Cluster Base SG (18 rules)

Self-referencing rules for all node-to-node communication:

- etcd: TCP 2379–2380 (client + peer)
- K8s API: TCP 6443
- kubelet: TCP 10250
- kube-controller-manager: TCP 10257
- kube-scheduler: TCP 10259
- VXLAN overlay: UDP 4789 (Calico VXLAN mode)
- Calico BGP: TCP 179, Calico Typha: TCP 5473
- NodePort range: TCP 30000–32767
- CoreDNS: TCP+UDP 53
- Traefik metrics: TCP 9100, Node Exporter: TCP 9101

Pod CIDR (192.168.0.0/16) → Node rules:

- K8s API: TCP 6443, kubelet: TCP 10250, CoreDNS: TCP+UDP 53
- Traefik metrics: TCP 9100, Node Exporter: TCP 9101 (Prometheus)

### Control Plane SG (1 rule)

- K8s API: TCP 6443 from VPC CIDR (SSM port-forwarding)

### Ingress SG (runtime rules)

Static config rules:

- HTTP health checks: TCP 80 from VPC CIDR (NLB health checks)

Runtime-added rules (in `base-stack.ts` after config loop):

- HTTPS from CloudFront: TCP 443 from CloudFront managed prefix list
- Admin access: TCP 80+443 from admin IPs via SSM `/admin/allowed-ips`

### Monitoring SG (5 rules)

- Prometheus: TCP 9090 from VPC CIDR
- Node Exporter: TCP 9100 from VPC CIDR + Pod CIDR
- Loki push API: TCP 30100 from VPC CIDR (NodePort)
- Tempo OTLP gRPC: TCP 30417 from VPC CIDR (NodePort)

## Network Load Balancer

Created by `NetworkLoadBalancerConstruct` in the base stack:

- **Type:** Network (TCP passthrough, no TLS termination)
- **Scheme:** Internet-facing
- **Targets:** Control plane ASG instances
- **Listeners:** TCP 80 and TCP 443 → Traefik ports on EC2
- **Health check:** TCP on port 80 (Traefik health endpoint)
- **Access logs:** S3 bucket with 3-day lifecycle expiration

## Route 53

- **Private hosted zone:** `k8s.internal` — stable DNS for K8s API
- **A record:** Updated by EIP failover Lambda on instance replacement
- **CloudFront alias:** `dev.nelsonlamounier.com` → distribution

## Traefik Ingress Controller

Deployed via ArgoCD Helm chart
(`kubernetes-app/platform/argocd-apps/traefik.yaml`):

- Runs as a DaemonSet on application nodes
- Listens on ports 80 (HTTP) and 443 (HTTPS)
- Handles SSL termination with Let's Encrypt (cert-manager)
- Routes traffic to K8s Services via IngressRoute CRDs

## Traffic Flow

```text
Internet → CloudFront (HTTPS, us-east-1)
         → WAF WebACL (rate limit, IP reputation, managed rules)
         → EIP origin (HTTP — avoids TLS mismatch)
         → NLB (TCP passthrough, eu-west-1)
         → Traefik IngressRoute → Service → Pod
```

## Decision Reasoning

1. **Data-driven security groups** — SG rules are typed arrays in
   config, not hardcoded in stack code. Prevents rule sprawl and makes
   port inventory auditable at a glance.

2. **NLB over ALB** — TCP passthrough; TLS handled by Traefik using
   cert-manager certificates. Avoids double TLS termination and keeps
   certificate management within Kubernetes.

3. **Private hosted zone for K8s API** — `k8s.internal` provides a
   stable DNS name (`kubeapi.k8s.internal:6443`). When the control
   plane instance is replaced, the EIP failover Lambda updates the A
   record.

4. **CloudFront → NLB → Traefik** — CloudFront terminates public TLS
   and applies WAF rules. The NLB passes TCP through to Traefik on
   the node's host network. This gives edge security (WAF) and
   Kubernetes-native routing (IngressRoute CRDs).

## Troubleshooting

### SG Self-Reference — Pod-to-Node Communication Failure

**What happened:** Pods could not communicate with node-level services.
Calico VXLAN encapsulated traffic appeared as node-to-node traffic but
was blocked by the security group.

**Why:** Calico VXLAN encapsulates pod traffic in the node's source IP.
Return traffic on the outer packet has the node's own IP, so the SG
must permit traffic originating from itself — a self-referencing rule.

**Fix:** Added a self-referencing ingress rule to the Cluster Base SG
so the node accepts traffic from its own security group.

---

### CloudFront 504 Timeouts

**What happened:** CloudFront returned 504 Gateway Timeout errors even
though the NLB health check was passing.

**Why:** The NLB health check targeted Traefik on port 80, which
responded successfully. However, the K8s API server pod was in
`CrashLoopBackOff`, so application requests reaching the pod failed.
The NLB marked the target as healthy (Traefik was fine), but the
upstream service was down.

**Fix:** Added a separate health check endpoint that verifies API
server reachability behind Traefik, not just Traefik availability.

---

### NLB Cross-AZ Routing

**What happened:** Requests were routed to nodes in AZs that had no
healthy control plane instance, causing intermittent failures.

**Why:** Cross-zone load balancing was enabled by default, distributing
traffic to all registered targets across AZs. The control plane only
ran in one AZ; targets in other AZs had no healthy backend.

**Fix:** Disabled cross-zone load balancing so the NLB only routes to
targets in AZs with a healthy instance.

---

### CloudFront CSRF Login Failure (Recurring)

**What happened:** Admin login returned `MissingCSRF` errors. Auth
cookies and `Set-Cookie` headers were not reaching the browser.

**Why:** Three cascading root causes:

1. **Wildcard cookie names** — `*authjs*` in the OriginRequestPolicy.
   CloudFront treats `*` as a literal character, not a glob. Zero auth
   cookies were forwarded.
2. **`CachingDisabled` strips `Set-Cookie`** — The managed policy sets
   `CookieBehavior: none`, which removes `Set-Cookie` from origin
   responses. The CSRF token never reached the browser.
3. **Behaviour ordering** — `/api/*` catch-all was listed before
   `/api/auth/*`. CloudFront uses first-match-wins ordering, so
   `/api/auth/csrf` matched the catch-all and used the wrong policy.

**Fix:** Three-layer guardrails implemented:

- **Compile-time:** `validateAuthCookies()` rejects wildcards, enforces
  10-cookie limit. `validateBehaviourOrdering()` prevents catch-all
  patterns from shadowing sub-paths.
- **Integration tests:** `edge-stack.integration.test.ts` validates
  `CookieBehavior`, wildcard absence, and behaviour order against the
  live distribution.
- **CI gating:** `verify-edge-stack` job blocks the pipeline on failure.

---

### Faro CORS — Browser Telemetry Blocked

**What happened:** Browser console showed CORS errors for Faro
telemetry POST requests to `/faro/collect`.

**Why:** The `alloy-faro-ingress` IngressRoute had no CORS middleware.
Traefik intercepts `OPTIONS` preflight requests before they reach the
Alloy pod. Without a Traefik middleware returning CORS headers, the
browser rejected the telemetry POST.

**Fix:** Created a `faro-cors` Traefik `Middleware` resource with
explicit allowed origins. Attached it to the Faro IngressRoute.
Tightened Alloy's own `cors_allowed_origins` from `["*"]` to the
same explicit list.

---

### CloudFront CachePolicy `AlreadyExists` Error During Deployment

**What happened:** The CDK deployment pipeline failed with `AlreadyExists` for
an `AWS::CloudFront::CachePolicy`.

**Why:** `CachePolicy` and `OriginRequestPolicy` resources in `edge-stack.ts`
were explicitly assigned hardcoded names via the `cachePolicyName` and
`originRequestPolicyName` props. When a policy is manually created for testing,
or if a previous stack deletion fails to clean up the policies, CloudFormation
fails to deploy because the exact name already exists globally across the AWS
account.

**Fix:** Removed the hardcoded string names from all `CachePolicy` and
`OriginRequestPolicy` constructs. By omitting the explicit name, CDK
automatically generates a unique physical name based on the construct's logical
ID (e.g., `EdgeStack-StaticAssetsCachePoli-ABC123XYZ`). This idiomatic CDK
approach prevents cross-environment naming conflicts and ensures robust
deployment automation.

## Transferable Skills Demonstrated

- **Network architecture design** — designing multi-layer traffic
  flows (CloudFront → WAF → NLB → Traefik → Pod) with security
  boundaries at each layer.
- **Config-driven infrastructure** — typed data arrays for SG rules
  instead of imperative CDK calls. The same approach used by platform
  teams managing hundreds of security groups.
- **Edge security engineering** — CloudFront cache policies, WAF rule
  configuration, behaviour ordering, and cookie forwarding mechanics.
- **Systematic troubleshooting** — diagnosing cascading root causes
  across CloudFront, cache policies, and behaviour ordering.

## Source Files

- `infra/lib/stacks/kubernetes/base-stack.ts` — VPC, SGs, NLB, Route 53
- `infra/lib/stacks/kubernetes/edge-stack.ts` — CloudFront, WAF, ACM
- `infra/lib/constructs/networking/cloudfront.ts` — CloudFront construct
- `infra/lib/constructs/networking/network-load-balancer.ts` — NLB
- `infra/lib/constructs/networking/vpc-flow-logs.ts` — VPC Flow Logs
- `infra/lib/constructs/security-group.ts` — Config-driven SG construct
- `infra/lib/config/nextjs.ts` — Auth cookie config, validation
- `infra/lib/config/kubernetes/configurations.ts` — SG rules, networking
- `kubernetes-app/platform/argocd-apps/traefik.yaml` — Traefik ArgoCD App

## Summary

This document covers the full networking stack from edge to pod:
CloudFront distribution with WAF WebACL in us-east-1, behaviour
ordering and cache policy mechanics, shared VPC with 4 config-driven
security groups, NLB with TCP passthrough, Traefik DaemonSet with
hostNetwork, and Route 53 private hosted zone. Includes structured
troubleshooting for five resolved production issues.

## Keywords

cloudfront, waf, vpc, security-groups, nlb, traefik, route53, calico,
networking, eip, cidr, cache-policy, behaviour-ordering, csrf,
data-driven, origin-request-policy
