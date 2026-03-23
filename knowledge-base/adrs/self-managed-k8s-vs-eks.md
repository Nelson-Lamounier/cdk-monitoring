# ADR: Self-Managed Kubernetes over EKS

**Date:** 2026-03-22
**Status:** Accepted

## Context

The project requires a Kubernetes cluster on AWS to host a Next.js frontend, Prometheus/Grafana monitoring stack, ArgoCD GitOps controller, and supporting workloads. The two primary options were Amazon EKS (managed control plane) or a self-managed kubeadm cluster on EC2.

## Decision

I chose kubeadm-based self-managed Kubernetes on EC2 over Amazon EKS for three reasons:

1. **Cost at single-node scale** — EKS charges $0.10/hour ($73/month) for the managed control plane before a single Pod runs. With a self-managed cluster running one t3.medium control plane and two t3.small workers, the total EC2 cost is approximately $45/month — the control plane fee alone exceeds the entire self-managed cluster cost.

2. **Full control-plane ownership** — Self-managing kubeadm gives direct access to etcd, kube-apiserver flags, certificate rotation, and upgrade paths. This is critical for learning and for building the bootstrap automation pipeline (Layer 1–4: Golden AMI → User Data → SSM Automation → State Manager drift enforcement).

3. **Deeper operational learning** — Building the cluster from scratch required implementing SG rules for every K8s port (etcd 2379–2380, kubelet 10250, VXLAN 4789, Calico BGP 179, CoreDNS 53), configuring IMDSv2, setting up EBS persistent storage, and designing the self-healing pipeline with K8sGPT. These are skills EKS abstracts away.

## Evidence

Key implementation files:

- `infra/lib/config/kubernetes/configurations.ts` — Full cluster config: K8s v1.35.1, Calico v3.29.3, containerd v1.7.24, instance types, SG rules
- `infra/lib/stacks/kubernetes/base-stack.ts` — VPC, 4 security groups (18 intra-cluster rules), KMS, EBS, NLB, EIP
- `infra/lib/stacks/kubernetes/control-plane-stack.ts` — ASG min=1/max=1, Launch Template, EIP failover Lambda
- `infra/lib/stacks/kubernetes/golden-ami-stack.ts` — EC2 Image Builder pipeline baking kubeadm + containerd + Calico
- `infra/lib/constructs/ssm/bootstrap-orchestrator.ts` — Step Functions state machine for automated bootstrap
- `infra/lib/constructs/ssm/node-drift-enforcement.ts` — SSM State Manager association for continuous enforcement (kernel modules, sysctl, services)
- `kubernetes-app/k8s-bootstrap/boot/` — Python/shell bootstrap scripts (control_plane.py, worker.py, verify-cluster.sh)

## Consequences

### Benefits

- **~40% lower cost** than EKS at single-node scale (~$45/month vs ~$118/month with EKS control plane fee)
- **Full lifecycle automation** built through CDK — AMI baking, automated bootstrap, self-healing, drift enforcement
- **Deep understanding** of K8s internals — kubeadm certificates, etcd backup, CNI networking, security group rules
- **Portfolio differentiator** — demonstrates operational maturity beyond clicking "Create Cluster" in the EKS console

### Trade-offs

- **Operational burden** — responsible for kubeadm upgrades, etcd backups, certificate rotation (auto via kubeadm, but must verify)
- **No managed add-ons** — must deploy CoreDNS, kube-proxy, CNI manually (handled by Golden AMI and SSM Automation)
- **No EKS-native integrations** — no IRSA (using instance profile instead), no managed node groups (using custom ASGs)
- **Single control plane** — no HA control plane; relies on ASG self-healing (acceptable for dev/portfolio, not for production workloads)

## Transferable Skills Demonstrated

- **Infrastructure automation** — full lifecycle automation (AMI baking → bootstrap → drift enforcement → self-healing) eliminates manual provisioning. This is the same automation pattern used by SRE teams to reduce MTTR and human error in production environments.
- **Cost-aware architecture** — choosing self-managed K8s at ~$45/month over EKS at ~$118/month demonstrates FinOps thinking before production budgets are at stake. Applicable to any team evaluating managed vs self-managed trade-offs.
- **Deep Kubernetes operational knowledge** — building the cluster from scratch (kubeadm, etcd, CNI, SG rules) provides foundation-level K8s understanding. This depth transfers to troubleshooting managed clusters (EKS, GKE) where the control plane is abstracted but the same components run underneath.

---

*Evidence files listed above are real paths in the cdk-monitoring repository.*