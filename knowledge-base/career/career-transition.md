---
title: "Career Transition — From Customer Service to Cloud Engineering"
doc_type: self-reflection
domain: career
tags:
  - career
  - transition
  - aws
  - cloud-engineering
  - self-taught
  - portfolio
related_docs:
  - career/learning-methodology.md
  - career/certification-journey.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
code_backed: false
---

# Career Transition — AWS Support to DevOps/Cloud Engineer

## Overview

This document captures the reasoning, strategy, and challenges behind transitioning from an AWS Technical Customer Service Associate role to a DevOps/Cloud Engineer position. It documents why a portfolio-driven approach was chosen over traditional job-hopping, and how the infrastructure project became the primary evidence of production readiness.

> **Category:** Self-Reflection
> **Not code-backed** — this article draws from career strategy and personal decisions, not repository infrastructure.

## Context

- **Current Role:** Technical Customer Service Associate, AWS Dublin
- **Target Role:** Junior to Mid-Level Cloud/DevOps Engineer
- **Approach:** Build production-grade infrastructure as a portfolio project, document every decision
- **Timeline:** Ongoing — the portfolio evolves with each new capability added

## The Starting Position

Working at AWS provides daily exposure to cloud services — but from the *support* side. The gap between understanding how a service works (support perspective) and knowing *when and why* to use it in a system (engineering perspective) is significant.

### What AWS Support Teaches
- Deep familiarity with service limits, error codes, and troubleshooting paths
- Customer empathy — understanding how engineers *actually* use services vs how documentation says they should
- Breadth across the AWS catalogue — exposure to services most engineers never touch
- Operational debugging — reading CloudTrail logs, analysing API call patterns, identifying misconfiguration

### What AWS Support Doesn't Teach
- System design — combining services into coherent architectures
- Infrastructure as Code — translating decisions into repeatable deployments
- CI/CD pipeline design — automating the path from code to production
- Operational ownership — being paged at 3AM for infrastructure *you* built, not infrastructure a customer built

## The Strategy: Portfolio Over Job-Hopping

### Why Not Just Apply?

The traditional path is: apply for junior DevOps roles with the AWS certification and support experience. The problem:

- **Certification alone is insufficient** — The DevOps Pro exam tests decision-making, but recruiters can't verify hands-on skills from a certificate number alone.
- **Support experience is undervalued** — Hiring managers often equate "support" with "Tier 1 helpdesk" rather than deep technical troubleshooting.
- **No production evidence** — Without a portfolio, the interview is entirely verbal. "Tell me about a time you..." becomes the only signal.

### Why Build From Scratch?

The portfolio project (cdk-monitoring) was specifically designed to fill every gap a recruiter might identify:

| Gap | Portfolio Evidence |
|:---|:---|
| No IaC experience | 15,000+ lines of CDK TypeScript across 20+ stacks |
| No K8s experience | Self-managed K8s cluster (kubeadm, not EKS) with ArgoCD GitOps |
| No CI/CD pipeline | GitHub Actions with SSM Automation, Step Functions orchestration |
| No monitoring experience | Full Prometheus/Grafana/Loki/Tempo stack on K8s |
| No cost awareness | >€30/month budget with FinOps guardrails and cost breakdowns |
| No production operations | Self-healing agent, runbooks, CrashLoopBackOff recovery |

### Why Self-Managed K8s Over EKS?

This is the most frequently questioned decision. EKS would be faster, more reliable, and industry-standard. Self-managed K8s was chosen *because* it exposes everything EKS abstracts away:

- **Certificate management** — Understanding kubelet cert rotation, API server TLS, and etcd encryption.
- **Networking** — Calico CNI configuration, pod-to-node security group rules, cross-subnet routing.
- **Control plane operations** — API server unreachability, etcd backup/restore, kubeadm upgrades.
- **Node bootstrapping** — Golden AMI pipeline, user-data orchestration, SSM-controlled join process.

A candidate who has operated self-managed K8s can evaluate managed vs self-hosted trade-offs for any team. A candidate who has only used EKS can't always articulate *what* EKS is doing for them.

## Decision Reasoning

- **Portfolio over certification** — Certifications prove knowledge. Portfolios prove *capability*. Both are needed, but the portfolio is the differentiator when competing against other certified candidates.
- **Public repository over private** — Every line of code is on GitHub. This is deliberate: it forces good practices (no hardcoded secrets, clean commit history, documented decisions) and gives recruiters something to review *before* the interview.
- **CDK over Terraform** — Working at AWS and targeting AWS-centric roles, CDK provides native integration and demonstrates TypeScript proficiency (a transferable skill). Terraform would signal multi-cloud breadth, but the project's depth is the selling point.
- **Documentation as a first-class deliverable** — The knowledge base, ADRs, and runbooks exist because "infrastructure that only one person can operate is a liability." Documenting decisions demonstrates team-readiness.
- **Blog as a sales asset** — Each article is structured to answer "Can this person help MY team?" with evidence. The Bedrock publisher automates content creation, but the knowledge base ensures every article has substance behind it.

## Challenges Encountered

- **Imposter syndrome** — Building from scratch with no team to validate decisions. Every architectural choice feels uncertain without peer review. The ADR (Architecture Decision Record) practice was the antidote: writing down *why* forces clarity.
- **Scope management** — The temptation to add "one more service" is constant. The project could include SQS, Step Functions for workflows, AppSync, etc. Staying focused on depth over breadth was essential.
- **Time investment** — Full-time job plus evening/weekend infrastructure work. The automated CI/CD pipeline exists partly so that deployments don't require manual afternoon attention.
- **Cost discipline** — Running production-grade infrastructure on a personal budget requires genuine FinOps practice: right-sized instances, spot-like scheduling, aggressive log retention policies.

## Transferable Skills Demonstrated

- **Career strategy as project management** — Treating a career transition like an engineering project: identify gaps, design solutions, measure progress, iterate. The same systematic approach applies to any large-scale initiative.
- **Self-directed capability building** — No bootcamp, no structured course. Identified the skills gap, designed a learning path, built evidence, and documented it. Demonstrates initiative and autonomy.
- **Production mindset from day one** — The portfolio isn't a tutorial project that works locally. It runs on AWS, has CI/CD, monitoring, alerting, and cost controls. This bridges the "but have you ever run anything in production?" interview question.
- **Communication through documentation** — ADRs, runbooks, knowledge base articles, and blog posts demonstrate the ability to communicate technical decisions to different audiences (engineers, recruiters, hiring managers).

## Summary

This self-reflection piece documents the career transition from a Technical Customer Service Associate at AWS to a Cloud/DevOps Engineering role, covering the motivation, strategy, challenges, and the portfolio-driven approach to demonstrating production-ready engineering skills.

## Keywords

career, transition, aws, cloud-engineering, self-taught, portfolio, devops, motivation, learning, professional-development
