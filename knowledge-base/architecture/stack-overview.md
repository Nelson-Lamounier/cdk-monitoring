# Architecture Overview: Self-Managed Kubernetes on AWS with CDK

**Project:** cdk-monitoring
**Author:** Nelson Lamounier
**Last Updated:** 2026-03-22

## 12-Stack Architecture

The Kubernetes platform is deployed as 12 independent CloudFormation stacks, orchestrated by a factory pattern in `infra/lib/projects/kubernetes/factory.ts`. Stacks are decoupled through SSM parameters — no cross-stack CloudFormation exports.

### Stack Dependency Graph

```
1. Kubernetes-Data          → DynamoDB, S3 Assets, SSM parameters
2. Kubernetes-Base          → VPC lookup, Security Groups ×4, KMS, EBS, EIP, Route 53, S3 scripts bucket, NLB
  2b. Kubernetes-GoldenAmi  → EC2 Image Builder pipeline (bakes Golden AMI with kubeadm, containerd, Calico)
  2c. Kubernetes-SsmAutomation → SSM Automation documents ×6, Step Functions orchestrator, EventBridge triggers
3. Kubernetes-ControlPlane  → Control plane EC2 (t3.medium), ASG min=1/max=1, EIP failover Lambda
  3b. Kubernetes-AppWorker       → Application node EC2 (t3.small), ASG, kubeadm join
  3c. Kubernetes-MonitoringWorker → Monitoring node EC2 (t3.medium Spot), ASG, kubeadm join
  3d. Kubernetes-ArgocdWorker    → ArgoCD node EC2 (t3.small Spot), ASG, kubeadm join
4. Kubernetes-AppIam        → Application-tier IAM grants (DynamoDB, S3, Secrets)
5. Kubernetes-API           → API Gateway + Lambda (email subscriptions)
6. Kubernetes-Edge          → ACM + WAF + CloudFront (us-east-1), Route 53 alias
7. Kubernetes-Observability → CloudWatch pre-deployment dashboard
```

### Why 12 Stacks?

Splitting into granular stacks isolates blast radius:
- Changing an AMI only redeploys GoldenAmi + Compute stacks
- Changing SG rules only redeploys Base stack
- Changing WAF rules only redeploys Edge stack (in us-east-1)
- SSM Automation docs can be updated independently from EC2 instances

### Cross-Stack Communication via SSM

All stacks discover each other through SSM Parameter Store paths (`/k8s/development/*`). The `SsmParameterStoreConstruct` writes parameters in producing stacks. Consuming stacks read via `ssm.StringParameter.valueFromLookup()` at synth time or `AwsCustomResource` at deploy time.

Example SSM parameters:
- `/k8s/development/vpc-id` — VPC ID from shared stack
- `/k8s/development/security-group-id` — cluster base SG
- `/k8s/development/control-plane-sg-id` — control plane SG
- `/k8s/development/eip-allocation-id` — Elastic IP
- `/k8s/development/kms-key-arn` — CloudWatch encryption key
- `/k8s/development/scripts-bucket-name` — S3 scripts bucket
- `/k8s/development/golden-ami/latest` — latest Golden AMI ID

### Factory Pattern

The Kubernetes factory (`infra/lib/projects/kubernetes/factory.ts`) implements `IProjectFactory` and creates all 12 stacks with correct dependency ordering. Usage:

```typescript
// infra/bin/app.ts selects factory based on -c project=k8s
const factory = new KubernetesFactory();
factory.create(app, { environment: Environment.DEVELOPMENT });
```

## Kubernetes Cluster Configuration

All cluster parameters are defined in `infra/lib/config/kubernetes/configurations.ts`:

| Parameter | Development | Production |
|---|---|---|
| Kubernetes version | 1.35.1 | 1.35.1 |
| Pod network CIDR | 192.168.0.0/16 | 192.168.0.0/16 |
| Service subnet | 10.96.0.0/12 | 10.96.0.0/12 |
| Control plane instance | t3.medium | t3.small |
| App worker instance | t3.small | t3.small |
| Monitoring worker | t3.medium (Spot) | t3.small (Spot) |
| ArgoCD worker | t3.small (Spot) | t3.small (Spot) |
| EBS volume | 30 GB | 50 GB |
| Log retention | 1 week | 3 months |
| Removal policy | DESTROY | RETAIN |

## Golden AMI — Baked Software Versions

The EC2 Image Builder pipeline bakes these into every AMI (from `K8sImageConfig`):

| Software | Version | Purpose |
|---|---|---|
| containerd | 1.7.24 | Container runtime |
| runc | 1.2.4 | OCI runtime |
| kubeadm/kubelet/kubectl | 1.35.1 | Kubernetes toolchain |
| Calico | v3.29.3 | CNI networking (BGP + VXLAN) |
| CNI plugins | 1.6.1 | Container Network Interface |
| crictl | 1.32.0 | CRI debugging tool |
| ECR credential provider | v1.31.0 | Pull images from ECR |
| K8sGPT | 0.4.29 | AI-powered K8s diagnostics (self-healing) |
| Docker Compose | v2.24.0 | Local development |
| AWS CLI | 2.x | AWS API access |

Base image: Amazon Linux 2023 (kernel 6.1, x86_64) from SSM path `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64`.

## Security Groups — 4 Data-Driven SGs

All rules are defined as typed config in `configurations.ts` — not inline in stack code. The `SecurityGroupConstruct` reads the config array and calls `addIngressRule()` for each entry.

### Cluster Base SG (intra-cluster)

Self-referencing rules for node-to-node communication:

| Port(s) | Protocol | Source | Purpose |
|---|---|---|---|
| 2379–2380 | TCP | self | etcd client and peer |
| 6443 | TCP | self | K8s API server |
| 10250 | TCP | self | kubelet API |
| 10257 | TCP | self | kube-controller-manager |
| 10259 | TCP | self | kube-scheduler |
| 4789 | UDP | self | VXLAN overlay networking |
| 179 | TCP | self | Calico BGP peering |
| 30000–32767 | TCP | self | NodePort services |
| 53 | TCP+UDP | self | CoreDNS |
| 5473 | TCP | self | Calico Typha |
| 9100 | TCP | self | Traefik metrics |
| 9101 | TCP | self | Node Exporter metrics |

Pod CIDR (192.168.0.0/16) → node rules:

| Port | Protocol | Purpose |
|---|---|---|
| 6443 | TCP | K8s API server (from pods) |
| 10250 | TCP | kubelet API (from pods) |
| 53 | TCP+UDP | CoreDNS (from pods) |
| 9100 | TCP | Traefik metrics (from pods) |
| 9101 | TCP | Node Exporter metrics (from pods) |

### Control Plane SG

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 6443 | TCP | VPC CIDR | K8s API from VPC (SSM port-forwarding) |

### Monitoring SG

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 9090 | TCP | VPC CIDR | Prometheus metrics |
| 9100 | TCP | VPC CIDR + Pod CIDR | Node Exporter metrics |
| 30100 | TCP | VPC CIDR | Loki push API (cross-stack log shipping) |
| 30417 | TCP | VPC CIDR | Tempo OTLP gRPC (cross-stack trace shipping) |

### Ingress SG

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 80 | TCP | VPC CIDR | HTTP health checks from NLB |
| 443 | TCP | CloudFront prefix list | HTTPS from CloudFront (added at runtime) |
| 80+443 | TCP | Admin IPs (SSM) | Admin access (added at runtime from `/admin/allowed-ips`) |

## Traffic Flow

```
User → CloudFront (HTTPS, dev.nelsonlamounier.com)
       → WAF (rate limit 2000/5min, IP reputation, AWS managed rules)
       → Elastic IP (HTTP — avoids SSL hostname mismatch with Traefik self-signed cert)
       → NLB (TCP passthrough, eu-west-1)
       → Traefik Ingress Controller (port 80/443)
       → Kubernetes Service → Pod
```

CloudFront is deployed in us-east-1 (required), compute in eu-west-1. The Edge stack reads the EIP from SSM cross-region.

## Bootstrap Pipeline

Instance boot follows a 4-layer hybrid strategy:

1. **Layer 1: Golden AMI** — pre-baked software (kubeadm, containerd, Calico manifests)
2. **Layer 2: User Data** — slim trigger: attach EBS volume, signal CloudFormation
3. **Layer 3: SSM Automation** — one-shot kubeadm bootstrap (control plane init or worker join)
4. **Layer 3b: SSM State Manager** — continuous drift enforcement every 30 minutes (kernel modules, sysctl, services)

EventBridge triggers the Step Functions orchestrator on every ASG `EC2 Instance Launch Successful` event. The orchestrator Lambda reads `k8s:bootstrap-role` ASG tags to resolve the correct SSM Automation document.

## Self-Healing Pipeline

K8sGPT (installed in the Golden AMI) is invoked by the self-healing Lambda via SSM SendCommand. It analyses cluster health using AI diagnostics and feeds results back to the Step Functions workflow for automated remediation.

## Source Files

- `infra/lib/projects/kubernetes/factory.ts` — 12-stack factory
- `infra/lib/config/kubernetes/configurations.ts` — all configs (SG rules, instance types, versions)
- `infra/lib/stacks/kubernetes/base-stack.ts` — long-lived infrastructure
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` — compute layer
- `infra/lib/stacks/kubernetes/edge-stack.ts` — CloudFront + WAF
- `infra/lib/stacks/kubernetes/ssm-automation-stack.ts` — bootstrap orchestration
- `infra/lib/stacks/kubernetes/golden-ami-stack.ts` — AMI baking pipeline
- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` — Step Functions state machine
- `infra/lib/constructs/ssm/node-drift-enforcement.ts` — drift remediation
