---
title: "Argo Rollouts & Zero-Downtime Static Asset Retention"
doc_type: adr
domain: kubernetes
tags:
  - argo-rollouts
  - bluegreen
  - zero-downtime
  - s3
  - static-assets
  - progressive-delivery
related_docs:
  - operations/ci-cd-implementation.md
  - frontend/frontend-integration.md
  - kubernetes/runbooks/bluegreen-rollout-stuck.md
last_updated: "2026-03-27"
author: Nelson Lamounier
status: accepted
---

# Argo Rollouts & Zero-Downtime Static Asset Retention

**Date:** 2026-03-27  
**Status:** Accepted  

## Context
Our Next.js frontend is deployed to a Kubernetes cluster via ArgoCD. Under our previous architecture, the GitOps sync was paired with an imperative `kubectl rollout restart` execution initiated from the GitHub Actions CI pipeline. 
Concurrently, the CI pipeline was doing a destructive `aws s3 sync --delete` on the CloudFront origin bucket.
When a new Next.js pod was promoted, users hitting the old Next.js pods (during rollout termination) would encounter broken CSS (`404 Not Found`) because the JavaScript/CSS chunks referencing their specific `BUILD_ID` were hard-deleted from S3 before they finished their session or before the pod fully terminated.

## Decision
1. **Adopt Argo Rollouts for Progressive Delivery:**
   We migrated the Next.js `Deployment` to an Argo `Rollout` using the BlueGreen strategy. This delegates the application deployment lifecycle, health checking, and preview-routing entirely to the cluster native controller rather than crude CI pipeline restarts.
2. **Implement N-1 Multi-Version Retention on S3:**
   Instead of destructive `sync --delete`, we rewrote the `sync-static-to-s3.ts` CI script to fetch the *previous* `BUILD_ID` from the cluster prior to upload. The deployment pipeline now uploads the *new* static assets while safely preserving the *immediate preceding* build chunks within S3.
3. **Automate S3 Garbage Collection:** 
   Assets older than the N-1 generation are safely purged from S3 by the script during the sync phase, preventing unbounded storage costs while guaranteeing zero 404s for active user sessions during the BlueGreen transition delay.

## Consequences
- **Positive:** True zero-downtime deployments. Transitions between pods are smooth without styling breakage.
- **Positive:** Elimination of brittle CI `kubectl` imperative dependencies. The environment relies entirely on GitOps auto-syncing via the ArgoCD Image Updater leveraging ECR tags.
- **Negative:** Increased CI pipeline complexity due to the required querying of the *active* Kubernetes Next.js pod to determine the historically stable `BUILD_ID` prior to executing the S3 mutations.

## Transferable Skills Demonstrated

- **Progressive delivery strategy** — evaluating BlueGreen vs Canary for static-asset-heavy apps
- **Static asset retention** — solving the active-user broken-link problem with S3 versioned builds
- **Cloud-native deployment patterns** — integrating Argo Rollouts with ArgoCD and S3
- **Architecture decision documentation** — evidence-based decision recording with trade-off analysis

## Summary

This ADR documents the decision to adopt Argo Rollouts with a BlueGreen strategy for the Next.js frontend deployment, replacing imperative `kubectl rollout restart` commands from CI. It also covers the N-1 multi-version static asset retention strategy on S3 that prevents broken CSS/JS during pod transitions.

## Keywords

argo-rollouts, bluegreen, zero-downtime, s3-sync, static-assets, progressive-delivery, next.js, kubernetes, deployment-strategy, css-404
