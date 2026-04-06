#!/usr/bin/env python3
"""
Knowledge Base — Phase 3: Add Transferable Skills sections.

Inserts '## Transferable Skills Demonstrated' before '## Summary' in each
target file. Idempotent: skips files that already contain the section.
"""

import os
import sys

KB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
os.chdir(KB_DIR)

SKILLS: dict[str, str] = {
    "observability/runbooks/faro-rum-no-data.md": """## Transferable Skills Demonstrated

- **End-to-end telemetry debugging** — tracing data flow from browser SDK through Alloy pipeline to Loki/Grafana
- **Log format analysis** — identifying logfmt vs JSON mismatches in panel queries
- **Kubernetes ConfigMap management** — live-patching Alloy collector configuration
- **Dashboard query engineering** — writing LogQL and PromQL queries for real-user monitoring
""",

    "observability/frontend-performance.md": """## Transferable Skills Demonstrated

- **SLI/SLO definition** — deriving golden signals (latency, errors, traffic, saturation) from reverse proxy metrics
- **Prometheus metric modelling** — crafting rate(), histogram_quantile(), and label-based filtering
- **Grafana dashboard design** — building production-grade panels with variables, thresholds, and alerting
- **Edge observability** — instrumenting Traefik ingress controller for per-service visibility
""",

    "observability/rum-dashboard-review.md": """## Transferable Skills Demonstrated

- **Real User Monitoring architecture** — designing browser-to-backend telemetry pipelines
- **Core Web Vitals analysis** — measuring LCP, FID, CLS for production performance
- **Faro SDK integration** — instrumenting Next.js applications with Grafana's frontend SDK
- **Cross-signal correlation** — linking frontend errors to backend traces via Tempo
""",

    "kubernetes/runbooks/pod-crashloop.md": """## Transferable Skills Demonstrated

- **Kubernetes troubleshooting methodology** — systematic Pod lifecycle debugging with kubectl
- **Container diagnostics** — analysing OOMKilled, ImagePullBackOff, and probe failures
- **AI-assisted operations** — leveraging K8sGPT for automated root cause analysis
- **Incident response** — structured triage from symptom to root cause to validation
""",

    "kubernetes/runbooks/instance-terminated.md": """## Transferable Skills Demonstrated

- **Auto-healing infrastructure** — designing self-recovery workflows with Step Functions and SSM
- **AWS event-driven architecture** — EventBridge rules for EC2 state change notifications
- **Kubernetes node lifecycle** — handling node drain, cordon, and rejoin procedures
- **Disaster recovery** — automated cluster reconstitution from golden AMI baselines
""",

    "kubernetes/runbooks/bluegreen-rollout-stuck.md": """## Transferable Skills Demonstrated

- **Progressive delivery** — operating Argo Rollouts BlueGreen deployments in production
- **GitOps debugging** — diagnosing ArgoCD sync failures and resource conflicts
- **Static asset versioning** — S3 retention strategy for zero-downtime frontend deploys
- **Rollback procedures** — safe manual promotion and abort workflows
""",

    "kubernetes/bootstrap-system-scripts.md": """## Transferable Skills Demonstrated

- **Infrastructure as Code scripting** — Python + Bash automation for cluster lifecycle
- **Certificate management** — TLS persistence and rotation via SSM SecureString
- **Disaster recovery** — etcd snapshot backup/restore to S3
- **GitOps bootstrapping** — ArgoCD ApplicationSet installation and sync-wave ordering
- **Shell engineering** — idempotent scripts with error handling, logging, and retry logic
""",

    "kubernetes/bootstrap-pipeline.md": """## Transferable Skills Demonstrated

- **Immutable infrastructure** — golden AMI build pipeline with Packer and User Data
- **AWS orchestration** — SSM Automation documents and Step Functions for multi-stage bootstrap
- **Kubernetes cluster lifecycle** — kubeadm init/join with HA control plane configuration
- **Infrastructure testing** — integration tests validating bootstrap stages end-to-end
""",

    "kubernetes/adrs/argo-rollouts-zero-downtime.md": """## Transferable Skills Demonstrated

- **Progressive delivery strategy** — evaluating BlueGreen vs Canary for static-asset-heavy apps
- **Static asset retention** — solving the active-user broken-link problem with S3 versioned builds
- **Cloud-native deployment patterns** — integrating Argo Rollouts with ArgoCD and S3
- **Architecture decision documentation** — evidence-based decision recording with trade-off analysis
""",

    "infrastructure/stack-overview.md": """## Transferable Skills Demonstrated

- **Multi-stack CDK architecture** — organising 12 stacks with cross-stack dependencies
- **Separation of concerns** — isolating compute, networking, AI/ML, and edge into independent stacks
- **AWS Well-Architected alignment** — designing for security, reliability, and cost optimisation
- **Infrastructure documentation** — communicating complex architectures to mixed audiences
""",
}

added = 0
skipped = 0

for filepath, skills_block in SKILLS.items():
    if not os.path.isfile(filepath):
        print(f"  ⚠️  File not found: {filepath}")
        continue

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Idempotent check
    if '## Transferable Skills Demonstrated' in content:
        print(f"  ⏭️  Already present: {filepath}")
        skipped += 1
        continue

    # Insert before ## Summary
    if '\n## Summary\n' in content:
        content = content.replace(
            '\n## Summary\n',
            f'\n{skills_block}\n## Summary\n'
        )
    else:
        # Append at end
        content = content.rstrip('\n') + '\n\n' + skills_block

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"  ✅ Added to: {filepath}")
    added += 1

print(f"\n✅ Transferable Skills enrichment complete: {added} added, {skipped} skipped")
