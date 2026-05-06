# EKS Migration — Plan 5b: Pivot to ALB Ingress + ACM + ExternalDNS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if available) to implement this plan task-by-task. Plan execution must NOT begin until § 0 (Open Questions) is resolved.

**Goal:** Replace the V1 ingress stack (Traefik DaemonSet → NLB + cert-manager + Let's Encrypt) with the AWS-native pattern (ALB Ingress + ACM + ExternalDNS) before the workload migration of Plan 5 Task 4 begins. Public domains route through one shared ALB via `IngressGroup`; admin paths reach the same ALB with WAF IP-allowlist. Plan 5 Tasks 6 and 8 (CloudFront origin swap, Day-1 cutover) collapse — the ALB IS the public endpoint.

**Why this pivot:** Plan 5 V1 (Traefik+LE) was a literal port of the kubeadm pattern to EKS. AWS's official EKS Best Practices guide and IAM Pod Identity guidance recommend ALB Ingress + ACM as the canonical EKS path; Traefik on EKS is third-party with no AWS-side endorsement for in-region traffic. The kubeadm cluster is fully decommissioned (no parallel-cluster constraint left), so the V1 layer carries no cost-of-change benefit. ExternalDNS is already installed (`EksAddonsStack`) but produces no records because no `Ingress`/`Service` carries an annotation it can act on — switching workloads from `IngressRoute` to `Ingress` activates it for free.

**Architecture (target state):**

```
Internet
   │
   ├─→ Route53  (records driven by ExternalDNS)
   │      │
   │      └─ A/AAAA → ALB DNS name
   │
   ├─→ ALB (single shared, IngressGroup: public)
   │      │
   │      ├─ Listener :443 + ACM cert (multi-SAN via SNI)
   │      ├─ Listener :80 → :443 redirect
   │      ├─ WAF WebACL (IP-allowlist on /argocd, /grafana, /prometheus paths)
   │      └─ Target Groups (IP target type → pods directly)
   │
   └─→ CloudFront (kept for public production domains; bypassed for dev)
          │
          └─ Origin: ALB DNS name (was kubeadm EIP)
```

**Tech Stack:** AWS Load Balancer Controller (already running), ACM (eu-west-1 for ALB; us-east-1 for CloudFront), ExternalDNS (already running, needs reconfiguration), AWS WAFv2, ArgoCD v2.x, Helm 3, EKS Pod Identity.

**Parent spec:** `docs/superpowers/specs/2026-05-05-eks-migration-design.md` § 5.2 (V2 ingress migration — promoted from "deferred" to "now") + this plan as the executable spec.

**Supersedes (in Plan 5):** Tasks 2 (cert-manager), 3 (Traefik chart copy), 6 (CloudFront origin add), 8 (primary swap), 10 (cutover rollback runbook). Plan 5 Task 4 (workload Apps) is rewritten to use `Ingress` + `IngressGroup` instead of Traefik `IngressRoute`. Plan 5 Tasks 1 (ESO ClusterSecretStore), 3.5 (Argo Rollouts + Image Updater), 5 (monitoring) carry over unchanged.

**Repos touched:**
- `kubernetes-bootstrap` — workload Helm charts (`charts/<workload>/`), `argocd-apps/eks/development/`, removal of `charts/traefik/`, `charts/cert-manager-config/`.
- `cdk-monitoring` — `infra/lib/stacks/kubernetes/edge-stack.ts` (origin → ALB), `tucaken-edge-stack.ts` (origin → ALB), `eks-pod-identity-stack.ts` (ExternalDNS multi-zone scope), `eks-addons-stack.ts` (ExternalDNS Helm values).

**Dependencies (live, verified 2026-05-06):**
- Plan 1 ✅, Plan 2 ✅, Plan 3 ✅, Plan 4 ✅
- Plan 5 foundation ✅: ESO ClusterSecretStores Ready, Argo Rollouts running, Image Updater installed, ALB Controller healthy, ExternalDNS running.
- 🟡 Plan 5 Tasks 2 & 3 deployed (Traefik + cert-manager-config) — to be retired by this plan.

---

## § 0 — Open Questions (MUST resolve before § 1)

**Each open question gates execution.** Do not start cleanup until every item below is answered and the answers are recorded in this file.

### 0.1 Hosted zone topology audit
ExternalDNS Pod Identity role currently grants `route53:ChangeResourceRecordSets` only on `arn:aws:route53:::hostedzone/Z04763221QPB6CZ9R77GM`. The dev SSO admin cannot read that zone (`AccessDenied` on `GetHostedZone`).

- [ ] In which account does `Z04763221QPB6CZ9R77GM` live? (Run `aws route53 get-hosted-zone --id Z04763221QPB6CZ9R77GM` against mgmt-account profile.)
- [ ] What domain is it? (Likely `nelsonlamounier.com` or a sub-domain.)
- [ ] Where do `tucaken.io` and `tucaken.com` live? (Production hosted zones — almost certainly mgmt account; ExternalDNS dev role has no access.)
- [ ] Who else writes to `Z04763221QPB6CZ9R77GM`? Audit existing record set count and any non-ExternalDNS authorship.

### 0.2 ACM certificate strategy
ALB requires certificates in the same region as the ALB (eu-west-1). CloudFront requires us-east-1.

- [ ] **eu-west-1 ALB cert(s)**: one wildcard cert covering all dev domains, OR per-domain certs attached via SNI? AWS Load Balancer Controller can attach up to 25 certs per ALB.
- [ ] **DNS validation**: ACM creates `_acme-challenge.<domain>` CNAME records. ExternalDNS does NOT manage these — needs either CDK-side ACM construct with `ValidationMethod: DNS` and `hostedZone` (and the DNS validation cross-account role) OR manual one-time creation.
- [ ] **Cert renewal**: ACM auto-renews if the validation CNAME stays put. Confirm validation records are persistent (CDK-managed, not ephemeral).
- [ ] **Wildcard scope**: `*.dev.nelsonlamounier.com` covers admin + workloads but not `nelsonlamounier.com` apex; need separate or SAN.
- [ ] **Existing certs**: 3 ISSUED certs for `nelsonlamounier.com` already in eu-west-1 ACM — reuse one or provision fresh.

### 0.3 ExternalDNS multi-domain configuration
Current state: `--domain-filter=nelsonlamounier.com` only.

- [ ] Add `--domain-filter=tucaken.io` and `--domain-filter=tucaken.com` — but ExternalDNS dev role can't write to those zones (mgmt-account).
- [ ] Two paths:
   - (a) **Single ExternalDNS, role chaining**: dev role assumes a cross-account R53 role (already exists at `arn:aws:iam::711387127421:role/Route53DnsValidationRole` per SSM `/k8s/development/cross-account-dns-role-arn`) for tucaken zones. Requires ExternalDNS args `--aws-assume-role` per zone.
   - (b) **Two ExternalDNS instances**: one in dev account (nelsonlamounier), one configured to assume into mgmt for tucaken. Adds operational complexity.
- [ ] Decision: which approach.
- [ ] **TXT-owner-id**: currently `eks-development`. Will collide with any other ExternalDNS writing to the same zones. Confirm no other writers.

### 0.4 Admin paths (`/argocd`, `/grafana`, `/prometheus`)
Today on kubeadm: Traefik `IngressRoute` with `IPAllowlist` middleware on `ops.nelsonlamounier.com/argocd` etc. Need EKS equivalent.

- [ ] **Same ALB or separate?** With one shared ALB, admin paths can be host-based (`ops.dev.nelsonlamounier.com/argocd → argocd-server`) and gated by WAF rule scoped to that hostname.
- [ ] **WAF IP-allowlist**: WebACL with an IP set rule scoped to `Host: ops.dev.nelsonlamounier.com`. Cost: ~$5/month + $1/rule.
- [ ] **Source IP preservation**: ALB IP-target mode preserves source IP; WAF acts on it. Verify.
- [ ] **Allowlist source**: SSM-stored CIDRs (existing pattern), refreshed via ESO. Confirm CIDRs are still relevant.

### 0.5 CloudFront fate per environment
3 distributions hardcode the dead kubeadm EIP today:
- `EIXKG0VM7CBIS` `nelsonlamounier.com` (S3 + EIP)
- `EAQTGLWU2USOL` `tucaken.io` + `www.tucaken.io` (EIP)
- `E132LV40IHEC8R` `tucaken.com` + `www.tucaken.com` (EIP)

- [ ] **Dev environment**: kill all 3 distributions for dev; route Route53 directly at the ALB. ALB serves HTTPS via ACM; no caching tier in dev.
- [ ] **Production / staging**: keep CloudFront in front of ALB; just swap origin from EIP → ALB DNS name. Caching, edge POPs, WAF tier preserved.
- [ ] **S3 nextjs assets**: still served via CloudFront for prod (the static `/_next` paths). For dev, ALB can proxy to a local Service or skip caching.

### 0.6 IngressGroup design
- [ ] Single group `public` for all workload Ingresses (one ALB).
- [ ] Group order (`alb.ingress.kubernetes.io/group.order`) per workload to control listener-rule precedence.
- [ ] Default backend: a 404 service or pinned to one workload (probably nextjs apex).
- [ ] Health checks: `/healthz` on each workload — confirm every chart exposes this path.

### 0.7 Cleanup scope
- [ ] Delete `argocd-apps/eks/development/traefik.yaml`. The Traefik Service + NLB will be removed by ArgoCD prune.
- [ ] Delete `argocd-apps/eks/development/cert-manager.yaml` (controller App) + `cert-manager-config-eks-development` (issuer App) — ALB+ACM doesn't need them.
- [ ] Decide fate of `charts/traefik/`, `charts/cert-manager-config/`: delete vs leave-but-unused. Suggest delete (kubeadm gone, no consumer).
- [ ] Delete `charts/argocd-ingress/` (kubeadm-only Traefik IngressRoute for ArgoCD admin). Replace with EKS Ingress in `argocd-apps/eks/development/argocd-ingress.yaml`.

---

## § 1 — Phase Structure

Each phase is one or more PRs against `kubernetes-bootstrap` and/or `cdk-monitoring`. Phases are sequential.

### Phase 1 — Cleanup
**Branch:** `feat/eks-plan5b-cleanup`. Single PR.

- [ ] Delete `argocd-apps/eks/development/traefik.yaml`, `cert-manager.yaml` (both apps).
- [ ] Delete `charts/traefik/` and `charts/cert-manager-config/`.
- [ ] (Optional) Delete `charts/argocd-ingress/` if § 0.7 confirmed.
- [ ] After ArgoCD prunes: confirm Traefik NLB is gone, no `argocd-apps/eks/development/cert-manager-config` Application.
- [ ] Cluster intentionally has no ingress; nothing user-facing reachable. Plan 5 Task 4 (workload migration) lands ingress.

### Phase 2 — ExternalDNS reconfig + ACM provisioning (cdk-monitoring)
**Branch:** `feat/eks-plan5b-dns-acm`. Single PR in cdk-monitoring.

- [ ] **Update ExternalDNS Pod Identity policy** (`eks-pod-identity-stack.ts`): grant `route53:ChangeResourceRecordSets` on additional hosted zones from § 0.1. Add `sts:AssumeRole` on the cross-account DNS role if § 0.3 picks role-chaining.
- [ ] **Update ExternalDNS Helm values** (`eks-addons-stack.ts`): add `--domain-filter=tucaken.io`, `--domain-filter=tucaken.com`. Configure `--aws-assume-role` if needed.
- [ ] **Provision ACM certs** (new construct `infra/lib/constructs/networking/alb-cert.ts`): one cert per environment for the dev base domain, or per-domain wildcard. DNS validation via the existing cross-account role.
- [ ] **Write ACM cert ARN(s) to SSM** at e.g. `/k8s/development/eks/alb-cert-arn` so workload Apps can reference.
- [ ] Tests: unit tests for new construct.

### Phase 3 — Workload Ingress pattern
**Branch:** `feat/eks-plan5b-workload-ingress-template`. PR in kubernetes-bootstrap.

Author the canonical workload Ingress template and apply to ONE workload first (admin-api as canary). Once verified end-to-end (Route53 record created, ACM cert served, pod reachable), apply to remaining 8 workloads.

- [ ] **Each workload chart's `templates/ingress.yaml`**:
  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: Ingress
  metadata:
    name: {{ .Release.Name }}
    annotations:
      kubernetes.io/ingress.class: alb
      alb.ingress.kubernetes.io/scheme: internet-facing
      alb.ingress.kubernetes.io/target-type: ip
      alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
      alb.ingress.kubernetes.io/ssl-redirect: '443'
      alb.ingress.kubernetes.io/group.name: public
      alb.ingress.kubernetes.io/group.order: '{{ .Values.ingress.groupOrder }}'
      alb.ingress.kubernetes.io/healthcheck-path: /healthz
      external-dns.alpha.kubernetes.io/hostname: {{ .Values.ingress.host }}
  spec:
    rules:
      - host: {{ .Values.ingress.host }}
        http:
          paths:
            - path: /
              pathType: Prefix
              backend:
                service:
                  name: {{ .Release.Name }}
                  port:
                    number: 80
  ```
- [ ] Per-workload values:
  - `admin-api`: host `admin.dev.nelsonlamounier.com`, order `100`.
  - `public-api`: host `api.dev.nelsonlamounier.com`, order `200`.
  - `nextjs`: host `dev.nelsonlamounier.com`, order `900` (default-like fallback).
  - `tucaken-app` (.io): host `dev.tucaken.io`, order `300`.
  - `tucaken-app` (.com): host `dev.tucaken.com`, order `400`.

### Phase 4 — Admin paths (argocd / grafana / prometheus)
**Branch:** `feat/eks-plan5b-admin-ingress`. PR in kubernetes-bootstrap.

- [ ] Author `argocd-apps/eks/development/argocd-ingress.yaml` — Ingress with host `ops.dev.nelsonlamounier.com`, paths `/argocd`, `/grafana`, `/prometheus` routing to respective backends.
- [ ] Annotation `alb.ingress.kubernetes.io/wafv2-acl-arn` referencing a WebACL provisioned in cdk-monitoring with the IP-allowlist rule.
- [ ] Allowlist CIDRs sourced from ESO → SSM (existing `/shared/development/admin-allowlist-ipv4` etc.).

### Phase 5 — CloudFront edge stacks
**Branch:** `feat/eks-plan5b-cloudfront`. PR in cdk-monitoring.

Per § 0.5 decision:
- **If kill-dev**: delete dev `EdgeStack` and dev `TucakenEdgeStack`. Route53 records (created by ExternalDNS) point directly at ALB.
- **If keep-dev**: edit both edge stacks to read ALB DNS from SSM (`/k8s/development/eks/alb-dns-name`, written by ExternalDNS-side construct or CFN custom resource) and use as `HttpOrigin`. Drop the kubeadm EIP origin.

### Phase 6 — Plan 5 Task 4 (workload migration)
Use Phase 3 template + Phase 4 admin pattern. Per workload, one PR:
- `admin-api`, `public-api`, `nextjs`, `tucaken-app`, `article-pipeline`, `ingestion`, `job-strategist`, `resume-import`, `platform-rds`.

Migration drop-in: `Rollout` (already supported in `argo-rollouts`), `Ingress` (this plan), `ExternalSecret` referencing `aws-ssm` ClusterSecretStore.

### Phase 7 — Plan 5 Task 5 (monitoring)
Unchanged from Plan 5 — fresh PVCs, system MNG affinity, dashboards as-code.

### Phase 8 — Verification + acceptance
- [ ] Each domain resolves to ALB via Route53 (dig).
- [ ] Each domain serves HTTPS with valid ACM cert.
- [ ] WAF allows admin paths only from allowlist CIDRs (test from non-allowed source → 403).
- [ ] Health checks pass; ALB registers all pod IPs.
- [ ] CloudWatch alarms (Plan 5 Task 7 carries over) fire on canary failures.
- [ ] CloudFront prod fallback unchanged (Plan 5 Task 5/8 already-live behaviours).

---

## Cost (eu-west-1, monthly, dev workloads)

| Item | Replaces | $/month |
|---|---|---|
| 1 ALB (single shared, IngressGroup) | 1 NLB (Traefik) | ~$18–22 |
| ACM certs | LE certs | $0 |
| WAF WebACL (admin allowlist) | Traefik IPAllowlist middleware | ~$10 ($5 + 5 rules × $1) |
| ExternalDNS R53 calls | manual R53 / bootstrap script | ~$0 (free tier) |
| Route53 hosted zones | (unchanged) | $0.50/zone (existing) |

Net change versus Plan 5 V1: NLB→ALB cost-neutral; +$10 WAF; -Traefik chart maintenance burden; -cert-manager + LE chart burden.

---

## Risks

| Risk | Mitigation |
|---|---|
| Hosted zone audit reveals tucaken zones can't be written to from EKS dev account | Use cross-account role chaining (§ 0.3 option a). If blocked, defer tucaken to Phase 6+ and ship nelsonlamounier-only first. |
| ACM DNS validation creates `_acme-challenge` CNAMEs in mgmt account; cross-account role must permit it | Existing `Route53DnsValidationRole` already permits this (used today for kubeadm certs). Reuse. |
| WAF rule order misconfiguration drops legitimate traffic | Per-rule canary test; deploy WebACL in COUNT mode first, observe, switch to BLOCK. |
| ALB cert SAN list overflows the 25-cert per-listener limit | Current dev: ≤6 hostnames. No risk. Production: re-evaluate with wildcard certs. |
| ExternalDNS `--policy=upsert-only` leaves stale records | Run a periodic sync with `--policy=sync` in a maintenance window to reap; or accept cosmetic stale records. |
| Removing Traefik mid-session breaks any URL still pointing at the NLB | No URL points at the NLB today (no DNS wired). Safe. |

---

## References

- AWS Best Practices: Load Balancing — https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html
- AWS Load Balancer Controller — IngressGroup annotation reference: https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
- ExternalDNS (sig-network) — https://kubernetes-sigs.github.io/external-dns/
- ACM DNS validation — https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html
- WAFv2 EKS integration — https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/#wafv2-acl-arn

---

## Out of Scope

- Migration of additional kubeadm-only Apps (ARC, descheduler, opencost, ecr-token-refresh, etc.) — handled per workload as needed; not all need EKS equivalents.
- Removal of CloudFront for production environments — Phase 5 only addresses dev.
- Auto Mode evaluation — explicitly rejected (decision recorded 2026-05-06).
- Plan 6 (`_deprecated_kubeadm/` rename of dead top-level `argocd-apps/`).

---

## Status

| Section | State | Date |
|---|---|---|
| § 0 Open Questions | 🔴 unresolved — must finish before § 1 starts | 2026-05-06 |
| Phase 1 Cleanup | 🔴 not started | — |
| Phase 2 DNS+ACM | 🔴 not started | — |
| Phase 3 Workload template | 🔴 not started | — |
| Phase 4 Admin Ingress | 🔴 not started | — |
| Phase 5 CloudFront | 🔴 not started | — |
| Phase 6 Workloads | 🔴 not started | — |
| Phase 7 Monitoring | 🔴 not started | — |
| Phase 8 Acceptance | 🔴 not started | — |
