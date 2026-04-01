---
title: "Runbook: Orphaned Local-Path PVCs (Archived)"
description: "Historical runbook for resolving stuck Pending Pods caused by local-path provisioner orphaned PVCs. Superseded by the AWS EBS CSI Driver migration (2026-03-31)."
tags: ["kubernetes", "storage", "local-path", "monitoring", "troubleshooting", "pvc", "archived"]
status: archived
superseded_by: "EBS CSI Driver migration — see observability/observability-implementation.md"
last_updated: "2026-03-31"
---

# Troubleshooting Orphaned Local-Path PVCs (Archived)

> [!IMPORTANT]
> **This runbook is archived.** As of 2026-03-31, all monitoring PVCs
> have been migrated from `local-path` to `ebs-sc` (AWS EBS CSI Driver).
> The orphaned PVC problem documented here no longer occurs because EBS
> volumes are network-attached and survive node replacement.
>
> See [observability-implementation.md](../../../knowledge-base/observability/observability-implementation.md)
> for the current storage architecture.

## Historical Context

### Symptoms (no longer expected)

- Stateful Pods (Grafana, Loki, Prometheus, Tempo) stuck in `Pending`.
- `kubectl describe pod` showing:
  `0/4 nodes are available: 1 node(s) didn't match PersistentVolume's node affinity...`
- Monitoring dashboards stop populating data.

### Root Cause

This occurred when the ASG replaced or terminated an EC2 instance
hosting `local-path` volumes:

- `local-path` PVs were locked to a specific node via `NodeAffinity`.
- Node termination orphaned the PVs/PVCs.
- The scheduler refused to place Pods on a new node because the old
  PVC demanded a host that no longer existed.

### Legacy Self-Healing (Removed)

The `pvc-cleaner` CronJob (`cleaner-cronjob.yaml`) previously ran
every 5 minutes to detect and delete orphaned `local-path` PVCs.
This infrastructure was removed as part of the EBS CSI migration:

- `kubernetes-app/platform/charts/monitoring/chart/templates/cleaner-cronjob.yaml` — deleted
- `kubernetes-app/platform/charts/monitoring/chart/templates/cleaner-rbac.yaml` — deleted
- `values.yaml` `pvcCleaner` section — removed

## Current Architecture (EBS CSI)

All monitoring components now use `ebs-sc` (`StorageClass: gp3`,
KMS-encrypted, `WaitForFirstConsumer`):

| Component | PVC | StorageClass |
|-----------|-----|-------------|
| Prometheus | `prometheus-data` | `ebs-sc` |
| Grafana | `grafana-data` | `ebs-sc` |
| Loki | `loki-data` | `ebs-sc` |
| Tempo | `tempo-data` | `ebs-sc` |

EBS volumes are network-attached and survive node replacement,
eliminating the orphaned PVC problem entirely.

## Summary

This archived runbook explains a historical issue where stateful Pods became permanently stuck in Pending state due to orphaned local-path PVCs following node termination. Since EC2 instances were ephemeral and local-path volumes were strictly tied to a specific node, the loss of the node necessitated manual or automated cleanup of the orphaned PVCs so the StatefulSet could provision a fresh volume on a new node. This problem was entirely eliminated by the cluster-wide migration to the AWS EBS CSI Driver (`ebs-sc`), which provides network-attached volumes that natively survive node replacement.

## Keywords

archived, local-path, orphaned-pvc, ebs-csi, migration, storage
