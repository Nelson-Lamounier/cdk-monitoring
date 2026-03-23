# Learning Methodology — From Tutorials to Building to Documenting

## Overview

This document captures how learning patterns evolved through the portfolio project — from following tutorials and documentation to building production systems and documenting every decision. It reflects on what works, what doesn't, and how the iterative learning cycle compounds over time.

> **Category:** Self-Reflection
> **Not code-backed** — this article draws from learning experience, not repository infrastructure.

## Context

- **Learning timeline:** ~18 months from first CDK stack to full production infrastructure
- **No formal training programme** — Self-directed learning alongside full-time AWS support role
- **Core belief:** You don't truly understand something until you've built it, broken it, and documented why it broke

## The Learning Progression

### Stage 1: Tutorial Following (Months 1–3)

**What it looked like:** Completing AWS workshops, following "Build X with CDK" guides, copying Terraform examples and converting to CDK.

**What it taught:**
- Basic CDK patterns — stacks, constructs, props interfaces
- AWS service fundamentals — how services connect, what IAM policies look like
- Tooling setup — Node.js, TypeScript, CDK CLI, AWS CLI

**Where it failed:**
- **Tutorials optimise for completion, not understanding.** A tutorial that deploys a Lambda behind API Gateway in 20 minutes teaches syntax but not *why* API Gateway was chosen over an ALB or a direct Lambda URL.
- **Copy-paste debt.** Code from tutorials works, but modifying it reveals gaps. "Why does this Lambda need VPC access?" isn't answered by the tutorial that just told you to add `vpc: myVpc`.
- **False confidence.** Completing 10 tutorials creates the illusion of knowing 10 services. In reality, you know 10 happy paths.

### Stage 2: Documentation Deep-Dives (Months 3–6)

**What it looked like:** Shifting from tutorials to AWS documentation, whitepapers, and CDK API reference. Reading the *entire* L2 construct source code for services being used.

**What it taught:**
- **Defaults matter.** CDK L2 constructs set dozens of defaults. Knowing what `removalPolicy: DESTROY` vs `RETAIN` does prevents data loss. Tutorials rarely explain these.
- **Constraint discovery.** Documentation reveals limits: "CloudFront requires certificates in us-east-1," "API Gateway has a 29-second timeout," "DynamoDB items are limited to 400KB." These constraints shape architecture.
- **Pattern recognition.** After reading the VPC construct source, the networking model clicked: subnets, route tables, NAT gateways, internet gateways — and *why* the CDK creates them in that order.

**Where it failed:**
- **Analysis paralysis.** Reading documentation without building creates an ever-growing "things to learn" list with no reduction in the "things I've built" list.
- **No feedback loop.** Documentation tells you how something *should* work. Only building tells you how it *actually* works in your specific context.

### Stage 3: Building From Scratch (Months 6–12)

**What it looked like:** Designing and building the cdk-monitoring infrastructure — self-managed K8s, CDK stacks, CI/CD pipeline, monitoring stack — with no tutorial as a guide.

**What it taught:**
- **Failure is the curriculum.** The CloudFront 504 timeouts, the ArgoCD Redis CrashLoopBackOff, the SecurityGroup self-reference rule — none of these appear in any tutorial. They are production realities that can only be learned by encountering them.
- **System interactions.** Individual services are straightforward. The complexity is in how they interact: CloudFront → EIP → Traefik → K8s → pod networking. Each transition is a potential failure point.
- **Trade-off reasoning.** With no tutorial dictating the architecture, every decision required explicit reasoning: "EKS or self-managed?" "Traefik or Nginx?" "ArgoCD or Flux?" Writing ADRs forced clarity.

**Where it still failed:**
- **Undocumented decisions decay.** Early in the project, decisions were made and not recorded. Months later, "why did I choose Calico over Cilium?" required re-researching the original trade-offs.
- **Knowledge silos.** Without documentation, the infrastructure existed only in my head. If I couldn't work on it for a week, re-onboarding took hours.

### Stage 4: Documenting Everything (Months 12+)

**What it looked like:** Creating the knowledge base, ADRs, runbooks, and blog articles. Treating documentation as a first-class engineering deliverable, not an afterthought.

**What it taught:**
- **Writing forces understanding.** Explaining *why* the CloudFront distribution uses HTTP_ONLY to the EIP origin required articulating the TLS termination strategy, the self-signed cert limitation, and the origin bypass mitigation. If I can't write it clearly, I don't fully understand it.
- **Documentation as debugging.** Writing up the ArgoCD Image Updater pipeline revealed a gap: the SHA regex filter was undocumented. Without documenting it, a future `latest` tag push would cause an unintended rollout.
- **Compound knowledge.** Each document builds on previous ones. The `frontend-integration.md` KB doc references the CloudFront construct, which references the edge stack, which references the EIP from the base stack. The dependency chain maps how the system actually fits together.

## The Iterative Learning Cycle

The stages aren't sequential — they're a continuous cycle:

```
Build something → It breaks → Read documentation → Fix it → Document why
    ↑                                                           ↓
    └───────── Apply pattern to next component ←────────────────┘
```

Every failure creates a documentation entry. Every documentation entry reveals a pattern. Every pattern accelerates the next build. This is not unique to DevOps — it's how any complex skill compounds.

## Anti-Patterns Discovered

### "I'll Document It Later"
Documentation written weeks after implementation misses critical context. The *why* behind a decision fades from memory faster than the *what*. Document during or immediately after building, not before the next sprint.

### "Tutorial Stacking"
Completing tutorial after tutorial without building anything original creates a false sense of progress. Five tutorials on different services don't compound. One project that integrates five services does.

### "Perfectionism Before Shipping"
The early versions of the K8s cluster were messy — hardcoded values, no config separation, manual deployment steps. Shipping the imperfect version and iterating was faster than designing the perfect architecture upfront. The current clean architecture emerged through refactoring, not initial design.

### "Learning Without Teaching"
Explaining a concept to someone else (or writing it in a blog post) reveals gaps that self-study misses. The "Junior Corner" section in blog articles forces simplification of complex topics, which deepens understanding.

## Decision Reasoning

- **Building over course-taking** — Online courses provide structured learning but don't develop the debugging instinct. Building from scratch guarantees encountering unexpected failures — which is what production engineering actually is.
- **Public documentation over private notes** — Writing for an audience (even a hypothetical one) forces clarity and completeness. Private notes tolerate ambiguity: "fix the thing with the cert." Public documentation requires: "The ACM certificate must be in us-east-1 because CloudFront only supports certificates from that region."
- **ADRs over verbal decisions** — When working solo, there's no one to explain decisions to. ADRs create an artificial "team" — the future self who will ask "why did I do this?" in 6 months.
- **Knowledge base over wiki** — A structured knowledge base with categories (code, ADRs, runbooks, cost, self-reflection) scales better than a flat wiki. Each document has a clear audience and purpose.

## Transferable Skills Demonstrated

- **Continuous learning methodology** — A structured approach to learning complex systems: build → break → read → fix → document. Applicable to any technical onboarding process.
- **Technical writing** — Translating implementation details into readable documentation for different audiences (engineers, recruiters, hiring managers). A skill that compounds across any engineering role.
- **Self-directed skill development** — Designing a learning path based on identified gaps rather than following a prescribed curriculum. Demonstrates autonomy and initiative.
- **Knowledge management** — Building a structured knowledge base that grows with the project. Demonstrates the ability to create institutional knowledge, not just personal expertise.
