# Networking Implementation — VPC, Security Groups, NLB, Traefik

**Project:** cdk-monitoring
**Last Updated:** 2026-03-22

## VPC Architecture

The Kubernetes cluster uses a shared VPC from the `deploy-shared` pipeline, looked up via VPC ID in the base stack:

```typescript
// base-stack.ts — VPC lookup (not created, discovered)
const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.configs.networking.vpcId });
```

The shared VPC provides public and private subnets across multiple AZs in eu-west-1. VPC Flow Logs are enabled via the `VpcFlowLogsConstruct` for network traffic analysis.

**Key networking values from config:**
- VPC CIDR: 10.0.0.0/16 (shared VPC)
- Pod network CIDR: 192.168.0.0/16 (Calico CNI)
- Service subnet: 10.96.0.0/12 (kubeadm default)
- K8s API port: 6443
- Traefik HTTP: 80, HTTPS: 443

## Security Groups — 4 Config-Driven SGs

All security group rules are defined as typed data in `infra/lib/config/kubernetes/configurations.ts` using `K8sPortRule[]`. The `SecurityGroupConstruct` iterates the config array and calls `addIngressRule()` per entry. This is a data-driven approach — adding a port rule is a config change, not a stack code change.

### Cluster Base SG (18 rules)

Self-referencing rules for all node-to-node communication:
- etcd: TCP 2379–2380 (client + peer)
- K8s API: TCP 6443
- kubelet: TCP 10250
- kube-controller-manager: TCP 10257
- kube-scheduler: TCP 10259
- VXLAN overlay: UDP 4789 (Calico VXLAN mode)
- Calico BGP: TCP 179
- Calico Typha: TCP 5473
- NodePort range: TCP 30000–32767
- CoreDNS: TCP+UDP 53
- Traefik metrics: TCP 9100
- Node Exporter: TCP 9101

Pod CIDR (192.168.0.0/16) → Node rules:
- K8s API: TCP 6443 (from pods)
- kubelet: TCP 10250 (from pods)
- CoreDNS: TCP+UDP 53 (from pods)
- Traefik metrics: TCP 9100, Node Exporter: TCP 9101 (from pods — Prometheus scraping)

### Control Plane SG (1 rule)

- K8s API: TCP 6443 from VPC CIDR (for SSM port-forwarding access)

### Ingress SG (runtime rules)

Static config rules:
- HTTP health checks: TCP 80 from VPC CIDR (NLB health checks)

Runtime-added rules (in `base-stack.ts` after config loop):
- HTTPS from CloudFront: TCP 443 from CloudFront managed prefix list
- Admin access: TCP 80+443 from admin IPs read from SSM parameter `/admin/allowed-ips`

### Monitoring SG (5 rules)

- Prometheus: TCP 9090 from VPC CIDR
- Node Exporter: TCP 9100 from VPC CIDR + Pod CIDR
- Loki push API: TCP 30100 from VPC CIDR (NodePort for cross-stack log shipping)
- Tempo OTLP gRPC: TCP 30417 from VPC CIDR (NodePort for cross-stack trace collection)

## Network Load Balancer

The NLB is created by `NetworkLoadBalancerConstruct` in the base stack:

- **Type:** Network (TCP passthrough, no TLS termination)
- **Scheme:** Internet-facing
- **Targets:** Control plane ASG instances
- **Listeners:** TCP 80 and TCP 443 → Traefik ports on EC2
- **Health check:** TCP on port 80 (Traefik health endpoint)
- **Access logs:** S3 bucket with 3-day lifecycle expiration

## Route 53

- **Private hosted zone:** `k8s.internal` — stable DNS for K8s API server endpoint within VPC
- **A record:** Created by EIP failover Lambda to point to the current control plane instance
- **CloudFront alias:** `dev.nelsonlamounier.com` → CloudFront distribution (in the Edge stack)

## Traefik Ingress Controller

Traefik is deployed via ArgoCD Helm chart (`kubernetes-app/platform/argocd-apps/traefik.yaml`):
- Runs as a DaemonSet on application nodes
- Listens on ports 80 (HTTP) and 443 (HTTPS)
- Handles SSL termination with Let's Encrypt certificates (via cert-manager)
- Routes traffic to Kubernetes Services based on IngressRoute CRDs

## Traffic Flow

```
Internet → CloudFront (HTTPS, dev.nelsonlamounier.com, us-east-1)
         → WAF WebACL (rate limit 2000/5min, IP reputation, managed rules)
         → Elastic IP origin (HTTP — avoids TLS mismatch with Traefik self-signed)
         → NLB (TCP passthrough, eu-west-1)
         → Traefik IngressRoute → Service → Pod
```

## Decision Reasoning

1. **Data-driven security groups** — SG rules are defined as typed arrays in `configurations.ts`, not hardcoded in stack code. Adding a new port rule is a config change that doesn't touch construct logic. This prevents SG rule sprawl and makes port inventory auditable at a glance.

2. **NLB over ALB** — The NLB does TCP passthrough (no TLS termination). TLS is handled by Traefik using cert-manager-issued certificates stored in etcd. This avoids double TLS termination and keeps certificate management within Kubernetes, not AWS.

3. **Private hosted zone for K8s API** — `k8s.internal` provides a stable DNS name for the K8s API server (`kubeapi.k8s.internal:6443`). When the control plane instance is replaced by the ASG, the EIP failover Lambda updates the A record. SSM port-forwarding and kubectl clients use this DNS name, not the EIP directly.

4. **CloudFront → NLB → Traefik traffic path** — CloudFront terminates public TLS and applies WAF rules. The NLB passes TCP through to Traefik on the node's host network. This gives both edge security (WAF rate limiting, IP reputation) and Kubernetes-native routing (IngressRoute CRDs).

## Challenges Encountered

- **Security Group self-reference** — pod-to-node communication failed until a self-referencing SG rule was added. Calico VXLAN encapsulates pod traffic in the node's IP, so return traffic needs the SG to allow traffic from itself. This was a 3-day debugging session that deepened SG understanding significantly.
- **CloudFront 504 timeouts** — CloudFront returned 504s when the K8s API server was unreachable inside the cluster. Root cause: the NLB health check was passing (Traefik responded), but the API server pod was in CrashLoopBackOff. Fixed by adding a separate health check endpoint that verifies API server reachability.
- **NLB cross-AZ traffic** — NLB distributed traffic to nodes in all AZs, but the control plane only ran in one AZ. Disabled cross-zone load balancing to avoid routing to AZs without a healthy target.

## Transferable Skills Demonstrated

- **Network architecture design** — designing multi-layer traffic flows (CloudFront → WAF → NLB → Traefik → K8s Service → Pod) with security boundaries at each layer. Applicable to any team designing zero-trust network architectures.
- **Config-driven infrastructure** — using typed data arrays for security group rules instead of imperative CDK calls. This pattern reduces infrastructure drift and is the same approach used by platform teams managing hundreds of security groups.
- **Troubleshooting methodology** — systematically diagnosing CloudFront 504s and SG self-reference issues demonstrates network debugging skills transferable to any cloud networking role.

## Source Files

- `infra/lib/stacks/kubernetes/base-stack.ts` — VPC, SGs, NLB, EIP, Route 53
- `infra/lib/config/kubernetes/configurations.ts` — SG rules config, networking config
- `infra/lib/constructs/networking/network-load-balancer.ts` — NLB construct
- `infra/lib/constructs/networking/vpc-flow-logs.ts` — VPC Flow Logs
- `infra/lib/constructs/security-group.ts` — Config-driven SG construct
- `kubernetes-app/platform/argocd-apps/traefik.yaml` — ArgoCD App for Traefik
- `kubernetes-app/k8s-bootstrap/system/traefik/traefik-values.yaml` — Traefik Helm values