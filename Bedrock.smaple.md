---
title: "Networking From Scratch: VPC, Calico, Traefik, and CloudFront on AWS"
description: "How I built a complete Kubernetes networking stack on AWS — from VPC design and Calico CNI to Traefik ingress and CloudFront edge, with the debugging sessions that nearly broke me."
tags: ["kubernetes", "networking", "calico", "traefik", "cloudfront", "vpc"]
slug: "networking-from-scratch-vpc-calico-traefik-cloudfront"
publishDate: "2026-03-23"
author: "Nelson Lamounier"
category: "DevOps"
readingTime: 8
---

<ImageRequest
  id="networking-hero"
  type="hero"
  instruction="Dark technical hero image showing layered network topology: browser icon → CloudFront globe → NLB shield → Traefik compass → Kubernetes pod. Use dark navy background with glowing connection lines between each layer."
  context="Hero image establishing the end-to-end networking theme of the article."
/>

## TL;DR

Building Kubernetes networking on AWS isn't a single decision — it's a chain of ten decisions, each one constrained by the previous. VPC CIDR that doesn't collide with your pod network. Calico CNI that uses VXLAN and needs a security group self-reference rule you won't find in the docs. An NLB doing pure TCP passthrough so Traefik handles TLS at the edge. CloudFront terminating public HTTPS and forwarding HTTP to your Elastic IP to avoid a certificate hostname mismatch. Every layer is deliberate. This article walks through each one — including the 3-day debugging session that taught me more about security groups than any certification ever did.

<Callout type="note">
  All infrastructure is deployed with AWS CDK (TypeScript) targeting Kubernetes 1.35.1 on Amazon Linux 2023. Security group rules are defined as typed config in `infra/lib/config/kubernetes/configurations.ts` — not inline in CDK stack code. The full networking stack lives in `infra/lib/stacks/kubernetes/base-stack.ts`.
</Callout>

## The VPC: One Decision That Shapes Everything Downstream

The shared VPC is not created by the Kubernetes stack. It's discovered.

```typescript
// infra/lib/stacks/kubernetes/base-stack.ts — VPC lookup (not created, discovered)
const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
  vpcId: props.configs.networking.vpcId
});
```

The VPC ID lives in SSM at `/k8s/development/vpc-id`, written by the `deploy-shared` pipeline. Consuming stacks read it at synth time. No cross-stack CloudFormation exports — those create hard coupling between stacks and make independent redeployment painful.

The CIDR layout matters more than it looks at first glance:

| Network | CIDR | Owner |
|---|---|---|
| VPC | 10.0.0.0/16 | AWS VPC |
| Pod network | 192.168.0.0/16 | Calico CNI |
| Service subnet | 10.96.0.0/12 | kubeadm default |

Those three ranges must not overlap. Calico assigns 192.168.0.0/16 to pods — well outside the VPC range — which means pod-to-AWS-service traffic routes cleanly through the node's VPC IP without CIDR ambiguity.

### Public Subnets Only — A FinOps Call

The cluster runs in two public subnets across AZ-a and AZ-b. No private subnets. No NAT Gateway.

That's a deliberate cost decision. A NAT Gateway in eu-west-1 runs approximately €30/month before data transfer charges. At this scale, that's real money. Instances use public IPs but are protected by strict security group rules — and critically, there is no SSH access. All administrative access routes through AWS Systems Manager Session Manager.

<Callout type="tip">
  Public subnets with strict security groups and SSM-only access can be as secure as private subnets for many workloads — at a fraction of the cost. The security boundary is the security group, not the subnet type. Platform teams running dev/staging environments should evaluate this trade-off explicitly rather than defaulting to private subnets.
</Callout>

<ImageRequest
  id="vpc-subnet-layout"
  type="diagram"
  instruction="Diagram showing the VPC layout: two public subnets in AZ-a and AZ-b within a 10.0.0.0/16 VPC. AZ-a contains Control Plane, App Worker, and Monitoring Worker nodes. AZ-b contains the ArgoCD Worker node. Show public IP assignments on each node. No private subnets or NAT Gateway."
  context="The reader needs to see the 2-AZ, public-subnet-only topology to understand why the NLB cross-AZ issue occurred and why the NAT Gateway cost saving was possible."
/>

## Calico CNI: BGP, VXLAN, and the Self-Reference Trap

Calico v3.29.3 is baked into the Golden AMI by the EC2 Image Builder pipeline. Every node that boots already has Calico binaries — no network call required at bootstrap time.

Calico operates in BGP + VXLAN mode. The BGP component handles node-to-node route advertisement (each node advertises its pod CIDR). The VXLAN component handles encapsulation when BGP routes aren't available — specifically, cross-subnet pod traffic.

Here's what caught me.

Calico VXLAN wraps pod packets inside UDP/4789, sourced from the node's VPC IP. When that packet hits another node's security group, AWS evaluates the source IP as the originating *node IP* — not the pod IP. The return traffic therefore needs the security group to permit traffic from itself.

This is the self-reference rule:

```typescript
// infra/lib/config/kubernetes/configurations.ts — Cluster Base SG self-reference rules
// Port 4789 UDP — VXLAN overlay networking
// Source: self (the same security group)
{
  port: 4789,
  protocol: Protocol.UDP,
  source: SgSource.SELF,
  description: 'VXLAN overlay — Calico encapsulated pod traffic'
},
{
  port: 179,
  protocol: Protocol.TCP,
  source: SgSource.SELF,
  description: 'Calico BGP peering between nodes'
},
```

Without that UDP 4789 self-reference, pod-to-pod traffic across nodes silently drops. Not a connection refused. Not a timeout. A black hole. It took me three days of packet captures and progressively narrowing the blame to find it. The fix is one rule. The understanding cost three days.

<Callout type="danger">
  If pod-to-pod communication works within a node but fails across nodes, check VXLAN port 4789 UDP in your security group self-reference rules before touching anything else. This is the Calico VXLAN gotcha that is not prominently documented.
</Callout>

## The Security Group Matrix — Config-Driven, Not Imperative

Four security groups govern the cluster. Every rule is defined as typed data in `configurations.ts` — the `SecurityGroupConstruct` reads the array and calls `addIngressRule()` for each entry. No inline `sg.addIngressRule()` calls scattered across stack code.

### Cluster Base SG — Intra-Cluster Communication

| Port(s) | Protocol | Source | Purpose |
|---|---|---|---|
| 2379–2380 | TCP | self | etcd client and peer |
| 6443 | TCP | self | K8s API server |
| 10250 | TCP | self | kubelet API |
| 4789 | UDP | self | Calico VXLAN overlay |
| 179 | TCP | self | Calico BGP peering |
| 5473 | TCP | self | Calico Typha |
| 53 | TCP+UDP | self | CoreDNS |
| 30000–32767 | TCP | self | NodePort services |

The pod CIDR (192.168.0.0/16) also needs inbound rules to reach node services — API server on 6443, kubelet on 10250, and CoreDNS on 53. Pods are not in the VPC CIDR. Without explicit pod CIDR rules, kube-dns breaks silently.

### Ingress SG — Traefik's Perimeter

This one has a runtime component. The static config covers NLB health checks. The runtime additions are applied in `base-stack.ts` after the config loop:

```typescript
// infra/lib/stacks/kubernetes/base-stack.ts — runtime SG additions
// CloudFront managed prefix list — resolves at deploy time
ingressSg.addIngressRule(
  ec2.Peer.prefixList(cloudFrontPrefixListId),
  ec2.Port.tcp(443),
  'HTTPS from CloudFront managed prefix list'
);

// Admin IPs from SSM — not hardcoded in source control
const adminIps = ssm.StringParameter.valueFromLookup(
  this, '/admin/allowed-ips'
);
ingressSg.addIngressRule(
  ec2.Peer.ipv4(adminIps),
  ec2.Port.tcpRange(80, 443),
  'Admin access from SSM-stored IP range'
);
```

Admin IPs in SSM, not in source code. This matters. Rotating an admin IP is an SSM parameter update and a pipeline re-run — no commit, no PR, no diff in git history that leaks IP addresses.

## The NLB → Traefik Path

The Network Load Balancer is intentionally dumb. TCP passthrough on ports 80 and 443. No TLS termination, no HTTP header inspection — it forwards bytes and gets out of the way.

```
# infra/lib/constructs/networking/network-load-balancer.ts
NLB configuration:
  Type:    Network (TCP passthrough)
  Scheme:  Internet-facing
  Targets: Control plane ASG instances
  Listeners:
    TCP 80  → Traefik port 80 on EC2
    TCP 443 → Traefik port 443 on EC2
  Health check: TCP port 80 (Traefik health endpoint)
  Access logs: S3 bucket, 3-day lifecycle expiration
  Cross-zone LB: DISABLED (see challenge below)
```

Traefik runs as a DaemonSet on the application nodes with `hostNetwork: true`. Host networking means Traefik binds directly to the EC2 instance's network interface on ports 80 and 443 — no NodePort, no ClusterIP indirection. The NLB forwards to the node IP and Traefik receives it directly.

TLS termination happens at Traefik with Let's Encrypt certificates managed by cert-manager. IngressRoute CRDs route traffic to the correct Kubernetes Service by hostname: `ops.{domain}` goes to the monitoring stack (Grafana, Prometheus, ArgoCD), `{domain}` goes to the Next.js frontend.

## CloudFront → EIP: The Cross-Region Architecture

CloudFront is deployed in us-east-1. AWS requires it — ACM certificates for CloudFront must be in us-east-1. Compute lives in eu-west-1. The Edge stack reads the Elastic IP from SSM cross-region using `AwsCustomResource`:

```typescript
// infra/lib/stacks/kubernetes/edge-stack.ts — cross-region SSM read
const eipAddress = new cr.AwsCustomResource(this, 'ReadEip', {
  onUpdate: {
    service: 'SSM',
    action: 'getParameter',
    region: 'eu-west-1',           // reads from eu-west-1
    parameters: { Name: '/k8s/development/eip-address' },
    physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()) // force fresh read
  },
  policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE })
});
```

The timestamp-based `physicalResourceId` forces a fresh SSM read on every deploy. Without it, CloudFormation caches the value and the Edge stack silently uses a stale EIP after a control plane replacement.

CloudFront forwards to the EIP using `HTTP_ONLY` — not HTTPS. This looks like it breaks security. It doesn't. The Elastic IP resolves to an AWS-managed hostname (`ec2-1-2-3-4.eu-west-1.compute.amazonaws.com`). Traefik's self-signed certificate doesn't match that hostname, causing a TLS hostname mismatch. HTTP between CloudFront and the origin avoids the mismatch. Public TLS is CloudFront's responsibility — it holds the ACM certificate for `dev.nelsonlamounier.com`.

<MermaidChart chart={`
graph LR
    User["User"]
    CF["CloudFront\ndev.nelsonlamounier.com\nus-east-1"]
    WAF["WAF\nRate 2000/5min\nIP reputation"]
    EIP["Elastic IP\nHTTP passthrough\neu-west-1"]
    NLB["NLB\nTCP passthrough"]
    Traefik["Traefik\nIngressRoute\nport 80/443"]
    Svc["K8s Service"]
    Pod["Pod"]
    User --> CF --> WAF --> EIP --> NLB --> Traefik --> Svc --> Pod
    style CF fill:#1a237e,color:#fff
    style WAF fill:#b71c1c,color:#fff
    style EIP fill:#e65100,color:#fff
    style NLB fill:#1565c0,color:#fff
    style Traefik fill:#2d6a4f,color:#fff
    style Svc fill:#33691e,color:#fff
    style Pod fill:#4a148c,color:#fff
`} />

WAF runs at the CloudFront layer with rate limiting (2,000 requests per 5 minutes), IP reputation lists, and AWS managed rule groups. Security at the edge — before a single byte reaches the origin.

## Challenges: The Debugging Sessions

### The Self-Reference That Wasn't There

Pod-to-pod communication worked fine within a node. Cross-node traffic silently dropped. Three days of debugging: checked CoreDNS, checked Calico node status, checked iptables — everything reported healthy. The problem was UDP 4789 VXLAN traffic being blocked at the security group layer because the self-reference rule was missing.

Calico VXLAN encapsulates pod packets in UDP with the source IP of the originating node. The receiving node's security group evaluates that source IP — and without a self-reference rule, the packet is dropped. **The fix was one line of config.** The cost was three days of my life.

This is why the security group rules are defined as data, not code. When I finally understood the model, I could add the rule in one place and have it apply consistently across every node role.

### NLB Cross-AZ Traffic

The NLB distributed requests across both AZs. The control plane runs only in AZ-a. When the NLB routed a health check to AZ-b, no healthy target existed there — and unhealthy traffic leaked through intermittently. Fix: disabled cross-zone load balancing. Traffic stays within the AZ that has a healthy Traefik target.

```typescript
// infra/lib/constructs/networking/network-load-balancer.ts
const nlb = new elbv2.NetworkLoadBalancer(this, 'NLB', {
  vpc,
  internetFacing: true,
  crossZoneEnabled: false  // explicitly disabled — single AZ control plane
});
```

### CloudFront 504 Timeouts

CloudFront returned 504s intermittently. The NLB health check was passing — Traefik was responding. The K8s API server pod was in CrashLoopBackOff. Root cause: the health check endpoint only confirmed Traefik was alive, not that the cluster was healthy. The fix was a separate health endpoint that verified API server reachability before returning 200. A health check that can't detect the actual failure mode is not a health check.

## Junior Corner: Why `hostNetwork: true` Is Not a Hack

When you run a Kubernetes pod with `hostNetwork: true`, the pod shares the node's network namespace. No virtual network interface. No pod IP. The pod binds to the EC2 instance's IP address directly.

For most pods, this is wrong — you want isolation. For Traefik running as an ingress controller, it's the correct choice. The NLB sends TCP traffic to the EC2 instance's IP on port 80/443. Without `hostNetwork: true`, that traffic would hit the node but find nothing listening on those ports — because the pod's port binding is inside its isolated network namespace, invisible to the node's network stack.

Think of it like this: regular pods live in apartments with their own doorbells. `hostNetwork: true` puts Traefik's doorbell directly on the building's front door. The NLB rings the building's doorbell. It needs to reach Traefik.

## Where This Applies

Every production Kubernetes deployment on AWS involves some version of this decision chain. The specific values change — private subnets replace public ones, EKS replaces kubeadm, ALB Ingress Controller replaces Traefik — but the topology logic is identical. Understanding *why* each layer exists (and what breaks when it's missing) is what separates engineers who can maintain existing infrastructure from engineers who can design new infrastructure.

The config-driven security group pattern scales directly. A team managing 20 clusters can maintain SG rules as typed config arrays, code-reviewed and version-controlled, rather than imperative CDK calls scattered across stacks. The self-reference debugging methodology transfers to any overlay networking system — Flannel, Weave, Cilium — they all have the same VPC visibility problem with encapsulated traffic.

## Lessons and What Comes Next

Building this networking stack from VPC CIDRs to CloudFront distributions gave me something certifications don't — a mental model of what each layer abstracts away and what it costs when it breaks.

This self-managed networking experience positions me to evaluate the EKS managed node group trade-off with real context. Not "EKS is easier" in the abstract, but: EKS VPC CNI eliminates the VXLAN self-reference problem by assigning real VPC IPs to pods. That's a concrete trade-off with a concrete operational cost. The engineers who can articulate that comparison — and choose deliberately rather than by default — are the ones building reliable platforms.

Next: extending this model with Calico NetworkPolicy to enforce zero-trust pod-to-pod communication, and evaluating AWS Gateway Load Balancer as a replacement for the CloudFront → NLB → Traefik chain for non-HTTP workloads.