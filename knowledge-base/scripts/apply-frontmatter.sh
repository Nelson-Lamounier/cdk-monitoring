#!/usr/bin/env bash
# =============================================================================
# Knowledge Base Frontmatter & Metadata Generator
# Applies YAML frontmatter, ## Summary, ## Keywords to all KB docs
# Generates .metadata.json sidecar files for Bedrock KB filtering
# =============================================================================
set -euo pipefail

KB_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "📁 Knowledge Base directory: $KB_DIR"
echo "🔄 Processing files..."

# Track counts
processed=0
skipped=0

process_file() {
    local file="$1"
    local frontmatter="$2"
    local summary="$3"
    local keywords="$4"
    local metadata_json="$5"

    # Skip if frontmatter already present
    if head -1 "$file" | grep -q "^---$"; then
        echo "  ⏭️  Already has frontmatter: $(basename "$file")"
        skipped=$((skipped + 1))
        return
    fi

    # Create temp file with frontmatter + summary + keywords + original content
    local tmp
    tmp=$(mktemp)

    # Write frontmatter
    echo "---" > "$tmp"
    echo "$frontmatter" >> "$tmp"
    echo "---" >> "$tmp"
    echo "" >> "$tmp"

    # Write original content
    cat "$file" >> "$tmp"

    # Append Summary and Keywords if not already present
    if ! grep -q "^## Summary$" "$tmp"; then
        echo "" >> "$tmp"
        echo "## Summary" >> "$tmp"
        echo "" >> "$tmp"
        echo "$summary" >> "$tmp"
    fi

    if ! grep -q "^## Keywords$" "$tmp"; then
        echo "" >> "$tmp"
        echo "## Keywords" >> "$tmp"
        echo "" >> "$tmp"
        echo "$keywords" >> "$tmp"
    fi

    mv "$tmp" "$file"

    # Generate .metadata.json sidecar
    local sidecar="${file}.metadata.json"
    echo "$metadata_json" > "$sidecar"

    echo "  ✅ Processed: $(basename "$file")"
    processed=$((processed + 1))
}

# =============================================================================
# ADRs
# =============================================================================

process_file "$KB_DIR/adrs/argo-rollouts-zero-downtime.md" \
'title: "Argo Rollouts & Zero-Downtime Static Asset Retention"
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
  - code/ci-cd-implementation.md
  - code/frontend-integration.md
  - runbooks/bluegreen-rollout-stuck.md
last_updated: "2026-03-27"
author: Nelson Lamounier
status: accepted' \
'This ADR documents the decision to adopt Argo Rollouts with a BlueGreen strategy for the Next.js frontend deployment, replacing imperative `kubectl rollout restart` commands from CI. It also covers the N-1 multi-version static asset retention strategy on S3 that prevents broken CSS/JS during pod transitions.' \
'argo-rollouts, bluegreen, zero-downtime, s3-sync, static-assets, progressive-delivery, next.js, kubernetes, deployment-strategy, css-404' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "kubernetes",
    "tags": "argo-rollouts,bluegreen,zero-downtime,s3,static-assets,progressive-delivery",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/argocd-over-flux.md" \
'title: "ArgoCD over Flux"
doc_type: adr
domain: kubernetes
tags:
  - argocd
  - flux
  - gitops
  - image-updater
  - sync-waves
  - app-of-apps
related_docs:
  - code/ci-cd-implementation.md
  - adrs/argo-rollouts-zero-downtime.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This ADR explains why ArgoCD was chosen over Flux CD as the GitOps controller for the Kubernetes cluster, citing the built-in web UI, App-of-Apps pattern with sync-wave ordering, and the ArgoCD Image Updater for automated ECR-to-Git image promotion.' \
'argocd, flux, gitops, image-updater, sync-waves, app-of-apps, kubernetes, cd-pipeline, ecr' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "kubernetes",
    "tags": "argocd,flux,gitops,image-updater,sync-waves,app-of-apps",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/cdk-over-terraform.md" \
'title: "AWS CDK over Terraform"
doc_type: adr
domain: infrastructure
tags:
  - cdk
  - terraform
  - iac
  - typescript
  - cloudformation
related_docs:
  - architecture/stack-overview.md
  - code/security-implementation.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This ADR documents the decision to use AWS CDK (TypeScript) over Terraform for infrastructure as code, highlighting type safety, single-language stack benefits, and native AWS CloudFormation integration as key factors.' \
'cdk, terraform, infrastructure-as-code, typescript, cloudformation, aws, iac, constructs' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "infrastructure",
    "tags": "cdk,terraform,iac,typescript,cloudformation",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/crossplane-for-app-level-iac.md" \
'title: "Crossplane for Application-Level IaC"
doc_type: adr
domain: kubernetes
tags:
  - crossplane
  - xrd
  - platform-engineering
  - golden-path
  - s3
  - sqs
  - gitops
related_docs:
  - code/crossplane-implementation.md
  - adrs/cdk-over-terraform.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This ADR explains the decision to use Crossplane XRDs for application-level AWS resource provisioning (S3 buckets, SQS queues) while CDK manages foundation infrastructure. The two-layer IaC model enables developer self-service through golden-path abstractions with enforced security defaults.' \
'crossplane, xrd, platform-engineering, golden-path, s3, sqs, gitops, kubernetes, developer-self-service, iac' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "kubernetes",
    "tags": "crossplane,xrd,platform-engineering,golden-path,s3,sqs,gitops",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/mcp-for-operations.md" \
'title: "MCP Servers for Operations & Developer Experience"
doc_type: adr
domain: operations
tags:
  - mcp
  - model-context-protocol
  - ai-operations
  - developer-tooling
  - kubernetes
  - dynamodb
  - ssm
related_docs:
  - code/self-healing-agent.md
  - code/bedrock-implementation.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This ADR documents the decision to build two custom MCP servers (mcp-infra-server with 19 tools and mcp-portfolio-docs with 8 tools) for AI-assisted infrastructure operations, replacing ad-hoc CLI scripts with structured, typed tool interfaces that AI assistants invoke via stdio.' \
'mcp, model-context-protocol, ai-operations, developer-tooling, kubernetes, dynamodb, ssm, zod, typescript, ai-assistant' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "operations",
    "tags": "mcp,model-context-protocol,ai-operations,developer-tooling,kubernetes,dynamodb,ssm",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/self-managed-k8s-vs-eks.md" \
'title: "Self-Managed Kubernetes over EKS"
doc_type: adr
domain: kubernetes
tags:
  - kubernetes
  - eks
  - kubeadm
  - self-managed
  - cost-optimisation
  - ec2
  - golden-ami
related_docs:
  - architecture/stack-overview.md
  - code/networking-implementation.md
  - implementation/kubernetes-bootstrap-pipeline.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This ADR explains the decision to use a self-managed kubeadm Kubernetes cluster on EC2 over Amazon EKS, driven by ~40% lower cost at single-node scale (~$45/month vs ~$118/month), full control-plane ownership for learning, and the deeper operational knowledge gained from building the cluster from scratch.' \
'kubernetes, eks, kubeadm, self-managed, cost-optimisation, ec2, golden-ami, bootstrap, calico, etcd' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "kubernetes",
    "tags": "kubernetes,eks,kubeadm,self-managed,cost-optimisation,ec2,golden-ami",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/step-functions-over-lambda-orchestration.md" \
'title: "Step Functions over Lambda Orchestration"
doc_type: adr
domain: infrastructure
tags:
  - step-functions
  - lambda
  - bootstrap
  - ssm-automation
  - event-driven
  - orchestration
related_docs:
  - implementation/kubernetes-bootstrap-pipeline.md
  - adrs/self-managed-k8s-vs-eks.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This ADR documents the decision to use AWS Step Functions over direct Lambda-to-Lambda orchestration for the Kubernetes bootstrap pipeline, citing visual execution history for debugging, built-in retry with exponential backoff, and cost optimisation through declarative state transitions.' \
'step-functions, lambda, bootstrap, ssm-automation, event-driven, orchestration, serverless, self-healing, asg' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "infrastructure",
    "tags": "step-functions,lambda,bootstrap,ssm-automation,event-driven,orchestration",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/adrs/traefik-over-nginx-alb.md" \
'title: "Traefik over NGINX Ingress / ALB"
doc_type: adr
domain: kubernetes
tags:
  - traefik
  - nginx
  - alb
  - ingress
  - ingressroute
  - daemonset
  - hostnetwork
  - observability
related_docs:
  - code/networking-implementation.md
  - code/frontend-integration.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This ADR explains the choice of Traefik over NGINX Ingress Controller and AWS ALB as the Kubernetes ingress solution, driven by Kubernetes-native IngressRoute CRDs, DaemonSet with hostNetwork for EIP failover compatibility, zero additional AWS cost, and built-in Prometheus metrics and OTLP tracing.' \
'traefik, nginx, alb, ingress, ingressroute, daemonset, hostnetwork, observability, cert-manager, prometheus, otlp' \
'{
  "metadataAttributes": {
    "doc_type": "adr",
    "domain": "kubernetes",
    "tags": "traefik,nginx,alb,ingress,ingressroute,daemonset,hostnetwork,observability",
    "status": "accepted"
  }
}'

# =============================================================================
# Architecture
# =============================================================================

process_file "$KB_DIR/architecture/stack-overview.md" \
'title: "CDK Stack Architecture Overview"
doc_type: architecture
domain: infrastructure
tags:
  - cdk
  - cloudformation
  - stack-architecture
  - 12-stacks
  - aws
  - kubernetes
  - bedrock
related_docs:
  - adrs/cdk-over-terraform.md
  - code/networking-implementation.md
  - code/security-implementation.md
  - live-infra/infrastructure-topology.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document provides the high-level architectural overview of the entire cdk-monitoring infrastructure, mapping all 12 CDK stacks across Kubernetes foundation, compute, AI/ML, shared services, and edge networking. It serves as the entry point for understanding the system architecture.' \
'cdk, cloudformation, stack-architecture, aws, kubernetes, bedrock, self-healing, edge, networking, security, observability' \
'{
  "metadataAttributes": {
    "doc_type": "architecture",
    "domain": "infrastructure",
    "tags": "cdk,cloudformation,stack-architecture,12-stacks,aws,kubernetes,bedrock",
    "status": "accepted"
  }
}'

# =============================================================================
# Code Analysis
# =============================================================================

process_file "$KB_DIR/code/bedrock-implementation.md" \
'title: "Bedrock AI Content Pipeline Implementation"
doc_type: code-analysis
domain: ai-ml
tags:
  - bedrock
  - lambda
  - pinecone
  - rag
  - converse-api
  - dynamodb
  - content-generation
related_docs:
  - adrs/step-functions-over-lambda-orchestration.md
  - code/self-healing-agent.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This document analyses the Bedrock publisher Lambda pipeline that transforms draft markdown articles into polished MDX portfolio content using Claude via the Converse API. It covers KB-augmented mode with Pinecone retrieval, adaptive thinking budgets, and the DynamoDB dual-record pattern for metadata and content versioning.' \
'bedrock, lambda, pinecone, rag, converse-api, dynamodb, content-generation, claude, mdx, publishing, s3-trigger' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "ai-ml",
    "tags": "bedrock,lambda,pinecone,rag,converse-api,dynamodb,content-generation",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/ci-cd-implementation.md" \
'title: "CI/CD & GitOps Pipeline Implementation"
doc_type: code-analysis
domain: operations
tags:
  - github-actions
  - argocd
  - ci-cd
  - gitops
  - ssm-automation
  - reusable-workflows
  - day-1
related_docs:
  - adrs/argocd-over-flux.md
  - adrs/argo-rollouts-zero-downtime.md
  - implementation/kubernetes-bootstrap-pipeline.md
last_updated: "2026-03-25"
author: Nelson Lamounier
status: accepted' \
'This document analyses the CI/CD pipeline spanning GitHub Actions for CDK infrastructure deployment (21 workflow files, reusable sub-workflows) and ArgoCD for Kubernetes workload delivery via ApplicationSet auto-discovery, Image Updater, and sync-wave orchestration. Includes the day-1 full-stack deployment orchestration for disaster recovery.' \
'github-actions, argocd, ci-cd, gitops, ssm-automation, reusable-workflows, day-1, ecr, applicationset, argo-rollouts, integration-tests' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "operations",
    "tags": "github-actions,argocd,ci-cd,gitops,ssm-automation,reusable-workflows,day-1",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/crossplane-implementation.md" \
'title: "Crossplane Implementation — Platform Engineering"
doc_type: code-analysis
domain: kubernetes
tags:
  - crossplane
  - xrd
  - platform-engineering
  - s3
  - sqs
  - iam
  - golden-path
related_docs:
  - adrs/crossplane-for-app-level-iac.md
  - code/security-implementation.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This document analyses the Crossplane implementation providing developer self-service for AWS resources via XRDs (XEncryptedBucket, XMonitoredQueue) deployed through the same ArgoCD GitOps pipeline as application workloads. It covers the golden-path abstraction model, CDK-managed IAM, and sync-wave deployment sequence.' \
'crossplane, xrd, platform-engineering, s3, sqs, iam, golden-path, argocd, composition, cdk-nag' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "kubernetes",
    "tags": "crossplane,xrd,platform-engineering,s3,sqs,iam,golden-path",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/frontend-integration.md" \
'title: "Frontend Integration — Infrastructure & Deployment"
doc_type: code-analysis
domain: frontend
tags:
  - nextjs
  - cloudfront
  - waf
  - argo-rollouts
  - bluegreen
  - api-gateway
  - traefik
  - ecr
related_docs:
  - adrs/traefik-over-nginx-alb.md
  - adrs/argo-rollouts-zero-downtime.md
  - code/networking-implementation.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This document analyses the infrastructure integration layer connecting the Next.js frontend to the AWS backend: CloudFront edge distribution with dual-origin architecture (S3 OAC + EIP), WAF protection, Argo Rollouts BlueGreen progressive delivery, ArgoCD Image Updater for automated ECR-to-Git promotion, and the reusable API Gateway construct.' \
'nextjs, cloudfront, waf, argo-rollouts, bluegreen, api-gateway, traefik, ecr, edge-stack, s3-oac, ssl, cors' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "frontend",
    "tags": "nextjs,cloudfront,waf,argo-rollouts,bluegreen,api-gateway,traefik,ecr",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/networking-implementation.md" \
'title: "Networking Implementation — VPC, Security Groups, NLB, Traefik"
doc_type: code-analysis
domain: infrastructure
tags:
  - vpc
  - security-groups
  - nlb
  - traefik
  - route53
  - cloudfront
  - calico
  - networking
related_docs:
  - adrs/traefik-over-nginx-alb.md
  - architecture/stack-overview.md
  - live-infra/infrastructure-topology.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document analyses the networking architecture: shared VPC with config-driven security groups (4 SGs, 18+ rules defined as typed data arrays), NLB with TCP passthrough, Traefik DaemonSet with hostNetwork, Route 53 private hosted zone for the K8s API, and the end-to-end traffic flow from CloudFront through WAF to pods.' \
'vpc, security-groups, nlb, traefik, route53, cloudfront, calico, networking, eip, waf, cidr, data-driven' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "infrastructure",
    "tags": "vpc,security-groups,nlb,traefik,route53,cloudfront,calico,networking",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/observability-implementation.md" \
'title: "Observability Stack Implementation"
doc_type: code-analysis
domain: observability
tags:
  - prometheus
  - grafana
  - loki
  - tempo
  - alloy
  - faro
  - alerting
  - monitoring
related_docs:
  - implementation/rum-dashboard-review.md
  - implementation/frontend-performance.md
  - runbooks/faro-rum-no-data.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This document analyses the Kubernetes-native monitoring stack: Prometheus with custom Helm chart and native scrape_configs (12 jobs), Grafana with 13 dashboards and unified alerting to SNS, Loki for log aggregation, Tempo for distributed tracing, Alloy as the Faro RUM collector, and Promtail DaemonSet for pod log shipping.' \
'prometheus, grafana, loki, tempo, alloy, faro, alerting, monitoring, scrape-configs, dashboards, rum, promtail' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "observability",
    "tags": "prometheus,grafana,loki,tempo,alloy,faro,alerting,monitoring",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/security-implementation.md" \
'title: "Security & Compliance Implementation"
doc_type: code-analysis
domain: infrastructure
tags:
  - iam
  - guardduty
  - kms
  - imdsv2
  - cdk-nag
  - ssm
  - network-policy
  - security
related_docs:
  - live-infra/security-posture.md
  - architecture/stack-overview.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document analyses the multi-layer security implementation: least-privilege IAM roles for control plane and Crossplane, GuardDuty threat detection, KMS encryption for CloudWatch and EBS, IMDSv2 enforcement with hop limit 2 for containers, CDK-nag AwsSolutions compliance at synth time, Kubernetes NetworkPolicies, and SSM-only access with no SSH.' \
'iam, guardduty, kms, imdsv2, cdk-nag, ssm, network-policy, security, compliance, zero-trust, encryption' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "infrastructure",
    "tags": "iam,guardduty,kms,imdsv2,cdk-nag,ssm,network-policy,security",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/code/self-healing-agent.md" \
'title: "Self-Healing Agent — AI-Driven Infrastructure Remediation"
doc_type: code-analysis
domain: ai-ml
tags:
  - bedrock
  - self-healing
  - agentcore
  - mcp
  - k8sgpt
  - cloudwatch
  - eventbridge
  - finops
related_docs:
  - adrs/mcp-for-operations.md
  - code/bedrock-implementation.md
last_updated: "2026-03-23"
author: Nelson Lamounier
status: accepted' \
'This document analyses the self-healing agent pipeline: CloudWatch Alarm → EventBridge → Bedrock ConverseCommand Lambda with a native tool-use loop via AgentCore Gateway (MCP protocol). Covers 4 MCP tools (diagnose-alarm, ebs-detach, check-node-health, analyse-cluster-health), Cognito M2M auth, FinOps guardrails, and the verified PoC (26.3s, ~$0.02).' \
'bedrock, self-healing, agentcore, mcp, k8sgpt, cloudwatch, eventbridge, finops, cognito, tool-use, ai-agent, remediation' \
'{
  "metadataAttributes": {
    "doc_type": "code-analysis",
    "domain": "ai-ml",
    "tags": "bedrock,self-healing,agentcore,mcp,k8sgpt,cloudwatch,eventbridge,finops",
    "status": "accepted"
  }
}'

# =============================================================================
# Cost
# =============================================================================

process_file "$KB_DIR/cost/cost-breakdown.md" \
'title: "Infrastructure Cost Breakdown"
doc_type: cost
domain: finops
tags:
  - cost
  - finops
  - ec2
  - spot
  - s3
  - cloudfront
  - lambda
  - budget
related_docs:
  - architecture/stack-overview.md
  - adrs/self-managed-k8s-vs-eks.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document provides a detailed cost analysis of the entire cdk-monitoring infrastructure, breaking down monthly spend across EC2 instances (Spot vs On-Demand), S3 storage, CloudFront distribution, Lambda functions, and supporting AWS services. It demonstrates FinOps thinking by comparing the self-managed Kubernetes cost against equivalent managed service pricing.' \
'cost, finops, ec2, spot, s3, cloudfront, lambda, budget, pricing, cost-optimisation, self-managed, eks-comparison' \
'{
  "metadataAttributes": {
    "doc_type": "cost",
    "domain": "finops",
    "tags": "cost,finops,ec2,spot,s3,cloudfront,lambda,budget",
    "status": "accepted"
  }
}'

# =============================================================================
# Implementation
# =============================================================================

process_file "$KB_DIR/implementation/frontend-performance.md" \
'title: "Frontend Performance Dashboard Implementation"
doc_type: implementation
domain: observability
tags:
  - traefik
  - prometheus
  - grafana
  - frontend-performance
  - golden-signals
  - latency
  - sli
related_docs:
  - code/observability-implementation.md
  - implementation/rum-dashboard-review.md
  - code/frontend-integration.md
last_updated: "2026-03-28"
author: Nelson Lamounier
status: accepted' \
'This document covers the Frontend Performance Dashboard, which provides server-side (edge) monitoring of the Next.js application by aggregating Traefik Ingress Controller metrics. It captures golden signals (request rate, error rate), SLIs (frontend availability), latency percentiles (P50, P95, P99), and connection health — filling the monitoring blind spot where client-side Faro RUM cannot detect pre-render failures.' \
'traefik, prometheus, grafana, frontend-performance, golden-signals, latency, sli, request-rate, error-rate, ttfb, autoscaling' \
'{
  "metadataAttributes": {
    "doc_type": "implementation",
    "domain": "observability",
    "tags": "traefik,prometheus,grafana,frontend-performance,golden-signals,latency,sli",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/implementation/kubernetes-bootstrap-pipeline.md" \
'title: "Kubernetes Bootstrap Pipeline"
doc_type: implementation
domain: kubernetes
tags:
  - bootstrap
  - ssm-automation
  - step-functions
  - golden-ami
  - kubeadm
  - user-data
  - ec2
related_docs:
  - adrs/step-functions-over-lambda-orchestration.md
  - adrs/self-managed-k8s-vs-eks.md
  - implementation/kubernetes-bootstrap-system-scripts.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document provides an implementation walkthrough of the 4-layer Kubernetes bootstrap pipeline: Golden AMI (EC2 Image Builder) → User Data (LaunchTemplate) → SSM Automation (6 documents) → Step Functions orchestration (EventBridge-triggered). It covers the full lifecycle from bare EC2 instance to operational Kubernetes node.' \
'bootstrap, ssm-automation, step-functions, golden-ami, kubeadm, user-data, ec2, image-builder, asg, calico, containerd' \
'{
  "metadataAttributes": {
    "doc_type": "implementation",
    "domain": "kubernetes",
    "tags": "bootstrap,ssm-automation,step-functions,golden-ami,kubeadm,user-data,ec2",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/implementation/kubernetes-bootstrap-system-scripts.md" \
'title: "Kubernetes Bootstrap System Scripts"
doc_type: implementation
domain: kubernetes
tags:
  - bootstrap
  - argocd
  - tls
  - etcd
  - disaster-recovery
  - python
  - shell
  - ssm
  - deploy-helpers
related_docs:
  - implementation/kubernetes-bootstrap-pipeline.md
  - adrs/argocd-over-flux.md
  - code/ci-cd-implementation.md
last_updated: "2026-03-25"
author: Nelson Lamounier
status: accepted' \
'This document provides an implementation walkthrough of the day-1 bootstrap system scripts in `k8s-bootstrap/system/`: ArgoCD vendored manifest bootstrap, TLS certificate persistence via SSM SecureString, automated hourly etcd snapshots to S3, the boot/ modular step architecture (10 CP + 3 worker modules), and the deploy_helpers framework for application-level K8s secret deployment.' \
'bootstrap, argocd, tls, etcd, disaster-recovery, python, shell, ssm, deploy-helpers, persist-tls-cert, systemd, pytest' \
'{
  "metadataAttributes": {
    "doc_type": "implementation",
    "domain": "kubernetes",
    "tags": "bootstrap,argocd,tls,etcd,disaster-recovery,python,shell,ssm,deploy-helpers",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/implementation/rum-dashboard-review.md" \
'title: "RUM Dashboard Review"
doc_type: implementation
domain: observability
tags:
  - rum
  - faro
  - grafana
  - loki
  - tempo
  - web-vitals
  - frontend-observability
related_docs:
  - code/observability-implementation.md
  - implementation/frontend-performance.md
  - runbooks/faro-rum-no-data.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document reviews the Real User Monitoring (RUM) Grafana dashboard powered by the Faro Web SDK, covering client-side performance metrics (Core Web Vitals, TTFB), error tracking, session analysis, and the end-to-end telemetry pipeline from browser to Loki and Tempo.' \
'rum, faro, grafana, loki, tempo, web-vitals, frontend-observability, alloy, browser-telemetry, core-web-vitals' \
'{
  "metadataAttributes": {
    "doc_type": "implementation",
    "domain": "observability",
    "tags": "rum,faro,grafana,loki,tempo,web-vitals,frontend-observability",
    "status": "accepted"
  }
}'

# =============================================================================
# Live Infrastructure
# =============================================================================

process_file "$KB_DIR/live-infra/aws-resource-inventory.md" \
'title: "AWS Resource Inventory"
doc_type: live-infra
domain: infrastructure
tags:
  - inventory
  - aws
  - resources
  - ec2
  - s3
  - lambda
  - cloudformation
related_docs:
  - architecture/stack-overview.md
  - live-infra/infrastructure-topology.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document provides a snapshot inventory of all live AWS resources across the cdk-monitoring infrastructure, including EC2 instances, S3 buckets, Lambda functions, CloudFormation stacks, and supporting services with resource counts and patterns.' \
'inventory, aws, resources, ec2, s3, lambda, cloudformation, resource-count, infrastructure-audit' \
'{
  "metadataAttributes": {
    "doc_type": "live-infra",
    "domain": "infrastructure",
    "tags": "inventory,aws,resources,ec2,s3,lambda,cloudformation",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/live-infra/infrastructure-topology.md" \
'title: "Live Infrastructure — Architecture Topology"
doc_type: live-infra
domain: infrastructure
tags:
  - topology
  - vpc
  - kubernetes
  - cloudfront
  - nlb
  - traefik
  - data-flow
related_docs:
  - architecture/stack-overview.md
  - code/networking-implementation.md
  - code/frontend-integration.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document maps the live infrastructure topology: network flow (CloudFront → NLB → Traefik → Pods), VPC architecture (public subnets, no NAT), 4-node Kubernetes cluster layout (control plane, app, ArgoCD, monitoring workers), and end-to-end data flows for article generation, self-healing agent, frontend requests, and the monitoring pipeline.' \
'topology, vpc, kubernetes, cloudfront, nlb, traefik, data-flow, network, 4-node, bootstrap, security-groups' \
'{
  "metadataAttributes": {
    "doc_type": "live-infra",
    "domain": "infrastructure",
    "tags": "topology,vpc,kubernetes,cloudfront,nlb,traefik,data-flow",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/live-infra/security-posture.md" \
'title: "Live Infrastructure — Security Posture"
doc_type: live-infra
domain: infrastructure
tags:
  - security
  - guardduty
  - inspector
  - security-hub
  - access-analyzer
  - encryption
  - network-security
related_docs:
  - code/security-implementation.md
  - architecture/stack-overview.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This document assesses the live security posture: GuardDuty feature coverage (CloudTrail, DNS, Flow Logs enabled; EKS/S3/Runtime disabled with reasoning), IAM Access Analyzer (9 active findings), Security Hub (enabled, 0 standards), encryption at rest across SSM/EBS/S3/DynamoDB, and network security architecture (SSM-only, IP allowlisting, private K8s API).' \
'security, guardduty, inspector, security-hub, access-analyzer, encryption, network-security, ssm-only, cdk-nag, defence-in-depth' \
'{
  "metadataAttributes": {
    "doc_type": "live-infra",
    "domain": "infrastructure",
    "tags": "security,guardduty,inspector,security-hub,access-analyzer,encryption,network-security",
    "status": "accepted"
  }
}'

# =============================================================================
# Runbooks
# =============================================================================

process_file "$KB_DIR/runbooks/bluegreen-rollout-stuck.md" \
'title: "BlueGreen Rollout Stuck (Argo Rollouts)"
doc_type: runbook
domain: kubernetes
tags:
  - argo-rollouts
  - bluegreen
  - troubleshooting
  - nextjs
  - argocd
  - image-updater
related_docs:
  - adrs/argo-rollouts-zero-downtime.md
  - code/frontend-integration.md
  - code/ci-cd-implementation.md
last_updated: "2026-03-27"
author: Nelson Lamounier
status: accepted' \
'This runbook covers diagnosing and resolving stuck BlueGreen rollouts for the Next.js frontend: verifying ArgoCD Image Updater commits, checking rollout state via Argo Rollouts CLI, and resolution steps for paused rollouts (promote), failed pods (abort), and image updater failures.' \
'argo-rollouts, bluegreen, troubleshooting, nextjs, argocd, image-updater, rollout-stuck, crashloopbackoff, promotion' \
'{
  "metadataAttributes": {
    "doc_type": "runbook",
    "domain": "kubernetes",
    "tags": "argo-rollouts,bluegreen,troubleshooting,nextjs,argocd,image-updater",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/runbooks/faro-rum-no-data.md" \
'title: "Faro RUM No Data Troubleshooting"
doc_type: runbook
domain: observability
tags:
  - faro
  - rum
  - grafana
  - loki
  - alloy
  - troubleshooting
  - no-data
related_docs:
  - implementation/rum-dashboard-review.md
  - code/observability-implementation.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This runbook provides step-by-step diagnosis for missing RUM data in Grafana dashboards: verifying Faro SDK initialisation, checking Alloy collector health, validating Loki log ingestion, and fixing pipeline configuration gaps between the frontend telemetry and the Grafana query layer.' \
'faro, rum, grafana, loki, alloy, troubleshooting, no-data, logfmt, ingressroute, web-sdk, telemetry-pipeline' \
'{
  "metadataAttributes": {
    "doc_type": "runbook",
    "domain": "observability",
    "tags": "faro,rum,grafana,loki,alloy,troubleshooting,no-data",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/runbooks/instance-terminated.md" \
'title: "EC2 Instance Terminated Unexpectedly"
doc_type: runbook
domain: kubernetes
tags:
  - ec2
  - asg
  - bootstrap
  - self-healing
  - step-functions
  - ssm-automation
  - eip-failover
related_docs:
  - adrs/step-functions-over-lambda-orchestration.md
  - implementation/kubernetes-bootstrap-pipeline.md
  - adrs/self-managed-k8s-vs-eks.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This runbook documents the automatic self-healing response when a Kubernetes EC2 node is terminated: ASG replacement → EventBridge → Step Functions bootstrap orchestration → SSM Automation (kubeadm init/join). Covers control plane special handling (EIP failover, secrets chaining, worker CA re-join) and manual verification steps.' \
'ec2, asg, bootstrap, self-healing, step-functions, ssm-automation, eip-failover, kubeadm, recovery, eventbridge' \
'{
  "metadataAttributes": {
    "doc_type": "runbook",
    "domain": "kubernetes",
    "tags": "ec2,asg,bootstrap,self-healing,step-functions,ssm-automation,eip-failover",
    "status": "accepted"
  }
}'

process_file "$KB_DIR/runbooks/pod-crashloop.md" \
'title: "Pod CrashLoopBackOff Troubleshooting"
doc_type: runbook
domain: kubernetes
tags:
  - pod
  - crashloopbackoff
  - troubleshooting
  - kubernetes
  - k8sgpt
  - argocd
related_docs:
  - code/self-healing-agent.md
  - code/observability-implementation.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted' \
'This runbook provides systematic troubleshooting steps for Kubernetes pods in CrashLoopBackOff state: checking pod events for common root causes (OOMKilled, image pull errors, readiness probe failures, misconfigured secrets), reviewing logs, and leveraging K8sGPT and the monitoring integration for automated diagnosis.' \
'pod, crashloopbackoff, troubleshooting, kubernetes, k8sgpt, argocd, oom, image-pull, readiness-probe, secrets' \
'{
  "metadataAttributes": {
    "doc_type": "runbook",
    "domain": "kubernetes",
    "tags": "pod,crashloopbackoff,troubleshooting,kubernetes,k8sgpt,argocd",
    "status": "accepted"
  }
}'

# =============================================================================
# Self-Reflection
# =============================================================================

process_file "$KB_DIR/self-reflection/career-transition.md" \
'title: "Career Transition — From Customer Service to Cloud Engineering"
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
  - self-reflection/learning-methodology.md
  - self-reflection/certification-journey.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
code_backed: false' \
'This self-reflection piece documents the career transition from a Technical Customer Service Associate at AWS to a Cloud/DevOps Engineering role, covering the motivation, strategy, challenges, and the portfolio-driven approach to demonstrating production-ready engineering skills.' \
'career, transition, aws, cloud-engineering, self-taught, portfolio, devops, motivation, learning, professional-development' \
'{
  "metadataAttributes": {
    "doc_type": "self-reflection",
    "domain": "career",
    "tags": "career,transition,aws,cloud-engineering,self-taught,portfolio",
    "status": "accepted",
    "code_backed": "false"
  }
}'

process_file "$KB_DIR/self-reflection/certification-journey.md" \
'title: "Certification Journey — AWS DevOps Engineer Professional"
doc_type: self-reflection
domain: career
tags:
  - certification
  - aws
  - devops-professional
  - exam
  - failure-analysis
  - spider-method
  - study-strategy
related_docs:
  - self-reflection/career-transition.md
  - self-reflection/learning-methodology.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
code_backed: false' \
'This self-reflection documents the experience of failing (726/750) and subsequently passing the AWS Certified DevOps Engineer Professional exam (DOP-C02). It covers the root cause analysis of the failure, the SPIDER method framework developed for systematic exam question analysis, and the study strategy pivot to official AWS materials.' \
'certification, aws, devops-professional, exam, failure-analysis, spider-method, study-strategy, skill-builder, mindset' \
'{
  "metadataAttributes": {
    "doc_type": "self-reflection",
    "domain": "career",
    "tags": "certification,aws,devops-professional,exam,failure-analysis,spider-method,study-strategy",
    "status": "accepted",
    "code_backed": "false"
  }
}'

process_file "$KB_DIR/self-reflection/learning-methodology.md" \
'title: "Learning Methodology — Build, Break, Document"
doc_type: self-reflection
domain: career
tags:
  - learning
  - methodology
  - build-break-document
  - self-directed
  - portfolio
related_docs:
  - self-reflection/career-transition.md
  - self-reflection/certification-journey.md
last_updated: "2026-03-22"
author: Nelson Lamounier
status: accepted
code_backed: false' \
'This self-reflection explains the "Build, Break, Document" learning methodology used throughout the portfolio project: building real infrastructure to learn services hands-on, deliberately breaking things to understand failure modes, and documenting every decision with evidence for knowledge retention and portfolio value.' \
'learning, methodology, build-break-document, self-directed, portfolio, knowledge-retention, hands-on, failure-modes' \
'{
  "metadataAttributes": {
    "doc_type": "self-reflection",
    "domain": "career",
    "tags": "learning,methodology,build-break-document,self-directed,portfolio",
    "status": "accepted",
    "code_backed": "false"
  }
}'

echo ""
echo "✅ Complete: $processed files processed, $skipped skipped"
echo "📄 Metadata sidecar files generated alongside each .md file"
