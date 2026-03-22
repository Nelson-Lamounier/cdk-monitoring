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

## Source Files

- `infra/lib/stacks/kubernetes/base-stack.ts` — VPC, SGs, NLB, EIP, Route 53
- `infra/lib/config/kubernetes/configurations.ts` — SG rules config, networking config
- `infra/lib/constructs/networking/network-load-balancer.ts` — NLB construct
- `infra/lib/constructs/networking/vpc-flow-logs.ts` — VPC Flow Logs
- `infra/lib/constructs/security-group.ts` — Config-driven SG construct
- `kubernetes-app/platform/argocd-apps/traefik.yaml` — ArgoCD App for Traefik
- `kubernetes-app/k8s-bootstrap/system/traefik/traefik-values.yaml` — Traefik Helm values